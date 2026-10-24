/**
 * Which rule file dm-lens hands Opengrep when the repo carries none (#4765).
 *
 * Opengrep used to start with `--config auto`, which downloads about 1074
 * registry rules on every spawn: about 8 s online, no findings at all offline.
 * dm-lens now prefers a local file, in this order (the repo's own rule file wins
 * first, in `resolveOpengrepConfig`):
 *
 *   1. the CACHED pack: the registry pack a background refresh downloaded on
 *      the user's own machine, validated and swapped in
 *      (`refreshOpengrepRulePack` in `installer/managed-tool-refresh.ts`);
 *   2. none yet (first run, offline, install kill switch, untrusted project):
 *      the caller falls back to `auto`, as before. dm-lens ships NO rules: the
 *      registry's rules are under the Semgrep Rules License and the community
 *      repo's are under Commons Clause, neither of which dm-lens redistributes
 *      (maintainer decision 2026-10-23). The fallback is safe offline because
 *      the server's own config-load failure is a recorded, unconfirmed scan,
 *      never a clean one (#4764).
 *
 * Presence of the cached file IS its validity: the refresh writes it only by an
 * atomic rename of a file that parsed and passed `opengrep --validate`, and
 * leaves the previous file in place on every failure. The cached rules are the
 * user's own copy of the registry and are never redistributed.
 *
 * This module is a leaf (no installer, no spawn) because the config resolver and
 * the LSP spawn path both import it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalDmLensDir } from "./file-utils.js";

/** The registry rule set `--config auto` resolved to; fetched by the refresh. */
export const OPENGREP_REGISTRY_PACK_URL = "https://semgrep.dev/c/auto";

/** Where the refresh keeps the validated registry pack, next to nothing it deletes. */
export function cachedOpengrepPackPath(): string {
	return path.join(getGlobalDmLensDir(), "rules", "opengrep-registry.yaml");
}

/** The refreshed pack to pass as `--config` when the repo has no rule file, if one exists. */
export function resolveOpengrepRulePack(): string | undefined {
	const cached = cachedOpengrepPackPath();
	try {
		if (fs.statSync(cached).size > 0) return cached;
	} catch {
		// none: no cached pack yet (ENOENT on a fresh or offline machine) is the
		// normal state; the caller falls back to `auto`.
	}
	return undefined;
}

/**
 * Opengrep's CLI prefixes the id of every rule loaded from a local file with
 * that file's directory (`/home/u/.dm-lens/rules/x.yaml` turns
 * `python.lang.eval` into `home.u..dm-lens.rules.python.lang.eval`; measured on
 * 1.30.0, absolute POSIX paths). The language server does not. A rule id that
 * names the install path varies per machine, so the CLI scan strips it for the
 * cached pack and reports the registry-form id the server reports and the
 * `auto` set used to. An id without the prefix is returned unchanged.
 * Windows drive paths are unmeasured; a mismatch there leaves the id as
 * Opengrep wrote it.
 */
export function stripPackRuleIdPrefix(
	checkId: string,
	packPath: string,
): string {
	const prefix = `${path
		.dirname(packPath)
		.replace(/^[\\/]+/, "")
		.replace(/[\\/:]+/g, ".")}.`;
	return checkId.startsWith(prefix) ? checkId.slice(prefix.length) : checkId;
}
