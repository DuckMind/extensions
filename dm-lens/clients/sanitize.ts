/**
 * Tool Output Sanitization for dm-lens
 *
 * Cleans and normalizes tool output for display to users.
 * Removes ANSI codes.
 */

// --- Constants ---

// ANSI escape codes for colors and formatting
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is the literal ANSI escape-sequence lead byte this pattern strips, not accidental input.
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
// Full ECMA-48 CSI grammar (parameter bytes 0-9;? , intermediate bytes
// space-/, final byte @-~) — matches every CSI sequence ANSI_ESCAPE does
// plus non-SGR ones (cursor moves, private-mode `?` sequences like
// `\x1b[?25l`, etc.), not just the `m`-terminated color codes.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is the literal ANSI escape-sequence lead byte this pattern strips, not accidental input.
const ANSI_ESCAPE_EXTENDED = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Remove ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, "").replace(ANSI_ESCAPE_EXTENDED, "");
}
