/**
 * dm-cliproxy — DM extension that manages model providers through a single
 * CliProxyAPI endpoint with one corporate key.
 *
 * On factory boot we:
 *   1. load ~/.dm/agent/dm-cliproxy/config.json (migrates legacy config; defaults if missing)
 *   2. fetch discovery (well-known → fall back to /v1/models)
 *   3. call dm.registerProvider for each enabled built-in + custom provider
 *   4. register slash commands /cliproxy and /cliproxy-setup
 *      (refresh, usage, and diagnostics are tabs/actions inside the hub)
 *   5. register status-line quota segment (shared file cache, see usage-shared-cache)
 *
 * All discovery + apply errors are logged but never abort extension load —
 * a missing/broken proxy must not prevent DM from starting.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@duckmind/dm-coding-agent";

import {
	applyAll,
	beginProviderRefresh,
	invalidateProviderLifecycle,
} from "./src/apply.ts";
import {
	discoveryCacheScope,
	readDiscoveryCache,
} from "./src/cache.ts";
import { registerCommands } from "./src/commands.ts";
import { loadConfig, resolveConfigValue } from "./src/config.ts";
import { detectConflicts } from "./src/conflicts.ts";
import { fetchDiscovery } from "./src/fetch-models.ts";
import type { ProxyConfig } from "./src/config.ts";
import type { UsageDocument } from "./src/fetch-usage.ts";
import { fetchUsage } from "./src/fetch-usage.ts";
import { log } from "./src/log.ts";
import {
	isUsageFresh,
	readUsageCache,
	releaseUsageLock,
	tryAcquireUsageLock,
	usageCachePaths,
	writeUsageCache,
} from "./src/usage-shared-cache.ts";
import { renderQuotaSegment } from "./src/status-quota.ts";

/** Status-line key. The leading "0" makes it sort before alphabetic keys so
 * the quota segment appears first on the footer's extension-status line. */
const QUOTA_STATUS_KEY = "0quota";
/** Minimum gap between network fetches triggered by turn_end, even if the
 * shared file cache is stale (prevents burst fetches during rapid turns). */
const TURN_FETCH_DEBOUNCE_MS = 5_000;

/**
 * Fetch usage data through the shared file cache: if the on-disk cache is
 * fresh (within TTL), return it without any network call; otherwise acquire
 * a cross-process lock and fetch at most once. Returns the best available
 * doc (possibly stale) or null on failure.
 */
async function loadUsageCached(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	opts: { readOnly?: boolean } = {},
): Promise<UsageDocument | null> {
	const { cachePath, lockPath } = usageCachePaths(
		cfg.proxy.endpoint,
		resolvedUsageKey,
	);
	const cached = readUsageCache(cachePath);
	if (cached && isUsageFresh(cached.ageMs)) return cached.doc;
	// readOnly mode (debounce path): never fetch, serve stale cache if available.
	if (opts.readOnly) return cached?.doc ?? null;
	// Stale or missing — try to become the fetcher.
	const token = tryAcquireUsageLock(lockPath);
	if (!token) {
		// Another instance is fetching; serve stale data if we have it.
		return cached?.doc ?? null;
	}
	try {
		const doc = await fetchUsage(cfg, resolvedUsageKey, { force: true });
		writeUsageCache(doc, cachePath);
		return doc;
	} catch (e) {
		log.debug("usage fetch failed in shared cache:", (e as Error).message);
		return cached?.doc ?? null;
	} finally {
		releaseUsageLock(token, lockPath);
	}
}

/** Update the quota status segment for the current model. No-op if the model
 * has no quota windows (e.g. a custom provider) or if usage is unavailable. */
async function refreshQuotaStatus(
	cfg: ProxyConfig,
	resolvedUsageKey: string,
	ui: {
		theme: {
			fg(color: "success" | "warning" | "error" | "dim", text: string): string;
		};
		setStatus(key: string, text: string | undefined): void;
	},
	model: { provider: string } | undefined,
	opts: { readOnly?: boolean } = {},
): Promise<void> {
	if (!model) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	if (!resolvedUsageKey) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const doc = await loadUsageCached(cfg, resolvedUsageKey, opts);
	if (!doc) {
		ui.setStatus(QUOTA_STATUS_KEY, undefined);
		return;
	}
	const rendered = renderQuotaSegment(doc, model.provider, ui.theme);
	ui.setStatus(QUOTA_STATUS_KEY, rendered ?? undefined);
}

interface QuotaHookDependencies {
	loadConfig: typeof loadConfig;
	resolveConfigValue: typeof resolveConfigValue;
	refreshQuotaStatus: typeof refreshQuotaStatus;
	now: () => number;
}

export interface CliproxyLifecycle {
	active: boolean;
	quotaGeneration: number;
}

