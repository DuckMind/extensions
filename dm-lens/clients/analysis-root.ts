/**
 * Classifies the root that owns one file for tool_result bookkeeping.
 *
 * This is the one root-selection seam shared by tool-result bookkeeping and
 * LSP admission. Callers still decide which work they own, but they must use
 * the root selected here rather than re-discovering a marker independently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
	isAtOrAboveHomeDir,
	isUnderDir,
	isVendorPath,
	pathsEqual,
	realpathOrResolve,
	walkUpDirs,
} from "./path-utils.js";
import { isDmLensInternalPath } from "./file-utils.js";
import { PROJECT_CONFIG_LOCATIONS } from "./config-locations.js";
import { getDirectoryMarkers } from "./workspace-topology.js";
import {
	resolveGitCheckout,
	resolveLinkedWorktreeOwner,
	sameCheckoutOtherRoot,
} from "./review-graph/git-identity.js";

export type AnalysisRootMode =
	| "session"
	| "linked-worktree"
	| "adopted"
	| "none";

const PROJECT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"Gemfile",
	"mix.exs",
	"composer.json",
];

function hasProjectMarker(dir: string): boolean {
	return PROJECT_MARKERS.some((marker) => {
		try {
			const stat = fs.statSync(nodePath.join(dir, marker));
			return stat.isFile() || marker === ".git";
		} catch {
			return false;
		}
	});
}

function nearestProjectRoot(filePath: string): string | undefined {
	let dir = nodePath.dirname(nodePath.resolve(filePath));
	const filesystemRoot = nodePath.parse(dir).root;
	while (dir !== filesystemRoot) {
		if (hasProjectMarker(dir)) return dir;
		dir = nodePath.dirname(dir);
	}
	return hasProjectMarker(filesystemRoot) ? filesystemRoot : undefined;
}

/** The selected filesystem root, or undefined for a refused path. */
export function resolveAnalysisRootPath(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): string | undefined {
	const resolved = realpathOrResolve(filePath);
	const session = realpathOrResolve(sessionRoot);
	const tmp = realpathOrResolve(os.tmpdir());
	const data = process.env.DM_LENS_HOME
		? realpathOrResolve(process.env.DM_LENS_HOME)
		: undefined;
	if (isVendorPath(resolved)) return undefined;
	if (
		resolved === tmp ||
		resolved === session ||
		isUnderDir(session, resolved) ||
		(!isUnderDir(resolved, session) &&
			(isDmLensInternalPath(resolved, session) ||
				(data !== undefined &&
					(resolved === data || isUnderDir(resolved, data)))))
	)
		return undefined;
	if (isUnderDir(resolved, session)) return session;
	const checkout = resolveGitCheckout(session);
	const linked = checkout && resolveLinkedWorktreeOwner(checkout, resolved);
	if (linked && !isVendorPath(resolved)) return linked.root;
	const candidate = nearestProjectRoot(resolved);
	if (!candidate || candidate === nodePath.parse(candidate).root)
		return undefined;
	const home = realpathOrResolve(homeDirOverride ?? os.homedir());
	// D1: sibling projects below $HOME are eligible; only $HOME itself and
	// ancestors are refused. Keep the shared ceiling in isAtOrAboveHomeDir.
	if (isAtOrAboveHomeDir(candidate, home)) return undefined;
	if (candidate === tmp || isUnderDir(session, candidate)) return undefined;
	if (isVendorPath(candidate)) return undefined;
	return candidate;
}

/**
 * The class AND the owning root, answered once (#2657). `resolveAnalysisRoot`
 * is the mode-only projection of this; a caller that needs the root for the
 * class must not re-derive it from a second rule — `resolveAnalysisRootPath`
 * is the eligibility rule for an out-of-session path and answers `undefined`
 * for a worktree root inside a pi-owned temp dir, which is not what the class
 * said.
 */
