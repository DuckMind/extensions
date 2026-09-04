import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const fixtureModels = Array.from({ length: 21 }, (_, index) => ({
	id: `test-model-${index + 1}`,
	owned_by: "test",
}));
const temporaryHome = mkdtempSync(join(tmpdir(), "dm-cliproxy-smoke-"));

try {
	const configDir = join(temporaryHome, ".dm", "agent", "dm-cliproxy");
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			proxy: {
				endpoint: "https://proxy.example/v1",
				apiKey: "test-key",
			},
			builtinProviders: {},
			customProviders: {
				"test-proxy": {
					api: "openai-completions",
					models: fixtureModels.map(({ id }) => ({ id })),
				},
			},
			discoveryExcludes: [],
			overrides: {},
			refreshIntervalMinutes: 0,
			usageCacheTtlMs: 30_000,
		}) + "\n",
		{ mode: 0o600 },
	);

	const environment = { ...process.env, HOME: temporaryHome };
	delete environment.DM_CLIPROXY_DEBUG;
	delete environment.PI_CLIPROXYAPI_DEBUG;
	const fixture = join(process.cwd(), "tests", "quiet-startup-fixture.ts");
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", fixture],
		{ cwd: process.cwd(), encoding: "utf8", env: environment },
	);
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const evidence = JSON.parse(result.stdout) as {
		requests: string[];
		registered: Array<{ name: string; api?: string; modelCount?: number }>;
		commands: string[];
		startupLogs: unknown[][];
	};
	assert.deepEqual(evidence.requests, [
		"https://proxy.example/.well-known/pi",
		"https://proxy.example/v1/models",
	]);
	assert.deepEqual(evidence.registered, [
		{ name: "test-proxy", api: "openai-completions", modelCount: 21 },
	]);
	assert.deepEqual(evidence.commands, ["cliproxy", "cliproxy-setup"]);
	assert.deepEqual(evidence.startupLogs, []);
} finally {
	rmSync(temporaryHome, { recursive: true, force: true });
}

console.log("dm-cliproxy smoke: ok");
