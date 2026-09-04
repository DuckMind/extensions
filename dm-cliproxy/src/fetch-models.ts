// Discovery:
//   1. GET <host>/.well-known/pi with User-Agent: dm-cliproxy/<ver>
//      → returns the server contract document (see PLAN.md).
//   2. On 404 / 5xx / non-JSON / network error → fall back to:
//      GET <endpoint>/v1/models with Authorization: Bearer <apiKey>
//      → classify locally via compat.ts.
//
// fetchDiscovery() returns a normalized in-memory model. Callers shouldn't
// know which path was used (except for logging).

import type { Api } from "@duckmind/dm-ai";

import {
	classifyCustom,
	isExcluded,
	modelDefaults,
	normalizeSuggestedProvider,
	reasoningFromId,
} from "./compat.ts";
import { discoveryCacheScope, writeDiscoveryCache } from "./cache.ts";
import type { ProxyConfig } from "./config.ts";
import { log } from "./log.ts";

export const PLUGIN_USER_AGENT = "dm-cliproxy/0.3.5";
const REQUEST_TIMEOUT_MS = 5_000;

export interface DiscoveryModelEntry {
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
}

export interface DiscoveryBuiltinProvider {
	/** "openai" or "anthropic" — name of the DM built-in provider. */
	name: string;
	api: Api;
	/** Models from upstream that map to this built-in provider. */
	models: DiscoveryModelEntry[];
}

export interface DiscoveryCustomEntry extends DiscoveryModelEntry {
	api: Api;
	/** Suggested custom provider slug (e.g. "myproxy-glm"). */
	suggestedProvider: string;
	/** Raw upstream owned_by, for diagnostics. */
	ownedBy: string;
}

export interface Discovery {
	source: "well-known" | "v1-models";
	upstreamVersion: string | null;
	builtinProviders: DiscoveryBuiltinProvider[];
	customPool: DiscoveryCustomEntry[];
	serverDiscoveryExcludes: string[];
	/** Total ids seen before any filtering. */
	upstreamTotal: number;
}

interface RawUpstreamModel {
	id: string;
	owned_by: string;
}

// --------------------------------------------------------------------------- HTTP

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(
		() => ctrl.abort(new Error("timeout")),
		REQUEST_TIMEOUT_MS,
	);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

function discoveryUrl(endpoint: string): string {
	return new URL("/.well-known/pi", new URL(endpoint).origin).toString();
}

// --------------------------------------------------------------------------- well-known path

