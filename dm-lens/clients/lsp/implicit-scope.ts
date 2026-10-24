/**
 * #4346: files that change another file's diagnostics while no import names
 * them, the part of a file's dependency scope no import graph holds.
 *
 * - A JS or TS file sees the global scope that ambient files feed: a
 *   declaration file, a file with `declare global` or `declare module`, and a
 *   script (a file with no import or export, so its top-level declarations are
 *   global). A new `globals.d.ts` answers `Cannot find name 'FOO'` in a file
 *   that never imports it; no graph build has an edge for it (#4368 probe: the
 *   source walk leaves declaration files out).
 * - A Go file shares its package with every Go file in its directory, and
 *   uses their declarations with no import.
 *
 * {@link implicitScopeOf} is the one membership test. The workspace-diagnostics
 * cache reads it for an entry's dependency scope (`workspace-diagnostics-cache.ts`),
 * the inline-blocker sweep for a blocker's (`blocker-freshness.ts`), and the
 * cascade in the inverse direction, for the files a change reaches
 * (`dispatch/integration.ts`, #4438).
 *
 * #4438 r2: the cache and the other two differ in what a doubt costs. For the
 * cache a member it cannot rule out costs one refusal and one re-touch, so it
 * fails closed ({@link feedsJsTsGlobalScope}, the directory clock of
 * {@link goPackageChangedAt}). The sweep demotes a blocker, which retires it
 * after three deliveries, and the cascade touches files and renders an
 * advisory; both act only on positive evidence: a role
 * {@link classifyJsTsGlobalScope} read as `"feeds"`, a Go peer
 * {@link goPackagePeersOf} admits. The created-module producer announces a
 * Go file's package files to its servers (`created-import-targets.ts`). Other
 * languages' implicit scopes are not modelled; the cache treats their finding
 * entries' scope as unknown.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAstGrepNapiSync, type SgNode } from "../deps/ast-grep-napi.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import { isFileKind } from "../file-kinds.js";
import { isDeclarationFile } from "../generated-artifacts.js";
import { exceedsLspSyncLimits } from "./content-limits.js";

/** Whether `filePath` is a Go source file. */
export function isGoSourceFile(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === ".go";
}

/** Whether `filePath` is a JS or TS file, which sees the TS/JS global scope. */
function seesJsTsGlobalScope(filePath: string): boolean {
	return isFileKind(filePath, "jsts");
}

/**
 * Whether `a` and `b`, both spelled by `normalizeMapKey` (forward slashes on
 * every platform), are Go files of one package directory.
 */
function inOneGoPackage(a: string, b: string): boolean {
	return (
		isGoSourceFile(a) &&
		isGoSourceFile(b) &&
		path.posix.dirname(a) === path.posix.dirname(b)
	);
}

/**
 * #4596: why an implicit-scope question could not be answered. Each cause is
 * also the ledger subject, so the retained population stays bounded while the
 * reason names the file the reader needs (AGENTS shape 9, shape 38).
 */
export type ImplicitScopeUnknownCause =
	/** A Go peer's header could not be opened. */
	| "unreadable-go-peer"
	/** A JS/TS file could not be read. */
	| "unreadable-file"
	/** A directory walked for its Go peers could not be listed. */
	| "unreadable-go-dir"
	/** A directory or peer's mtime could not be read. */
	| "unreadable-mtime"
	/** The parser threw on the file's bytes. */
	| "parse-failed";

/**
 * #4596: record one unresolved implicit-scope decision with its path and its
 * cause. The verdict stays conservative (`"unknown"` feeds the global scope,
 * which makes the diagnostics cache refuse rather than serve); only the
 * silence was the defect — an unreadable module graded `"unknown"` with no
 * row anywhere, so a wrong refusal had no trace (audit probe 1).
 */
function recordUnknownRole(
	filePath: string,
	cause: ImplicitScopeUnknownCause,
	err?: unknown,
): void {
	incrementDegradationCount({
		kind: "lsp-implicit-scope-unknown",
		subject: cause,
		reason: `${cause}: ${filePath}${err === undefined ? "" : ` (${err instanceof Error ? err.message : String(err)})`} — unresolved, so the diagnostics cache refuses its entry and the blocker sweep and the cascade see no role for it`,
		metadata: {
			file: filePath,
			cause,
			...(err === undefined
				? {}
				: { err: err instanceof Error ? err.message : String(err) }),
		},
	});
}

