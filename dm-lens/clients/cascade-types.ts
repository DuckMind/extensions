import type { Diagnostic } from "./dispatch/types.js";
import type { PrimaryUnavailableCause } from "./lsp/diagnostic-binding.js";
import type {
	CascadeIndeterminate,
	ImpactCascadeResult,
} from "./review-graph/types.js";

export interface CascadeNeighborResult {
	filePath: string;
	reason: "imports" | "calls" | "references" | "fallback";
	diagnostics: Diagnostic[];
	lspTouched: boolean;
	/** The touch did not confirm either clean state or diagnostics. */
	inconclusive?: boolean;
	/**
	 * #1459/#1470: scanners that did NOT look at this file — breaker open, resync
	 * deferred by the fan-out gate, or cut off by the aux grace timer. Present
	 * means "these findings are not a full picture", so a zero-diagnostic
	 * neighbour must not be rendered as a clean leaf. Deliberately separate from
	 * `inconclusive`: the primary answered and its findings stand.
	 */
	unconfirmedServerIds?: string[];
	/**
	 * #4403 round 4 (N2): no primary language server answered for this file,
	 * and why. The cascade names the server in one line instead of listing the
	 * file (clients/cascade-format.ts, `splitCascadeUnansweredPrimaries`).
	 */
	primaryUnavailable?: {
		serverIds: string[];
		cause: PrimaryUnavailableCause;
	};
	durationMs?: number;
}

/**
 * Everything around a cascade section's neighbour block, so turn_end can
 * render the block again for the neighbours a result still owns, with the
 * same frame (#4487). Composed by `composeCascadeSection`
 * (clients/cascade-format.ts).
 */
export interface CascadeSectionLayout {
	/** Language root the neighbour paths display against. */
	cwd: string;
	noun: string;
	includeReason: boolean;
	/** The impact header (`formatImpactCascade`), or "". */
	header: string;
	/** "... and N more dependent file(s)", or "". */
	truncationLine: string;
	/**
	 * #3157 round 3, N1: the line saying the policy input bound cut findings
	 * nobody evaluated, or "". It speaks even when the block is empty.
	 */
	coverageLine: string;
	/** This delivery's disposition drops (#1616 / #3157). */
	policySuppressed: number;
}

/**
 * #4485: the selected neighbours a run touched but got no answer for within
 * its bound, grouped by the server that was asked. Bounded by the selected
 * slice (`CASCADE_NEIGHBOUR_BUDGET`); turn_end caps the paths it shows.
 */
export interface CascadeUnconfirmed {
	count: number;
	servers: Array<{
		serverId: string;
		/** The wait the touch was given, for the pending line's wording. */
		waitMs: number;
		paths: string[];
	}>;
}

/** #4403 round 5 (V1): one line naming primaries that did not answer. */
export interface CascadeUnansweredPrimaryNote {
	serverIds: readonly string[];
	line: string;
}

export interface CascadeResult {
	filePath: string;
	impact: ImpactCascadeResult;
	neighbors: CascadeNeighborResult[];
	formatted: string;
	/**
	 * #4403 round 5 (V1): the lines naming primaries that did not answer,
	 * which `formatted` carries, and `formatted` as it reads without them.
	 * turn_end renders each server's line once per session
	 * (`renderCascadeResult` in clients/cascade-format.ts).
	 */
	unansweredPrimaries?: {
		notes: CascadeUnansweredPrimaryNote[];
		formattedWithoutNotes: string;
	};
	/**
	 * #4487: the frame `formatted` was composed with. turn_end re-renders the
	 * neighbours this result still owns through it; a result without one
	 * renders `formatted` whole.
	 */
	layout?: CascadeSectionLayout;
}

