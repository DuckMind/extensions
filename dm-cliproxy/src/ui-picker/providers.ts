// Resolve the list of providers shown in the left panel. The union covers:
//   - every built-in provider that the proxy offers AND/OR dm-ai knows
//     about (so a newly-released provider that's not in the local catalog
//     still surfaces);
//   - every custom group already declared in the user's config.

import type { Api } from "@duckmind/dm-ai";
import { getModels, getProviders } from "@duckmind/dm-ai/compat";

import type { ProxyConfig } from "../config.ts";
import type { CatalogIndex, ProviderEntry } from "./types.ts";

export function collectProviders(
	cfg: ProxyConfig,
	catalog: CatalogIndex,
): ProviderEntry[] {
	const out: ProviderEntry[] = [];

	const proxyProviderNames = new Set<string>(catalog.builtinModelIds.keys());
	const knownPiAiProviders = new Set<string>(getProviders());
	const builtinNames = new Set<string>([
		...proxyProviderNames,
		...knownPiAiProviders,
	]);

	for (const name of Array.from(builtinNames).sort()) {
		const proxyIds = catalog.builtinModelIds.get(name);
		if (!proxyIds || proxyIds.length === 0) continue;

		// Pick the API: dm-ai catalog first, then proxy hint.
		let api: Api | undefined;
		try {
			const localModels = getModels(name as Parameters<typeof getModels>[0]);
			const hit = localModels.find((m) => proxyIds.includes(m.id));
			if (hit) api = hit.api as Api;
		} catch {
			/* unknown provider in dm-ai \u2014 fall back to proxy hint */
		}
		if (!api) {
			const firstId = proxyIds[0]!;
			api = catalog.byId.get(firstId)?.suggestedApi ?? "openai-responses";
		}

		out.push({
			kind: "builtin",
			name,
			api,
			subtitle: `built-in \u00b7 ${api}`,
		});

		// Make sure config has a slot so state tracking is straightforward.
		if (!cfg.builtinProviders[name]) {
			cfg.builtinProviders[name] = { enabled: false, models: [] };
		}
	}

	for (const slug of Object.keys(cfg.customProviders).sort()) {
		const p = cfg.customProviders[slug]!;
		out.push({
			kind: "custom",
			name: slug,
			api: p.api,
			subtitle: `custom \u00b7 ${p.api}`,
		});
	}

	return out;
}
