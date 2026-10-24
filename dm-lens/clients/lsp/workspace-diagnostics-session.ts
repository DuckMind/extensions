/**
 * #1782: the session clock the workspace-diagnostics cache measures entry age
 * against, in a module of its own.
 *
 * It lives here rather than in `workspace-diagnostics-cache.ts` for one
 * measured reason (#1786 review F5): `handleSessionStart` must re-arm it, and
 * importing the cache module to do so drags `reverse-deps.ts`,
 * `blocker-freshness.ts`, and the generation-guard machinery into the EAGER
 * session-start module graph — 17 ms, about 9% of cold session start. This file
 * imports nothing, so the re-arm stays a plain synchronous call with no await
 * inserted into the middle of the reset sequence and no import cost.
 *
 * The default is module-import time so the very first sweep in a cold extension
 * host already treats every entry written by a PREVIOUS process as pre-session
 * (fail-closed). It must still be re-armed per session: a pi extension host
 * survives `session_start`, so a process-lifetime value would pin the first
 * session's clock for the life of the process (AGENTS.md's
 * session-signal-vs-latch screen). Registered in
 * `tests/support/session-state-registry.ts`, whose conformance suite proves the
 * reset is reachable from `handleSessionStart`.
 *
 * The one import, `bounded-cache.ts`, imports nothing itself.
 */
import { BoundedFifoMap } from "../bounded-cache.js";

let _sessionStartedAt = Date.now();

/** Re-arm the session clock. Called by `handleSessionStart`. */
export function resetWorkspaceDiagnosticsCacheSession(
	startedAt: number = Date.now(),
): void {
	_sessionStartedAt = startedAt;
	_fileCreations.clear();
	_allFilesChangedAt = 0;
}

/** When the current session started, for entry-age comparisons. */
export function workspaceDiagnosticsCacheSessionStart(): number {
	return _sessionStartedAt;
}

/**
 * #4320: a file created after an entry was scanned can resolve an import that
 * entry reported missing, with no edit to the importer and no edit to anything
 * the importer was known to import (an unresolved import has no edge in the
 * reverse-dependency index), so neither freshness check in `isEntryFresh` can
 * see it.
 *
 * One record per created path per language-server client: the last time that
 * client SENT a `Created` watched-files notification for the path, keyed by
 * its server id, root and the path (normalized by the caller, `uriToPath`).
 * Only that server can answer differently because of it, and only for files
 * under that root. #4346: the path decides which entries it touches. The
 * workspace-diagnostics cache refuses an entry only for a created path in the
 * entry's dependency scope (`workspace-diagnostics-cache.ts`), so a creation
 * nothing depends on leaves every entry serving.
 *
 * #4476: dm-lens also records a declaration file it saw created, edited or
 * deleted on disk with no client involved (`noteWorkspaceFilesChangedOnDisk`).
 * Such a record names no server (`serverId` empty): any server can answer
 * differently because of it. A dependency install changes files no record can
 * name (`noteWorkspaceDependenciesChanged`), so it moves `_allFilesChangedAt`.
 *
 * Bounded at {@link MAX_FILE_CREATIONS} paths per session; an evicted record
 * folds into `_allFilesChangedAt`, which counts for every path, server and
 * root, so eviction can only refuse more, never serve a stale finding.
 * Re-armed with the session clock above.
 */
export interface FileCreation {
	/** The client's server id; empty for a change seen on disk (#4476). */
	serverId: string;
	root: string;
	/** The created path, as `normalizeMapKey` spells it. */
	path: string;
	at: number;
}
/** Created paths kept per session before the oldest fold. */
export const MAX_FILE_CREATIONS = 1024;
const _fileCreations = new BoundedFifoMap<string, FileCreation>(
	MAX_FILE_CREATIONS,
);
let _allFilesChangedAt = 0;

/** Record that the client for `serverId` at `root` just sent `paths` as Created. */
export function noteWorkspaceFileCreated(
	serverId: string,
	root: string,
	paths: readonly string[],
	at: number = Date.now(),
): void {
	for (const created of paths) {
		const key = `${serverId}\0${root}\0${created}`;
		const latest = Math.max(_fileCreations.get(key)?.at ?? 0, at);
		for (const [, evicted] of _fileCreations.set(key, {
			serverId,
			root,
			path: created,
			at: latest,
		})) {
			_allFilesChangedAt = Math.max(_allFilesChangedAt, evicted.at);
		}
	}
}

/**
 * #4476: record `paths` (normalized) under `root` that dm-lens saw created,
 * edited or deleted on disk and no client announced.
 */
export function noteWorkspaceFilesChangedOnDisk(
	root: string,
	paths: readonly string[],
	at: number = Date.now(),
): void {
	noteWorkspaceFileCreated("", root, paths, at);
}

/**
 * #4476: a dependency install changed what every file may resolve to, so every
 * entry scanned before `at` is refused, under any root (an install is rare,
 * and a refusal costs one re-touch).
 */
export function noteWorkspaceDependenciesChanged(
	at: number = Date.now(),
): void {
	_allFilesChangedAt = Math.max(_allFilesChangedAt, at);
}

/**
 * The latest Created a server `fromServer` accepts was sent at a root `holds`
 * accepts, for a path `counts` accepts (every path when omitted), or the
 * eviction fold or the last dependency install, whichever is later (0 when
 * none this session). A change seen on disk counts for every server (#4476).
 */
export function workspaceFileCreatedAtFor(
	fromServer: (serverId: string) => boolean,
	holds: (root: string) => boolean,
	counts: (creation: FileCreation) => boolean = () => true,
): number {
	let latest = _allFilesChangedAt;
	for (const creation of _fileCreations.values()) {
		if (
			creation.at > latest &&
			(creation.serverId === "" || fromServer(creation.serverId)) &&
			holds(creation.root) &&
			counts(creation)
		) {
			latest = creation.at;
		}
	}
	return latest;
}
