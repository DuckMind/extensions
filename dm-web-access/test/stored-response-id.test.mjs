import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const previousEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "pi-stored-response-id-"));
process.env.DM_CODING_AGENT_DIR = root;
process.env.PI_WEB_ACCESS_CACHE_ROOT = root;
process.env.BRAVE_API_KEY = "fixture-key";
delete process.env.BRAVE_BASE_URL;
const configPath = join(root, "web-search.json");
const baseConfig = { workflow: "none", maxInlineContentChars: 1000, fetchRouting: { providers: ["http"] }, summaryModel: "fixture/model" };
await writeFile(configPath, JSON.stringify(baseConfig));

const { default: initializeExtension } = await import("../index.ts");
const { clearResults, storeResult } = await import("../storage.ts");
const { createWebToolCore, createStandaloneWebToolCore, DEFAULT_TOOL_NAMES } = await import("../web-tool-core.ts");
const { createMcpServer } = await import("../mcp-server.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const pageUrl = "http://93.184.216.34/page";
const page = "ORIGINAL_PAGE_MARKER and a short original source.";
const model = { provider: "fixture", id: "model", api: "fixture-api", contextWindow: 32000, input: ["text"] };
let completions = 0;
const ctx = {
	model,
	scopedModels: [],
	modelRegistry: {
		find: () => model,
		getAvailable: () => [model],
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
		complete: async () => {
			completions++;
			return { stopReason: "stop", content: [{ type: "text", text: "GENERATED_PROSE_MARKER" }] };
		},
	},
};
const visibleText = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
function printedCall(result, selector = "urlIndex", toolName = "get_search_content") {
	const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = visibleText(result).match(new RegExp(`${escaped}\\(\\{ responseId: "([^"]+)", ${selector}: 0(?:, offset: (\\d+))?`));
	assert.ok(match, `missing a visible ${toolName} call for ${selector}`);
	return { responseId: match[1], [selector]: 0, offset: Number(match[2] ?? 0) };
}
async function registered(config = {}) {
	await writeFile(configPath, JSON.stringify({ ...baseConfig, ...config }));
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {},
	});
	return {
		fetch: tools.find(tool => tool.name === "fetch_content"),
		search: tools.find(tool => tool.name === "web_search"),
		retrieve: tools.find(tool => tool.name === (config.toolNames?.getSearchContent ?? "get_search_content")),
	};
}

beforeEach(async () => {
	clearResults();
	completions = 0;
	await writeFile(configPath, JSON.stringify(baseConfig));
	globalThis.fetch = async input => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://api.search.brave.com/")) return Response.json({ web: { results: [{ title: "Source", url: pageUrl, description: "SEARCH_SNIPPET_MARKER" }] } });
		if (url === "https://api.anysearch.com/v1/search") return Response.json({ code: 0, data: { results: [{ title: "Source", url: pageUrl, snippet: "SEARCH_SNIPPET_MARKER", content: page }], metadata: {} } });
		if (url === pageUrl) return new Response(page, { headers: { "content-type": "text/plain" } });
		throw new Error("Unexpected fixture request");
	};
});
after(async () => {
	clearResults();
	globalThis.fetch = originalFetch;
	process.env = previousEnv;
	await rm(root, { recursive: true, force: true });
});

for (const mode of ["readable", "raw"]) {
	test(`untruncated ${mode} fetch exposes a usable ID without altering the body block`, async () => {
		const tools = await registered();
		const result = await tools.fetch.execute("fetch", { url: pageUrl, mode });
		assert.equal(result.details.truncated, false);
		assert.equal(result.content[0].text, page);
		assert.equal(result.structuredContent.urls[0].content, page);
		const args = printedCall(result);
		assert.equal(args.responseId, result.details.responseId);
		const stored = await tools.retrieve.execute("read", args);
		assert.equal(stored.details.error, undefined);
		assert.match(visibleText(stored), /ORIGINAL_PAGE_MARKER/);
	});
}

test("untruncated answer exposes an original-source ID without claiming the answer is stored", async () => {
	const tools = await registered();
	const result = await tools.fetch.execute("answer", { url: pageUrl, mode: "answer", prompt: "Fixture question?" }, undefined, undefined, ctx);
	assert.equal(completions, 1);
	assert.equal(result.content[0].text, "GENERATED_PROSE_MARKER");
	assert.match(visibleText(result), /original (?:source|page)/i);
	const stored = await tools.retrieve.execute("read", printedCall(result));
	assert.match(visibleText(stored), /ORIGINAL_PAGE_MARKER/);
	assert.doesNotMatch(visibleText(stored), /GENERATED_PROSE_MARKER/);
});

