/**
 * #4532: honest rendering for TypeScript diagnostics produced by a root whose
 * dependency install does not resolve.
 *
 * A pi session edited a file in a linked worktree that had no `node_modules`.
 * The `typescript` server rooted there published seven severity-1 rows: TS2307
 * on `node:crypto`, TS2503 on `NodeJS`, and TS2304 for the four `node` timer
 * globals. Every one of them is an AMBIENT-DECLARATION gap — `@types/node` is
 * not installed, so the server has no `NodeJS` namespace, no `node:` module
 * types and no timer globals — and none is a defect in the edited file. dm-lens
 * rendered them as `🔴 STOP — 7 issue(s) must be fixed`, four times over ten
 * minutes; the agent cannot fix a missing install by editing code, and the
 * blockers starved the cascade (`cascade_skip reason=primary_has_blockers`).
 *
 * DEMOTE-WITH-LABEL, never suppress, exactly as #1640's inferred-project rule
 * does for its own config gap: the finding keeps its line, its code and its
 * evidence, and its text names the environment it needs. The difference is what
 * proves the demotion. #1640 asks the server which project a file belongs to;
 * this asks the filesystem whether any dependency install could be resolved for
 * it, which costs a bounded walk-up of `stat` calls and no server request.
 *
 * FAIL CLOSED (AGENTS shape 69). The gate admits a closed list of (code,
 * operand) pairs from the TypeScript server and refuses every other form:
 * another code (a real type error), another server (an auxiliary sharing the
 * same result), a missing name that is not one of `node`'s globals, and any
 * root that resolves a `node_modules` at all. A missing MODULE is admitted only
 * in two known-good forms: a Node built-in (`node:crypto`, `fs/promises`), or a
 * package some `package.json` on the file's walk-up DECLARES. Every other
 * specifier stays blocking without being named: a relative or absolute path, a
 * `#` import, and every tsconfig `paths`/`baseUrl` alias (`@/x`, `@app/x`,
 * `~/x`, `src/x`), because no manifest declares them (#4532 round 5: the
 * enumerated form this replaced refused the spellings it listed and demoted
 * every alias it did not, two rounds running). The cost is named: an
 * undeclared or misspelled import stays blocking in an uninstalled worktree,
 * which is the truth, since installing would not fix it.
 *
 * The one "we do not know" path changes nothing: an unreadable directory in the
 * walk-up, an absent, unreadable or malformed `package.json`, a message the
 * admitted parse cannot read, or a diagnostic whose producer cannot be named
 * leaves the finding at its published severity. An unanswered question is not
 * a verdict (AGENTS shape 10).
 */

import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import type { LSPDiagnostic } from "./client.js";
import { incrementDegradationCount } from "../degradation-ledger.js";
import { logLatency } from "../latency-logger.js";

/**
 * The stable, greppable half of the label. A finding that survives at reduced
 * authority says so in its own text, so no downstream renderer has to be taught
 * about the demotion separately (the same contract `INFERRED_PROJECT_MARKER`
 * carries).
 */
export const ENVIRONMENT_GAP_MARKER =
	"no dependency install resolved for this workspace";

/** The full label appended to a demoted diagnostic's message. */
export const ENVIRONMENT_GAP_NOTICE = `[${ENVIRONMENT_GAP_MARKER}; install the project's dependencies (npm ci, pnpm install, …) and the server picks them up on its next restart]`;

/**
 * `source` values the classic typescript-language-server stamps on its own
 * diagnostics. Auxiliary servers sharing the same result (opengrep, typos,
 * zizmor, ast-grep) carry their own source and are NOT affected by a tsconfig
 * or install gap, so they keep their severity.
 */
const TYPESCRIPT_DIAGNOSTIC_SOURCES = new Set(["typescript", "ts", "tsserver"]);

/**
 * Whether a diagnostic came from the TypeScript server. Both demotions in
 * `demoteLanguageServerRows` (`inferred-project.ts`) refuse every other
 * producer's findings through this one predicate.
 */