/**
 * The Go files in `dir`, as absolute paths; `undefined` when the directory
 * cannot be read.
 */
export function goPackageFiles(dir: string): string[] | undefined {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		recordUnknownRole(dir, "unreadable-go-dir", err);
		return undefined;
	}
	return entries.flatMap((entry) =>
		entry.isFile() && isGoSourceFile(entry.name)
			? [path.join(dir, entry.name)]
			: [],
	);
}

/**
 * #4438: `filePath`'s implicit scope as a membership test, or `undefined` when
 * it is not modelled (a file neither Go nor JS/TS). The scope of a Go file is
 * the Go files of its directory; of a JS/TS file, every file that feeds the
 * TS/JS global scope (`feeds`, {@link feedsJsTsGlobalScope} unless a caller
 * memoizes it). A file is never in its own scope. `filePath` and every member
 * asked about are `normalizeMapKey` spellings.
 */
export function implicitScopeOf(
	filePath: string,
	feeds: (other: string) => boolean = feedsJsTsGlobalScope,
): ((other: string) => boolean) | undefined {
	if (isGoSourceFile(filePath)) {
		return (other) => other !== filePath && inOneGoPackage(filePath, other);
	}
	if (seesJsTsGlobalScope(filePath)) {
		return (other) => other !== filePath && feeds(other);
	}
	return undefined;
}

/**
 * #4346, moved here by #4438: when the Go package in `dir` last changed, for
 * the diagnostics cache: the directory's own mtime (a file added, removed or
 * renamed) or the newest Go file's. `undefined` when the directory or a file
 * cannot be stat'ed, which the cache reads as changed.
 */
export function goPackageChangedAt(dir: string): number | undefined {
	try {
		let changedAt = fs.statSync(dir).mtimeMs;
		for (const peer of goPackageFiles(dir) ?? []) {
			changedAt = Math.max(changedAt, fs.statSync(peer).mtimeMs);
		}
		return changedAt;
	} catch (err) {
		recordUnknownRole(dir, "unreadable-mtime", err);
		return undefined;
	}
}

/** Bytes of a Go file read for its build line and package clause. */
const GO_HEADER_BYTES = 8 * 1024;

/** `GOOS` values (`go tool dist list`), for build lines and file names. */
const KNOWN_GOOS = new Set(
	"aix android darwin dragonfly freebsd hurd illumos ios js linux netbsd openbsd plan9 solaris wasip1 windows zos".split(
		" ",
	),
);
/** `GOARCH` values (`go tool dist list`). */
const KNOWN_GOARCH = new Set(
	"386 amd64 arm arm64 loong64 mips mips64 mips64le mipsle ppc64 ppc64le riscv64 s390x wasm".split(
		" ",
	),
);
const GOOS_BY_PLATFORM: Record<string, string> = {
	win32: "windows",
	sunos: "solaris",
};
const GOARCH_BY_ARCH: Record<string, string> = { x64: "amd64", ia32: "386" };
const UNIX_GOOS = new Set(
	"aix android darwin dragonfly freebsd hurd illumos ios linux netbsd openbsd solaris".split(
		" ",
	),
);

/** Whether the host's Go build (`GOOS`/`GOARCH`, else the platform) satisfies `tag`. */
function hostSatisfiesGoTag(tag: string): boolean {
	const goos =
		process.env.GOOS || GOOS_BY_PLATFORM[process.platform] || process.platform;
	const goarch =
		process.env.GOARCH || GOARCH_BY_ARCH[process.arch] || process.arch;
	return (
		tag === goos || tag === goarch || (tag === "unix" && UNIX_GOOS.has(goos))
	);
}

/**
 * Whether a Go file is not known to be in the host's build: left out by a
 * `_GOOS`, `_GOARCH` or `_GOOS_GOARCH` file-name suffix or by a `//go:build`
 * line of one OS, architecture or `unix` term (`windows`, `!linux`), or
 * carrying a constraint this does not evaluate: a compound line, a tag that
 * names no OS or architecture (`ignore`, `go1.21`), or a legacy `// +build`
 * line with no `//go:build` line. #4438 r3: an undecided constraint is no
 * evidence, so a built compound peer does not demote (stated trade-off).
 */
