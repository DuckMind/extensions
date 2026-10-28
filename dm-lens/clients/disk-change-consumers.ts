/**
 * #4535 slice 3: the consumer census. Every consumer of a disk change dm-lens
 * did not author, against every detector that can publish one.
 *
 * The publisher ({@link ./disk-changes.ts}) delivers a change to its
 * subscribers and, through the sequence it allocates, to the consumers that
 * read `projectSeq`/`fileSeq`. A consumer nobody wired used to be invisible: the
 * HEAD look, the out-of-band look and the heartbeat each reached whatever their
 * author remembered, and the gaps were found one audit at a time. This table
 * makes a missing wire a failing test instead. `tests/clients/
 * disk-change-census-4535.test.ts` fails when
 *
 * - a consumer has no cell for an origin (the type forces it), a `subscriber`
 *   cell does not match what {@link ensureDiskChangeSubscribers} registered, or a
 *   registered subscriber has no row;
 * - a consumer's anchor symbol is gone from its file, so the row describes code
 *   that no longer exists;
 * - a cell claims anything but `subscriber`, `fed`, `pull`, `n/a` or `pending`,
 *   or gives no reason.
 *
 * A `pending` cell is a known gap with its remainder named. The test pins their
 * count, so a wire that lands removes an entry and a new gap is a deliberate
 * edit, not a silent one. Evidence for every `fed`, `pull` and `n/a` cell is the
 * audit of 2026-10-16 (#4535, first and second comments) unless the reason
 * names a closer one.
 */
import { DISK_CHANGE_ORIGINS, type DiskChangeOrigin } from "./disk-changes.js";

/** How a consumer learns about a change from one origin. */
export type ConsumerWire =
	| { wire: "subscriber" }
	| { wire: "fed"; by: string }
	| { wire: "pull"; why: string }
	| { wire: "n/a"; why: string }
	| { wire: "pending"; gap: string };

export interface DiskChangeConsumer {
	id: string;
	/** The file, and the symbol in it, that answers "is this still fresh?". */
	anchor: { file: string; symbol: string };
	kind: "refresher" | "marker";
	/** The publisher registration id, when the consumer subscribes. */
	subscriberId?: string;
	cells: Record<DiskChangeOrigin, ConsumerWire>;
}

const subscriber: ConsumerWire = { wire: "subscriber" };
const fed = (by: string): ConsumerWire => ({ wire: "fed", by });
const pull = (why: string): ConsumerWire => ({ wire: "pull", why });
const na = (why: string): ConsumerWire => ({ wire: "n/a", why });
const pending = (gap: string): ConsumerWire => ({ wire: "pending", gap });

/** The one remainder every `pending` cell below belongs to. */
const REMAINDER = "#4535 slice 3 remainder";

const SYNTHETIC_WRITE =
	"the bash recovery dispatches a synthetic write, which runs the pi edit path";
const NO_SWEEP_SEQUENCE =
	"the settled sweep replays only the drifted half through the mutation bridge (an unverifiable path is never replayed, and a rejected replay records nothing), so no sequence moves for those paths";
const NO_HEARTBEAT_PUBLISH = `${REMAINDER}: the drift heartbeat publishes nothing yet`;
const NO_HEAD_SEQUENCE =
	"a HEAD move allocates no sequence (#4493: it records no mutation)";
const UNHELD_BY_LSP_CONSUMER =
	"the LSP consumer's held-document phase (resyncHeldDocuments) sends the publish's paths no server holds as exact-URI watched-files events, so a closed module reaches a live primary (#4742)";
const INSTALL_ALLOCATES_NOTHING =
	"a dependency install is unenumerable and allocates no sequence";
const SEQUENCE_BY_PUBLISHER =
	"the out-of-band publish allocates the sequence for declaration paths (an install allocates none)";

/**
 * The same cell for a content-keyed consumer: a changed byte misses, whichever
 * detector saw it.
 */
function contentKeyed(why: string): DiskChangeConsumer["cells"] {
	return Object.fromEntries(
		DISK_CHANGE_ORIGINS.map((origin) => [origin, pull(why)]),
	) as DiskChangeConsumer["cells"];
}

