/**
 * #4509: which of a covered run's findings its answering lane already
 * delivers. napi runs beside the ast-grep server while it holds a recorded
 * blocker (Gate B); where the server flagged the same rule on the same line,
 * at least as severely, the server's copy stands for napi's, so the one
 * finding is listed once. The dispatcher applies it to a run's delivery and
 * the collect-later settle to what a settled run records and observes.
 *
 * Keyed by line and rule, never line alone (#4529 review, probe P45): a team
 * sgconfig's server flags its own rules, so another rule on napi's blocker
 * line is another finding, and a downgraded copy of the same rule would turn
 * napi's blocker into a warning.
 */

import { normalizeRuleId } from "./rule-id-normalize.js";
import type { Diagnostic, OutputSemantic } from "./types.js";

export function semanticRank(semantic: OutputSemantic): number {
	if (semantic === "blocking") return 4;
	if (semantic === "warning") return 3;
	if (semantic === "fixed") return 2;
	if (semantic === "silent") return 1;
	return 0;
}

/** The server's `ast-grep:<id>` and napi's `<id>` name one rule. */
function laneKey(d: Diagnostic): string {
	return `${d.line ?? 1}\0${normalizeRuleId(d.rule ?? "")}`;
}

/**
 * @returns whether a finding of the covered run is one `lane` delivers: the
 * same rule on the same line, at a semantic at least as severe.
 */
export function laneCopyStandsFor(
	lane: readonly Diagnostic[],
): (d: Diagnostic) => boolean {
	const rankByKey = new Map<string, number>();
	for (const d of lane) {
		const key = laneKey(d);
		rankByKey.set(
			key,
			Math.max(rankByKey.get(key) ?? 0, semanticRank(d.semantic)),
		);
	}
	return (d) => (rankByKey.get(laneKey(d)) ?? -1) >= semanticRank(d.semantic);
}
