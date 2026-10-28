import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@duckmind/dm-ai";
import { ModelRuntime } from "@duckmind/dm-coding-agent";
import type { ExtensionAPI } from "@duckmind/dm-coding-agent";
import { registerTestProvider } from "../support/host-registry.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import { CHILD_FANOUT_BOUNDARY_INSTRUCTIONS, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, rewriteSubagentPrompt } from "../../src/runs/shared/subagent-prompt-runtime.ts";

type Flags = { inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean };
type Fixture = { globalContext?: boolean; repoContext?: boolean; orchestrationSkill?: boolean };
type Run = { flags: Flags; fixture?: Fixture; unsetFlags?: boolean; fanout?: boolean; structured?: boolean; prompts?: string[]; toolTurn?: boolean; hooks?: Array<(dm: ExtensionAPI) => void> };

const count = (text: string, part: string) => text.split(part).length - 1;

describe("child provider system prompt", () => {
	let root: string;
	let agentDir: string;
	let repo: string;
	const previousAgentDir = process.env.DM_CODING_AGENT_DIR;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-child-prompt-sections-"));
		agentDir = path.join(root, "agent");
		repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		writeSkill("probe-skill");
		fs.writeFileSync(path.join(repo, "notes.txt"), "notes");
		process.env.DM_CODING_AGENT_DIR = agentDir;
	});

	after(() => {
		if (previousAgentDir === undefined) delete process.env.DM_CODING_AGENT_DIR;
		else process.env.DM_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeSkill(name: string): void {
		fs.mkdirSync(path.join(agentDir, "skills", name), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\nBody`);
	}

	function setFixture({ globalContext = true, repoContext = true, orchestrationSkill = false }: Fixture): void {
		const toggle = (file: string, present: boolean, write: () => void) => present ? write() : fs.rmSync(file, { recursive: true, force: true });
		toggle(path.join(agentDir, "AGENTS.md"), globalContext, () => fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "GLOBAL-CONTEXT-MARKER"));
		toggle(path.join(repo, "AGENTS.md"), repoContext, () => fs.writeFileSync(path.join(repo, "AGENTS.md"), "REPO-CONTEXT-MARKER"));
		toggle(path.join(agentDir, "skills", "dm-subagents"), orchestrationSkill, () => writeSkill("dm-subagents"));
	}

	/** Runs a real SDK child, one run per prompt, and returns the system prompt of every provider request. */
	async function providerPrompts(run: Run): Promise<string[]> {
		setFixture(run.fixture ?? {});
		const faux = fauxProvider({ provider: "probe", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const requests: string[] = [];
		const reply = (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (context) => {
			requests.push(context.systemPrompt ?? "");
			return message;
		};
		faux.setResponses((run.prompts ?? ["Task"]).flatMap(() => run.toolTurn
			? [reply(fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" })), reply(fauxAssistantMessage("done"))]
			: [reply(fauxAssistantMessage("done"))]));
		const parentProviders = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		parentProviders.registerNativeProvider(faux.provider);
		const { session, config } = buildInProcessChildLaunch({
			host: "parent", cwd: repo, childAgentName: "worker", childIndex: 0, sessionEnabled: false, waitToolEnabled: false,
			model: "probe/local", systemPrompt: "Role instructions.", systemPromptMode: "append", ...run.flags,
			...(run.fanout ? { allowNestedSubagents: true } : {}),
			...(run.structured ? { structuredOutput: createStructuredOutputRuntime({ type: "object" }, agentDir) } : {}),
		});
		// Unset flags make the prompt runtime leave the prompt alone, so the same launch yields DM's original render.
		if (run.unsetFlags) Object.assign(config, { inheritProjectContext: undefined, inheritGlobalContext: undefined, inheritSkills: undefined });
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@duckmind/dm-coding-agent") });
		const hooks = run.hooks ?? [];
		const child = await factory.create({ ...session, parentProviderRegistry: parentProviders, hooks: [...session.hooks, ...hooks.map((factory, index) => ({ name: `probe-${index}`, factory }))] });
		try {
			for (const prompt of run.prompts ?? ["Task"]) await child.prompt(prompt);
		} finally {
			await child.dispose();
			await factory.dispose();
		}
		return requests;
	}

	it("sends sections that later extensions add to the provider, after the filtered prompt a bridge captured", async () => {
		const captured: string[] = [];
		const requests = await providerPrompts({
			flags: { inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: true },
			prompts: ["Task", "Next task"],
			toolTurn: true,
			hooks: [
				(dm) => dm.on("before_agent_start", (event) => { captured.push(event.systemPrompt); }),
				(dm) => dm.on("before_agent_start", (event) => { event.systemPromptOptions.sections.probe = "PROBE-SECTION-MARKER"; }),
			],
		});

		assert.equal(requests.length, 4, "a tool-result request and a second prompt each re-send the prompt");
		assert.equal(new Set(requests).size, 1, "the prompt is identical across requests");
		for (const [index, request] of requests.entries()) {
			const capture = captured[index < 2 ? 0 : 1]!;
			assert.match(request, /<probe>\nPROBE-SECTION-MARKER\n<\/probe>/);
			assert.ok(request.startsWith(capture), "the bridge-captured prompt is the head of the provider prompt");
			assert.doesNotMatch(capture, /GLOBAL-CONTEXT-MARKER/);
			assert.doesNotMatch(request, /GLOBAL-CONTEXT-MARKER/);
			assert.match(request, /REPO-CONTEXT-MARKER/);
			assert.ok(request.includes(`\n\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}`));
			assert.ok(request.indexOf("<probe>") > request.indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), "hook-set sections follow the child boundary");
			assert.equal(count(request, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
		}
	});

	it("appends the boundary once to a prompt another extension returns", async () => {
		const [request] = await providerPrompts({
			flags: { inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true },
			hooks: [(dm) => dm.on("before_agent_start", () => ({ systemPrompt: "Extension-owned prompt." }))],
		});
		assert.equal(request, `Extension-owned prompt.\n\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}`);
	});

	const inheritAll = { inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true };
	const noGlobal = { inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: true };
	for (const [label, run, absent] of [
		["nothing to remove", { flags: inheritAll }, {}],
		["context and skills not loaded", { flags: { inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false } }, {}],
		["global context removed", { flags: noGlobal }, { globalContext: false }],
		["the only context file removed", { flags: noGlobal, fixture: { repoContext: false } }, { globalContext: false }],
		["dm-subagents skill removed next to another skill", { flags: inheritAll, fixture: { orchestrationSkill: true } }, { orchestrationSkill: false }],
		["structured output", { flags: noGlobal, structured: true }, { globalContext: false }],
	] as Array<[string, Run, Fixture]>) {
		it(`sends a child without other extensions DM's render of the launch without the removed resources, plus the boundary (${label})`, async () => {
			// The launch without the removed resources leaves rewriteSubagentPrompt nothing to strip, so it only appends the boundary.
			const [render] = await providerPrompts({ ...run, fixture: { ...run.fixture, ...absent }, unsetFlags: true });
			const [actual] = await providerPrompts(run);
			const expected = rewriteSubagentPrompt(render!, { ...run.flags, structuredOutput: run.structured });
			// The structured-output scratch dir is created between these two live
			// requests; only its dynamic entry in DM's ls_la snapshot may vary.
			const stable = (prompt: string) => prompt.replace(/^[ \t]*d[ \t]+\d+[ \t]+dm-subagent-structured-[^\r\n]+(?:\r?\n)?/gm, "");
			assert.equal(stable(actual!), stable(expected));
		});
	}

	it("keeps the fanout child's provider prompt byte-identical", async () => {
		const flags = inheritAll;
		const seen: string[] = [];
		const [rewritten] = await providerPrompts({ flags, fanout: true, hooks: [(dm) => dm.on("before_agent_start", (event) => { seen.push(event.systemPrompt); })] });
		// With everything inherited the filter removes nothing, so the prompt seen mid-chain is DM's original render.
		assert.equal(rewritten, rewriteSubagentPrompt(seen[0]!, { ...flags, fanoutChild: true }));
		assert.ok(rewritten!.endsWith(`\n\n${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}`));
	});
});
