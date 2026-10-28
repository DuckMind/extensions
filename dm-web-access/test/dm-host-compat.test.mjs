import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader } from "@duckmind/dm-coding-agent";

const extensionPath = new URL("../index.ts", import.meta.url).pathname;
async function loadOnDm(config) {
	const agentDir = mkdtempSync(join(tmpdir(), "dm-web-host-probe-"));
	writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config));
	const previous = process.env.DM_CODING_AGENT_DIR;
	process.env.DM_CODING_AGENT_DIR = agentDir;
	try {
		const loader = new DefaultResourceLoader({
			cwd: agentDir, agentDir, noExtensions: true, noContextFiles: true,
			noSkills: true, noPromptTemplates: true, noThemes: true,
			additionalExtensionPaths: [extensionPath],
		});
		await loader.reload();
		return loader.getExtensions();
	} finally {
		if (previous === undefined) delete process.env.DM_CODING_AGENT_DIR;
		else process.env.DM_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("actual DM host registers direct web tools eagerly on dynamic configuration", async () => {
	const result = await loadOnDm({ toolActivation: "dynamic" });
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const names = [...result.extensions[0].tools.keys()];
	for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
		assert.ok(names.includes(name), `missing ${name}`);
	}
	assert.ok(!names.includes("web_enable"), "host loop snapshots tools and cannot activate mid-turn");
	assert.ok([...result.extensions[0].tools.values()].every(tool => tool.definition.exposure !== "deferred"));
});

test("actual DM host registers deferred tools for QuickJS without declaring them active", async () => {
	const result = await loadOnDm({ toolExposure: "deferred", toolActivation: "none" });
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const tools = result.extensions[0].tools;
	for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
		assert.equal(tools.get(name)?.definition.exposure, "deferred", name);
	}
	assert.ok(!tools.has("web_enable"));
});

test("actual DM host refuses deferred dynamic exposure until host snapshots update mid-turn", async () => {
	const result = await loadOnDm({ toolExposure: "deferred", toolActivation: "dynamic" });
	assert.equal(result.extensions.length, 0);
	assert.match(JSON.stringify(result.errors), /cannot activate deferred web tools/);
});
