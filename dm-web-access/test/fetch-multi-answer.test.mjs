import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const sources = {
	"http://93.184.216.34/a": "SOURCE_A " + "p".repeat(190),
	"http://93.184.216.34/b": "SOURCE_B " + "q".repeat(190),
	"http://93.184.216.34/c": "SOURCE_C " + "r".repeat(190),
};
const answers = { SOURCE_A: "ANSWER_A short and complete.", SOURCE_B: "ANSWER_B_" + "b".repeat(1800), SOURCE_C: "ANSWER_C never shown." };

// Three URLs with a 1,000-char inline cap: answer A fits, B is cut, C has no room left.
function runFixture({ mode = "answer", config = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-fetch-multi-answer-"));
	const agent = join(root, "agent");
	const cache = join(root, "cache");
	mkdirSync(agent);
	mkdirSync(cache);
	writeFileSync(join(agent, "web-search.json"), JSON.stringify({
		workflow: "none", maxInlineContentChars: 1000, fetchRouting: { providers: ["http"] }, ...config,
	}));
	try {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const sources = ${JSON.stringify(sources)};
				const answers = ${JSON.stringify(answers)};
				const mode = ${JSON.stringify(mode)};
				globalThis.fetch = async input => {
					const source = sources[String(input instanceof Request ? input.url : input)];
					if (!source) throw new Error('Unexpected fixture HTTP request: ' + input);
					return new Response(source, { headers: { 'content-type': 'text/plain' } });
				};
				const { default: initialize } = await import(${JSON.stringify(indexUrl)});
				const tools = [];
				initialize({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				const model = { provider: 'fixture', id: 'model', api: 'fixture-api', input: ['text'], contextWindow: 32000 };
				const ctx = { model, scopedModels: [], modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture-key' }),
					complete: async (_model, context) => {
						const input = context.messages[0].content[0].text;
						const text = answers[Object.keys(answers).find(key => input.includes(key))];
						return { stopReason: 'stop', content: [{ type: 'text', text }] };
					},
				} };
				const result = await tools.find(t => t.name === 'fetch_content').execute('fetch', {
					urls: Object.keys(sources), mode, ...(mode === 'answer' ? { prompt: 'Fixture question?' } : {}),
				}, undefined, undefined, ctx);
				const text = result.content.map(c => c.text).join('\\n');
				const match = text.match(/([\\w-]+)\\(\\{ responseId: "([^"]+)", urlIndex: (\\d+)(?:, offset: (\\d+))? \\}\\)/);
				const tool = match && tools.find(t => t.name === match[1]);
				const retrieved = tool ? await tool.execute('visible-call', { responseId: match[2], urlIndex: Number(match[3]), ...(match[4] ? { offset: Number(match[4]) } : {}) }) : null;
				console.log(JSON.stringify({ result, text, retrieved }));
			`,
			encoding: "utf8", timeout: 20_000,
			env: { ...process.env, DM_CODING_AGENT_DIR: agent, PI_WEB_ACCESS_CACHE_ROOT: cache },
		});
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("multi-URL answers are visible, bounded, and the stored ID points at the sources", () => {
	const { result, text, retrieved } = runFixture();
	assert.ok(text.includes(answers.SOURCE_A));
	const shownB = 1000 - answers.SOURCE_A.length;
	assert.ok(text.includes(`${answers.SOURCE_B.slice(0, shownB)}\n[answer truncated at the output limit`));
	assert.ok(!text.includes(answers.SOURCE_B.slice(0, shownB + 1)));
	assert.match(text, /\n### c\n\n\[answer omitted; earlier answers used the output limit/);
	assert.ok(!text.includes(answers.SOURCE_C));
	assert.match(text, /Stored content is the original source pages, not the answers/);
	assert.deepEqual(result.structuredContent.urls.map(u => u.content), [answers.SOURCE_A, answers.SOURCE_B, answers.SOURCE_C]);
	assert.equal(retrieved.details.error, undefined);
	assert.match(retrieved.content[0].text, /SOURCE_A p+/);
	assert.doesNotMatch(retrieved.content[0].text, /ANSWER_/);
});

test("multi-URL answers with retrieval disabled name no retrieval call", () => {
	const { text, retrieved } = runFixture({ config: { tools: { getSearchContent: { enabled: false } } } });
	assert.ok(text.includes(answers.SOURCE_A));
	assert.match(text, /Content retrieval is not registered\.$/);
	assert.equal(retrieved, null);
});

test("multi-URL readable output keeps its listing", () => {
	const { result, text } = runFixture({ mode: "readable" });
	assert.equal(text, `## Fetched URLs\n\n${result.structuredContent.urls.map(u => `- ${u.title || u.url} (${u.content.length} chars)\n`).join("")}`
		+ `\n---\nUse get_search_content({ responseId: "${result.details.responseId}", urlIndex: 0 }) to retrieve bounded content slices.`);
});
