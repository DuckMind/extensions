/**
 * #4346: the producer for a module created outside dm-lens (a shell, `cp`,
 * codegen, another editor). No tool result names such a file, so no Created
 * reaches a language server that caches a failed lookup (Pyrefly and pyright,
 * measured), and its importer keeps reporting the missing import for the
 * server's life when only the importer is diagnosed.
 *
 * The importer is the one input that names the module, and it is in hand when
 * a diagnostics call is about to answer for it. So before a batch answers, the
 * files its importers resolve to now (`extractForwardImports`, the
 * tree-sitter import extraction and the review graph's resolvers, which the
 * inline-blocker sweep also uses) join the files announced
 * through `LSPService.announceCreatedFiles`. Each client still decides what is
 * new to it (#4344's path-birth rule and announced memory), so an old module,
 * or one already announced, sends nothing.
 *
 * Bounded: at most {@link CREATED_IMPORT_SCAN_MAX_FILES} importers per call,
 * and none the LSP does not sync (`exceedsLspSyncLimits`): such a file gets no
 * server answer, so its imports have nothing to make stale (#4368 r1 F2).
 * Each bound is recorded once per session (`lsp-created-import-scan-incomplete`,
 * subjects `capped` and `oversized`).
 *
 * #4346 final lane: a Go file's package files are named by no import, so
 * {@link goPackageFilesToAnnounce} announces the Go files beside every Go file
 * of the call. A TypeScript ambient file created outside dm-lens that no call
 * names stays outside the producer: finding one needs a walk of the project.
 * Each resolved importer's scope (its targets and its unresolved sources) is
 * handed to the caller, so the workspace-diagnostics cache can refuse an entry
 * only for a creation in that scope. A scope is incomplete when the importer
 * may hold a dependency the extraction did not capture
 * (`holdsUncapturedDependency` in `blocker-freshness.ts`, #4346 r3) or a
 * target may re-export (`reexportsFrom`).
 *
 * Observed by one `lsp_created_import_scan_rollup` row per session
 * ({@link emitCreatedImportScanRollupAtSessionEnd}), never one per call.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { logLatency } from "../latency-logger.js";
import { getProcessSingleton } from "../process-singletons.js";
import { exceedsLspSyncLimits } from "./content-limits.js";
import { goPackageFiles, isGoSourceFile } from "./implicit-scope.js";

/** Importers resolved per diagnostics call. */
export const CREATED_IMPORT_SCAN_MAX_FILES = 32;

interface CreatedImportScanRollup {
	/** The project the last call resolved in, for the row's `filePath`. */
	cwd: string;
	calls: number;
	importers: number;
	targets: number;
	capped: number;
	oversized: number;
	totalMs: number;
	maxMs: number;
}

// One cell per process, as the session-end rollups beside it (a module graph
// evaluated twice still counts into one tally).
function rollup(): CreatedImportScanRollup {
	return getProcessSingleton("lsp-created-import-scan-rollup", 1, () => ({
		cwd: "",
		calls: 0,
		importers: 0,
		targets: 0,
		capped: 0,
		oversized: 0,
		totalMs: 0,
		maxMs: 0,
	}));
}

/** Snapshot of this session's producer tally (non-mutating). */
export function getCreatedImportScanRollup(): Readonly<CreatedImportScanRollup> {
	return { ...rollup() };
}

/**
 * One `lsp_created_import_scan_rollup` row at a primary `session_shutdown`
 * (`resetLSPService` with that reason calls it):
 * the calls that resolved importers this session, the importers resolved, the
 * targets found, the calls past the cap, the importers skipped as oversized,
 * and the total and longest call. Nothing when no call resolved anything;
 * clears the tally.
 */
export function emitCreatedImportScanRollupAtSessionEnd(): void {
	const tally = rollup();
	if (tally.calls === 0) return;
	const { cwd, ...counts } = tally;
	logLatency({
		type: "phase",
		phase: "lsp_created_import_scan_rollup",
		filePath: cwd,
		durationMs: 0,
		metadata: { ...counts, totalMs: Math.round(counts.totalMs) },
	});
	Object.assign(tally, {
		calls: 0,
		importers: 0,
		targets: 0,
		capped: 0,
		oversized: 0,
		totalMs: 0,
		maxMs: 0,
	});
}

/**
 * Whether `filePath` is over the bound the LSP syncs. An unreadable file is
 * not: extraction answers it with no imports.
 */
function overLspSyncLimits(filePath: string): boolean {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return false;
	}
	return exceedsLspSyncLimits(content).tooLarge;
}

/** One resolved importer's imports, for the workspace-diagnostics cache. */
export interface ImportScope {
	/** The files its imports resolve to now. */
	targets: readonly string[];
	/** Its import sources that resolve to nothing now. */
	unresolved: readonly string[];
	/** Whether the targets and sources are all of its direct dependencies,
	 * and no target re-exports another module. */
	complete: boolean;
}