export function isTypeScriptSourcedDiagnostic(d: LSPDiagnostic): boolean {
	return TYPESCRIPT_DIAGNOSTIC_SOURCES.has((d.source ?? "").toLowerCase());
}

/** The registered id of the server whose ambient declarations are at stake. */
const TYPESCRIPT_SERVER_ID = "typescript";

/** Walk-up levels one environment question may stat (fail closed past it). */
export const ENV_NODE_MODULES_WALK_MAX_LEVELS = 32;

/**
 * `node`'s own global declarations, all of which live in `@types/node`. A
 * missing name is only an environment gap when it is one of these; every other
 * name is a real reference error. Kept as one closed list rather than a regex
 * so an unlisted spelling stays blocking.
 */
export const NODE_GLOBALS: ReadonlySet<string> = new Set([
	"process",
	"Buffer",
	"require",
	"module",
	"exports",
	"__dirname",
	"__filename",
	"global",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"setImmediate",
	"clearImmediate",
	"queueMicrotask",
	"structuredClone",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"AbortController",
	"AbortSignal",
	"fetch",
	"performance",
]);

/** `Cannot find module '<specifier>' or its corresponding type declarations.` */
const MISSING_MODULE = /^Cannot find module '([^']+)'/;
/** `Cannot find namespace '<name>'.` */
const MISSING_NAMESPACE = /^Cannot find namespace '([^']+)'/;
/** `Cannot find name '<name>'.` */
const MISSING_NAME = /^Cannot find name '([^']+)'/;

/** The namespace `@types/node` declares and nothing else in a TS project does. */
const NODE_NAMESPACE = "NodeJS";

/**
 * Codes this gate can demote at all; every other code stays blocking.
 *
 * 2580/2591 are TypeScript's own "do you need to install type definitions for
 * node?" forms of 2304 for the main Node globals (`process`, `require`,
 * `Buffer`, `module`): the checker reports those four with 2580, or 2591 when
 * `compilerOptions.types` is set, never with 2304 (#4532 round 3, CodeRabbit).
 */
const ENVIRONMENT_GAP_CODES = new Set([2307, 2503, 2304, 2580, 2591]);

/** The codes whose message is `Cannot find name '<name>'.` */
type MissingNameCode = 2304 | 2580 | 2591;

/** The manifest fields whose names a dependency install provides. */
const DECLARING_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

/**
 * The package a module specifier names: `@scope/name` for a scoped one, its
 * first segment otherwise. A project path yields a name no manifest declares
 * (`.`, an empty segment, `#internal`, `~`, `src`), so it needs no case of its
 * own; `@/x` (an empty scope) yields none at all.
 */
function packageNameOf(specifier: string): string | undefined {
	if (specifier.startsWith("@")) return /^@[^/]+\/[^/]+/.exec(specifier)?.[0];
	return specifier.split("/")[0];
}

/**
 * A package-name spelling: an optional `@scope/` and a name, neither empty nor
 * led by `.` or `_`, over npm's URL-safe characters. Capitals stay admitted
 * for legacy names (`JSONStream`), and `~` for yarn's `"~": "link:./src"`.
 * Everything else (`""`, `"."`, `"C:"`, an empty `@types/` stem) is a key no
 * install creates, and admitting it would demote a project path.
 */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9~-][\w.~-]*\/)?[A-Za-z0-9~-][\w.~-]*$/;

function admitPackageName(names: Set<string>, name: string): void {
	if (PACKAGE_NAME.test(name)) names.add(name);
}

/**
 * Every package name declared by a `package.json` at or above `startDir`, over
 * the same bounded walk the install lookup uses: an install at any level
 * resolves upward, so a name an ancestor manifest declares (a monorepo root's
 * hoisted devDependency) is one the install would provide. A declared
 * `@types/foo` also declares `foo`, and `@types/scope__bar` declares
 * `@scope/bar`: the types package is what an absent install leaves missing.
 */
