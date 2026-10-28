/**
 * #4535: one publisher for disk changes dm-lens did not author.
 *
 * Five push detectors notice such a change (opaque bash recovery, the HEAD
 * look, the out-of-band look, the observed-mutation settled sweep, the LSP
 * drift heartbeat). Before this module each one hand-wired its own set of
 * consumers, so the review graph, the word index, the project snapshot and the
 * diagnostics cache only learned about a change if that particular detector
 * happened to know about them — after a HEAD move or an external edit they
 * served old bytes while LSP resynced, and an enumerable external change moved
 * no `projectSeq`, so `isProjectSnapshotFresh` read the stale snapshot as
 * fresh. (A change no detector can enumerate — a dependency install — still
 * moves no sequence: what a snapshot stamp means for one is #4535 slices 2 and
 * 3, not this module.)
 *
 * A detector now calls {@link publishDiskChange} with what it saw. The
 * publisher:
 * 1. allocates the EXISTING project sequence through
 *    `RuntimeCoordinator.recordProjectMutations` (one locked append for the
 *    whole recorded population, `source: "external"`), never a second sequence
 *    space — five consumers already compare their state against `projectSeq`,
 *    and a parallel counter would make every snapshot read fresh;
 * 2. fans one {@link DiskChange} out to every registered subscriber, isolated
 *    one from another;
 * 3. returns the record and each subscriber's opaque answer, so an awaited
 *    caller (the out-of-band look's restart count) can order its own work.
 *
 * Invariants (audit §3.3):
 * - the detector commits its own per-root record BEFORE publishing (I1);
 * - the sequence is allocated BEFORE the fan-out, so one `seq` and one `at`
 *   describe the same event for every consumer (I2);
 * - the caller owns the await: the publisher awaits its subscribers, and the
 *   detector decides whether the hook waits for that under its own bound (I3);
 * - the publisher writes the sequence and the change log only. Authorship,
 *   turn state, the format queue and the dispatch delta stay agent-only: an
 *   incoming change never credits authorship (#4131) and moves no FileTime
 *   (#3865) (I4);
 * - a throwing subscriber is isolated and recorded once per consumer per root
 *   per session (I5).
 *
 * The registry is process-wide, like the per-root records the out-of-band look
 * keeps: a subscriber describes the disk, not a session, and two sessions on
 * one root share it. It is bounded by construction (one entry per registered
 * consumer id; publishing grows nothing).
 */
import type { ContentStamp } from "./content-stamp.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";
import type { ProjectChangeSource } from "./project-changes.js";

/**
 * Which detector observed the change. The list is the one source of the
 * origin type, the subscriber declarations and the consumer census
 * (`clients/disk-change-consumers.ts`): a detector added here is a cell every
 * consumer row must answer.
 */
export const DISK_CHANGE_ORIGINS = [
	"out-of-band",
	"bash-recovery",
	"head-move",
	"settled-sweep",
	"drift-heartbeat",
] as const;
export type DiskChangeOrigin = (typeof DISK_CHANGE_ORIGINS)[number];

/**
 * The evidence the detector holds (`AGENTS.md` shape 10: a skip has a verdict
 * only with a stated reason, and "not reproduced" needs evidence):
 * - `observed` — the detector read the bytes (bash content diff, settled-sweep
 *   hash, drift fingerprint);
 * - `inferred` — the detector saw only an identity/size/mtime/HEAD change (an
 *   install stamp, a HEAD delta, a declaration stat walk). An `inferred` change
 *   may never be used to confirm a finding "not reproduced"; a marker that
 *   subscribes to both kinds confirms with its own content check.
 */
export type DiskChangeKind = "observed" | "inferred";

/** A path's typed change, in the detector's own spelling. */
export interface DiskPathChange {
	/** As the detector saw it: an LSP watched-files event is a URI. */
	filePath: string;
	type: "created" | "changed" | "deleted";
}

export interface DiskChange {
	/**
	 * The project sequence after the batch's allocation (0 when nothing was
	 * allocated: an unenumerable change, or a publisher called without a
	 * runtime). A subscriber treats 0 as "no seq evidence" and falls back to
	 * its own content check.
	 */
	seq: number;
	/** Each recorded path's fileSeq, keyed by the bump's normalized key. */
	fileSeqs: ReadonlyMap<string, number>;
	/** Canonical project root the change belongs to. */
	root: string;
	origin: DiskChangeOrigin;
	/** Every trigger that fed this publish (one per detector branch). */
	sources: readonly string[];
	kind: DiskChangeKind;
	/**
	 * The recorded population, normalized. `"unknown"` when the change cannot
	 * be enumerated (a dependency install, a cut delta): a subscriber then takes
	 * its conservative branch rather than reading the empty list as "nothing
	 * changed".
	 */
	paths: readonly string[] | "unknown";
	/** The typed subset, when the detector typed each path. */
	pathChanges?: readonly DiskPathChange[];
	/** Byte stamps for the paths the detector actually read (#4551). */
	after?: ReadonlyMap<string, ContentStamp>;
	/** One wall clock for the whole publish. */
	at: number;
	/** The live session generation when the publisher had one; 0 otherwise. */
	sessionScopeId: number;
}