export function registerQuotaHooks(
	dm: ExtensionAPI,
	overrides: Partial<QuotaHookDependencies> = {},
	lifecycle: CliproxyLifecycle = { active: true, quotaGeneration: 0 },
): void {
	const deps: QuotaHookDependencies = {
		loadConfig,
		resolveConfigValue,
		refreshQuotaStatus,
		now: Date.now,
		...overrides,
	};
	let lastTurnFetchMs = 0;

	const renderCurrent = async (
		ctx: ExtensionContext,
		readOnly = false,
	): Promise<void> => {
		if (!ctx.hasUI || !lifecycle.active) return;
		const renderGeneration = ++lifecycle.quotaGeneration;
		const cfg = deps.loadConfig();
		const resolvedUsageKey = deps.resolveConfigValue(cfg.proxy.usageKey);
		const guardedUi = {
			theme: ctx.ui.theme,
			setStatus(key: string, text: string | undefined): void {
				if (
					lifecycle.active &&
					renderGeneration === lifecycle.quotaGeneration
				) {
					ctx.ui.setStatus(key, text);
				}
			},
		};
		await deps.refreshQuotaStatus(
			cfg,
			resolvedUsageKey,
			guardedUi,
			ctx.model,
			readOnly ? { readOnly: true } : {},
		);
	};

	dm.on("session_start", async (_event, ctx) => {
		await renderCurrent(ctx);
	});
	dm.on("model_select", async (_event, ctx) => {
		await renderCurrent(ctx, true);
	});
	dm.on("turn_end", async (_event, ctx) => {
		const now = deps.now();
		const readOnly = now - lastTurnFetchMs < TURN_FETCH_DEBOUNCE_MS;
		if (!readOnly) lastTurnFetchMs = now;
		await renderCurrent(ctx, readOnly);
	});
}

export default async function cliproxyapi(dm: ExtensionAPI): Promise<void> {
	registerCommands(dm);
	const lifecycle: CliproxyLifecycle = {
		active: true,
		quotaGeneration: 0,
	};
	registerQuotaHooks(dm, {}, lifecycle);
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	dm.on("session_shutdown", () => {
		lifecycle.active = false;
		lifecycle.quotaGeneration++;
		if (refreshTimer !== undefined) clearInterval(refreshTimer);
		invalidateProviderLifecycle(dm);
	});

	const cfg = loadConfig();
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.debug(
			"apiKey is empty after resolution — skipping initial apply. Run /cliproxy-setup to configure.",
		);
		invalidateProviderLifecycle(dm);
		return;
	}

	// Conflict scan is read-only and cheap; do it once at startup.
	const conflicts = detectConflicts(cfg);
	for (const c of conflicts) log.warn(`conflict (${c.kind}): ${c.detail}`);

	try {
		const cachedGeneration = beginProviderRefresh(dm);
		const cached = readDiscoveryCache(
			discoveryCacheScope(cfg.proxy.endpoint, resolvedKey),
		);
		if (cached) {
			// Serve the last good discovery instantly so DM startup never blocks on
			// the ~5s proxy round-trip, then revalidate over the network in the
			// background (applyAll is idempotent — it just re-registers providers).
			log.debug(
				`discovery from cache (age ${Math.round(cached.ageMs / 1000)}s): ${cached.discovery.builtinProviders.length} builtin, ${cached.discovery.customPool.length} custom`,
			);
			await applyAll(dm, cfg, cached.discovery, cachedGeneration);
			void (async () => {
				const refreshGeneration = beginProviderRefresh(dm);
				try {
					const fresh = await fetchDiscovery(cfg, resolvedKey);
					if (!lifecycle.active) return;
					await applyAll(dm, cfg, fresh, refreshGeneration);
					log.debug("discovery revalidated from network");
				} catch (e) {
					log.warn(
						"background discovery revalidate failed:",
						(e as Error).message,
					);
				}
			})();
		} else {
			const refreshGeneration = beginProviderRefresh(dm);
			const discovery = await fetchDiscovery(cfg, resolvedKey);
			if (!lifecycle.active) return;
			await applyAll(dm, cfg, discovery, refreshGeneration);
		}
	} catch (err) {
		log.error("initial apply failed:", (err as Error).message);
		// Commands stay registered; user can open /cliproxy and press r to refresh.
	}

	if (cfg.refreshIntervalMinutes > 0) {
		const ms = cfg.refreshIntervalMinutes * 60_000;
		refreshTimer = setInterval(() => {
			void (async () => {
				const refreshGeneration = beginProviderRefresh(dm);
				try {
					if (!lifecycle.active) return;
					const c = loadConfig();
					const k = resolveConfigValue(c.proxy.apiKey);
					if (!k) return;
					const d = await fetchDiscovery(c, k);
					if (!lifecycle.active) return;
					await applyAll(dm, c, d, refreshGeneration);
					log.debug("background refresh ok");
				} catch (e) {
					log.warn("background refresh failed:", (e as Error).message);
				}
			})();
		}, ms);
		log.debug(`background refresh every ${cfg.refreshIntervalMinutes}m`);
	}

}