export function classifyAnalysisRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): { mode: AnalysisRootMode; root: string | undefined } {
	const resolved = realpathOrResolve(filePath);
	if (isVendorPath(resolved)) return { mode: "none", root: undefined };
	const checkout = resolveGitCheckout(sessionRoot);
	const owner = checkout
		? resolveLinkedWorktreeOwner(checkout, resolved)
		: null;
	if (owner) return { mode: "linked-worktree", root: owner.root };
	const root = resolveAnalysisRootPath(filePath, sessionRoot, homeDirOverride);
	if (!root) return { mode: "none", root: undefined };
	// #4689 item 7: `root` is an identity (`resolveAnalysisRootPath` resolves
	// the session through the kernel), so the session side is compared as one
	// too. A spelling here made a symlink-spelled session root adopt itself.
	if (pathsEqual(root, sessionRoot)) return { mode: "session", root };
	return { mode: "adopted", root };
}

export function resolveAnalysisRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): AnalysisRootMode {
	return classifyAnalysisRoot(filePath, sessionRoot, homeDirOverride).mode;
}

export function canWriteAnalysisRoot(mode: AnalysisRootMode): boolean {
	return mode === "session" || mode === "linked-worktree";
}

/** What a session declares to its root registries for one file (#2657). */
export interface SessionConfigRoot {
	/**
	 * The root to hand `ensureLSPConfigInitialized`, or `undefined` when the
	 * session must register NOTHING for this file.
	 */
	register: string | undefined;
	/** The owning class, as {@link resolveAnalysisRoot} answered it. */
	mode: AnalysisRootMode;
}

/**
 * #2657: the root a session should REGISTER for `filePath`, declared as one
 * workspace rather than one directory, and whether it may register at all.
 *
 * Pre-fix, the `tool_call` seam registered `path.dirname(filePath)`, so a
 * session touching 128 directories cycled the FIFO(128) session-root registry
 * and evicted the project root — which carries the operator's
 * `lsp.disabledServers` denial — until something re-registered it, and
 * `getConfigForFile` walked a population that grew with the number of
 * directories an agent happened to touch.
 *
 * The registration follows the CLASS, never the directory:
 *
 * 1. `session` — register the nearest directory at or above the file that
 *    holds a file the config loader layers (`holdsProjectConfig`), never
 *    above the session root. The loader layers upward from the registered
 *    root, so that root must sit at or below the nearest config owner or a
 *    nested config stops applying; otherwise the session root itself.
 * 2. `linked-worktree` — register the worktree root, or the nearest config
 *    owner below it by the rule in 1: it is its own workspace with its own
 *    `.dm-lens.json`, and `resolveServerRoot`'s #2052 gate refuses a file
 *    outside every registered root, so registering nothing would deny the
 *    worktree its LSP client. Per-worktree isolation is preserved (maintainer
 *    decision on #1129).
 * 3. `adopted` — register NOTHING. An adopted root is a foreign project, never
 *    a session root: it is served through the `adopted` branch of
 *    `resolveServerRoot` and admitted by `ClientRegistry.admitAdoptedRoot`,
 *    which is capped, idle-evicted, and refuses its project-local binaries.
 *    Registering it would launder `adopted` into `session` for
 *    `analysisRootModeForFile` and skip every one of those rules.
 * 4. `none` — register nothing; `tool_result` announces the skip.
 *
 * The population is therefore O(workspaces + nested config owners), not
 * O(directories touched).
 *
 * The root is decided by identity and SPELLED on the file's side (#4689 item
 * 7): the session-root registry (`clients/lsp/session-roots.ts`) tests
 * containment lexically, so a root registered in any other spelling never
 * holds the file, the #2052 gate declines it, and its `lsp.disabledServers`
 * denial stops applying. When no ancestor of the file's spelling is the root
 * (a directory link from outside into it), the link's entry is registered (see
 * `configRootOnFileSpelling`). When no ancestor is even inside the root (a
 * file link from outside), no registrable spelling holds the file, so the
 * session root is registered as the host spelled it: the entry `session_start`
 * made, restored if the cap dropped it, never a new one.
 */
