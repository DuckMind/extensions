// applyAll: take a fully-loaded config + a fresh Discovery and call
// dm.registerProvider for each enabled builtin + each custom provider.

import type { Api } from "@duckmind/dm-ai";
import { getModels } from "@duckmind/dm-ai/compat";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@duckmind/dm-coding-agent";

import { ALLOWED_APIS, baseUrlFor, modelDefaults } from "./compat.ts";
import type { CustomProviderModelConfig, ProxyConfig } from "./config.ts";
import { resolveConfigValue } from "./config.ts";
import type { Discovery, DiscoveryCustomEntry } from "./fetch-models.ts";
import { discoveryToIdSet } from "./fetch-models.ts";
import { log } from "./log.ts";

export interface ApplyReport {
	registered: Array<{ provider: string; modelCount: number; api: Api }>;
	skipped: Array<{ provider: string; reason: string }>;
	unregistered: string[];
}

const ownedProviders = new WeakMap<ExtensionAPI, Set<string>>();
const providerGenerations = new WeakMap<ExtensionAPI, number>();

export function beginProviderRefresh(dm: ExtensionAPI): number {
	const generation = (providerGenerations.get(dm) ?? 0) + 1;
	providerGenerations.set(dm, generation);
	return generation;
}

function isCurrentProviderRefresh(
	dm: ExtensionAPI,
	generation: number | undefined,
): boolean {
	return (
		generation === undefined ||
		generation === (providerGenerations.get(dm) ?? 0)
	);
}

function reconcileOwnedProviders(
	dm: ExtensionAPI,
	nextProviders: Set<string>,
	report: ApplyReport,
): void {
	const previous = ownedProviders.get(dm) ?? new Set<string>();
	for (const name of previous) {
		if (nextProviders.has(name)) continue;
		dm.unregisterProvider(name);
		report.unregistered.push(name);
	}
	ownedProviders.set(dm, new Set(nextProviders));
}

export function unregisterOwnedProviders(dm: ExtensionAPI): string[] {
	const report: ApplyReport = { registered: [], skipped: [], unregistered: [] };
	reconcileOwnedProviders(dm, new Set(), report);
	return report.unregistered;
}

export function invalidateProviderLifecycle(dm: ExtensionAPI): string[] {
	beginProviderRefresh(dm);
	return unregisterOwnedProviders(dm);
}

