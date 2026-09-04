#!/usr/bin/env node

import { renderBrowserActionText, runBrowserAction } from "../src/browser-cua-lib.mjs";

function printUsage() {
	console.log(`dm-cua browser helper

Usage:
  node browser-cua.mjs list [--json]
  node browser-cua.mjs navigate --url <url> [--tab <prefix>] [--json]
  node browser-cua.mjs snapshot [--tab <prefix>] [--json]
  node browser-cua.mjs screenshot [--tab <prefix>] [--output <path>] [--json]
  node browser-cua.mjs click --selector <css> [--tab <prefix>] [--json]
  node browser-cua.mjs click_xy --x <num> --y <num> [--tab <prefix>] [--json]
  node browser-cua.mjs type --text <text> [--tab <prefix>] [--json]
  node browser-cua.mjs evaluate --expression <js> [--tab <prefix>] [--json]
  node browser-cua.mjs handoff [--tab <prefix>] [--json]
  node browser-cua.mjs stop [--json]

	Notes:
		  - This helper uses DM's bundled CUA CDP sidecar.
		  - Fresh dedicated browser profiles auto-bootstrap a blank tab.
		  - handoff opens the dedicated browser visibly for user-authorized login or
		    verification. DM does not solve challenges or enter credentials for you.
		  - Profiles persist by project under ~/.dm/agent/cua/profiles by default;
		    set DM_CUA_EPHEMERAL=1 for a disposable profile.
	  - Default browser is Chrome/Chromium. If absent, DM attempts a non-interactive
	    package-manager install; set DM_CUA_AUTO_INSTALL=0 to opt out.
	  - To try CloakBrowser, set DM_CUA_BROWSER=cloak
	    and point DM_CUA_BROWSER_PATH or CLOAKBROWSER_BINARY_PATH at its Chromium binary.
	  - screenshot defaults to ~/.dm/agent/cua/screenshots when --output is omitted.`);
}

function parseArgs(argv) {
	const options = {};
	const positionals = [];
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const inlineIndex = value.indexOf("=");
		const hasInlineValue = inlineIndex > 2;
		const key = hasInlineValue ? value.slice(2, inlineIndex) : value.slice(2);
		if (key === "json" || key === "help") {
			options[key] = true;
			continue;
		}
		if (hasInlineValue) {
			options[key] = value.slice(inlineIndex + 1);
			continue;
		}
		const next = argv[index + 1];
		if (typeof next === "undefined" || next.startsWith("--")) {
			throw new Error(`Missing value for --${key}`);
		}
		options[key] = next;
		index += 1;
	}
	return { options, positionals };
}

async function main() {
	const { options, positionals } = parseArgs(process.argv.slice(2));
	if (options.help || positionals.length === 0) {
		printUsage();
		return;
	}
	const action = positionals[0];
	const payload = await runBrowserAction({
		action,
		tab: options.tab,
		url: options.url,
		selector: options.selector,
		x: options.x == null ? undefined : Number(options.x),
		y: options.y == null ? undefined : Number(options.y),
		text: options.text,
		expression: options.expression,
		outputPath: options.output,
	});
	if (options.json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(renderBrowserActionText(payload));
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	let wantsJson = false;
	try {
		wantsJson = process.argv.slice(2).includes("--json");
	} catch {
		// Ignore parse fallback.
	}
	if (wantsJson) {
		console.log(JSON.stringify({ status: "error", message }, null, 2));
	} else {
		console.error(message);
	}
	process.exit(1);
}
