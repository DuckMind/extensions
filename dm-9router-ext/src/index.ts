import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@duckmind/dm-coding-agent";
import { Type } from "typebox";

export interface NineRouterConfig {
	baseUrl: string;
	apiKey: string | undefined;
}

export interface NineRouterModel {
	id: string;
	object: string;
	owned_by?: string;
	kind?: string;
}

interface DiskConfigSnapshot {
	existed: boolean;
	contents?: Buffer;
	mode?: number;
}

interface PreparedConfigWrite {
	tempPath: string;
	snapshot: DiskConfigSnapshot;
}

const DEFAULT_BASE_URL = "http://localhost:20128";
const ENV_BASE_URL = process.env.NINE_ROUTER_BASE_URL;
const ENV_API_KEY = process.env.NINE_ROUTER_API_KEY;
const CONFIG_PATH = join(homedir(), ".dm", "agent", "9router-config.json");
const CUSTOM_TYPE_CONFIG = "9router-config";
const CUSTOM_TYPE_LAST_ROUTE = "9router-last-route";
const ROUTING_HEADERS = [
	"x-9router-model",
	"x-routed-model",
	"x-actual-model",
	"x-upstream-model",
	"x-provider-model",
];

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function applyEnvOverrides(config: NineRouterConfig): NineRouterConfig {
	return {
		baseUrl: normalizeBaseUrl(ENV_BASE_URL || config.baseUrl),
		apiKey: ENV_API_KEY || config.apiKey,
	};
}

function loadConfigFromDisk(): NineRouterConfig | null {
	try {
		if (!existsSync(CONFIG_PATH)) return null;
		const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<NineRouterConfig>;
		if (typeof data.baseUrl !== "string" || !data.baseUrl.trim()) return null;
		return {
			baseUrl: normalizeBaseUrl(data.baseUrl.trim()),
			apiKey:
				typeof data.apiKey === "string" && data.apiKey.trim()
					? data.apiKey.trim()
					: undefined,
			};
	} catch {
		console.error("[dm-9router-ext] Failed to load persisted config");
		return null;
	}
}

function serializeConfig(config: NineRouterConfig): Buffer {
	const persisted: { baseUrl: string; apiKey?: string } = {
		baseUrl: config.baseUrl,
	};
	if (config.apiKey) persisted.apiKey = config.apiKey;
	return Buffer.from(`${JSON.stringify(persisted, null, 2)}\n`);
}

function captureDiskConfigSnapshot(): DiskConfigSnapshot {
	if (!existsSync(CONFIG_PATH)) return { existed: false };
	const stat = statSync(CONFIG_PATH);
	return {
		existed: true,
		contents: readFileSync(CONFIG_PATH),
		mode: stat.mode & 0o777,
	};
}

