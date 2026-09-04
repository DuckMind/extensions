import assert from "node:assert/strict";

import {
	applyAll,
	beginProviderRefresh,
	invalidateProviderLifecycle,
} from "../src/apply.ts";
import type { ProxyConfig } from "../src/config.ts";
import type { Discovery } from "../src/fetch-models.ts";
import { registerQuotaHooks } from "../index.ts";

const registered: string[] = [];
const unregistered: string[] = [];
const dmProviderMock = {
	registerProvider(name: string): void {
		registered.push(name);
	},
	unregisterProvider(name: string): void {
		unregistered.push(name);
	},
};
const cfg: ProxyConfig = {
	proxy: {
		endpoint: "http://127.0.0.1:8317/v1",
		apiKey: "test-key",
		usageKey: "usage-one",
	},
	builtinProviders: {},
	customProviders: {
		"corp-glm": {
			api: "openai-completions",
			models: [{ id: "glm-test" }],
		},
	},
	discoveryExcludes: [],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 30_000,
};
const discovery: Discovery = {
	source: "v1-models",
	upstreamVersion: null,
	builtinProviders: [],
	customPool: [
		{
			id: "glm-test",
			name: "GLM Test",
			api: "openai-completions",
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 16_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			suggestedProvider: "corp-glm",
			ownedBy: "test",
		},
	],
	serverDiscoveryExcludes: [],
	upstreamTotal: 1,
};

const first = await applyAll(dmProviderMock as any, cfg, discovery);
assert.deepEqual(first.registered.map((entry) => entry.provider), ["corp-glm"]);
assert.deepEqual(first.unregistered, []);

const disabled = structuredClone(cfg);
disabled.customProviders = {};
const second = await applyAll(dmProviderMock as any, disabled, discovery);
assert.deepEqual(second.unregistered, ["corp-glm"]);
assert.deepEqual(unregistered, ["corp-glm"]);

await applyAll(dmProviderMock as any, cfg, discovery);
const noKey = structuredClone(cfg);
noKey.proxy.apiKey = "";
const third = await applyAll(dmProviderMock as any, noKey, discovery);
assert.deepEqual(third.unregistered, ["corp-glm"]);
assert.deepEqual(unregistered, ["corp-glm", "corp-glm"]);

const currentGeneration = beginProviderRefresh(dmProviderMock as any);
const staleGeneration = currentGeneration - 1;
const stale = await applyAll(
	dmProviderMock as any,
	cfg,
	discovery,
	staleGeneration,
);
assert.equal(stale.registered.length, 0);
await applyAll(dmProviderMock as any, cfg, discovery, currentGeneration);
assert.deepEqual(invalidateProviderLifecycle(dmProviderMock as any), ["corp-glm"]);

type Handler = (_event: unknown, ctx: any) => Promise<void>;
const handlers = new Map<string, Handler>();
const dmHookMock = {
	on(event: string, handler: Handler): void {
		handlers.set(event, handler);
	},
};
let currentCfg = structuredClone(cfg);
let now = 10_000;
const seen: Array<{ key: string; readOnly: boolean }> = [];
const statusWrites: string[] = [];
let releaseFirstRefresh: (() => void) | undefined;
let refreshCount = 0;
registerQuotaHooks(dmHookMock as any, {
	loadConfig: () => structuredClone(currentCfg),
	resolveConfigValue: (raw) => raw ?? "",
	refreshQuotaStatus: async (_current, key, ui, model, opts) => {
		refreshCount++;
		if (refreshCount === 1) {
			await new Promise<void>((resolve) => {
				releaseFirstRefresh = resolve;
			});
		}
		seen.push({ key, readOnly: Boolean(opts.readOnly) });
		ui.setStatus("0quota", `${model?.provider}:${key}`);
	},
	now: () => now,
});

const ctx = {
	hasUI: true,
	ui: {
		theme: { fg: (_color: string, value: string) => value },
		setStatus(_key: string, value: string | undefined) {
			if (value) statusWrites.push(value);
		},
	},
	model: { provider: "openai" },
};
const firstQuotaRefresh = handlers.get("session_start")!({}, ctx);
currentCfg.proxy.usageKey = "usage-two";
await handlers.get("model_select")!({}, {
	...ctx,
	model: { provider: "anthropic" },
});
releaseFirstRefresh!();
await firstQuotaRefresh;
delete currentCfg.proxy.usageKey;
now += 1_000;
await handlers.get("turn_end")!({}, ctx);

assert.deepEqual(seen, [
	{ key: "usage-two", readOnly: true },
	{ key: "usage-one", readOnly: false },
	{ key: "", readOnly: false },
]);
assert.deepEqual(statusWrites, ["anthropic:usage-two", "openai:"]);
assert.deepEqual(registered, ["corp-glm", "corp-glm", "corp-glm"]);
console.log("dm-cliproxy state: ok");