/** Why a cascade run produced no formatted output. */
export type CascadeSkipReason =
	| "blockers" // primary file had blocking diagnostics
	| "non_code" // file kind not eligible for cascade
	| "no_neighbors" // reverse-dep lookup found no importing files
	| "clean" // every selected neighbor answered, none with errors
	| "indeterminate" // #1023: impact could NOT be computed (degraded/cold/missing-node graph) — surfaced as an honest advisory, never as a silent all-clear
	| "error"; // the deferred compute rejected (never surfaced inline)

/**
 * Always-present result of one computeCascadeForFile invocation.
 * result is defined only when formatted output was produced.
 */
export interface CascadeRun {
	filePath: string;
	/** Sequence captured when the write launched this deferred computation. */
	origin?: { turnSeq?: number; writeSeq?: number; projectSeq?: number };
	result: CascadeResult | undefined;
	neighborCount: number;
	diagnosticCount: number;
	/** Preserves selected paths for result-less indeterminate runs; bounded to the selected slice. */
	selectedNeighborPaths?: string[];
	/**
	 * #4485: selected neighbours that got no answer within their bound. A run
	 * carrying it never reads `no_neighbors` or `clean`; turn_end names them
	 * in one advisory line per server.
	 */
	unconfirmed?: CascadeUnconfirmed;
	/**
	 * #4487: the selected neighbours this run freshly observed (a confirmed
	 * touch, a pull, a post-edit snapshot or a publish inside the wait),
	 * clean or not. turn_end clears a neighbour's pending errors on a clean
	 * one and re-serves the rest. Bounded by the selected slice.
	 */
	observedNeighborPaths?: string[];
	skipReason?: CascadeSkipReason;
	/**
	 * #1023: set when the impact compute was DEGRADED/COLD/ERRORED or its
	 * selected neighbor budget omitted eligible dependents (see
	 * {@link CascadeIndeterminate}). Carries the detail the turn-end seam renders
	 * into an honest advisory. Decoupled from `skipReason` so a thrown compute
	 * (`skipReason: "error"`) can surface too.
	 */
	indeterminate?: CascadeIndeterminate;
	/**
	 * #3168 F3: the #1444 publish stamp of the resolved-found observation this
	 * run was built from (`publishedAt`, threaded through the resolved-found
	 * plumb). The carried-render age label renders from it. Absent on the
	 * deferred-compute re-park arm, which has no stamp and falls to the
	 * neutral wording.
	 */
	observedAt?: number;
	/**
	 * #4495 round 3: the earliest moment the content behind this run's
	 * neighbour diagnostics could have been read: the in-lane compute's start
	 * (every touch, pull, post-edit snapshot and fallback reads after it), or
	 * a late answer's pre-notify touch stamp. The pending record keeps it as
	 * `checkedAt`, so a file written after it (by anything pi never saw) is
	 * known to have changed since the check. `observedAt` is the publish stamp
	 * and only labels a carried run's age.
	 */
	checkedAt?: number;
	/**
	 * #1443: how many turn boundaries this run has survived without being
	 * consumed. Stamped by `RuntimeCoordinator.beginTurn` when it carries a run
	 * appended after the previous turn_end's `consumeCascadeRuns` (the
	 * quiet-window reconcile's late re-injection). The carry is bounded to ONE
	 * turn — beginTurn drops (and logs) anything that would reach 2. The
	 * turn-end origin filter does NOT read this field to decide whether to
	 * keep or reject a run (see `getFilesChangedSince` in runtime-turn.ts for
	 * the actual per-file supersede check) — it is carried through only for
	 * observability in the drop log's metadata.
	 */
	carriedTurns?: number;
}

/**
 * How long a cascade neighbour's diagnostics stay usable (#1816), in
 * `clients/lsp/index.ts`'s neighbour-diagnostics cache. #4486: the cascade
 * compute no longer reads it; an observation is current there only when it
 * was published after the compute started (`isPostEditObservation` in
 * clients/dispatch/integration.ts), whatever its age.
 */
export const CASCADE_DIAGNOSTICS_TTL_MS = 240_000;