function declaredPackageNames(startDir: string): Set<string> {
	const names = new Set<string>();
	let dir = path.resolve(startDir);
	for (let level = 0; level < ENV_NODE_MODULES_WALK_MAX_LEVELS; level++) {
		try {
			const manifest = JSON.parse(
				fs.readFileSync(path.join(dir, "package.json"), "utf8"),
			) as Record<string, Record<string, unknown> | null | undefined>;
			for (const field of DECLARING_FIELDS) {
				const declared = manifest[field];
				// A field declares names only as an object; an array or a string
				// would hand its index keys in as names.
				if (typeof declared !== "object" || declared === null) continue;
				if (Array.isArray(declared)) continue;
				for (const name of Object.keys(declared)) {
					admitPackageName(names, name);
					if (!name.startsWith("@types/")) continue;
					const stem = name.slice("@types/".length);
					admitPackageName(
						names,
						stem.includes("__") ? `@${stem.replace("__", "/")}` : stem,
					);
				}
			}
		} catch {
			// none: an absent, unreadable or malformed manifest declares nothing,
			// so a specifier only it could have admitted stays blocking (fail
			// closed). The demotion's own record is `lsp-environment-gap-demoted`.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return names;
}

/** What `environmentGapKind` admits: the code, and a missing module's specifier. */
interface EnvironmentGapCandidate {
	code: 2307 | 2503 | MissingNameCode;
	/** TS2307 only: the specifier, admitted later against the root's manifests. */
	specifier?: string;
}

/**
 * Whether this diagnostic has an environment gap's (code, operand) shape.
 * Returns what it admitted, `undefined` otherwise, so the caller records what
 * fired rather than re-deriving it. A TS2307 is only a CANDIDATE here: its
 * specifier is admitted against the root's manifests once the install lookup
 * has answered (see `demoteEnvironmentGapDiagnostics`).
 */
export function environmentGapKind(
	diagnostic: LSPDiagnostic,
): EnvironmentGapCandidate | undefined {
	if (diagnostic.severity !== 1) return undefined;
	if (!isTypeScriptSourcedDiagnostic(diagnostic)) return undefined;
	if (
		diagnostic.serverId !== undefined &&
		diagnostic.serverId !== TYPESCRIPT_SERVER_ID
	)
		return undefined;
	const code = Number(diagnostic.code);
	if (!ENVIRONMENT_GAP_CODES.has(code)) return undefined;
	const message = diagnostic.message.trim();
	if (code === 2307) {
		const specifier = MISSING_MODULE.exec(message)?.[1];
		return specifier === undefined ? undefined : { code, specifier };
	}
	if (code === 2503) {
		return MISSING_NAMESPACE.exec(message)?.[1] === NODE_NAMESPACE
			? { code }
			: undefined;
	}
	const name = MISSING_NAME.exec(message)?.[1];
	return name !== undefined && NODE_GLOBALS.has(name)
		? { code: code as MissingNameCode }
		: undefined;
}

/**
 * Whether some directory at or above `startDir` holds a `node_modules` entry.
 *
 * The walk starts at the file's own directory and continues ABOVE the client
 * root, because `node` and tsserver both resolve upward past it: an install one
 * level above the server's root still resolves the file's imports, so demoting
 * there would hide a real blocker. A symlink that does not resolve stats as
 * absent, which is the reported case — the worktree's `node_modules` was
 * dangling or missing, and a dangling link is no install.
 *
 * Fail-closed direction: a directory that cannot be statted for a reason other
 * than absence (permissions, I/O) answers "resolvable", so the finding keeps its
 * published severity.
 */
export function hasResolvableNodeModules(
	startDir: string,
	stat: (candidate: string) => fs.Stats = (candidate) => fs.statSync(candidate),
): boolean {
	let dir = path.resolve(startDir);
	for (let level = 0; level < ENV_NODE_MODULES_WALK_MAX_LEVELS; level++) {
		try {
			stat(path.join(dir, "node_modules"));
			return true;
		} catch (err) {
			// none: this catch answers the walk's own question (absent vs
			// unreadable) instead of swallowing a failure — an unreadable ancestor
			// returns true, so the finding keeps its published severity. The
			// demotion's own record is `lsp-environment-gap-demoted`.
			// Unreadable is not absent: keep the finding blocking. Only ENOENT is
			// absence; ENOTDIR (a walk level that is not a directory) is a path no
			// diagnostic names, so it gets the unanswered verdict too (#4532 r5).
			if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
				return true;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	// The cap is a depth bound, not a verdict: an unbounded ancestry could still
	// hold an install, so past it the question is unanswered and the finding
	// stays blocking.
	return true;
}

export interface EnvironmentGapOptions {
	filePath: string;
	/**
	 * Test seam: the directory the walk-up starts from. Defaults to the file's
	 * own directory, which is where `node`'s own resolution starts.
	 */
	startDir?: string;
	/** Test seam: the `stat` the walk-up uses. */
	stat?: (candidate: string) => fs.Stats;
}

/**
 * Pure transform: demote every admitted environment gap to a warning and append
 * the label. Warnings, hints, auxiliary-sourced findings and every refused form
 * are returned untouched.
 *
 * Returns the SAME array reference when nothing changed, so callers can cheaply
 * skip rebuilding their result objects (the contract
 * `demoteInferredProjectDiagnostics` already follows).
 */
export function demoteEnvironmentGapDiagnostics(
	diagnostics: LSPDiagnostic[],
	options: EnvironmentGapOptions,
): LSPDiagnostic[] {
	const candidates = new Map<LSPDiagnostic, EnvironmentGapCandidate>();
	for (const diagnostic of diagnostics) {
		const kind = environmentGapKind(diagnostic);
		if (kind !== undefined) candidates.set(diagnostic, kind);
	}
	if (candidates.size === 0) return diagnostics;
	// One filesystem question per file, asked only when a demotion could act.
	const startDir = options.startDir ?? path.dirname(options.filePath);
	if (hasResolvableNodeModules(startDir, options.stat)) return diagnostics;
	// A missing module is an install gap only in the two known-good forms; the
	// manifests are read once, and only when a non-built-in candidate asks.
	let declared: Set<string> | undefined;
	const admitted = new Map<LSPDiagnostic, EnvironmentGapCandidate["code"]>();
	for (const [diagnostic, { code, specifier }] of candidates) {
		if (specifier !== undefined && !isBuiltin(specifier)) {
			declared ??= declaredPackageNames(startDir);
			const name = packageNameOf(specifier);
			if (name === undefined || !declared.has(name)) continue;
		}
		admitted.set(diagnostic, code);
	}
	if (admitted.size === 0) return diagnostics;
	const startedAt = Date.now();
	const counts = new Map<number, number>();
	const demoted = diagnostics.map((diagnostic) => {
		const kind = admitted.get(diagnostic);
		if (kind === undefined) return diagnostic;
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
		return {
			...diagnostic,
			severity: 2 as const,
			message: `${diagnostic.message} ${ENVIRONMENT_GAP_NOTICE}`,
		};
	});
	for (const [code, count] of counts) {
		// One record per admitted code per session: the count carries the repeat,
		// as every bounded degradation does.
		incrementDegradationCount({
			kind: "lsp-environment-gap-demoted",
			subject: String(code),
			reason: `TS${code} from a root with no resolvable node_modules: the finding keeps its line and loses blocking authority while the dependencies are absent`,
			metadata: { code, count, filePath: options.filePath },
		});
	}
	logLatency({
		type: "phase",
		phase: "lsp_environment_gap_demote",
		filePath: options.filePath,
		durationMs: Date.now() - startedAt,
		metadata: {
			demoted: demoted.length - (diagnostics.length - admitted.size),
			considered: diagnostics.length,
			codes: [...counts.keys()].sort((a, b) => a - b).join(","),
		},
	});
	return demoted;
}
