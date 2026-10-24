/**
 * The one line-addressing owner for document content (#2066).
 *
 * Two consumers need two different answers about the same bytes, and each used
 * to walk (and allocate) the whole document itself:
 *
 *  - `lfNewlineCount`: how many `\n` the document holds. The `lsp_document_send`
 *    record's `contentLineCount` and the LSP sync bound
 *    (`clients/lsp/content-limits.ts`) both read this count.
 *  - `lastLine`: where the last LSP-addressable line begins, for the
 *    Incremental `didChange` range (#1669).
 *
 * The count needs no terminator knowledge and stays native on every document
 * (`countLfNewlines`); only `lastLine` needs the `\r` rules, and only a
 * document holding a `\r` pays a per-character loop for it. `lineTextAt` reads
 * one line's text out of the same addressing scheme without materializing the
 * others.
 */

/** Where a document's last LSP-addressable line begins (#2066). */
export interface LastLinePosition {
	/** Its 0-based line index. */
	index: number;
	/** Its first character's offset into the document. */
	start: number;
}

export interface DocumentContentScan {
	/** `\n` count — `contentLineCount` is this + 1. */
	lfNewlineCount: number;
	lastLine: LastLinePosition;
}

/**
 * ONE native walk over the document for the `\n` count and the line start the
 * last `\n` leaves behind.
 */
function walkLfLines(content: string): {
	lfNewlineCount: number;
	lastStart: number;
} {
	let lfNewlineCount = 0;
	let lastStart = 0;
	for (
		let i = content.indexOf("\n");
		i !== -1;
		i = content.indexOf("\n", i + 1)
	) {
		lfNewlineCount++;
		lastStart = i + 1;
	}
	return { lfNewlineCount, lastStart };
}

/**
 * The last `\n` walk this module made, so the two consumers of the SAME bytes
 * pay one (#2066 round 3).
 *
 * A send is preceded by the sync bound (`exceedsLspSyncLimits`), which counts
 * this document's `\n` to compare it against the line limit. The send then
 * asked for the same number again. A JS string is immutable, so an equal value
 * proves equal bytes — a hit returns the count of exactly this content, from
 * whichever spelling of it was walked, and different bytes miss and are walked
 * again. One entry, replaced on every miss and never read across documents, so
 * it holds at most one document's text.
 */
let lastNewlineWalk: { content: string; lfNewlineCount: number } | undefined;

/**
 * The document's `\n` count — the answer a bound check or a record asks for,
 * on its own (#2066).
 *
 * A `\r` needs no disambiguation for this number: `\r\n` carries exactly one
 * `\n`, and a lone `\r` carries none, so the count is the `\n` count on every
 * document and this native walk costs an LF document and a CRLF one the same.
 * That is why the sync bound asks THIS function: `scanDocumentContent`'s
 * `\r` branch runs a per-character loop for `lastLine`, and paying it to
 * answer a count made `exceedsLspSyncLimits` 4.6x to 5.5x slower on any
 * document holding a `\r` (review F1: 0.06 -> 0.31 ms at 196 KB).
 *
 * #2066 round 3: the answer is kept for the guard below, because the send that
 * follows this bound check asks for it again.
 */
export function countLfNewlines(content: string): number {
	const lfNewlineCount = walkLfLines(content).lfNewlineCount;
	lastNewlineWalk = { content, lfNewlineCount };
	return lfNewlineCount;
}

/** The `\n` count `walkLfLines` just made for THIS content, if it made one. */
function reusedNewlineCount(content: string): number | undefined {
	return lastNewlineWalk?.content === content
		? lastNewlineWalk.lfNewlineCount
		: undefined;
}

/** Where the last `\n` leaves the final line, without a walk (#2066 round 3). */
function lastLfLineStart(content: string): number {
	const lastNewline = content.lastIndexOf("\n");
	return lastNewline === -1 ? 0 : lastNewline + 1;
}

/**
 * #2066: the ONE full-document walk a send needs. The #1095 sha256 is a second
 * walk and stays; it is native, and it is load-bearing (`clients/lsp/
 * diagnostic-binding.ts`).
 *
 * The two counts below are deliberately NOT the same number and must not be
 * collapsed into one. `lfNewlineCount` counts `\n` only, because its consumers
 * pair against `diagnostic_past_eof`, whose gate counts LF BYTES
 * (`clients/diagnostic-line-freshness.ts`) and against the sync bound's
 * historical `split("\n")` length; merging the conventions would put two
 * records one apart on exactly the mixed-ending documents the pairing exists
 * to debug. `lastLine` uses the full LSP terminator set (`\r\n`, lone `\r`,
 * `\n` — #1669 review F6), because a CRLF or classic-Mac document whose
 * terminators went uncounted computes a range ending mid-document.
 */
export function scanDocumentContent(content: string): DocumentContentScan {
	// #2066 round 3: the sync bound may have counted these exact bytes already.
	// A hit costs no walk at all — see `lastNewlineWalk`.
	const reused = reusedNewlineCount(content);
	// A document with no `\r` (the common case) has exactly one terminator
	// kind, so `lastLine` starts right after the last `\n` and its index is the
	// `\n` count itself.
	if (content.indexOf("\r") === -1) {
		if (reused !== undefined) {
			return {
				lfNewlineCount: reused,
				lastLine: { index: reused, start: lastLfLineStart(content) },
			};
		}
		const { lfNewlineCount, lastStart } = walkLfLines(content);
		return {
			lfNewlineCount,
			lastLine: { index: lfNewlineCount, start: lastStart },
		};
	}
	// The count is the native one on every document; the per-character loop
	// below is the ONLY cost a `\r` adds, and it computes `lastLine` alone.
	const lfNewlineCount = reused ?? walkLfLines(content).lfNewlineCount;
	let index = 0;
	let start = 0;
	// `charCodeAt`, not `codePointAt` (typescript:S7758, accepted): both are
	// compared against 10/13, which no surrogate unit or astral code point can
	// equal, so they are interchangeable here — but `codePointAt` measured 8%
	// slower on a 400 KiB LF document (0.716 vs 0.663 ms/scan), because every
	// ordinary character pays a surrogate-pair check this loop never uses.
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code !== 10 && code !== 13) continue;
		// `\r\n` is ONE terminator; the `\n` it carries is already in the
		// native count above, so only the terminator index moves here.
		if (code === 13 && content.charCodeAt(i + 1) === 10) i++;
		index++;
		start = i + 1;
	}
	return { lfNewlineCount, lastLine: { index, start } };
}

/**
 * The text of one 0-based line, without splitting the document.
 *
 * `content.split("\n")[line]` materialized every line of the document — one
 * substring per line — to read one of them (#2066: 0.65 ms on a 1.95 MB
 * document, on the diagnostic-conversion call sites). This walks the line
 * boundaries with the native `indexOf` and slices only the line asked for.
 *
 * The semantics are the split's, exactly:
 *  - `\n` is the only separator, so a line keeps a trailing `\r`
 *    (`clients/lsp/edits.ts` clamps for that).
 *  - A line past the end of the document is `""`.
 *  - A negative or non-integer index is `""` — `lines[1.5]` is `undefined` on
 *    the split array, and a fractional index must not round into a real line.
 */
export function lineTextAt(content: string, line: number): string {
	if (!Number.isInteger(line) || line < 0) return "";
	let start = 0;
	for (let current = 0; current < line; current++) {
		const next = content.indexOf("\n", start);
		if (next === -1) return "";
		start = next + 1;
	}
	const end = content.indexOf("\n", start);
	return end === -1 ? content.slice(start) : content.slice(start, end);
}
