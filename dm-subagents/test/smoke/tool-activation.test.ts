import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
	type FauxResponseStep,
	type Tool,
} from "@duckmind/dm-ai";
import { registerApiProvider, unregisterApiProviders } from "@duckmind/dm-ai/compat";
import {
	DefaultResourceLoader,
	AuthStorage,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@duckmind/dm-coding-agent";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";

const packageToolNames = new Set(["subagents_enable", "bg_wait", "subagent_supervisor", "subagent"]);

function serializedCharacters(tools: Tool[]): number {
	return tools.filter((tool) => packageToolNames.has(tool.name)).reduce((total, tool) => total + JSON.stringify(tool).length, 0);
}

function perToolSizes(tools: Tool[]): string {
	return tools.filter((tool) => packageToolNames.has(tool.name)).map((tool) => `${tool.name}=${JSON.stringify(tool).length}`).join(", ");
}

async function runNativeSession(config: Record<string, unknown> | undefined, responses: FauxResponseStep[], prompts: string[]): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-subagents-tool-activation-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	if (config) {
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify(config));
	}
	const priorAgentDir = process.env.DM_CODING_AGENT_DIR;
	const priorChild = process.env.DM_SUBAGENT_CHILD;
	process.env.DM_CODING_AGENT_DIR = agentDir;
	delete process.env.DM_SUBAGENT_CHILD;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: registerSubagentExtension } = await import(`../../index.ts?native-activation=${Date.now()}`);
		const faux = fauxProvider({ provider: "tool-activation", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses(responses);
		const settingsManager = SettingsManager.inMemory({});
		const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("tool-activation", "local-faux-test-key");
		const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: false, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			// The host bundles its own dm-subagents; test only the imported extension's declarations.
			bundledPackageRoots: [],
			extensionFactories: [registerSubagentExtension],
		});
		await resourceLoader.reload();
		assert.equal(resourceLoader.getExtensions().errors.length, 0, JSON.stringify(resourceLoader.getExtensions().errors));
		({ session } = await createAgentSession({
			cwd, agentDir, settingsManager, resourceLoader, modelRegistry, authStorage,
			model: faux.getModel("local"), sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		}));
		await session.bindExtensions({});
		// The 0.80 host uses the compat API registry for model streams.
		registerApiProvider({ api: faux.api, stream: faux.provider.stream, streamSimple: faux.provider.streamSimple }, "tool-activation-smoke");
		for (const [index, prompt] of prompts.entries()) {
			await session.prompt(prompt);
			if (config?.toolActivation === "dynamic" && index === 0) {
				assert.ok(session.getActiveToolNames().includes("subagent"),
					`Activation did not select subagent: ${JSON.stringify(session.messages.slice(-4))}`);
			}
			assert.notEqual(session.messages.at(-1)?.role === "assistant" ? session.messages.at(-1).stopReason : undefined, "error",
				`Native DM request failed: ${JSON.stringify(session.messages.at(-1))}`);
		}
		assert.equal(faux.state.callCount, responses.length, `DM did not call the faux provider: ${JSON.stringify(session.messages.at(-1))}`);
	} finally {
		unregisterApiProviders("tool-activation-smoke");
		if (session) {
			await (session.extensionRunner as any).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.DM_CODING_AGENT_DIR; else process.env.DM_CODING_AGENT_DIR = priorAgentDir;
		if (priorChild === undefined) delete process.env.DM_SUBAGENT_CHILD; else process.env.DM_SUBAGENT_CHILD = priorChild;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("native DM exposes the full subagent schema on the request immediately after activation", { timeout: 30_000 }, async () => {
	const captured: number[] = [];
	const sizes: string[] = [];
	await runNativeSession({ toolActivation: "dynamic" }, [
		(context) => {
			const tools = context.tools ?? [];
			const systemPrompt = context.systemPrompt;
			assert.match(systemPrompt, /dm-subagents is installed/i);
			assert.match(systemPrompt, /complexity alone is not authorization/i);
			captured.push(serializedCharacters(tools));
			sizes.push(perToolSizes(tools));
			const loader = tools.find((tool) => tool.name === "subagents_enable");
			const wait = tools.find((tool) => tool.name === "bg_wait");
			const supervisor = tools.find((tool) => tool.name === "subagent_supervisor");
			assert.ok(loader);
			assert.equal(wait, undefined, "a session that has not delegated does not declare bg_wait");
			assert.equal(supervisor, undefined, "a session that has not delegated does not declare subagent_supervisor");
			assert.ok(JSON.stringify(loader).length <= 800);
			assert.ok(!tools.some((tool) => tool.name === "subagent"));
			return fauxAssistantMessage(fauxToolCall("subagents_enable", {}), { stopReason: "toolUse" });
		},
		(context) => {
			const tools = context.tools ?? [];
			captured.push(serializedCharacters(tools));
			sizes.push(perToolSizes(tools));
			// DM sends the effective declaration list with each model request.
			const subagent = tools.find((tool) => tool.name === "subagent");
			assert.ok(subagent);
			assert.ok(tools.some((tool) => tool.name === "subagent_supervisor"));
			assert.ok(tools.some((tool) => tool.name === "bg_wait"));
			assert.deepEqual(subagent.parameters, createSubagentParamsSchema());
			return fauxAssistantMessage("Activation verified.");
		},
	], ["Use the authorized delegation tools."]);

	assert.equal(captured.length, 2);
	// Every package tool definition is sent on every request. Raising these budgets needs owner approval (#2770).
	assert.ok(captured[0]! <= 500, `cold package tool text exceeded budget: ${captured[0]} (${sizes[0]})`);
	assert.ok(captured[1]! <= 5_500, `activated package tool text exceeded budget: ${captured[1]} (${sizes[1]})`);
	assert.ok(captured[1]! - captured[0]! >= 3_000, `lazy activation should remove the full subagent schema from cold requests: cold=${captured[0]} active=${captured[1]} (${sizes.join("; ")})`);
	console.log(`package tool characters cold=${captured[0]} (${sizes[0]}) activated=${captured[1]} (${sizes[1]})`);
});

test("native DM starts auto sessions with subagent and no loader when the model cannot add tools", { timeout: 30_000 }, async () => {
	// The faux model sets no compat flags.
	const requests: string[][] = [];
	const record: FauxResponseFactory = (context) => {
		// One tool declaration across both prompts: the tool list never changed.
		requests.push((context.tools ?? []).map((tool) => tool.name));
		return fauxAssistantMessage("ok");
	};
	await runNativeSession(undefined, [record, record], ["First prompt.", "Second prompt."]);

	assert.equal(requests.length, 2);
	assert.ok(requests[0]!.includes("subagent") && requests[0]!.includes("bg_wait"));
	assert.equal(requests[0]!.includes("subagents_enable"), false);
});
