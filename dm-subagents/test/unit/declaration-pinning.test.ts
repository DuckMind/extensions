import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@duckmind/dm-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from "@duckmind/dm-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { createDmTestRegistry, registerDmTestProvider } from "../support/dm-model-registry.ts";

it("declares subagent tools on fresh and resumed DM sessions", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-subagents-declarations-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(cwd);
	fs.mkdirSync(path.join(agentDir, "agents"));
	fs.writeFileSync(path.join(agentDir, "agents", "specialist.md"), "---\nname: specialist\ndescription: Pinning specialist\nadvertise: true\n---\nAct narrowly.\n");
	const prior = process.env.DM_CODING_AGENT_DIR;
	process.env.DM_CODING_AGENT_DIR = agentDir;
	const faux = fauxProvider({ provider: "declaration-pinning", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	const manager = SessionManager.inMemory(cwd);
	const requests: Array<{ systemPrompt: string; tools: Array<{ name: string }> }> = [];
	const run = async (sessionManager: SessionManager, callTool: boolean) => {
		faux.setResponses([
			(context) => {
				requests.push({ systemPrompt: context.systemPrompt, tools: context.tools ?? [] });
				return callTool
					? fauxAssistantMessage(fauxToolCall("subagent", { action: "list", capabilities: true }), { stopReason: "toolUse" })
					: fauxAssistantMessage("done");
			},
			(context) => {
				requests.push({ systemPrompt: context.systemPrompt, tools: context.tools ?? [] });
				return fauxAssistantMessage("listed");
			},
		]);
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerSubagentExtension, (dm) => registerDmTestProvider(dm, faux)],
		});
		await resourceLoader.reload();
		const { modelRegistry, authStorage } = createDmTestRegistry(agentDir, faux);
		const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRegistry, authStorage, model: faux.getModel("local"), sessionManager, noTools: "builtin" });
		try {
			await session.bindExtensions({});
			await session.prompt("Inspect.");
			if (callTool) {
				assert.ok(session.messages.some(message => message.role === "toolResult" && !message.isError));
			}
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	};
	try {
		await run(manager, false);
		await run(SessionManager.inMemory(cwd, undefined, structuredClone(manager.getEntries())), true);
		assert.equal(requests.length, 3);
		for (const request of requests) {
			assert.ok(request.tools.some(tool => tool.name === "subagent"));
			assert.ok(request.tools.some(tool => tool.name === "bg_wait"));
			assert.match(request.systemPrompt, /subagent/);
		}
	} finally {
		if (prior === undefined) delete process.env.DM_CODING_AGENT_DIR;
		else process.env.DM_CODING_AGENT_DIR = prior;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
