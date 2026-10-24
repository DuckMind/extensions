import path from "node:path";
import {
	getLanguageId as getKindLanguageId,
	SPECIAL_FILENAMES,
} from "../file-kinds.js";
import { getLspCapableKinds } from "../language-policy.js";
import {
	EXTENSION_TO_LSP_ID,
	lspLanguageId,
	resolveFilenameLanguage,
} from "../language-registry.js";

/**
 * Language ID Mappings for LSP
 *
 * Maps file extensions to LSP language identifiers.
 */

/**
 * Extension -> LSP `languageId`, projected from the canonical language registry
 * (clients/language-registry.ts, #2424). One FileKind can span several LSP ids
 * (jsts covers typescript/typescriptreact/vue, cxx covers c and cpp) and the
 * protocol spells some of them differently from the canonical id
 * ("shellscript", not "shell"), so the registry carries an `lspId` column and
 * this map is a pure projection of it — `Readonly` because the projection is
 * `Object.freeze`d at the source (#2424 review, S4).
 *
 * #1545 added a derived per-kind fill-in on top of the then-hand-curated table:
 * powershell had no entry at all and cxx covered a third of its extensions, so
 * `didOpen` announced those files as "plaintext". Tolerance for that varies by
 * server — json/yaml/clangd answer the same either way, a DocumentSelector
 * server may not handle the document at all — so the id is sent correctly
 * rather than relied on being ignored. The registry now owns every extension of
 * every lspCapable kind, so that fill-in contributed ZERO entries and is gone
 * (#2424 review, named output a). The net it provided is now a test, not a
 * runtime `??=`: lsp-capable-seam-coverage's "maps every lspCapable kind's
 * extensions to an LSP language id" fails the moment the registry misses one,
 * which is the fix a silent per-kind fallback would have hidden.
 */
export const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> =
	EXTENSION_TO_LSP_ID;

/**
 * file-kinds.ts's basename classifier (Makefile, Dockerfile.<suffix>,
 * CMakeLists.txt, …) matches by regex, not literal filename, so it can't be
 * flattened into LANGUAGE_EXTENSIONS' literal-key map. Derived from
 * SPECIAL_FILENAMES — the same single source of truth detectFileKind() uses —
 * filtered to lspCapable kinds so a basename pattern that classifies into an
 * lspCapable kind always resolves a language id here too (#1594).
 */
const BASENAME_LANGUAGE_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	languageId: string;
}> = (() => {
	const lspCapableKinds = new Set(getLspCapableKinds());
	return SPECIAL_FILENAMES.filter(({ kind }) => lspCapableKinds.has(kind)).map(
		({ pattern, kind }) => ({
			pattern,
			languageId: getKindLanguageId(kind),
		}),
	);
})();

function getBasenameLanguageId(base: string): string | undefined {
	return BASENAME_LANGUAGE_PATTERNS.find(({ pattern }) => pattern.test(base))
		?.languageId;
}

/**
 * Get language ID for a file path
 *
 * Filename-tier first (#4636). The registry declares some files by BASENAME —
 * exact names and closed `<stem>*<tail>` patterns — because their format is a
 * convention rather than a suffix, and `EXTENSION_TO_LSP_ID` cannot answer for
 * them: it is a projection of `extensions` only, so `tsconfig.json` fell
 * through to `.json` and was announced `json`. The JSON language server reads
 * `languageId === 'jsonc'` as "comments are allowed"
 * (vscode-langservers-extracted 4.10.0, lib/json-language-server/jsonServer.js:521),
 * so every upstream comment in that file came back blocking.
 *
 * The filename tier is consulted only for entries that DECLARE a name, so its
 * blast radius is the declared vocabulary itself. Two declared answers move
 * besides the #4636 additions, both toward the registry's own `lspId`: a
 * `Makefile` now takes the `shell` entry's `shellscript` (the protocol spelling
 * every `.sh` file already used) instead of file-kinds.ts's per-kind `shell`,
 * and `terragrunt.hcl`/`root.hcl` answer `terragrunt` instead of `undefined`
 * (no server covers that kind, so no wire carries either).
 */
export function getLanguageId(filePath: string): string | undefined {
	const declared = resolveFilenameLanguage(filePath);
	if (declared) return lspLanguageId(declared);

	const ext = path.extname(filePath).toLowerCase();
	if (ext && LANGUAGE_EXTENSIONS[ext]) {
		return LANGUAGE_EXTENSIONS[ext];
	}

	const base = path.basename(filePath);
	return (
		LANGUAGE_EXTENSIONS[base] ??
		LANGUAGE_EXTENSIONS[base.toLowerCase()] ??
		getBasenameLanguageId(base)
	);
}