export function resolveSessionConfigRoot(
	filePath: string,
	sessionRoot: string,
	homeDirOverride?: string,
): SessionConfigRoot {
	const { mode, root } = classifyAnalysisRoot(
		filePath,
		sessionRoot,
		homeDirOverride,
	);
	if (root === undefined || mode === "adopted" || mode === "none")
		return { register: undefined, mode };
	// The owner the class resolved — the session root or the worktree root —
	// never the edited file's directory and never a re-derived eligibility.
	return {
		register:
			configRootOnFileSpelling(filePath, root) ?? nodePath.resolve(sessionRoot),
		mode,
	};
}

/**
 * The nearest config owner at or below `root` on the file's own spelling, else the outermost ancestor of that spelling still inside `root`:
 * `root` itself when the file is spelled under it, or, for a directory link
 * from outside into it, the link's entry. Either holds the file lexically, and
 * every file under it resolves into `root`, so registering it serves the file
 * and makes no outside file a session file. `undefined` when no ancestor is
 * inside `root` (a file link from outside). `isUnderDir` holds a directory
 * within itself and compares identities on POSIX (#4689), so a link on either
 * side neither stops the walk early nor carries it above the root.
 */
function configRootOnFileSpelling(
	filePath: string,
	root: string,
): string | undefined {
	let entry: string | undefined;
	for (const dir of walkUpDirs(nodePath.dirname(nodePath.resolve(filePath)))) {
		if (!isUnderDir(dir, root)) return entry;
		if (holdsProjectConfig(dir)) return dir;
		entry = dir;
	}
	return entry;
}

/**
 * Does `dir` hold a file the config loader layers? The loader reads EVERY
 * `PROJECT_CONFIG_LOCATIONS` entry in each directory upward from the
 * registered root, the legacy LSP-scoped `pi-lsp.json` and `.dm-lens/lsp.json`
 * included, so a root registered above a directory holding only one of those
 * never applies it (#4734 Greptile "Nested LSP settings disappear").
 * `findDmLensConfigInDir` knows only the two dm-lens basenames. Presence is
 * read from the memoized directory listings: an entry that cannot be read
 * still makes `dir` the owner, so the loader reads it and reports the failure.
 */
function holdsProjectConfig(dir: string): boolean {
	return PROJECT_CONFIG_LOCATIONS.some((location) => {
		// `relativePath` is POSIX-joined. Descend only through names the parent
		// listing holds, so no listing is cached for a directory that is absent.
		let at = dir;
		for (const segment of location.relativePath.split("/")) {
			if (!getDirectoryMarkers(at).entryNames.has(segment)) return false;
			at = nodePath.join(at, segment);
		}
		return true;
	});
}

/**
 * May this ROOT receive session bookkeeping? The session root, a directory
 * under it, and the session repository's linked worktrees may; an adopted
 * project must not (AGENTS.md "What it is"). The root form of
 * {@link resolveAnalysisRoot}, which answers "session" for any file under the
 * session root (a monorepo package's client is rooted there, #4532 round 5,
 * review F7): checkout identity is read at the root itself, not at a child
 * path, so a caller holding a root asks the owner instead of re-deriving the
 * rule.
 */
export function isSessionBookkeepingRoot(
	root: string,
	sessionRoot: string,
): boolean {
	const resolved = realpathOrResolve(root);
	// The file form's first refusal (#4532 round 6, verify r5): every file
	// under a vendor root resolves to "none", so the root is no session's.
	if (isVendorPath(resolved)) return false;
	const session = realpathOrResolve(sessionRoot);
	if (pathsEqual(resolved, session) || isUnderDir(resolved, session))
		return true;
	const checkout = resolveGitCheckout(session);
	if (!checkout) return false;
	// The owner rule itself, asked of two ROOTS instead of a root and a file
	// (#4532 round 4, NITPICK-1): this used to be a second spelling of
	// `resolveLinkedWorktreeOwner`'s predicate, on `===` rather than `pathsEqual`.
	return sameCheckoutOtherRoot(checkout, resolveGitCheckout(resolved));
}
