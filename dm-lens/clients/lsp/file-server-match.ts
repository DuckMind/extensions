/**
 * Which registered servers match a file, before and apart from the operator's
 * `lsp.disabledServers` denial.
 *
 * `config.ts` owns server selection (`selectionReason`: the denial, then these
 * file gates). The gates and the registered-server list live here so a reader
 * that is not selection can apply the same gates without importing
 * `config.js`. #4403: the LSP service (`clients/lsp/index.ts`) asks which
 * disabled primaries would have served a file (`disabledPrimaryServerIds` in
 * `session-roots.ts`), and its import surface from `config.js` is mirrored by
 * whole-module `vi.mock` factories in dozens of test files (#2052), so a new
 * symbol taken from `config.js` would break each of them.
 *
 * Imports no runtime module of `clients/`: `config.js` imports it, and an
 * edge back would join the `config.js` ↔ `server.js` cycle the boundary
 * baseline admits once (`.dependency-cruiser-known-violations.json`).
 */

import path from "node:path";
import type { RegisteredLSPConfig } from "./config.js";
import type { LSPServerInfo } from "./server.js";

/** The file gates' answer: `config.ts`'s `ServerSelectionReason` minus the denial. */
type FileMatchReason = "selected" | "extension-mismatch" | "path-filter";

/** The lower-cased extension and basename the file gates match against. */
export function fileMatchKeys(filePath: string): { ext: string; base: string } {
	return {
		ext: path.extname(filePath).toLowerCase(),
		base: path.basename(filePath).toLowerCase(),
	};
}

/** The file gates of server selection, without the operator's denial. */
export function fileMatchReason(
	server: LSPServerInfo,
	filePath: string,
	ext: string,
	base: string,
): FileMatchReason {
	let matched = false;
	for (const value of server.extensions) {
		const lower = value.toLowerCase();
		if (lower === ext || lower === base) {
			matched = true;
			break;
		}
	}
	if (!matched) return "extension-mismatch";
	// #636: a server's extension match can be intentionally broader than what
	// it can usefully act on (zizmor attaches to "yaml" but only ever reports
	// on GitHub Actions workflow/action/dependabot paths). `pathFilter`, when
	// present, is an ADDITIONAL narrowing gate — never a widening one.
	if (server.pathFilter && !server.pathFilter(filePath)) return "path-filter";
	return "selected";
}

/**
 * Every server a config registers — built-in (the config's own list, else
 * `catalog`, the built-in table) plus custom — BEFORE any gate is applied.
 *
 * Spelled once because callers need the same list for opposite purposes:
 * `getAllServers` DROPS the disabled ones, `explainServersForFile` REPORTS
 * them, and `disabledPrimaryServerIds` (`session-roots.ts`) looks only at
 * them. A custom server that only one of them composed would be a server the
 * runtime runs and the introspection cannot see, or the reverse. The caller
 * passes the built-in table so this module needs no runtime import.
 */
export function registeredServers(
	config: RegisteredLSPConfig,
	catalog: readonly LSPServerInfo[],
): LSPServerInfo[] {
	const builtins = config.registeredServers.length
		? config.registeredServers
		: catalog;
	return [...builtins, ...config.customServers];
}
