import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@duckmind/dm-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager } from "@duckmind/dm-coding-agent";

const extensionPath = new URL("../index.ts", import.meta.url).pathname;

async function requestWithWebTools(config, toolCall) {
	const root = mkdtempSync(join(tmpdir(), "dm-web-access-sdk-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config));
	const previous = process.env.DM_CODING_AGENT_DIR;
	const previousFauxKey = process.env.FAUX_API_KEY;
	process.env.DM_CODING_AGENT_DIR = root;
	process.env.FAUX_API_KEY = "test";
	let session;
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const modelRuntime = new Proxy(models, {
			get(target, property) {
				if (property === "hasConfiguredAuth") return () => true;
				if (property === "checkAuth") return async () => ({ type: "api_key", key: "test" });
				if (property === "getApiKeyAndHeaders") return async () => ({ ok: true, apiKey: "test" });
				if (property === "isUsingOAuth" || property === "isUsingSubscription") return () => false;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: root, noExtensions: true, noContextFiles: true,
			noSkills: true, noPromptTemplates: true, noThemes: true,
			additionalExtensionPaths: [extensionPath],
			extensionFactories: toolCall?.name === "codemode" ? [createCodemodeExtension()] : [],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const schemas = [];
		faux.setResponses(toolCall ? [
			(context) => {
				schemas.push(context.tools ?? []);
				return fauxAssistantMessage(fauxToolCall(toolCall.name, toolCall.arguments), { stopReason: "toolUse" });
			},
			(context) => {
				schemas.push(context.tools ?? []);
				return fauxAssistantMessage("done");
			},
		] : [(context) => {
			schemas.push(context.tools ?? []);
			return fauxAssistantMessage("done");
		}]);
		const result = await createAgentSession({
			cwd: root, agentDir: root, model: faux.getModel(), modelRuntime,
			resourceLoader: loader, sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		});
		session = result.session;
		assert.deepEqual(result.extensionsResult.errors, []);
		if (toolCall?.name === "codemode") session.settingsManager.setProjectTrusted(true);
		await session.bindExtensions({});
		await session.prompt("Research this");
		assert.equal(schemas.length, toolCall ? 2 : 1);
		return toolCall ? { schemas, transcript: JSON.stringify(session.messages) } : schemas[0];
	} finally {
		session?.dispose();
		if (previous === undefined) delete process.env.DM_CODING_AGENT_DIR;
		else process.env.DM_CODING_AGENT_DIR = previous;
		if (previousFauxKey === undefined) delete process.env.FAUX_API_KEY;
		else process.env.FAUX_API_KEY = previousFauxKey;
		rmSync(root, { recursive: true, force: true });
	}
}

test("native DM sends the enabled web schemas on the first request", async () => {
	const tools = await requestWithWebTools({ toolActivation: "eager" });
	assert.deepEqual(tools.map(tool => tool.name), ["web_search", "source_check", "fetch_content", "get_search_content"]);
	assert.ok(tools.every(tool => tool.parameters), "every exposed tool has a schema");
	assert.ok(!tools.some(tool => tool.name === "web_enable"), "eager mode does not register the loader");
});

test("native DM sends only configured and renamed schemas", async () => {
	const tools = await requestWithWebTools({
		toolNames: { webSearch: "research_web", sourceCheck: "verify_sources", fetchContent: "grab_content", getSearchContent: "open_content" },
		tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } },
	});
	assert.deepEqual(tools.map(tool => tool.name), ["grab_content"]);
});

test("native DM falls back to eager tools when dynamic activation cannot reach the next request", async () => {
	const tools = await requestWithWebTools({ toolActivation: "dynamic" });
	assert.deepEqual(tools.map(tool => tool.name), ["web_search", "source_check", "fetch_content", "get_search_content"]);
});

test("native DM keeps deferred web schemas off the model and invokes them from QuickJS", async () => {
	const { schemas, transcript } = await requestWithWebTools(
		{ toolExposure: "deferred", toolActivation: "none" },
		{ name: "codemode", arguments: { code: 'try { await tools.get_search_content({responseId:"missing"}); } catch (error) { return {names: ALL_TOOLS.map(t => t.name), error: error.message}; }' } },
	);
	assert.deepEqual(schemas.map(tools => tools.map(tool => tool.name)), [["codemode"], ["codemode"]]);
	assert.match(transcript, /get_search_content/);
	assert.match(transcript, /No stored results/);
});
