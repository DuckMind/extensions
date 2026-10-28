import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { walkUpDirs } from "./path-utils.js";

const packageRootCache = new Map<string, string>();

/**
 * Resolve the installed package root for the current module.
 * Walks upward from the caller until it finds the nearest package.json.
 *
 * This is the correct alternative to process.cwd() for resolving
 * dm-lens's own assets (rules, grammars, configs) when installed
 * globally — cwd is the user's project, not the extension root.
 *
 * Credit: alexx-ftw (PR #1)
 */
export function getPackageRoot(importMetaUrl: string): string {
	const cached = packageRootCache.get(importMetaUrl);
	if (cached) return cached;

	// #4689 item 6: the module's own directory as a path identity, so a package
	// reached through a link (`npm link`, a pnpm store) roots where its files
	// live. No `package.json` on the way up leaves the filesystem root.
	let root = "";
	for (const dir of walkUpDirs(path.dirname(fileURLToPath(importMetaUrl)))) {
		root = dir;
		if (fs.existsSync(path.join(dir, "package.json"))) break;
	}
	packageRootCache.set(importMetaUrl, root);
	return root;
}

/**
 * Resolve a path relative to the installed package root.
 */
export function resolvePackagePath(
	importMetaUrl: string,
	...segments: string[]
): string {
	return path.join(getPackageRoot(importMetaUrl), ...segments);
}