function goBuildExcludesHost(filePath: string, header: string): boolean {
	const parts = path
		.basename(filePath, ".go")
		.replace(/_test$/, "")
		.split("_");
	const last = parts.at(-1) ?? "";
	const prev = parts.length > 2 ? (parts.at(-2) ?? "") : "";
	if (parts.length > 1 && KNOWN_GOARCH.has(last)) {
		if (!hostSatisfiesGoTag(last)) return true;
		if (KNOWN_GOOS.has(prev) && !hostSatisfiesGoTag(prev)) return true;
	} else if (
		parts.length > 1 &&
		KNOWN_GOOS.has(last) &&
		!hostSatisfiesGoTag(last)
	) {
		return true;
	}
	const line = /^\/\/go:build[ \t](.*)$/m.exec(header);
	if (!line) return /^\/\/[ \t]*\+build[ \t]/m.test(header);
	const term = /^\s*(!?)([\w.]+)\s*$/.exec(line[1]!);
	const tag = term?.[2] ?? "";
	if (!(KNOWN_GOOS.has(tag) || KNOWN_GOARCH.has(tag) || tag === "unix"))
		return true;
	return hostSatisfiesGoTag(tag) === (term?.[1] === "!");
}

/** The first `GO_HEADER_BYTES` of a Go file, or `undefined` when unreadable. */
function goHeaderOf(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(GO_HEADER_BYTES);
		const read = fs.readSync(fd, buffer, 0, GO_HEADER_BYTES, 0);
		return buffer.toString("utf8", 0, read);
	} catch (err) {
		recordUnknownRole(filePath, "unreadable-go-peer", err);
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** The package clause of a Go file's header, comments skipped. */
function goPackageClauseOf(header: string): string | undefined {
	const code = header
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, "");
	return /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(code)?.[1];
}

/**
 * #4438 r2: the Go files whose write is evidence that `filePath`'s verdict
 * may have changed, as a membership test over `normalizeMapKey` spellings, or
 * `undefined` when `filePath` is not Go or its package clause cannot be read.
 * A peer counts when {@link implicitScopeOf} holds it, it reads, it has the
 * same package clause (so `package p_test` does not), it is not a `_test.go`
 * file unless `filePath` is one (a test file is compiled only into the test
 * variant), and the host build includes it ({@link goBuildExcludesHost}).
 * An unreadable peer, a deleted one included, is no evidence.
 */
export function goPackagePeersOf(
	filePath: string,
): ((peer: string) => boolean) | undefined {
	const inScope = isGoSourceFile(filePath)
		? implicitScopeOf(filePath)
		: undefined;
	const ownHeader = inScope && goHeaderOf(filePath);
	const clause = ownHeader ? goPackageClauseOf(ownHeader) : undefined;
	if (!inScope || !clause) return undefined;
	const testFile = isGoTestFile(filePath);
	return (peer) => {
		if (!inScope(peer) || (isGoTestFile(peer) && !testFile)) return false;
		const header = goHeaderOf(peer);
		return (
			header !== undefined &&
			goPackageClauseOf(header) === clause &&
			!goBuildExcludesHost(peer, header)
		);
	};
}

function isGoTestFile(filePath: string): boolean {
	return filePath.toLowerCase().endsWith("_test.go");
}

/** What a parse of `filePath` must look for, by extension. */
type GlobalScopeProbe = "ts-script-or-ambient" | "ambient" | "js-script";

function probeFor(filePath: string): GlobalScopeProbe | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".ts":
		case ".tsx":
			return "ts-script-or-ambient";
		// ES and CommonJS module extensions: never a script, but a TS one can
		// still hold `declare global`.
		case ".mts":
		case ".cts":
			return "ambient";
		case ".js":
		case ".jsx":
			return "js-script";
		default:
			return undefined;
	}
}

/**
 * #4438 r2: a file's role in the TS/JS global scope. `"unknown"` when no
 * answer could be read: the file is unreadable or over the LSP sync limits,
 * the parser does not load, or the parse fails.
 */