function writeConfigTemp(contents: Buffer, mode = 0o600): string {
	const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${randomUUID()}`;
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
		writeFileSync(tempPath, contents, { flag: "wx", mode });
		chmodSync(tempPath, mode);
		return tempPath;
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function prepareConfigWrite(config: NineRouterConfig): PreparedConfigWrite {
	const snapshot = captureDiskConfigSnapshot();
	return {
		tempPath: writeConfigTemp(serializeConfig(config)),
		snapshot,
	};
}

function commitPreparedConfig(prepared: PreparedConfigWrite): void {
	renameSync(prepared.tempPath, CONFIG_PATH);
	chmodSync(CONFIG_PATH, 0o600);
}

function restoreDiskSnapshot(snapshot: DiskConfigSnapshot): void {
	if (!snapshot.existed) {
		rmSync(CONFIG_PATH, { force: true });
		return;
	}
	const tempPath = writeConfigTemp(snapshot.contents ?? Buffer.alloc(0), snapshot.mode ?? 0o600);
	renameSync(tempPath, CONFIG_PATH);
	chmodSync(CONFIG_PATH, snapshot.mode ?? 0o600);
}

function loadConfigFromSession(ctx: ExtensionContext): NineRouterConfig | null {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getBranch?: () => ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
	};
	const entries =
		typeof sessionManager.getBranch === "function"
			? sessionManager.getBranch()
			: sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE_CONFIG) continue;
		const data = entry.data as Partial<NineRouterConfig> | undefined;
		if (typeof data?.baseUrl !== "string" || !data.baseUrl.trim()) continue;
		return {
			baseUrl: normalizeBaseUrl(data.baseUrl.trim()),
			apiKey: undefined,
		};
	}
	return null;
}

export async function fetchModels(
	config: NineRouterConfig,
	signal?: AbortSignal,
): Promise<NineRouterModel[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
	const response = await fetch(`${config.baseUrl}/v1/models`, {
		method: "GET",
		headers,
		signal,
	});
	if (!response.ok) {
		throw new Error(
			`9router returned ${response.status}: ${response.statusText}`,
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("9router returned invalid model metadata");
	}
	if (
		typeof payload !== "object" ||
		payload === null ||
		!Array.isArray((payload as { data?: unknown }).data) ||
		(payload as { data: unknown[] }).data.some(
			(model) =>
				typeof model !== "object" ||
				model === null ||
				typeof (model as { id?: unknown }).id !== "string" ||
				!(model as { id: string }).id.trim(),
		)
	) {
		throw new Error("9router returned invalid model metadata");
	}
	return (payload as { data: NineRouterModel[] }).data;
}

async function testConnection(
	config: NineRouterConfig,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
	try {
		await fetchModels(config, signal);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function mapNineRouterModel(model: NineRouterModel) {
	return {
		id: model.id,
		name: model.owned_by === "combo" ? `🔀 ${model.id}` : model.id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
	};
}

function registerNineRouterProvider(
	dm: ExtensionAPI,
	config: NineRouterConfig,
	models: NineRouterModel[],
): void {
	dm.registerProvider("9router", {
		name: "9router",
		baseUrl: `${config.baseUrl}/v1`,
		apiKey: config.apiKey || "9router-no-api-key",
		api: "openai-completions",
		models: models.map(mapNineRouterModel),
	});
}

function unregisterNineRouterProvider(dm: ExtensionAPI): void {
	dm.unregisterProvider("9router");
}

export default async function dm9router(dm: ExtensionAPI): Promise<void> {
	const diskConfig = loadConfigFromDisk();
	let persistedConfig = diskConfig || {
		baseUrl: DEFAULT_BASE_URL,
		apiKey: undefined,
	};
	let hasPersistedConfig = diskConfig !== null;
	let config = applyEnvOverrides(persistedConfig);
	let discoveredModels: NineRouterModel[] = [];
	let lastRoutedModel: string | undefined;
	let activeProvider: string | undefined;
	let isConnected = false;

	const snapshotRuntime = () => ({
		persistedConfig,
		hasPersistedConfig,
		config,
		discoveredModels,
		isConnected,
	});

	const restoreProviderSnapshot = (snapshot: ReturnType<typeof snapshotRuntime>): void => {
		try {
			if (snapshot.isConnected) {
				registerNineRouterProvider(dm, snapshot.config, snapshot.discoveredModels);
			} else {
				unregisterNineRouterProvider(dm);
			}
		} catch {
			console.error("[dm-9router-ext] Failed to restore the previous provider snapshot");
		}
	};

	const commitConfigTransaction = (
		nextPersistedConfig: NineRouterConfig,
		nextConfig: NineRouterConfig,
		nextModels: NineRouterModel[],
		appendSessionEntry: boolean,
	): void => {
		const previous = snapshotRuntime();
		let prepared: PreparedConfigWrite | undefined;
		let providerTouched = false;
		let diskTouched = false;
		try {
			prepared = prepareConfigWrite(nextPersistedConfig);
			providerTouched = true;
			registerNineRouterProvider(dm, nextConfig, nextModels);
			diskTouched = true;
			commitPreparedConfig(prepared);
			if (appendSessionEntry) {
				dm.appendEntry(CUSTOM_TYPE_CONFIG, {
					baseUrl: nextPersistedConfig.baseUrl,
				});
			}
			persistedConfig = nextPersistedConfig;
			hasPersistedConfig = true;
			config = nextConfig;
			discoveredModels = nextModels;
			isConnected = true;
		} catch {
			if (prepared) rmSync(prepared.tempPath, { force: true });
			if (diskTouched && prepared) {
				try {
					restoreDiskSnapshot(prepared.snapshot);
				} catch {
					console.error("[dm-9router-ext] Failed to restore the previous config file");
				}
			}
			if (providerTouched) restoreProviderSnapshot(previous);
			throw new Error("9router configuration update failed; previous configuration remains active");
		}
	};

	try {
		discoveredModels = await fetchModels(config, AbortSignal.timeout(1500));
		isConnected = true;
		registerNineRouterProvider(dm, config, discoveredModels);
	} catch {
		unregisterNineRouterProvider(dm);
	}

	dm.on("session_start", async (_event, ctx) => {
		const restored = loadConfigFromSession(ctx);
		if (!hasPersistedConfig && restored) {
			const restoredConfig = applyEnvOverrides(restored);
			try {
				const nextModels = await fetchModels(restoredConfig, ctx.signal);
				commitConfigTransaction(restored, restoredConfig, nextModels, false);
			} catch {}
		}
		if (isConnected && discoveredModels.length > 0) {
			ctx.ui.notify(
				`9router connected — ${discoveredModels.length} models available`,
				"info",
			);
		}
	});

	dm.on("after_provider_response", (event) => {
		if (event.status >= 400 || activeProvider !== "9router") return;
		for (const header of ROUTING_HEADERS) {
			const value = event.headers[header];
			if (!value || typeof value !== "string") continue;
			lastRoutedModel = value;
			dm.appendEntry(CUSTOM_TYPE_LAST_ROUTE, {
				model: value,
				timestamp: Date.now(),
			});
			break;
		}
	});

	dm.on("model_select", async (event) => {
		activeProvider = event.model.provider;
		if (activeProvider !== "9router") lastRoutedModel = undefined;
	});

	dm.registerCommand("9router-status", {
		description: "Show 9router connection status and configuration",
		handler: async (_args, ctx) => {
			const test = await testConnection(config, ctx.signal);
			const lines = [
				"🔗 9router Status",
				"",
				`Base URL:    ${config.baseUrl}`,
				`API Key:     ${config.apiKey ? "set" : "not set"}`,
				`Connection:  ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
				`Models:      ${discoveredModels.length} available`,
			];
			if (lastRoutedModel) lines.push(`Last routed: ${lastRoutedModel}`);
			ctx.ui.notify(lines.join("\n"), test.ok ? "info" : "warning");
		},
	});

	dm.registerCommand("9router-models", {
		description: "Browse 9router available models and combos",
		handler: async (_args, ctx) => {
			if (discoveredModels.length === 0) {
				ctx.ui.notify(
					"No 9router models discovered. Check connection with /9router-status",
					"warning",
				);
				return;
			}
			const items = discoveredModels.map((model) => ({
				value: model.id,
				label: model.owned_by === "combo" ? `🔀 ${model.id}` : model.id,
			}));
			const selected = await ctx.ui.select(
				"Select a 9router model to use:",
				items.map((item) => item.label),
			);
			const modelId = items.find((item) => item.label === selected)?.value;
			if (!modelId) return;
			dm.sendUserMessage(`/model 9router/${modelId}`, { deliverAs: "followUp" });
		},
	});

	dm.registerCommand("9router-config", {
		description: "Configure 9router base URL and API key",
		handler: async (_args, ctx) => {
			const test = await testConnection(config, ctx.signal);
			ctx.ui.notify(
				[
					"Current config:",
					`  Base URL:  ${config.baseUrl}`,
					`  API Key:   ${config.apiKey ? "set" : "not set"}`,
					`  Status:    ${test.ok ? "🟢 connected" : "🔴 disconnected"}`,
					"",
					"Enter new values. Blank keeps the current value.",
				].join("\n"),
				"info",
			);
			const newBaseUrl = await ctx.ui.input("Base URL", config.baseUrl);
			if (newBaseUrl === undefined) return;
			const newApiKey = await ctx.ui.input(
				"API key (blank keeps current, '-' clears):",
				"",
			);
			if (newApiKey === undefined) return;
			const nextPersistedConfig = {
				baseUrl: normalizeBaseUrl(
					newBaseUrl.trim() || persistedConfig.baseUrl,
				),
				apiKey:
					newApiKey.trim() === ""
						? persistedConfig.apiKey
						: newApiKey.trim() === "-"
							? undefined
							: newApiKey.trim(),
			};
			const nextConfig = applyEnvOverrides(nextPersistedConfig);
			try {
				const nextModels = await fetchModels(nextConfig, ctx.signal);
				commitConfigTransaction(nextPersistedConfig, nextConfig, nextModels, true);
				ctx.ui.notify(
					`9router updated — ${discoveredModels.length} models at ${config.baseUrl}`,
					"info",
				);
			} catch {
				ctx.ui.notify(
					"9router update failed; the previous configuration remains active",
					"error",
				);
			}
		},
	});

	dm.registerCommand("9router-reload", {
		description: "Reload models from 9router",
		handler: async (_args, ctx) => {
			const previous = snapshotRuntime();
			let providerTouched = false;
			try {
				const nextModels = await fetchModels(config, ctx.signal);
				providerTouched = true;
				registerNineRouterProvider(dm, config, nextModels);
				discoveredModels = nextModels;
				isConnected = true;
				ctx.ui.notify(
					`9router reloaded — ${discoveredModels.length} models`,
					"info",
				);
			} catch {
				if (providerTouched) restoreProviderSnapshot(previous);
				ctx.ui.notify(
					"9router reload failed; the previous provider and model list remain active",
					"error",
				);
			}
		},
	});

	dm.registerTool({
		name: "ninerouter_status",
		label: "9router Status",
		description: "Check 9router connection status and list available models",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const test = await testConnection(config, ctx.signal);
			const combos = discoveredModels.filter((model) => model.owned_by === "combo");
			return {
				content: [
					{
						type: "text",
						text: [
							`9router: ${test.ok ? "connected" : `disconnected (${test.error})`}`,
							`Base URL: ${config.baseUrl}`,
							`Total models: ${discoveredModels.length}`,
							`  Regular: ${discoveredModels.length - combos.length}`,
							`  Combos:  ${combos.length}`,
							lastRoutedModel ? `Last routed model: ${lastRoutedModel}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					connected: test.ok,
					baseUrl: config.baseUrl,
					modelCount: discoveredModels.length,
					comboCount: combos.length,
					lastRoutedModel,
					models: discoveredModels.map((model) => model.id),
				},
			};
		},
	});
}