/** A block or line comment, for {@link holdsReexport}. */
const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * #4346 r3: whether `text` may re-export: an `export` followed by a `from`
 * with no `;` between. That is `/\bexport\b[^;]*?\bfrom\b/s`, tested per
 * `;`-free run from its first `export`, because the regex alone takes
 * quadratic time on a file with no semicolons (20 s on 1.9 MB, measured).
 * Through a re-export the importer depends on a module its own imports do
 * not name. Not a list of forms (round 2 listed them and its verify found
 * three more); a false positive (semicolon-free code, a comment) makes the
 * scope incomplete, which fails closed.
 *
 * A `;` inside a comment must not end a run (a block comment holding `;`
 * inside `export { ... } from`, #4430 r3 verify), so the text is also read
 * with its comments removed. Both readings count: the comment pattern does
 * not know strings (`"http://x"` reads as a line comment), so asking it alone
 * could hide a re-export.
 */
function holdsReexport(text: string): boolean {
	return [text, text.replace(COMMENT, "")].some((form) =>
		form.split(";").some((run) => {
			const at = run.search(/\bexport\b/);
			return at >= 0 && /\bfrom\b/.test(run.slice(at));
		}),
	);
}

/**
 * Whether `target` may re-export ({@link holdsReexport}); an unreadable one
 * counts as re-exporting. Every target is read, whatever its language: a
 * match in a non-JS/TS file only makes the scope incomplete (fails closed).
 * Memoized per call in `seen`.
 */
function reexportsFrom(target: string, seen: Map<string, boolean>): boolean {
	let answer = seen.get(target);
	if (answer === undefined) {
		try {
			answer = holdsReexport(fs.readFileSync(target, "utf8"));
		} catch {
			answer = true;
		}
		seen.set(target, answer);
	}
	return answer;
}

/**
 * The files `importers` import now, deduplicated, for `announceCreatedFiles`.
 * `onScope` hears each importer this call resolved; an importer past the cap,
 * or skipped as oversized, is not heard.
 */
export async function importTargetsToAnnounce(
	cwd: string,
	importers: readonly string[],
	onScope?: (importer: string, scope: ImportScope) => void,
): Promise<string[]> {
	if (importers.length === 0) return [];
	const started = performance.now();
	const tally = rollup();
	if (importers.length > CREATED_IMPORT_SCAN_MAX_FILES) {
		tally.capped += 1;
		recordDegradationOnce({
			kind: "lsp-created-import-scan-incomplete",
			subject: "capped",
			reason: `resolved the imports of ${CREATED_IMPORT_SCAN_MAX_FILES} of ${importers.length} files in one diagnostics call`,
		});
	}
	// Lazy: the import extraction stack stays off the LSP module graph until a
	// call has an importer to resolve.
	const { extractForwardImports } = await import("../blocker-freshness.js");
	const targets = new Set<string>();
	const reexports = new Map<string, boolean>();
	let resolved = 0;
	// Extraction answers [] for a missing, unreadable or non-source file; it
	// does not throw (its own contract, which the blocker sweep relies on too).
	for (const importer of importers.slice(0, CREATED_IMPORT_SCAN_MAX_FILES)) {
		if (overLspSyncLimits(importer)) {
			tally.oversized += 1;
			recordDegradationOnce({
				kind: "lsp-created-import-scan-incomplete",
				subject: "oversized",
				reason:
					"skipped resolving the imports of a file over the LSP sync limits (the LSP does not sync it, so it has no answer to refresh)",
			});
			continue;
		}
		resolved += 1;
		const scope = await extractForwardImports(cwd, importer);
		if (onScope) {
			const complete =
				scope.complete &&
				!scope.targets.some((target) => reexportsFrom(target, reexports));
			onScope(importer, { ...scope, complete });
		}
		for (const target of scope.targets) targets.add(target);
	}
	const elapsedMs = performance.now() - started;
	tally.cwd = cwd;
	tally.calls += 1;
	tally.importers += resolved;
	tally.targets += targets.size;
	tally.totalMs += elapsedMs;
	tally.maxMs = Math.max(tally.maxMs, Math.round(elapsedMs));
	return [...targets];
}

/**
 * #4346: the Go files that share a package with a Go file of `files` and are
 * not in `files`, for `announceCreatedFiles`. No import names a Go file of the
 * same package, so a file created there outside dm-lens reached no server.
 * One directory read per distinct directory, so the work is bounded by the
 * call's own files; an unreadable directory adds nothing.
 */
export function goPackageFilesToAnnounce(files: readonly string[]): string[] {
	// Lexical spellings: a file listed under another spelling is only announced
	// twice, and each client's announced memory drops the repeat.
	const listed = new Set<string>();
	for (const file of files) {
		if (isGoSourceFile(file)) listed.add(path.resolve(file));
	}
	const dirs = new Set([...listed].map((file) => path.dirname(file)));
	const peers: string[] = [];
	for (const dir of dirs) {
		for (const peer of goPackageFiles(dir) ?? []) {
			if (!listed.has(peer)) peers.push(peer);
		}
	}
	return peers;
}