export interface DiskChangeSubscriber {
	/** Stable consumer id; a second registration of one id replaces the first. */
	id: string;
	handler: (change: DiskChange) => unknown;
	/**
	 * The origins this consumer is delivered. The publisher skips every other
	 * origin, so the declaration is what the consumer census reads and cannot
	 * differ from what the consumer receives (#4535 slice 3: the diagnostics
	 * cache dropped four origins inside its own handler, where no census could
	 * see it). Absent on an entry registered by an older module copy: all.
	 */
	origins?: readonly DiskChangeOrigin[];
}

/**
 * The producer's structural view of the runtime: the bulk mutation seam plus
 * the session identity a session-scoped subscriber fences on. `RuntimeCoordinator`
 * satisfies it; a test passes a plain object.
 */
export interface DiskChangeRuntime {
	recordProjectMutations?(args: {
		paths: readonly string[];
		source: ProjectChangeSource;
		cwd?: string;
		onAppendError?: (err: unknown) => void;
	}): { projectSeq: number; fileSeqs: ReadonlyMap<string, number> };
	readonly sessionGeneration?: number;
}

export interface DiskChangeInput {
	root: string;
	origin: DiskChangeOrigin;
	/** Detector branch labels; defaults to the origin. */
	sources?: readonly string[];
	/** Defaults to `inferred`: a detector that only stat-compared says so. */
	kind?: DiskChangeKind;
	paths: readonly string[] | "unknown";
	pathChanges?: readonly DiskPathChange[];
	after?: ReadonlyMap<string, ContentStamp>;
	/** One clock for the publish; defaults to now. */
	at?: number;
}

export interface DiskChangePublishResult {
	change: DiskChange;
	/** Each subscriber's own answer, by consumer id. Opaque to the publisher. */
	results: ReadonlyMap<string, unknown>;
	/**
	 * Consumer ids whose handler threw. Their absence from `results` means the
	 * same thing as an unregistered consumer, and the two are opposite facts: a
	 * caller that needed an answer must tell "never asked" from "asked and
	 * failed" (review round 2, F3/F7). The throw itself is recorded once per
	 * consumer per root per session as `disk-change-subscriber-failed`.
	 */
	failedSubscribers: ReadonlySet<string>;
}

/**
 * Paths one publish allocates a sequence for. A longer population (a HEAD
 * move's delta, a settled sweep) records the first 64 and reports the rest as
 * unenumerable with one bounded record: the conservative direction for every
 * subscriber, never a false clean. The cap counts the detector's own spellings
 * ({@link recordedPopulation}), so it also bounds the normalization work.
 *
 * A detector that can name a longer population must PUBLISH it in chunks of
 * this size ({@link publishDiskChangeChunked}) rather than accept the
 * truncation: `"unknown"` is the right value for a change nobody can
 * enumerate, and the wrong value for one the detector already listed. A
 * delivered consumer reads `"unknown"` as the whole held set, so an over-cap
 * listed publish spends its capped delivery outside the change it named
 * (review round 3, HIGH: 65 changed paths, `changedSent 0/65`,
 * `unrelatedSent 64/135`).
 */
export const DISK_CHANGE_MAX_RECORDED_PATHS = 64;

/**
 * The chunkable publish input: a listed (or unlistable) population and no typed
 * subset. `pathChanges` describes ONE record whole (the out-of-band look's
 * watched-files events), so a caller that types its paths keeps the single
 * {@link publishDiskChange} form instead of splitting the typing across
 * records.
 */
export type ChunkableDiskChangeInput = Omit<
	DiskChangeInput,
	"paths" | "pathChanges"
> & { paths: readonly string[] | "unknown" };

const REGISTRY_FAMILY = "disk-changes.subscribers";
const REGISTRY_VERSION = 1;

function subscribers(): Map<string, DiskChangeSubscriber> {
	return getProcessSingleton(
		REGISTRY_FAMILY,
		REGISTRY_VERSION,
		() => new Map<string, DiskChangeSubscriber>(),
	);
}

/**
 * Register a consumer for `origins` (every origin when omitted). Idempotent per
 * id (a second module evaluation adopts the first cell and replays the same
 * registration instead of double-delivering). Returns the unsubscriber.
 */