export const DISK_CHANGE_CONSUMERS: readonly DiskChangeConsumer[] = [
	{
		id: "lsp-documents",
		anchor: {
			file: "clients/disk-change-subscribers.ts",
			symbol: "lspSubscriber",
		},
		kind: "refresher",
		subscriberId: "lsp",
		cells: {
			"out-of-band": subscriber,
			"bash-recovery": subscriber,
			"head-move": subscriber,
			"settled-sweep": subscriber,
			"drift-heartbeat": na(
				"the heartbeat is the LSP service's own resync of the drifted document",
			),
		},
	},
	{
		id: "lsp-diagnostics-cache",
		anchor: {
			file: "clients/disk-change-subscribers.ts",
			symbol: "diagnosticsCacheSubscriber",
		},
		kind: "refresher",
		subscriberId: "diagnostics-cache",
		cells: {
			"out-of-band": subscriber,
			"bash-recovery": subscriber,
			"head-move": subscriber,
			"settled-sweep": subscriber,
			"drift-heartbeat": subscriber,
		},
	},
	{
		id: "lsp-unheld-modules",
		anchor: {
			file: "clients/disk-change-subscribers.ts",
			symbol: "resyncHeldDocuments",
		},
		kind: "refresher",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: only declaration files are forwarded to a server; a closed module changed on disk keeps its old bytes in a live primary (#4742)`,
			),
			"bash-recovery": fed(UNHELD_BY_LSP_CONSUMER),
			"head-move": fed(UNHELD_BY_LSP_CONSUMER),
			"settled-sweep": fed(UNHELD_BY_LSP_CONSUMER),
			"drift-heartbeat": na(
				"the heartbeat resyncs the held document it found drifted and has no unheld population",
			),
		},
	},
	{
		id: "read-guard",
		anchor: {
			file: "clients/read-guard.ts",
			symbol: "currentLinesMatchReadSnapshot",
		},
		kind: "refresher",
		cells: contentKeyed(
			"authorship stays agent-only (#4131, #3865); the guard compares the current bytes with its read snapshot at each edit check",
		),
	},
	{
		id: "runner-caches",
		anchor: {
			file: "clients/tree-sitter-client.ts",
			symbol: "TreeSitterClient",
		},
		kind: "refresher",
		cells: contentKeyed(
			"the tree-sitter, napi and rule caches are keyed by content: a changed byte is a miss",
		),
	},
	{
		id: "dispatch-delta-baseline",
		anchor: {
			file: "clients/dispatch/dispatcher.ts",
			symbol: "deltaBaselineFactKey",
		},
		kind: "refresher",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: an install changes what a file resolves to; the baseline keeps the old findings`,
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: after a HEAD move the delta reports pre-existing findings as new`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: no dispatch runs for a swept file, so the baseline is not rewritten`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "inline-blocker-records",
		anchor: {
			file: "clients/blocker-freshness.ts",
			symbol: "sweepInlineBlockerFreshness",
		},
		kind: "marker",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: an install leaves blockers current`,
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: demoted at turn end only; line citations name the old bytes until the next edit`,
			),
			"settled-sweep": pending(`${REMAINDER}: demoted at turn end only`),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "record-carry-position-stale",
		anchor: {
			file: "clients/inline-blocker-fields.ts",
			symbol: "positionStale",
		},
		kind: "marker",
		cells: {
			"out-of-band": na(
				"an install or a declaration change moves no line position",
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: the carried line positions are not re-aligned after a HEAD move (#4529)`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: the carried line positions are not re-aligned after a swept change (#4529)`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "widget-rows",
		anchor: {
			file: "clients/widget-state.ts",
			symbol: "reconcileStaleWidgetFiles",
		},
		kind: "marker",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: the mtime drop does not see an install`,
			),
			"bash-recovery": pull(
				"the render-time mtime and past-EOF check sheds the rewritten file's rows",
			),
			"head-move": pull(
				"the render-time mtime check sheds a rewritten file's rows",
			),
			"settled-sweep": pull(
				"the render-time mtime check sheds a rewritten file's rows",
			),
			"drift-heartbeat": pull(
				"the render-time mtime check sheds a rewritten file's rows",
			),
		},
	},
	{
		id: "widget-dependency-demotion",
		anchor: {
			file: "clients/widget-state.ts",
			symbol: "reconcileStaleWidgetDependencyBlockers",
		},
		kind: "marker",
		cells: {
			"out-of-band": pending(`${REMAINDER}: an install demotes no LSP row`),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: demotion waits for the next read of mode=all`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: demotion waits for the next read of mode=all`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "advisory-and-project-diagnostics",
		anchor: {
			file: "clients/advisory-provenance.ts",
			symbol: "validateAdvisoryProvenance",
		},
		kind: "marker",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: advisory provenance and the project-diagnostics cache ignore an install`,
			),
			"bash-recovery": pull(
				"the provenance hash and the cache reconcile (project-diagnostics/cache.ts) re-read the file",
			),
			"head-move": pull(
				"the provenance hash and the cache reconcile (project-diagnostics/cache.ts) re-read the file",
			),
			"settled-sweep": pull(
				"the provenance hash and the cache reconcile (project-diagnostics/cache.ts) re-read the file",
			),
			"drift-heartbeat": pull(
				"the provenance hash and the cache reconcile (project-diagnostics/cache.ts) re-read the file",
			),
		},
	},
	{
		id: "actionable-warnings-merge",
		anchor: {
			file: "clients/actionable-warnings.ts",
			symbol: "ActionableWarningsReportFile",
		},
		kind: "marker",
		cells: {
			"out-of-band": fed(SEQUENCE_BY_PUBLISHER),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: ${NO_HEAD_SEQUENCE}, so a fileSeq compares equal`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: ${NO_SWEEP_SEQUENCE}, so a fileSeq compares equal`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "cascade-carry-over-supersede",
		anchor: { file: "clients/runtime-turn.ts", symbol: "consumeCascadeRuns" },
		kind: "marker",
		cells: {
			"out-of-band": fed(SEQUENCE_BY_PUBLISHER),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: ${NO_HEAD_SEQUENCE}, so a carried cascade run is never superseded`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: ${NO_SWEEP_SEQUENCE}, so a carried cascade run is never superseded`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "review-graph-and-reverse-deps",
		anchor: {
			file: "clients/review-graph/builder.ts",
			symbol: "updateGraphFiles",
		},
		kind: "refresher",
		cells: {
			"out-of-band": pending(`${REMAINDER}: ${INSTALL_ALLOCATES_NOTHING}`),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(`${REMAINDER}: swept at the next edit cascade only`),
			"settled-sweep": pending(
				`${REMAINDER}: swept at the next edit cascade only`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "review-graph-answers-trust-note",
		anchor: {
			file: "clients/review-graph/builder.ts",
			symbol: "getReviewGraphRevisionDrift",
		},
		kind: "marker",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: an answer carries no note after an install`,
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pull(
				"getReviewGraphRevisionDrift derives the stamped-versus-current HEAD note on every call",
			),
			"settled-sweep": pending(
				`${REMAINDER}: an answer carries no note after a swept change`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "word-index",
		anchor: {
			file: "clients/word-index.ts",
			symbol: "refreshWordIndexIncrementally",
		},
		kind: "refresher",
		cells: {
			"out-of-band": pending(`${REMAINDER}: refreshed at session start only`),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(`${REMAINDER}: refreshed at session start only`),
			"settled-sweep": pending(`${REMAINDER}: refreshed at session start only`),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "project-snapshot",
		anchor: {
			file: "clients/project-snapshot.ts",
			symbol: "isProjectSnapshotFresh",
		},
		kind: "refresher",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: ${INSTALL_ALLOCATES_NOTHING}, so a snapshot stamp reads fresh`,
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: ${NO_HEAD_SEQUENCE}, so a snapshot stamp reads fresh`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: ${NO_SWEEP_SEQUENCE}, so a snapshot stamp reads fresh`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "call-graph-and-codebase-model",
		anchor: { file: "clients/call-graph.ts", symbol: "buildCallGraph" },
		kind: "refresher",
		cells: {
			"out-of-band": pending(`${REMAINDER}: built at session start only`),
			"bash-recovery": pending(
				`${REMAINDER}: built at session start only, even a pi edit leaves it`,
			),
			"head-move": pending(`${REMAINDER}: built at session start only`),
			"settled-sweep": pending(`${REMAINDER}: built at session start only`),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "knip-analysis-memo",
		anchor: { file: "clients/knip-client.ts", symbol: "matchesMemoSignal" },
		kind: "refresher",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: ${INSTALL_ALLOCATES_NOTHING}, so a memo hit serves analysis of the pre-install tree`,
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: ${NO_HEAD_SEQUENCE}, so a memo hit serves analysis of the pre-move tree`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: ${NO_SWEEP_SEQUENCE}, and the memo revalidates package.json and the knip config only`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "formatter-detection-cache",
		anchor: { file: "clients/formatters.ts", symbol: "detectionCache" },
		kind: "refresher",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: an install can add a formatter binary the cache has not seen`,
			),
			"bash-recovery": fed(SYNTHETIC_WRITE),
			"head-move": pending(
				`${REMAINDER}: a moved config file leaves the cached detection`,
			),
			"settled-sweep": pending(
				`${REMAINDER}: a swept config file leaves the cached detection`,
			),
			"drift-heartbeat": pending(NO_HEARTBEAT_PUBLISH),
		},
	},
	{
		id: "workspace-modules-cache",
		anchor: {
			file: "clients/review-graph/workspace-modules.ts",
			symbol: "clearModuleGraphCache",
		},
		kind: "refresher",
		cells: {
			"out-of-band": pending(
				`${REMAINDER}: the workspace-modules cache and the tool-availability latches wait for session start after an install`,
			),
			"bash-recovery": na(
				"only a dependency install changes the module graph or tool availability",
			),
			"head-move": na(
				"only a dependency install changes the module graph or tool availability",
			),
			"settled-sweep": na(
				"only a dependency install changes the module graph or tool availability",
			),
			"drift-heartbeat": na(
				"only a dependency install changes the module graph or tool availability",
			),
		},
	},
];