async function tryWellKnown(cfg: ProxyConfig): Promise<Discovery | null> {
	const url = discoveryUrl(cfg.proxy.endpoint);
	let resp: Response;
	try {
		resp = await fetchWithTimeout(url, {
			headers: { "User-Agent": PLUGIN_USER_AGENT, Accept: "application/json" },
		});
	} catch (err) {
		log.debug(
			"well-known fetch failed:",
			(err as Error).message,
			"— falling back to /v1/models",
		);
		return null;
	}
	if (!resp.ok) {
		log.debug(`well-known returned ${resp.status} — falling back to /v1/models`);
		return null;
	}
	let body: any;
	try {
		body = await resp.json();
	} catch {
		log.debug("well-known returned non-JSON — falling back to /v1/models");
		return null;
	}
	if (!body || body.schemaVersion !== 1) {
		log.debug("well-known schemaVersion != 1 — falling back to /v1/models");
		return null;
	}

	const builtin: DiscoveryBuiltinProvider[] = [];
	const builtinProviders = (body.builtinProviders ?? {}) as Record<string, any>;
	for (const [name, p] of Object.entries(builtinProviders)) {
		if (!p || !Array.isArray(p.models)) continue;
		const models: DiscoveryModelEntry[] = p.models.map(
			(m: any): DiscoveryModelEntry => ({
				id: String(m.id),
				name: typeof m.name === "string" ? m.name : String(m.id),
				reasoning: Boolean(m.reasoning ?? reasoningFromId(String(m.id))),
				contextWindow:
					typeof m.contextWindow === "number" ? m.contextWindow : 200_000,
				maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : 16_000,
				cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		builtin.push({ name, api: (p.api as Api) ?? "openai-responses", models });
	}

	const customPool: DiscoveryCustomEntry[] = (
		Array.isArray(body.customModelPool) ? body.customModelPool : []
	).map(
		(m: any): DiscoveryCustomEntry => ({
			id: String(m.id),
			name: typeof m.name === "string" ? m.name : String(m.id),
			reasoning: Boolean(m.reasoning ?? reasoningFromId(String(m.id))),
			contextWindow:
				typeof m.contextWindow === "number" ? m.contextWindow : 128_000,
			maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : 16_000,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			api: (m.api as Api) ?? "openai-completions",
			suggestedProvider: normalizeSuggestedProvider(
				typeof m.suggestedProviderName === "string"
					? m.suggestedProviderName
					: "misc",
				cfg.proxy.providerPrefix,
			),
			ownedBy: typeof m.owned_by === "string" ? m.owned_by : "",
		}),
	);

	return {
		source: "well-known",
		upstreamVersion:
			typeof body?.upstream?.upstreamVersion === "string"
				? body.upstream.upstreamVersion
				: null,
		builtinProviders: builtin,
		customPool,
		serverDiscoveryExcludes: Array.isArray(body.discoveryExcludes)
			? body.discoveryExcludes.filter(
					(s: unknown): s is string => typeof s === "string",
				)
			: [],
		upstreamTotal:
			typeof body?.counts?.upstreamTotal === "number"
				? body.counts.upstreamTotal
				: 0,
	};
}

// --------------------------------------------------------------------------- /v1/models path

async function fetchRawModels(
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<RawUpstreamModel[]> {
	const url = new URL(
		"/v1/models",
		new URL(cfg.proxy.endpoint).origin,
	).toString();
	const resp = await fetchWithTimeout(url, {
		headers: {
			Authorization: `Bearer ${resolvedKey}`,
			Accept: "application/json",
			"User-Agent": PLUGIN_USER_AGENT,
		},
	});
	if (!resp.ok) {
		throw new Error(`/v1/models returned ${resp.status}`);
	}
	const body = (await resp.json()) as {
		data?: Array<{ id?: unknown; owned_by?: unknown }>;
	};
	if (!body?.data || !Array.isArray(body.data)) return [];
	return body.data
		.map((m) => ({
			id: typeof m.id === "string" ? m.id : "",
			owned_by: typeof m.owned_by === "string" ? m.owned_by : "",
		}))
		.filter((m) => m.id);
}

function classifyLocally(raw: RawUpstreamModel[], cfg: ProxyConfig): Discovery {
	const excludes = cfg.discoveryExcludes;
	const builtinByName = new Map<string, DiscoveryBuiltinProvider>();
	const customPool: DiscoveryCustomEntry[] = [];
	let upstreamTotal = 0;

	for (const m of raw) {
		upstreamTotal++;
		if (isExcluded(m.id, excludes)) continue;

		if (m.owned_by === "openai") {
			const entry = modelDefaults(m.id);
			pushBuiltin(
				builtinByName,
				"openai",
				"openai-responses",
				entryToDiscovery(entry),
			);
			continue;
		}
		if (m.owned_by === "anthropic") {
			const entry = modelDefaults(m.id);
			pushBuiltin(
				builtinByName,
				"anthropic",
				"anthropic-messages",
				entryToDiscovery(entry),
			);
			continue;
		}
		const { slug, api } = classifyCustom(m.owned_by, cfg.proxy.providerPrefix);
		const base = modelDefaults(m.id);
		customPool.push({
			id: m.id,
			name: base.name ?? m.id,
			reasoning: base.reasoning ?? false,
			contextWindow: base.contextWindow ?? 128_000,
			maxTokens: base.maxTokens ?? 16_000,
			cost: base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			api,
			suggestedProvider: slug,
			ownedBy: m.owned_by,
		});
	}

	return {
		source: "v1-models",
		upstreamVersion: null,
		builtinProviders: Array.from(builtinByName.values()),
		customPool,
		serverDiscoveryExcludes: [],
		upstreamTotal,
	};
}

function pushBuiltin(
	map: Map<string, DiscoveryBuiltinProvider>,
	name: string,
	api: Api,
	entry: DiscoveryModelEntry,
): void {
	let p = map.get(name);
	if (!p) {
		p = { name, api, models: [] };
		map.set(name, p);
	}
	p.models.push(entry);
}

function entryToDiscovery(
	base: ReturnType<typeof modelDefaults>,
): DiscoveryModelEntry {
	return {
		id: base.id,
		name: base.name ?? base.id,
		reasoning: base.reasoning ?? false,
		contextWindow: base.contextWindow ?? 128_000,
		maxTokens: base.maxTokens ?? 16_000,
		cost: base.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// --------------------------------------------------------------------------- public

export async function fetchDiscovery(
	cfg: ProxyConfig,
	resolvedKey: string,
): Promise<Discovery> {
	const cacheScope = discoveryCacheScope(cfg.proxy.endpoint, resolvedKey);
	const wk = await tryWellKnown(cfg);
	if (wk) {
		log.debug(
			`discovery via /.well-known/pi: ${wk.builtinProviders.length} builtin, ${wk.customPool.length} custom`,
		);
		writeDiscoveryCache(wk, cacheScope);
		return wk;
	}
	if (!resolvedKey) {
		throw new Error(
			"well-known unavailable AND proxy apiKey is empty — cannot fall back to /v1/models. Set proxy.apiKey in config.",
		);
	}
	const raw = await fetchRawModels(cfg, resolvedKey);
	const d = classifyLocally(raw, cfg);
	log.debug(
		`discovery via /v1/models: ${d.builtinProviders.length} builtin, ${d.customPool.length} custom`,
	);
	writeDiscoveryCache(d, cacheScope);
	return d;
}

/** Convenience: flat set of all upstream ids (after server-applied excludes). */
export function discoveryToIdSet(d: Discovery): Set<string> {
	const out = new Set<string>();
	for (const p of d.builtinProviders) for (const m of p.models) out.add(m.id);
	for (const m of d.customPool) out.add(m.id);
	return out;
}