export function subscribeDiskChange(
	id: string,
	handler: (change: DiskChange) => unknown,
	origins: readonly DiskChangeOrigin[] = DISK_CHANGE_ORIGINS,
): () => void {
	subscribers().set(id, { id, handler, origins });
	return () => {
		if (subscribers().get(id)?.handler === handler) subscribers().delete(id);
	};
}

/**
 * The registered consumers and the origins each is delivered, in registration
 * order (the consumer census and tests).
 */
export function diskChangeSubscriberOrigins(): Map<
	string,
	readonly DiskChangeOrigin[]
> {
	return new Map(
		[...subscribers().values()].map((subscriber) => [
			subscriber.id,
			subscriber.origins ?? DISK_CHANGE_ORIGINS,
		]),
	);
}

function publishFailure(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Publish one disk change: allocate the existing sequence for the recorded
 * population, then fan out. Never throws for a subscriber's failure and never
 * throws for an append failure: `recordProjectMutations` routes that to
 * `onAppendError`, and the publisher records one bounded
 * `disk-change-append-failed` row before calling a caller's own callback.
 */
export async function publishDiskChange(
	input: DiskChangeInput,
	runtime?: DiskChangeRuntime,
	onAppendError?: (err: unknown) => void,
): Promise<DiskChangePublishResult> {
	const at = input.at ?? Date.now();
	const root = normalizeMapKey(input.root);
	const { recorded, truncated } =
		input.paths === "unknown"
			? { recorded: [] as string[], truncated: false }
			: recordedPopulation(input.paths);
	const { seq, fileSeqs } = allocateSequence(
		recorded,
		input,
		runtime,
		appendFailureHandler(root, onAppendError),
	);
	if (truncated) {
		// The wording names what actually happened to each half: the first 64 are
		// NAMED to subscribers, the rest are reported as unenumerable. A publish
		// made without a runtime allocates no sequence for any of them, so the
		// record says so rather than claiming a sequence that never existed
		// (review round 2, F4).
		recordDegradationOnce({
			kind: "disk-change-paths-truncated",
			subject: root,
			reason: `one publish carried more than ${DISK_CHANGE_MAX_RECORDED_PATHS} paths; the first ${DISK_CHANGE_MAX_RECORDED_PATHS} are named and the rest are reported as unenumerable${
				seq === 0
					? " (this publish allocated no sequence: it ran with no runtime)"
					: ""
			}`,
		});
	}
	const unknown = input.paths === "unknown" || truncated;
	const change: DiskChange = {
		seq,
		fileSeqs,
		root,
		origin: input.origin,
		sources: input.sources ?? [input.origin],
		kind: input.kind ?? "inferred",
		paths: unknown ? "unknown" : recorded,
		...(input.pathChanges ? { pathChanges: input.pathChanges } : {}),
		...(input.after ? { after: input.after } : {}),
		at,
		sessionScopeId: runtime?.sessionGeneration ?? 0,
	};
	const started = Date.now();
	const { results, failed } = await fanOut(change);
	logLatency({
		type: "phase",
		phase: "disk_change_published",
		filePath: root,
		durationMs: Date.now() - started,
		result: `${input.origin}:${recorded.length}`,
		metadata: {
			origin: input.origin,
			sources: change.sources.join(","),
			kind: change.kind,
			recorded: recorded.length,
			unknown: unknown ? 1 : 0,
			truncated: truncated ? 1 : 0,
			seq,
			subscribers: [...subscribers().keys()].join(",").slice(0, 200),
		},
	});
	return { change, results, failedSubscribers: failed };
}

/**
 * Publish a detector's listed population in {@link DISK_CHANGE_MAX_RECORDED_PATHS}
 * chunks, one publish at a time, and return every publish in population order.
 *
 * This is the shape every detector with a population it already listed uses
 * (a HEAD move's delta, the bash-write population, the recovered set): each
 * chunk stays inside the cap, so no publish is reported as `"unknown"`, and a
 * consumer's awaited phase is drawn from the change instead of from every
 * document the root happens to hold. An `"unknown"` population has nothing to
 * split and publishes once.
 *
 * `onChunk` is awaited after each chunk's fan-out and before the next publishes,
 * so a caller that must await a chunk's own answer (the recovered set's drift
 * pass) keeps one chunk in flight at a time. It receives the chunk's position
 * in the chain, because the ordinal is the caller's evidence when a chunk
 * fails (`publishDriftPass` records it and goes on).
 */
export async function publishDiskChangeChunked(
	input: ChunkableDiskChangeInput,
	runtime?: DiskChangeRuntime,
	onAppendError?: (err: unknown) => void,
	onChunk?: (
		published: DiskChangePublishResult,
		position: { index: number; total: number },
	) => Promise<void> | void,
): Promise<DiskChangePublishResult[]> {
	if (input.paths === "unknown")
		return [await publishDiskChange(input, runtime, onAppendError)];
	const chunkSize = DISK_CHANGE_MAX_RECORDED_PATHS;
	// At least one publish for an empty population: a detector that saw the
	// event but no path still records it, and every consumer still hears it.
	const chunks = Math.max(1, Math.ceil(input.paths.length / chunkSize));
	const published: DiskChangePublishResult[] = [];
	for (let index = 0; index < chunks; index += 1) {
		const one = await publishDiskChange(
			{
				...input,
				paths: input.paths.slice(index * chunkSize, (index + 1) * chunkSize),
			},
			runtime,
			onAppendError,
		);
		published.push(one);
		await onChunk?.(one, { index, total: chunks });
	}
	return published;
}

/**
 * The recorded population: the cap and the de-duplication both happen in the
 * detector's own spelling, BEFORE `normalizeMapKey` costs one realpath lookup
 * per path (~200 µs on Windows, `clients/path-utils.ts`). A 2048-path HEAD
 * delta therefore normalizes 64 paths, not 2048. The normalized pass still
 * collapses two spellings of one file, which can only shrink the population,
 * and the cap is decided on what the detector named.
 */
function recordedPopulation(paths: readonly string[]): {
	recorded: string[];
	truncated: boolean;
} {
	const named = new Set<string>();
	const raw: string[] = [];
	let truncated = false;
	for (const filePath of paths) {
		if (named.has(filePath)) continue;
		if (raw.length === DISK_CHANGE_MAX_RECORDED_PATHS) {
			truncated = true;
			break;
		}
		named.add(filePath);
		raw.push(filePath);
	}
	const seen = new Set<string>();
	const recorded: string[] = [];
	for (const filePath of raw) {
		const key = normalizeMapKey(filePath);
		if (seen.has(key)) continue;
		seen.add(key);
		recorded.push(key);
	}
	return { recorded, truncated };
}

/**
 * The append failure the caller never sees otherwise: `allocateSequence`
 * routes it to `onAppendError`, so a publisher with no handler would hand its
 * subscribers a sequence the change log does not hold and record nothing
 * anywhere. One bounded row per root per session (the count carries the
 * repeat, as `change-log-lock-unavailable` does for the same log), then the
 * caller's own callback.
 */
function appendFailureHandler(
	root: string,
	onAppendError: ((err: unknown) => void) | undefined,
): (err: unknown) => void {
	return (err) => {
		incrementDegradationCount({
			kind: "disk-change-append-failed",
			subject: root,
			reason: `the change log did not record this publish: ${publishFailure(err)}`,
		});
		onAppendError?.(err);
	};
}

/**
 * Step 1 (I2): the existing sequence, through the bulk mutation seam, before
 * any subscriber sees the record. A publisher with no runtime allocates
 * nothing and reports `seq: 0`, which a subscriber reads as "no seq evidence".
 */
function allocateSequence(
	recorded: readonly string[],
	input: DiskChangeInput,
	runtime: DiskChangeRuntime | undefined,
	onAppendError: (err: unknown) => void,
): { seq: number; fileSeqs: ReadonlyMap<string, number> } {
	if (recorded.length === 0) return { seq: 0, fileSeqs: new Map() };
	const allocated = runtime?.recordProjectMutations?.({
		paths: recorded,
		source: "external",
		cwd: input.root,
		onAppendError,
	});
	return {
		seq: allocated?.projectSeq ?? 0,
		fileSeqs: allocated?.fileSeqs ?? new Map(),
	};
}

/** Step 2 (I5): every registered consumer, isolated one from another. */
async function fanOut(
	change: DiskChange,
): Promise<{ results: Map<string, unknown>; failed: Set<string> }> {
	const results = new Map<string, unknown>();
	const failed = new Set<string>();
	// A snapshot, not a live iteration: a subscriber that unsubscribes or
	// registers while this publish runs must not change who this one reaches.
	const registered = Array.from(subscribers().values());
	for (const subscriber of registered) {
		// Delivery is the declaration (see {@link DiskChangeSubscriber.origins}).
		if (subscriber.origins && !subscriber.origins.includes(change.origin))
			continue;
		try {
			results.set(subscriber.id, await subscriber.handler(change));
		} catch (cause) {
			failed.add(subscriber.id);
			recordDegradationOnce({
				kind: "disk-change-subscriber-failed",
				subject: `${subscriber.id}:${change.root}`,
				reason: `subscriber threw: ${publishFailure(cause)}`,
			});
		}
	}
	return { results, failed };
}
