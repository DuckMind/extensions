// Slash commands (2):
//   /cliproxy         — open the hub (Models / Usage / Diagnostics + actions)
//   /cliproxy-setup   — first-run / re-run wizard for endpoint+keys
//
// Refresh, usage, and diagnostics are now actions/tabs inside the hub.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@duckmind/dm-coding-agent";

import { applyAll, beginProviderRefresh } from "./apply.ts";
import { loadConfig, resolveConfigValue } from "./config.ts";
import { fetchDiscovery } from "./fetch-models.ts";
import { clearUsageCache } from "./fetch-usage.ts";
import { runHub } from "./ui-hub/index.ts";
import { runSetup } from "./ui-setup.ts";

export function registerCommands(dm: ExtensionAPI): void {
	dm.registerCommand("cliproxy", {
		description:
			"Manage proxy models, usage, and diagnostics in one hub overlay",
		handler: handleCliproxy.bind(null, dm),
	});

	dm.registerCommand("cliproxy-setup", {
		description:
			"Set endpoint, API key, and (optional) usage key for the proxy",
		handler: handleSetup.bind(null, dm),
	});
}

// --------------------------------------------------------------------------- /cliproxy

async function handleCliproxy(
	dm: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cfg = loadConfig();
	if (!cfg.proxy.endpoint || !resolveConfigValue(cfg.proxy.apiKey)) {
		ctx.ui.notify(
			"endpoint or API key not set \u2014 launching setup first",
			"info",
		);
		const ok = await runSetup(ctx, true);
		if (!ok) return;
	}
	const current = loadConfig();
	const resolvedKey = resolveConfigValue(current.proxy.apiKey);
	let discovery;
	try {
		discovery = await fetchDiscovery(current, resolvedKey);
	} catch (err) {
		ctx.ui.notify(`discovery failed: ${(err as Error).message}`, "error");
		return;
	}
	await runHub(dm, ctx, current, discovery);
}

// --------------------------------------------------------------------------- /cliproxy-setup

async function handleSetup(
	dm: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const ok = await runSetup(ctx, true);
	if (!ok) return;
	// After saving, eagerly reapply so the new endpoint/key actually takes effect.
	const cfg = loadConfig();
	try {
		const refreshGeneration = beginProviderRefresh(dm);
		const discovery = await fetchDiscovery(
			cfg,
			resolveConfigValue(cfg.proxy.apiKey),
		);
		const rep = await applyAll(dm, cfg, discovery, refreshGeneration);
		clearUsageCache();
		ctx.ui.notify(
			`setup ok \u00b7 ${rep.registered.length} providers registered (source=${discovery.source})`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`setup saved, but apply failed: ${(err as Error).message}`,
			"warning",
		);
	}
}