export async function applyAll(
	dm: ExtensionAPI,
	cfg: ProxyConfig,
	discovery: Discovery,
	refreshGeneration?: number,
): Promise<ApplyReport> {
	const report: ApplyReport = { registered: [], skipped: [], unregistered: [] };
	if (!isCurrentProviderRefresh(dm, refreshGeneration)) {
		report.skipped.push({
			provider: "*",
			reason: "stale refresh generation",
		});
		return report;
	}
	const nextProviders = new Set<string>();
	const proxyIds = discoveryToIdSet(discovery);
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.warn(
			"proxy apiKey is empty — dm.registerProvider calls will be skipped",
		);
		reconcileOwnedProviders(dm, nextProviders, report);
		return report;
	}

	// -------- builtin providers (anthropic, openai, etc.)
	const builtinByName = new Map<
		string,
		Array<{
			id: string;
			name: string;
			reasoning: boolean;
			contextWindow: number;
			maxTokens: number;
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
		}>
	>();
	for (const p of discovery.builtinProviders) {
		builtinByName.set(
			p.name,
			p.models.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				cost: m.cost,
			})),
		);
	}

	for (const [name, p] of Object.entries(cfg.builtinProviders)) {
		if (!isCurrentProviderRefresh(dm, refreshGeneration)) return report;
		if (!p?.enabled) {
			report.skipped.push({ provider: name, reason: "disabled" });
			continue;
		}
		if (!Array.isArray(p.models) || p.models.length === 0) {
			report.skipped.push({ provider: name, reason: "empty whitelist" });
			continue;
		}
		let catalog: ReadonlyArray<{
			id: string;
			name: string;
			api: Api;
			reasoning: boolean;
			input: ("text" | "image")[];
			cost: any;
			contextWindow: number;
			maxTokens: number;
			thinkingLevelMap?: any;
		}> = [];
		try {
			catalog = getModels(name as any) as any;
		} catch {
			/* unknown provider in dm-ai catalog — keep going with proxy data */
		}
		const catalogById = new Map(catalog.map((m) => [m.id, m]));
		const proxyById = new Map(
			(builtinByName.get(name) ?? []).map((m) => [m.id, m]),
		);

		interface MergedModel {
			id: string;
			name: string;
			reasoning: boolean;
			contextWindow: number;
			maxTokens: number;
			cost: any;
			input: ("text" | "image")[];
			api: Api;
			thinkingLevelMap?: any;
		}
		const selected: MergedModel[] = [];
		for (const id of p.models) {
			if (!proxyIds.has(id)) continue;
			const c = catalogById.get(id);
			const px = proxyById.get(id);
			if (c) {
				selected.push({
					id: c.id,
					name: c.name,
					reasoning: c.reasoning,
					contextWindow: c.contextWindow,
					maxTokens: c.maxTokens,
					cost: c.cost,
					input: c.input,
					api: c.api,
					thinkingLevelMap: c.thinkingLevelMap,
				});
				continue;
			}
			if (!px) continue;
			// Catalog miss — fall back to proxy metadata. Pick API by provider name.
			const api: Api =
				name === "anthropic"
					? "anthropic-messages"
					: ((p.apiOverride as Api | undefined) ?? "openai-responses");
			selected.push({
				id: px.id,
				name: px.name,
				reasoning: px.reasoning,
				contextWindow: px.contextWindow,
				maxTokens: px.maxTokens,
				cost: px.cost,
				input: ["text"],
				api,
			});
		}
		if (selected.length === 0) {
			report.skipped.push({
				provider: name,
				reason: "no whitelisted models present on proxy",
			});
			continue;
		}
		const api: Api = (p.apiOverride ?? selected[0]!.api) as Api;
		if (!ALLOWED_APIS.has(api)) {
			report.skipped.push({
				provider: name,
				reason: `api "${api}" not in allowlist`,
			});
			continue;
		}
		const modelDefs: ProviderModelConfig[] = selected.map((m) => {
			const ov = cfg.overrides[m.id] ?? {};
			const base: ProviderModelConfig = {
				id: m.id,
				name: typeof ov.name === "string" ? ov.name : m.name,
				api,
				reasoning:
					typeof ov.reasoning === "boolean" ? ov.reasoning : m.reasoning,
				input: m.input,
				cost: ov.cost ?? m.cost,
				contextWindow:
					typeof ov.contextWindow === "number"
						? ov.contextWindow
						: m.contextWindow,
				maxTokens:
					typeof ov.maxTokens === "number" ? ov.maxTokens : m.maxTokens,
			};
			if (m.thinkingLevelMap) base.thinkingLevelMap = m.thinkingLevelMap;
			return base;
		});
		const providerConfig: ProviderConfig = {
			name,
			baseUrl: baseUrlFor(api, cfg.proxy.endpoint),
			apiKey: resolvedKey,
			authHeader: true,
			api,
			models: modelDefs,
		};
		dm.registerProvider(name, providerConfig);
		nextProviders.add(name);
		report.registered.push({
			provider: name,
			modelCount: modelDefs.length,
			api,
		});
	}

	// -------- custom providers
	const proxyCustomById = new Map<string, DiscoveryCustomEntry>(
		discovery.customPool.map((m) => [m.id, m]),
	);
	for (const [name, c] of Object.entries(cfg.customProviders)) {
		if (!isCurrentProviderRefresh(dm, refreshGeneration)) return report;
		if (!ALLOWED_APIS.has(c.api)) {
			report.skipped.push({
				provider: name,
				reason: `api "${c.api}" not in allowlist`,
			});
			continue;
		}
		const present: CustomProviderModelConfig[] = c.models.filter((m) =>
			proxyIds.has(m.id),
		);
		if (present.length === 0) {
			report.skipped.push({
				provider: name,
				reason: "no configured models present on proxy",
			});
			continue;
		}
		const modelDefs: ProviderModelConfig[] = present.map((m) => {
			const fromPool = proxyCustomById.get(m.id);
			const base = modelDefaults(m.id);
			const ov = cfg.overrides[m.id] ?? {};
			return {
				id: m.id,
				name: m.name ?? fromPool?.name ?? base.name ?? m.id,
				api: c.api,
				reasoning:
					pickBool(
						m.reasoning,
						fromPool?.reasoning,
						base.reasoning,
						ov.reasoning,
					) ?? false,
				input: ["text"],
				cost: m.cost ??
					fromPool?.cost ??
					base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow:
					pickNum(
						m.contextWindow,
						fromPool?.contextWindow,
						base.contextWindow,
						ov.contextWindow,
					) ?? 128000,
				maxTokens:
					pickNum(
						m.maxTokens,
						fromPool?.maxTokens,
						base.maxTokens,
						ov.maxTokens,
					) ?? 16000,
			};
		});
		const providerConfig: ProviderConfig = {
			name,
			baseUrl: baseUrlFor(c.api, cfg.proxy.endpoint),
			apiKey: resolvedKey,
			authHeader: true,
			api: c.api,
			models: modelDefs,
		};
		dm.registerProvider(name, providerConfig);
		nextProviders.add(name);
		report.registered.push({
			provider: name,
			modelCount: modelDefs.length,
			api: c.api,
		});
	}

	if (isCurrentProviderRefresh(dm, refreshGeneration)) {
		reconcileOwnedProviders(dm, nextProviders, report);
	}
	log.debug(
		`applyAll: registered ${report.registered.length} providers, skipped ${report.skipped.length}, unregistered ${report.unregistered.length}`,
	);
	return report;
}

function pickNum(...vals: Array<number | undefined>): number | undefined {
	for (const v of vals) if (typeof v === "number") return v;
	return undefined;
}
function pickBool(...vals: Array<boolean | undefined>): boolean | undefined {
	for (const v of vals) if (typeof v === "boolean") return v;
	return undefined;
}