test("single-fetch guidance uses a renamed retrieval tool", async () => {
	const tools = await registered({ toolNames: { getSearchContent: "grab_content" } });
	const result = await tools.fetch.execute("fetch", { url: pageUrl, mode: "raw" });
	const stored = await tools.retrieve.execute("read", printedCall(result, "urlIndex", "grab_content"));
	assert.equal(stored.details.error, undefined);
	assert.doesNotMatch(visibleText(result), /get_search_content\(/);
});

test("untruncated fetch does not suggest a disabled retrieval tool", async () => {
	const tools = await registered({ tools: { getSearchContent: { enabled: false } } });
	assert.equal(tools.retrieve, undefined);
	const result = await tools.fetch.execute("fetch", { url: pageUrl, mode: "raw" });
	assert.equal(result.content.length, 1);
	assert.equal(result.content[0].text, page);
	assert.doesNotMatch(visibleText(result), /get_search_content\(/);
});

test("registered auto-summary exposes the underlying search ID and preserves the summary block", async () => {
	const tools = await registered();
	const result = await tools.search.execute("summary", { query: "fixture", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
	assert.equal(completions, 1);
	assert.equal(result.content[0].text, "GENERATED_PROSE_MARKER");
	assert.equal(result.details.summary.text, "GENERATED_PROSE_MARKER");
	const args = printedCall(result, "queryIndex");
	assert.equal(args.responseId, result.details.searchId);
	const stored = await tools.retrieve.execute("read", args);
	assert.match(visibleText(stored), /SEARCH_SNIPPET_MARKER/);
	assert.doesNotMatch(visibleText(stored), /GENERATED_PROSE_MARKER/);
});

test("auto-summary retains separate fetched-page and search IDs when content is ready", async () => {
	const tools = await registered();
	const result = await tools.search.execute("summary", { query: "fixture", provider: "anysearch", workflow: "auto-summary", includeContent: true }, undefined, undefined, ctx);
	const fetchedArgs = printedCall(result);
	const searchArgs = printedCall(result, "queryIndex");
	assert.equal(fetchedArgs.responseId, result.details.fetchId);
	assert.equal(searchArgs.responseId, result.details.searchId);
	assert.notEqual(fetchedArgs.responseId, searchArgs.responseId);
	const fetched = await tools.retrieve.execute("page", fetchedArgs);
	assert.match(visibleText(fetched), /ORIGINAL_PAGE_MARKER/);
});

test("auto-summary guidance uses a renamed retrieval tool", async () => {
	const tools = await registered({ toolNames: { getSearchContent: "grab_content" } });
	const result = await tools.search.execute("summary", { query: "fixture", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
	const stored = await tools.retrieve.execute("read", printedCall(result, "queryIndex", "grab_content"));
	assert.equal(stored.details.error, undefined);
	assert.doesNotMatch(visibleText(result), /get_search_content\(/);
});

test("auto-summary does not suggest disabled retrieval", async () => {
	const tools = await registered({ tools: { getSearchContent: { enabled: false } } });
	const result = await tools.search.execute("summary", { query: "fixture", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
	assert.equal(result.content.length, 1);
	assert.equal(visibleText(result), "GENERATED_PROSE_MARKER");
});

test("the shared approved-review formatter retains usable search guidance", async () => {
	const core = createWebToolCore({
		settings: { toolNames: DEFAULT_TOOL_NAMES, enabledTools: { webSearch: true, sourceCheck: true, fetchContent: true, getSearchContent: true }, maxInlineContentChars: 1000, fetchModes: { defaultMode: "readable", allowedModes: ["readable", "raw"] } },
		storeFetchedContent: storeResult,
	});
	const result = core.buildSearchReturn({ queryList: ["fixture"], results: [{ query: "fixture", answer: "Provider answer", results: [], error: null, provider: "fixture" }], urls: [], includeContent: false, approvedSummary: "Approved prose", workflow: "summary-review", curated: true });
	assert.equal(result.content[0].text, "Approved prose");
	const stored = await core.getSearchContent(printedCall(result, "queryIndex"));
	assert.match(visibleText(stored), /Provider answer/);
});

test("MCP short fetch exposes an ID through content, without exporting metadata", async t => {
	const core = createStandaloneWebToolCore();
	const server = createMcpServer(core, { name: "visible-id-test", version: "0.0.0" });
	const client = new Client({ name: "test", version: "0.0.0" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	t.after(async () => { await client.close(); await server.close(); });
	const result = await client.callTool({ name: "fetch_content", arguments: { url: pageUrl, mode: "raw" } });
	assert.equal(result.details, undefined);
	assert.equal(result.structuredContent, undefined);
	assert.equal(result.content[0].text, page);
	const stored = await client.callTool({ name: "get_search_content", arguments: printedCall(result) });
	assert.notEqual(stored.isError, true);
	assert.match(visibleText(stored), /ORIGINAL_PAGE_MARKER/);
});
