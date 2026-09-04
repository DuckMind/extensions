/**
 * Artifact-safe TUI subset for DM Lens compact renderers.
 *
 * DM's compiled binary owns the full TUI package, while bundled extensions are
 * intentionally shipped without nested node_modules. Lens only needs a mutable
 * text component and terminal-width helpers, so this bridge remains loadable
 * in the published artifact.
 */
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
import type { Component } from "@duckmind/dm-tui";
export type { Component } from "@duckmind/dm-tui";

function printableWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	if (codePoint === 0 || (codePoint >= 0x300 && codePoint <= 0x36f)) return 0;
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6)
	)
		? 2
		: 1;
}

export function visibleWidth(text: string): number {
	return Array.from(text.replace(ANSI_ESCAPE, "")).reduce(
		(width, character) => width + printableWidth(character),
		0,
	);
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleWidth(text))) : text;
	}
	const suffix = visibleWidth(ellipsis) < maxWidth ? ellipsis : "";
	const limit = maxWidth - visibleWidth(suffix);
	let output = "";
	let width = 0;
	for (const character of text.replace(ANSI_ESCAPE, "")) {
		const nextWidth = printableWidth(character);
		if (width + nextWidth > limit) break;
		output += character;
		width += nextWidth;
	}
	output += suffix;
	return pad ? output + " ".repeat(Math.max(0, maxWidth - visibleWidth(output))) : output;
}

export class Text implements Component {
	constructor(
		private text = "",
		private readonly paddingX = 1,
		private readonly paddingY = 1,
	) {}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.text.trim()) return [];
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const margin = " ".repeat(this.paddingX);
		const lines = this.text.replace(/\t/g, "   ").split("\n").map((line) => {
			const rendered = truncateToWidth(line, contentWidth, "", true);
			return truncateToWidth(`${margin}${rendered}${margin}`, width, "", true);
		});
		const padding = Array.from({ length: this.paddingY }, () => " ".repeat(width));
		return [...padding, ...lines, ...padding];
	}
}
