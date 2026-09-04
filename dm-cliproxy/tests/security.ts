import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	readDiscoveryCache,
	discoveryCacheScope,
	writeDiscoveryCache,
} from "../src/cache.ts";
import {
	ensurePrivateDirectory,
	ensurePrivateFile,
	resolveConfigValue,
	saveConfigAtPath,
} from "../src/config.ts";
import {
	readUsageCache,
	releaseUsageLock,
	tryAcquireUsageLock,
	usageCachePaths,
	writeUsageCache,
} from "../src/usage-shared-cache.ts";
import {
	buildStepOverlay,
	resolveWizardValue,
	type WizardStep,
} from "../src/ui-setup.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;
const root = mkdtempSync(join(tmpdir(), "dm-cliproxy-security-"));

try {
	const secretStep: WizardStep = {
		label: "apiKey",
		hint: "secret",
		required: true,
		secret: true,
	};
	let submitted: string | undefined;
	const overlay = buildStepOverlay(
		{ requestRender() {} },
		{
			fg(_name, value) {
				return value;
			},
			bold(value) {
				return value;
			},
		},
		secretStep,
		"",
		(value) => {
			submitted = value;
		},
	);
	const token = "SECRET_TOKEN_123";
	overlay.handleInput(token);
	const rendered = overlay.render(80).join("\n");
	assert.equal(rendered.includes(token), false);
	assert.equal(rendered.includes("•".repeat(token.length)), true);
	overlay.handleInput("\r");
	assert.equal(submitted, token);

	assert.equal(resolveWizardValue(secretStep, "$EXISTING_KEY", ""), "$EXISTING_KEY");
	assert.equal(resolveWizardValue(secretStep, "", ""), null);
	assert.equal(
		resolveWizardValue(
			{ ...secretStep, label: "usageKey", required: false },
			"$EXISTING_USAGE_KEY",
			"-",
		),
		"",
	);

	const warnings: unknown[][] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args);
	try {
		assert.equal(
			resolveConfigValue(
				`!${process.execPath} -e "process.stderr.write('${token}');process.exit(7)"`,
			),
			"",
		);
	} finally {
		console.warn = originalWarn;
	}
	const warningText = JSON.stringify(warnings);
	assert.equal(warningText.includes(token), false);
	assert.match(warningText, /failed to resolve/);

	const privateDir = join(root, "private");
	mkdirSync(privateDir, { mode: 0o755 });
	ensurePrivateDirectory(privateDir);
	assert.equal(mode(privateDir), 0o700);
	const privateFile = join(privateDir, "secret.json");
	writeFileSync(privateFile, "{}");
	chmodSync(privateFile, 0o644);
	ensurePrivateFile(privateFile);
	assert.equal(mode(privateFile), 0o600);
	const atomicConfigPath = join(root, "atomic", "config.json");
	saveConfigAtPath(
		{
			proxy: { endpoint: "http://127.0.0.1:8317/v1", apiKey: "$KEY" },
			builtinProviders: {},
			customProviders: {},
			discoveryExcludes: [],
			overrides: {},
			refreshIntervalMinutes: 0,
			usageCacheTtlMs: 30_000,
		},
		atomicConfigPath,
	);
	assert.equal(mode(atomicConfigPath), 0o600);

	const discoveryPath = join(root, "cache", "discovery.json");
	mkdirSync(dirname(discoveryPath), { recursive: true, mode: 0o755 });
	writeFileSync(
		discoveryPath,
		JSON.stringify({
			savedAt: Date.now(),
			scope: "scope-a",
			discovery: {
				source: "v1-models",
				upstreamVersion: null,
				builtinProviders: [],
				customPool: [],
				serverDiscoveryExcludes: [],
				upstreamTotal: 0,
			},
		}),
	);
	chmodSync(discoveryPath, 0o644);
	assert.ok(readDiscoveryCache("scope-a", discoveryPath));
	assert.equal(readDiscoveryCache("scope-b", discoveryPath), null);
	assert.equal(mode(dirname(discoveryPath)), 0o700);
	assert.equal(mode(discoveryPath), 0o600);
	chmodSync(discoveryPath, 0o644);
	writeDiscoveryCache(
		{
			source: "v1-models",
			upstreamVersion: null,
			builtinProviders: [],
			customPool: [],
			serverDiscoveryExcludes: [],
			upstreamTotal: 0,
		},
		"scope-a",
		discoveryPath,
	);
	assert.equal(mode(discoveryPath), 0o600);
	assert.notEqual(
		discoveryCacheScope("https://one.example/v1", "key"),
		discoveryCacheScope("https://two.example/v1", "key"),
	);

	const usagePath = join(root, "usage", "cache.json");
	mkdirSync(dirname(usagePath), { recursive: true, mode: 0o755 });
	writeFileSync(
		usagePath,
		JSON.stringify({ fetchedAt: Date.now(), doc: { accounts: [] } }),
	);
	chmodSync(usagePath, 0o644);
	assert.ok(readUsageCache(usagePath));
	assert.equal(mode(dirname(usagePath)), 0o700);
	assert.equal(mode(usagePath), 0o600);
	chmodSync(usagePath, 0o644);
	writeUsageCache({ accounts: [] } as any, usagePath);
	assert.equal(mode(usagePath), 0o600);

	const lockPath = join(root, "usage", "cache.lock");
	const lockToken = tryAcquireUsageLock(lockPath);
	assert.ok(lockToken);
	assert.equal(mode(lockPath), 0o600);
	assert.equal(releaseUsageLock(lockToken!, lockPath), true);
	assert.notDeepEqual(
		usageCachePaths("https://one.example/v1", "usage", root),
		usageCachePaths("https://one.example/v1", "other-usage", root),
	);

	console.log("dm-cliproxy security: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