export type GlobalScopeRole = "feeds" | "none" | "unknown";

/**
 * #4438 r2: the role `filePath`'s name decides with no read (a declaration
 * file always feeds; a file no parse probes, such as `.mjs`, `.vue` or a
 * non-JS/TS file, never does), or `undefined` when a parse must decide.
 */
export function globalScopeRoleByName(
	filePath: string,
): GlobalScopeRole | undefined {
	if (isDeclarationFile(filePath)) return "feeds";
	return probeFor(filePath) ? undefined : "none";
}

/** A line that opens with an ES `import` or `export`. */
const MODULE_LINE = /^[ \t]*(?:import|export)\b/m;
/** An ambient declaration that feeds the global scope from a module. */
const AMBIENT_DECLARATION = /\bdeclare\s+(?:global|module)\b/;

/**
 * #4438 r2: a module's role read from its text with no parse: a line that
 * opens with `import` or `export`, and no `declare global` or `declare
 * module` anywhere, answers `"none"`; otherwise `undefined` (a parse
 * decides). A comment or string line opening with `export` can make a script
 * read as a module, so only a caller that acts on `"feeds"` alone may use it
 * (the blocker sweep, which then keeps a blocker); the cache's fail-closed
 * answer never does.
 */
export function globalScopeRoleByText(
	content: string,
): GlobalScopeRole | undefined {
	return MODULE_LINE.test(content) && !AMBIENT_DECLARATION.test(content)
		? "none"
		: undefined;
}

/**
 * Whether `filePath` feeds the TS/JS global scope. A declaration file always
 * counts. A TS file counts when it is a script or holds `declare global` or
 * `declare module`; a `.js`/`.jsx` file when it is a script with no CommonJS
 * marker (`require(...)`, `module.exports`, `exports.x`), which TypeScript
 * treats as a module. `.mjs`, `.cjs`, Vue and Svelte files never count.
 * A parser that does not load is recorded once per session.
 */
export function classifyJsTsGlobalScope(filePath: string): GlobalScopeRole {
	const byName = globalScopeRoleByName(filePath);
	if (byName) return byName;
	const probe = probeFor(filePath)!;
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		recordUnknownRole(filePath, "unreadable-file", err);
		return "unknown";
	}
	if (exceedsLspSyncLimits(content).tooLarge) return "unknown";
	const napi = loadAstGrepNapiSync();
	if (!napi) {
		recordDegradationOnce({
			kind: "ast-grep-napi-unavailable",
			subject: "implicit-scope",
			reason:
				"native addon failed to load; every created JS/TS file counts as feeding the global scope in the diagnostics cache, and its role is unknown to the blocker sweep and the cascade",
		});
		return "unknown";
	}
	const lang =
		probe === "js-script"
			? napi.Lang.JavaScript
			: path.extname(filePath).toLowerCase() === ".tsx"
				? napi.Lang.Tsx
				: napi.Lang.TypeScript;
	let root: SgNode;
	try {
		root = napi.parse(lang, content).root();
	} catch (err) {
		recordUnknownRole(filePath, "parse-failed", err);
		return "unknown";
	}
	let isModule = false;
	for (const child of root.children()) {
		const kind = child.kind();
		if (kind === "import_statement" || kind === "export_statement") {
			isModule = true;
		} else if (
			kind === "ambient_declaration" &&
			child
				.children()
				.some((part) => part.kind() === "global" || part.kind() === "module")
		) {
			return "feeds";
		}
	}
	if (probe === "ambient" || isModule) return "none";
	if (probe === "js-script") {
		return ["require($$$ARGS)", "module.exports", "exports.$NAME"].some(
			(pattern) => root.find(pattern) !== null,
		)
			? "none"
			: "feeds";
	}
	return "feeds";
}

/**
 * The diagnostics cache's answer: {@link classifyJsTsGlobalScope}, failing
 * closed, so an unknown role counts as feeding and the cache refuses rather
 * than serves.
 */
export function feedsJsTsGlobalScope(filePath: string): boolean {
	return classifyJsTsGlobalScope(filePath) !== "none";
}
