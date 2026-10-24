/**
 * Prompt-cache observability (#1018).
 *
 * Two provider-independent signals, both sinking into ~/.dm-lens/latency.log
 * via {@link logLatency} (matching the neighboring `type: "phase"` records):
 *
 *   1. Response-side cache usage (`cache_usage`) — on each assistant
 *      `message_end`, record the provider-reported token/cost breakdown so a
 *      session's actual cacheRead/cacheWrite behavior is queryable after the
 *      fact. This is what the provider DID, not what we hoped it would do.
 *
 *   2. Request-side context observations (`cache_context`) — one bounded record
 *      for every `context` call, describing dm-lens's own before/after message
 *      transformation, placement, injection sources, and privacy-preserving
 *      hashes. This is what dm-lens observed locally, not the final provider
 *      request after other context handlers have run and not a provider cache
 *      result. #1938: this record used to also carry a `prefixObservation` /
 *      `firstMessageChange` pair derived from a SEPARATE bounded hash of the
 *      pre-injection prefix (capped at `MAX_HASHED_MESSAGES` messages /
 *      `MAX_HASHED_CONTENT_CHARS` chars). Every real session's transcript
 *      exceeds that cap almost immediately, so the pair reported "unknown" on
 *      97% of records — dead weight in every record, answering nothing. The
 *      pair is removed; signal 3 below (`cache_prefix_break`) already covers
 *      first-message stability with an unbounded hash and never truncates.
 *
 *   3. Request-side prefix stability (`cache_prefix_break`) — a content hash of
 *      `messages[0]` observed on every request hook that sees the list the
 *      provider receives first (`context_with_system` on pi 0.87+, `context`
 *      before it). After #1016 the first message must stay byte-stable across a
 *      whole session; a logged CHANGE flags that something (dm-lens or
 *      otherwise) broke the cache prefix. This remains a local observation,
 *      never a provider cache-miss claim. #4631: the observer must move with
 *      the injector, because 0.87+'s `context` event never carries the system
 *      head, and hashing the conversation instead made a rewritten head look
 *      stable.
 *
 * #1071 adds miss ATTRIBUTION on top of those three. Each `cache_usage` record
 * carries the inter-turn gap and a `cacheMissCause` verdict, and each
 * `cache_context` record splits a mixed injection payload by contributing
 * source. #1996 makes every unexplained miss name the absent/conflicting
 * evidence and emits one fixed-key `cache_usage_summary` at session shutdown.
 * Heuristic causes require complete request hashing and full provider/model
 * identity evidence. Identity comparison uses SHA-256 over the full normalized
 * value while logs retain only a bounded display prefix; malformed numeric
 * usage is sanitized before it reaches JSON metadata.
 * The per-turn records still ride events that already fire once per turn, and
 * all attribution derives from bounded in-process state — nothing reads
 * latency.log back or serializes transcript content.
 *
 * All paths are defensive: `usage` (and its fields) may be absent on older
 * hosts or non-assistant messages, so every access is guarded and the handlers
 * never throw — on error they `dbg(...)` and no-op, like the other index.ts
 * event handlers.
 */
import { createHash } from "node:crypto";
import { BoundedFifoMap, BoundedLruCache } from "./bounded-cache.js";
import {
	recordDegradation,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { lazyEnvNumber } from "./env-utils.js";
import { logLatency } from "./latency-logger.js";
import { compareOrdinal } from "./string-utils.js";

interface AssistantMessageLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	responseModel?: unknown;
	usage?: unknown;
}

type CacheContextInjectionSource =
	| "session-guidance"
	| "turn-findings"
	| "test-findings"
	| "agent-nudge";
type InjectedByteSource =
	| "sessionGuidance"
	| "turnFindings"
	| "testFindings"
	| "agentNudge"
	| "turnEndAdvisory"
	| "other";
export type InjectedBytes = Record<InjectedByteSource, number>;
export type CacheContextPlacement =
	| "prepend"
	// Retired by #3693; kept so old latency logs still parse.
	| "insert-before-final"
	| "append-to-last-user"
	| "append"
	| "none";
export type CachePrefixObservation =
	| "baseline"
	| "unchanged"
	| "changed"
	| "empty";

/**
 * The request hook that carried dm-lens's injection (#4631). pi 0.87+ runs
 * `context` handlers over the conversation WITHOUT its system messages and then
 * `context_with_system` handlers over the full transcript; dm-lens injects from
 * exactly one of them, so a record naming the hook is also the record of which
 * generation's request shape was observed.
 */
export type CacheContextInjectionHook = "context" | "context_with_system";

/**
 * Why a turn read less from the provider prompt cache than the turn before it
 * (#1071, 2026-08-21 investigation). A verdict is an ATTRIBUTION of a locally
 * observable cause, never a provider statement: the provider reports token
 * counts only, so `unknown` is a real and expected answer.
 */
type CacheMissCause =
	| "ttl-expired"
	| "prefix-broke"
	| "tool-set-changed"
	| "system-prompt-changed"
	| "partial-eviction"
	| "model-provider-changed"
	| "injection-dropped"
	| "prefix-shrunk"
	| "unknown";

/** Why a miss could not be assigned a local cause (#1996). */
type CacheMissUnknownReason =
	| "no-prior-sample"
	| "cache-read-unavailable"
	| "malformed-provider-usage"
	| "request-correlation-unavailable"
	| "request-evidence-incomplete"
	| "sequence-hash-truncated"
	| "model-provider-unavailable"
	| "provider-reported-zero-stable-prefix"
	| "provider-reported-low-read-stable-prefix"
	| "no-local-explanation";

/** Which shape of shortfall triggered the verdict. */
type CacheMissKind = "zero-read" | "low-read";

type ContextMessageLike = { role?: unknown; content?: unknown };

/** One source's share of a mixed injection payload (#1071). */
export interface CacheContextInjectionSlice {
	source: CacheContextInjectionSource;
	messages: ReadonlyArray<ContextMessageLike>;
}

interface CacheUsageContext {
	sessionId?: string;
	sessionRole?: "primary" | "concurrent-secondary";
	turnIndex?: number;
}

interface CacheUsageSessionSummary {
	usageRecords: number;
	cacheHits: number;
	missObservations: number;
	cacheMissCauses: Record<CacheMissCause, number>;
	unknownEvidenceReasons: Record<CacheMissUnknownReason, number>;
}

/** RuntimeCoordinator's counter is process-global when sessions share a host. */
const PROCESS_TURN_SCOPE = "process-global-runtime" as const;
const SECONDARY_TURN_SCOPE = "unavailable-concurrent-secondary" as const;

/**
 * Keep context telemetry bounded even when a tool result or user message is
 * unexpectedly large. This is a hash input only; none of the sampled text is
 * written to the log.
 */
const MAX_HASHED_MESSAGES = 64;
const MAX_HASHED_CONTENT_CHARS = 2048;
const MAX_REPORTED_MESSAGES = 10_000;
const MAX_INJECTED_CHARS = 16_384;
const MAX_INJECTED_BYTES = 65_536;
let contextObservationCounter = 0;

/**
 * Documented deterministic char→token estimate. Four characters per token is
 * the same ratio #1071's issue body used to size the sampled injections. It is
 * an ESTIMATE: never present a value derived from it as provider-measured
 * usage.
 */
const CHARS_PER_ESTIMATED_TOKEN = 4;

/**
 * Idle gap after which a provider prompt cache entry is assumed expired.
 *
 * The gap this is compared against is measured to REQUEST time, not to the
 * `message_end` that follows it — see {@link resolveInterTurnGap}. The provider
 * looks the cache up when the request arrives, so the response's own generation
 * time is not idle time and must not count toward expiry.
 *
 * Evidence (2026-08-21 KV-cache investigation, 63 sessions, 2,288 turns): the
 * 34 zero-`cacheRead` turns had a MEDIAN inter-turn gap of 166s, against 9s for
 * every other turn. Those 34 turns carried 6.96M fresh input tokens, 35.1% of
 * all fresh input in the window. 60s sits between the two populations and
 * matches the documented 5-minute-minus-safety-margin behavior of the shortest
 * provider TTL tier we run against. Override with
 * `DM_LENS_PROVIDER_CACHE_TTL_MS` when a provider's TTL differs.
 */
export const DEFAULT_PROVIDER_CACHE_TTL_MS = 60_000;
const _providerCacheTtl = lazyEnvNumber(
	"DM_LENS_PROVIDER_CACHE_TTL_MS",
	DEFAULT_PROVIDER_CACHE_TTL_MS,
);
const getProviderCacheTtlMs = _providerCacheTtl.get;
export const _resetProviderCacheTtlForTests = _providerCacheTtl._resetForTests;

/**
 * A turn counts as "anomalously low" when it reads back less than half of what
 * the previous turn read. The investigation's partial-break population (90
 * turns, upper-bounded at 2.7M tokens) was selected by exactly this shape: a
 * non-zero `cacheRead` well below the prior turn's, which a zero-read filter
 * misses entirely.
 */
const LOW_CACHE_READ_RATIO = 0.5;

/**
 * Fresh input must exceed the estimated new content by this factor before a
 * shortfall reads as provider-side eviction rather than as our own payload.
 * The investigation upper-bounds a whole session's injections at ~2.7 tokens
 * per turn, so fresh input several times the measured new content cannot be
 * explained by what dm-lens added.
 */
const PARTIAL_EVICTION_INPUT_FACTOR = 4;

/**
 * Floor for the same rule, so a turn with almost no new content does not read
 * as eviction on a handful of tokens.
 */
const PARTIAL_EVICTION_MIN_FRESH_TOKENS = 512;

/**
 * Cap on the per-session character accumulators used for attribution, and on a
 * single transcript-growth measurement feeding them.
 *
 * This is deliberately NOT `MAX_INJECTED_CHARS`. That 16 KiB cap exists to keep
 * the reported injection size small, and dm-lens injections average about 2.7
 * estimated tokens per turn, so it is never reached in practice. Transcript
 * growth is a different population: one ordinary tool result can add 20,000
 * characters in a single turn. Measuring growth through the injection cap
 * latched `attributionCharsCapped` on a routine turn and suppressed the
 * `partial-eviction` verdict, which made the verdict near-unreachable (#1071
 * review round 1, F2).
 */
const MAX_ATTRIBUTION_CHARS = 262_144;

/** Byte companion to {@link MAX_ATTRIBUTION_CHARS}, at four bytes per char. */
const MAX_ATTRIBUTION_BYTES = 1_048_576;

/**
 * Per-session state that turns two independent records into one verdict: the
 * `context` observations describe what dm-lens added, and the `message_end`
 * usage describes what the provider charged. Both already run per turn, so
 * attribution rides them rather than adding a phase.
 */
interface SessionAttributionState {
	/** `Date.now()` of the previous `cache_usage` record for this session. */
	lastUsageAtMs?: number;
	/**
	 * `Date.now()` of the most recent `context` observation since that record.
	 * This is REQUEST time, the moment the provider performs its cache lookup.
	 * Cleared at every usage record, so a turn whose request dm-lens never saw
	 * cannot inherit an earlier turn's request timestamp.
	 */
	lastContextAtMs?: number;
	/** A `cache_prefix_break` CHANGE fired since the previous usage record. */
	prefixBrokeSinceLastUsage: boolean;
	/** A prefix baseline or unchanged observation was seen since the usage record. */
	prefixStableSinceLastUsage: boolean;
	/** A bounded context sequence hash lost content or message coverage. */
	sequenceHashTruncatedSinceLastUsage: boolean;
	/** Request hashing encountered cycles, throwing getters, or unreadable data. */
	requestEvidenceIncompleteSinceLastUsage: boolean;
	/**
	 * The last HEALTHY `cacheRead`, the baseline every shortfall is measured
	 * against (#4687). A miss measured against it does not replace it, so a
	 * second consecutive rewrite is measured against the last read that was
	 * whole rather than against the previous miss's remainder. A DURABLE shrink
	 * does replace it: a request whose whole prompt is below half this number is
	 * a smaller prompt, and keeping the old number made every following turn a
	 * fresh false miss (#4718 review F1, F8).
	 */
	lastHealthyCacheRead?: number;
	/** Unbounded hash of the ordered system-message set dm-lens last observed. */
	lastSystemSetHash?: string;
	/** The tool loadout folded from those system messages, in replay order. */
	lastToolLoadout?: string;
	/** The ordered system-message set changed since the previous usage record. */
	systemPromptChangedSinceLastUsage: boolean;
	/** The tool loadout those system messages declare changed. */
	toolSetChangedSinceLastUsage: boolean;
	/**
	 * #4743: a request since the previous usage record stopped re-sending a
	 * span dm-lens had added to the request before it, so the provider's
	 * cached prefix ended where that span sat.
	 */
	injectionDroppedSinceLastUsage: boolean;
	/**
	 * #4743: the rolling digest of every message the previous request sent
	 * (8 bytes each, see {@link rollingMessageDigests}), the reference the next
	 * request's first differing index is measured against. `null`: that
	 * request had no digest (a bound or an unserializable message).
	 */
	lastRequestDigests?: Buffer | null;
	/** Positions in that request where a dm-lens span began (sorted). */
	lastInjectedPositions?: readonly number[] | undefined;
	/** Unknown-cause misses recorded for this session (#4687 item 5). */
	unexplainedMisses: number;
	/** Characters dm-lens injected since the previous usage record. */
	injectedCharsSinceLastUsage: number;
	/** Characters of transcript growth observed since the previous usage record. */
	newTranscriptCharsSinceLastUsage: number;
	/** Either accumulator hit a bound, so the estimate is a floor, not a total. */
	attributionCharsCapped: boolean;
	injectedBytes: InjectedBytes;
	injectedFindingsRepeated: number;
	readonly findingIdentities: Set<string>;
	findingIdentityCapRecorded: boolean;
	turnEndAdvisoryBytes: number;
	/** Delivered tool-result bytes summed over the turn (#2800 item 7). */
	toolResultBytes: number;
	/** Delivered tool results whose bound fired, counted over the turn. */
	toolResultsTruncated: number;
	/** Transcript length at the previous `context` observation. */
	lastObservedMessageCount?: number;
	/** Full-identity SHA-256 evidence from the previous usage record. */
	lastProviderIdentityHash?: string;
	lastModelIdentityHash?: string;
	/** Bounded process-local session summary, emitted at session shutdown. */
	summary: CacheUsageSessionSummary;
}

function emptyCacheMissCauses(): Record<CacheMissCause, number> {
	return {
		"ttl-expired": 0,
		"prefix-broke": 0,
		"tool-set-changed": 0,
		"system-prompt-changed": 0,
		"partial-eviction": 0,
		"model-provider-changed": 0,
		"injection-dropped": 0,
		"prefix-shrunk": 0,
		unknown: 0,
	};
}

function emptyUnknownEvidenceReasons(): Record<CacheMissUnknownReason, number> {
	return {
		"no-prior-sample": 0,
		"cache-read-unavailable": 0,
		"malformed-provider-usage": 0,
		"request-correlation-unavailable": 0,
		"request-evidence-incomplete": 0,
		"sequence-hash-truncated": 0,
		"model-provider-unavailable": 0,
		"provider-reported-zero-stable-prefix": 0,
		"provider-reported-low-read-stable-prefix": 0,
		"no-local-explanation": 0,
	};
}

function newCacheUsageSummary(): CacheUsageSessionSummary {
	return {
		usageRecords: 0,
		cacheHits: 0,
		missObservations: 0,
		cacheMissCauses: emptyCacheMissCauses(),
		unknownEvidenceReasons: emptyUnknownEvidenceReasons(),
	};
}

// Shared cap for every per-session bounded map in this module (also used by
// `prefixHashBySession` below) — a long-lived process cycling through many
// sessions cannot grow any of them without limit.
export const MAX_TRACKED_SESSIONS = 32;
const attributionBySession = new BoundedLruCache<
	string,
	SessionAttributionState
>(MAX_TRACKED_SESSIONS);

function newAttributionState(): SessionAttributionState {
	return {
		prefixBrokeSinceLastUsage: false,
		prefixStableSinceLastUsage: false,
		systemPromptChangedSinceLastUsage: false,
		toolSetChangedSinceLastUsage: false,
		injectionDroppedSinceLastUsage: false,
		unexplainedMisses: 0,
		sequenceHashTruncatedSinceLastUsage: false,
		requestEvidenceIncompleteSinceLastUsage: false,
		injectedCharsSinceLastUsage: 0,
		newTranscriptCharsSinceLastUsage: 0,
		attributionCharsCapped: false,
		injectedBytes: emptyInjectedBytes(),
		injectedFindingsRepeated: 0,
		findingIdentities: new Set(),
		findingIdentityCapRecorded: false,
		turnEndAdvisoryBytes: 0,
		toolResultBytes: 0,
		toolResultsTruncated: 0,
		summary: newCacheUsageSummary(),
	};
}

const MAX_FINDING_IDENTITIES = 2_000;

function emptyInjectedBytes(): InjectedBytes {
	return {
		sessionGuidance: 0,
		turnFindings: 0,
		testFindings: 0,
		agentNudge: 0,
		turnEndAdvisory: 0,
		other: 0,
	};
}

function sourceKey(source: CacheContextInjectionSource): InjectedByteSource {
	return {
		"session-guidance": "sessionGuidance",
		"turn-findings": "turnFindings",
		"test-findings": "testFindings",
		"agent-nudge": "agentNudge",
	}[source] as InjectedByteSource;
}

/** Best-effort, language-neutral identity extraction from rendered findings. */
function findingIdentities(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const location = line.match(/(?:^|\s)([^\s:]+):(\d+)(?::\d+)?/);
		if (!location) continue;
		const rule =
			line.match(/(?:rule|code)\s*[:=]\s*([\w./-]+)/i)?.[1] ??
			line.match(/\(([\w./-]+)\)\s*$/)?.[1] ??
			line.match(/:\d+(?::\d+)?\s+([\w./-]+)/)?.[1];
		if (rule) out.push(`${location[1]}:${location[2]}:${rule}`);
	}
	return out;
}

/**
 * Fetch (creating if absent) one session's attribution state, refreshing LRU
 * recency and evicting the oldest entries past the cap — same bounding as
 * {@link recordSessionHash}, so a long-lived process cycling through sessions
 * cannot grow this map without limit.
 */
function attributionFor(key: string): SessionAttributionState {
	const existing = attributionBySession.get(key);
	const state = existing ?? newAttributionState();
	// `get` above already moved an existing entry to MRU; `set` below also
	// refreshes recency on a create, so every fetch counts as a touch.
	attributionBySession.set(key, state);
	return state;
}

/**
 * Fold one `context` observation into the session's attribution state: how much
 * dm-lens injected, and how much the transcript itself grew since the previous
 * observation. The transcript delta is what the "far above the injected and new
 * content" rule measures fresh input against. The first observation in a
 * session only anchors the message-count baseline, because there is no earlier
 * point to measure growth from.
 */
function recordContextAttribution(
	key: string,
	existingMessages: ReadonlyArray<ContextMessageLike>,
	injectedSize: { chars: number; capped: boolean },
): void {
	const state = attributionFor(key);
	const baseline = Math.min(
		state.lastObservedMessageCount ?? existingMessages.length,
		existingMessages.length,
	);
	const grown = measureTranscriptGrowth(existingMessages.slice(baseline));
	state.injectedCharsSinceLastUsage = Math.min(
		MAX_ATTRIBUTION_CHARS,
		state.injectedCharsSinceLastUsage + injectedSize.chars,
	);
	state.newTranscriptCharsSinceLastUsage = Math.min(
		MAX_ATTRIBUTION_CHARS,
		state.newTranscriptCharsSinceLastUsage + grown.chars,
	);
	if (
		injectedSize.capped ||
		grown.capped ||
		state.injectedCharsSinceLastUsage >= MAX_ATTRIBUTION_CHARS ||
		state.newTranscriptCharsSinceLastUsage >= MAX_ATTRIBUTION_CHARS
	) {
		// The accumulators are now floors, not totals. The verdict rules must not
		// treat a floor as a measured value.
		state.attributionCharsCapped = true;
	}
	state.lastObservedMessageCount = existingMessages.length;
	// #1071 review round 1, F1: this handler runs at REQUEST time, which is when
	// the provider looks the prompt cache up. Stamping it here is what lets the
	// gap exclude the response's own generation time.
	state.lastContextAtMs = Date.now();
}

/**
 * Which clock the reported gap was measured to.
 *
 * `request-time` is the accurate basis: the provider looks the prompt cache up
 * when the request arrives, so idle time ends at the `context` call.
 * `message-end-fallback` means no `context` observation arrived for this turn,
 * so the only available endpoint was this record itself, and the value INCLUDES
 * the response's own generation time. `no-prior-turn` means there is no earlier
 * record to measure from.
 */
type CacheGapBasis = "request-time" | "message-end-fallback" | "no-prior-turn";

/**
 * Idle milliseconds before this turn's provider request.
 *
 * Measuring `message_end` to `message_end` would fold the response's own
 * generation time into the gap, and generation dominates: over a real corpus
 * the median generation time is 7,407 ms against a median true idle of 228 ms,
 * a factor of 30. At the 60s threshold, 8.7% of consecutive pairs measure over
 * on the message-end basis while only 3.3% were truly idle over. That is a 3.4x
 * inflation of `ttl-expired`, which would have confirmed the investigation's
 * hypothesis by construction (#1071 review round 1, F1).
 */
function resolveInterTurnGap(
	state: SessionAttributionState,
	nowMs: number,
): { gapMs: number | null; basis: CacheGapBasis } {
	if (state.lastUsageAtMs === undefined) {
		return { gapMs: null, basis: "no-prior-turn" };
	}
	if (state.lastContextAtMs !== undefined) {
		return {
			gapMs: Math.max(0, state.lastContextAtMs - state.lastUsageAtMs),
			basis: "request-time",
		};
	}
	return {
		gapMs: Math.max(0, nowMs - state.lastUsageAtMs),
		basis: "message-end-fallback",
	};
}

function estimateTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_ESTIMATED_TOKEN);
}

function readableTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

type NumericEvidenceStatus = "available" | "absent" | "malformed";

interface NumericEvidence {
	value?: number;
	status: NumericEvidenceStatus;
}

function readNumericEvidence(
	record: Record<string, unknown>,
	key: string,
): NumericEvidence {
	let raw: unknown;
	try {
		raw = record[key];
	} catch {
		return { status: "malformed" };
	}
	if (raw === undefined) return { status: "absent" };
	const value = readableTokenCount(raw);
	return value === undefined
		? { status: "malformed" }
		: { status: "available", value };
}

const MAX_LOGGED_IDENTITY_CHARS = 200;

interface IdentityEvidence {
	display?: string;
	hash?: string;
	status: "complete" | "truncated" | "unavailable";
}

/**
 * Keep the human-readable identity bounded while comparing a SHA-256 digest of
 * the FULL normalized value. Comparing the display prefix would make two long
 * provider/model ids that differ after the cap collide (#1996 review).
 */
function identityEvidence(value: unknown): IdentityEvidence {
	if (typeof value !== "string") return { status: "unavailable" };
	const normalized = value.trim();
	if (!normalized) return { status: "unavailable" };
	const truncated = normalized.length > MAX_LOGGED_IDENTITY_CHARS;
	return {
		display: normalized.slice(0, MAX_LOGGED_IDENTITY_CHARS),
		hash: createHash("sha256").update(normalized).digest("hex"),
		status: truncated ? "truncated" : "complete",
	};
}

interface CacheMissVerdict {
	kind: CacheMissKind;
	cause: CacheMissCause;
	unknownReason?: CacheMissUnknownReason;
}

/**
 * Classify a turn's prompt-cache shortfall. Returns `null` when no comparable
 * miss exists: no prior readable usage record or a healthy read. The caller
 * separately records why an unreadable/first zero sample could not be
 * classified, so those evidence gaps remain visible in the session summary.
 *
 * Rules, in the order they are applied, each stated with the evidence behind
 * it (2026-08-21 investigation, 63 sessions, 2,288 turns, 94.2% overall hit
 * rate):
 *
 *   1. `tool-set-changed` / `system-prompt-changed` — the ordered system-message
 *      set changed since the previous usage record. A change to the tool
 *      loadout those messages declare is `tool-set-changed`; any other system
 *      change is `system-prompt-changed`. Both are DIRECT local observations
 *      (#4687 item 2): the system set is hashed unbounded, so a long tool
 *      result can no longer turn the cause into `unknown`.
 *   2. `prefix-broke` — a `cache_prefix_break` CHANGE fired in this session
 *      since the previous usage record. This is a DIRECT local observation of
 *      the cause, so it outranks the timing heuristics below. The window was
 *      byte-stable throughout, so this verdict should stay rare; if it does
 *      not, #1016's fix has regressed.
 *   3. `model-provider-changed` — both adjacent identities were present and
 *      differ. This is direct local evidence and outranks timing heuristics.
 *   3b. `injection-dropped` — a request since the previous usage record first
 *      differed from the request before it at a position where dm-lens had
 *      added a span (#4743): the span was request-local, so the next request
 *      no longer carried it and the cached prefix ended there. Direct local
 *      evidence from the per-message rolling digest.
 *   4. `prefix-shrunk` — a low or zero read of a request whose whole prompt
 *      is itself below half the baseline (`promptShrank`): the prompt got
 *      smaller (compaction, a trimmed transcript), so the read is low because
 *      there is less to read, and the compacted turn often reads nothing at
 *      all (#4718 verify F11). It is decided from the provider's own token
 *      counts, not from timing, so it outranks the evidence gates; it names
 *      the turn so the shrink never counts as an unexplained miss (#4718
 *      review F7).
 *   5. Evidence gates — heuristic causes require a REQUEST-time observation,
 *      a complete bounded sequence hash, adjacent full provider/model identity,
 *      and well-formed provider usage numbers.
 *      Missing evidence returns a specific unknown reason; it never lets a
 *      plausible but unproved heuristic win. `ttl-expired` is measured from
 *      the request clock alone, so content-hash truncation does not gate it
 *      (#4687 item 4: a 20,000-character tool result is ordinary, not evidence
 *      that the gap is unreadable).
 *   6. `ttl-expired` — a REQUEST-time gap reached the configured provider TTL.
 *      A message-end fallback includes generation time and cannot prove this.
 *   7. `partial-eviction` — a non-zero but low read, where fresh input runs far
 *      above the new content we measured. dm-lens injections average ~2.7
 *      estimated tokens per turn, so they cannot account for a multiple of the
 *      measured content; the remainder is provider-side eviction, typically at
 *      a context limit. Suppressed when the character accumulators were capped,
 *      because a floor estimate would manufacture the verdict. "Fresh input"
 *      is every uncached prompt token, `input + cacheWrite`: Anthropic and
 *      Bedrock carry the re-sent tokens in `cacheWrite`, so `input` alone made
 *      the rule unreachable on them (#4718 round 3, the F8 shape).
 *   8. `unknown` — a real shortfall with no local explanation. A bounded
 *      `cacheMissUnknownReason` names the missing or conflicting evidence;
 *      provider behavior is never guessed.
 */
function classifyCacheMiss(args: {
	cacheRead: number | undefined;
	input: number;
	priorCacheRead: number | undefined;
	interTurnGapMs: number | null;
	gapBasis: CacheGapBasis;
	ttlMs: number;
	prefixBroke: boolean;
	toolSetChanged: boolean;
	systemPromptChanged: boolean;
	prefixStable: boolean;
	sequenceHashTruncated: boolean;
	requestEvidenceIncomplete: boolean;
	stableSessionIdentity: boolean;
	modelProviderChanged: boolean;
	modelProviderEvidenceAvailable: boolean;
	providerUsageMalformed: boolean;
	estimatedNewTokens: number;
	attributionCharsCapped: boolean;
	promptShrank: boolean;
	injectionDropped: boolean;
}): CacheMissVerdict | null {
	const cacheRead = readableTokenCount(args.cacheRead);
	if (cacheRead === undefined) return null;
	// No baseline turn in this session: a first turn reads zero because nothing
	// is cached yet, not because anything went wrong.
	const priorCacheRead = readableTokenCount(args.priorCacheRead);
	if (priorCacheRead === undefined) {
		return null;
	}
	let kind: CacheMissKind;
	if (cacheRead === 0) {
		kind = "zero-read";
	} else if (
		priorCacheRead > 0 &&
		cacheRead < priorCacheRead * LOW_CACHE_READ_RATIO
	) {
		kind = "low-read";
	} else {
		return null;
	}

	// A missing stable session id makes every cross-event baseline ambiguous. Do
	// not let the shared fallback bucket turn another session's evidence into a
	// cause claim (#1996 concurrent primary/secondary invariant).
	if (!args.stableSessionIdentity) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "request-correlation-unavailable",
		};
	}
	if (args.toolSetChanged) return { kind, cause: "tool-set-changed" };
	if (args.systemPromptChanged) {
		return { kind, cause: "system-prompt-changed" };
	}
	if (args.prefixBroke) return { kind, cause: "prefix-broke" };
	if (args.modelProviderChanged) {
		return { kind, cause: "model-provider-changed" };
	}
	if (args.injectionDropped) return { kind, cause: "injection-dropped" };
	if (args.promptShrank) return { kind, cause: "prefix-shrunk" };
	// TTL and transcript-growth claims need the request-side context observation.
	// A response-time fallback includes generation and can only explain why the
	// verdict stayed unknown; it cannot establish cache expiry.
	if (args.gapBasis !== "request-time") {
		return {
			kind,
			cause: "unknown",
			unknownReason: "request-correlation-unavailable",
		};
	}
	// TTL and eviction are heuristics. They are only evidence-backed if the
	// bounded request observation is complete and both adjacent usage records
	// identify the same provider/model. Otherwise an unseen prompt or identity
	// change remains a competing explanation, so classification must fail closed.
	if (args.requestEvidenceIncomplete) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "request-evidence-incomplete",
		};
	}
	if (args.providerUsageMalformed) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "malformed-provider-usage",
		};
	}
	if (!args.modelProviderEvidenceAvailable) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "model-provider-unavailable",
		};
	}
	// #4687 item 4: the gap is measured from the request clock, not from the
	// content hash. A long tool result makes the bounded sequence observation
	// incomplete, and it used to return `sequence-hash-truncated` here — before
	// the TTL rule could fire — so an ordinary 20,000-character message hid a
	// genuine expiry. TTL is proved by the clock, so it runs first; the
	// truncation gate keeps gating `partial-eviction`, which DOES need to know
	// what else changed.
	if (args.interTurnGapMs !== null && args.interTurnGapMs >= args.ttlMs) {
		return { kind, cause: "ttl-expired" };
	}
	if (args.sequenceHashTruncated) {
		return {
			kind,
			cause: "unknown",
			unknownReason: "sequence-hash-truncated",
		};
	}
	if (
		kind === "low-read" &&
		!args.attributionCharsCapped &&
		args.input >
			Math.max(
				PARTIAL_EVICTION_MIN_FRESH_TOKENS,
				args.estimatedNewTokens * PARTIAL_EVICTION_INPUT_FACTOR,
			)
	) {
		return { kind, cause: "partial-eviction" };
	}
	if (args.prefixStable) {
		return {
			kind,
			cause: "unknown",
			unknownReason:
				kind === "zero-read"
					? "provider-reported-zero-stable-prefix"
					: "provider-reported-low-read-stable-prefix",
		};
	}
	return {
		kind,
		cause: "unknown",
		unknownReason: "no-local-explanation",
	};
}

/**
 * What one usage record does to the session's prompt-cache baseline. Logged
 * beside the usage numbers on `cache_usage`, so a reader can tell why a later
 * shortfall was or was not measured against this read.
 *
 * `advanced` — a healthy record IS the prefix this session last read whole;
 * `shrunk` — a low read whose whole prompt fell below half the baseline
 * (`promptShrank`), i.e. a durable smaller prompt (compaction, a trimmed
 * transcript); `held` — a miss that kept the last healthy read (a rewrite, a
 * zero read, the compacted turn itself when it read nothing, or unreadable
 * token counts); `switched` — a model or provider
 * change cleared it; `cleared` — the record carried no readable `cacheRead`.
 */
type CacheBaselineDecision =
	| "advanced"
	| "shrunk"
	| "held"
	| "switched"
	| "cleared";

/**
 * Whether this request's whole prompt is SMALLER than the prefix the session
 * last read whole, by the same ratio that makes a read low (#4718 review F1,
 * F8).
 *
 * pi-ai reports every request's prompt as three disjoint counts on every api:
 * `cacheRead`, `cacheWrite` and `input` (`totalTokens` is their sum plus
 * `output`). Providers differ only in where the uncached part lands: Anthropic
 * and Bedrock report it as `cacheWrite`, while Gemini, Vertex, Mistral and
 * OpenAI report `cacheWrite: 0` and carry it in `input`. Their sum is the
 * prompt on all of them, so no provider class is needed. A rewritten prefix
 * comes back as uncached tokens and keeps the prompt near the old prefix; a
 * compacted transcript shrinks the prompt itself. Reading `cacheWrite` alone
 * (round 2) took Gemini's zero write for a shrink, so its second rewrite read
 * as a hit.
 *
 * A prompt below half the baseline is the same "low" the classifier applies
 * to the read, so a turn held by this rule has a prompt the next turn's read
 * is not low against: holding can cost one miss, never a stream of them.
 *
 * The read does not matter (#4718 verify F11): a compaction changes the
 * prefix, so the compacted turn usually reads NOTHING from cache (13 of 13
 * real compactions in the maintainer's log) and its prompt arrives in `input`
 * or `cacheWrite`. An empty prompt (pi-ai's all-zero usage on an aborted or
 * errored request) proves nothing, so it is not a shrink. Any unreadable
 * count fails closed (false: hold and keep the miss).
 */
function promptShrank(args: {
	cacheRead: number | undefined;
	input: number | undefined;
	cacheWrite: number | undefined;
	priorCacheRead: number | undefined;
}): boolean {
	const prior = readableTokenCount(args.priorCacheRead);
	const cacheRead = readableTokenCount(args.cacheRead);
	const input = readableTokenCount(args.input);
	const cacheWrite = readableTokenCount(args.cacheWrite);
	if (
		prior === undefined ||
		cacheRead === undefined ||
		input === undefined ||
		cacheWrite === undefined
	) {
		return false;
	}
	const prompt = cacheRead + input + cacheWrite;
	return prompt > 0 && prompt < prior * LOW_CACHE_READ_RATIO;
}

/**
 * Decide the baseline the NEXT turn is measured against (#4687 item 3, #4718
 * review F1). A baseline that only ever advanced treated a durable prefix
 * shrink as a permanent miss: the shrink turn's lower read was never written
 * again, and every later turn re-reported the same shortfall against a prefix
 * that no longer exists.
 */
function nextCacheBaseline(args: {
	cacheRead: number | undefined;
	priorCacheRead: number | undefined;
	kind: CacheMissKind | undefined;
	modelProviderChanged: boolean;
	promptShrank: boolean;
}): { baseline: number | undefined; decision: CacheBaselineDecision } {
	// A new provider or model tokenizes and caches its own prefix, so the read
	// of the previous one says nothing about it: start a fresh baseline rather
	// than measuring the new provider against the old provider's number.
	if (args.modelProviderChanged) {
		return { baseline: undefined, decision: "switched" };
	}
	if (args.cacheRead === undefined) {
		return { baseline: undefined, decision: "cleared" };
	}
	// Only a low read moves the baseline to the smaller prefix. A zero-read
	// shrink (the compacted turn itself, #4718 verify F11) holds: moving to 0
	// would switch off low-read detection for the next turn, which reads the
	// compacted prefix and shrinks the baseline with real read evidence.
	if (args.promptShrank && args.kind === "low-read") {
		return { baseline: args.cacheRead, decision: "shrunk" };
	}
	// No kind means no shortfall: a healthy read becomes the new baseline.
	if (args.kind === undefined) {
		return { baseline: args.cacheRead, decision: "advanced" };
	}
	// A rewrite, a zero read, or counts that cannot prove a smaller prompt: keep
	// the last healthy read so a second consecutive rewrite is still a miss.
	return { baseline: args.priorCacheRead, decision: "held" };
}

/**
 * Record one unexplained miss (#4687 item 5).
 *
 * The FIRST unknown miss in a session counts silently: one provider-side gap
 * with no local cause is ordinary noise, so it only raises the session's own
 * counter and the ledger hears nothing. That silence is what the doc says and
 * what a reader of `/lens-perf` or `dmlens_health` sees: no `⚠` line before the
 * second miss (#4718 review F2, where the first miss already recorded a ledger
 * entry). From the SECOND on the session has a pattern, so the ledger carries
 * one bounded `prompt-cache-miss-unexplained` row and every later miss only
 * raises the count. The row is written through `recordDegradationOnce` exactly
 * once, so the ledger count is the ADMITTED misses, the session total less the
 * silent first: 1 after the second miss, 2 after the third. The durable row is
 * written once, at admission, so its `metadata.misses` always reads 2. The
 * session's exact total is `cache_usage_summary`'s `cacheMissCauses.unknown`
 * (#4718 review F10). A shrink is named `prefix-shrunk` and never reaches this
 * counter (#4718 review F7).
 */
function recordUnexplainedMiss(
	state: SessionAttributionState,
	subject: string,
	unknownReason: CacheMissUnknownReason | undefined,
): void {
	state.unexplainedMisses += 1;
	if (state.unexplainedMisses === 1) return;
	const reason = `prompt-cache miss has no local cause (${unknownReason ?? "unspecified"})`;
	const metadata = {
		unknownReason: unknownReason ?? "unspecified",
		misses: state.unexplainedMisses,
	};
	// Both ledger entries are documented no-throw: a telemetry failure never
	// compromises the observed path. The record object is inlined at each call
	// so the kind literal sits in the record's own call site.
	if (state.unexplainedMisses === 2)
		recordDegradationOnce({
			kind: "prompt-cache-miss-unexplained",
			subject,
			reason,
			metadata,
		});
	else
		recordDegradation({
			kind: "prompt-cache-miss-unexplained",
			subject,
			reason,
			metadata,
		});
}

function recordCacheUsageSummary(args: {
	state: SessionAttributionState;
	cacheRead: number | undefined;
	priorCacheRead: number | undefined;
	verdict: CacheMissVerdict | null;
	unknownReason?: CacheMissUnknownReason;
}): void {
	const summary = args.state.summary;
	summary.usageRecords += 1;
	let unknownReasonRecorded = false;
	if (args.unknownReason === "malformed-provider-usage") {
		summary.unknownEvidenceReasons["malformed-provider-usage"] += 1;
		unknownReasonRecorded = true;
	}
	if (args.cacheRead === undefined) {
		if (!unknownReasonRecorded) {
			summary.unknownEvidenceReasons["cache-read-unavailable"] += 1;
		}
		return;
	}
	if (args.priorCacheRead === undefined) {
		if (args.cacheRead === 0) {
			summary.missObservations += 1;
			if (!unknownReasonRecorded) {
				summary.unknownEvidenceReasons["no-prior-sample"] += 1;
			}
		} else {
			summary.cacheHits += 1;
		}
		return;
	}
	if (!args.verdict) {
		summary.cacheHits += 1;
		return;
	}
	summary.missObservations += 1;
	summary.cacheMissCauses[args.verdict.cause] += 1;
	if (
		args.verdict.cause === "unknown" &&
		args.unknownReason &&
		!unknownReasonRecorded
	) {
		summary.unknownEvidenceReasons[args.unknownReason] += 1;
	}
}

interface BoundedHashState {
	contentTruncated: boolean;
	incomplete: boolean;
}

function boundedHashScalar(value: unknown, state: BoundedHashState): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") {
		const truncated = value.length > MAX_HASHED_CONTENT_CHARS;
		if (truncated) state.contentTruncated = true;
		const suffix = truncated ? ":content-truncated" : "";
		return `string:${value.length}:${value.slice(0, MAX_HASHED_CONTENT_CHARS)}${suffix}`;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return `${typeof value}:${String(value)}`;
	}
	return typeof value;
}

function boundedHashArray(
	value: unknown[],
	depth: number,
	seen: Set<object>,
	state: BoundedHashState,
): string {
	if (value.length > 12) state.contentTruncated = true;
	const items = value
		.slice(0, 12)
		.map((item) => boundedHashValue(item, depth + 1, seen, state));
	return `array:${value.length}:[${items.join(",")}]`;
}

function boundedHashObject(
	value: Record<string, unknown>,
	depth: number,
	seen: Set<object>,
	state: BoundedHashState,
): string {
	const keys = Object.keys(value).sort((left, right) =>
		compareOrdinal(left, right),
	);
	if (keys.length > 24) state.contentTruncated = true;
	const fields = keys
		.slice(0, 24)
		.map(
			(key) => `${key}:${boundedHashValue(value[key], depth + 1, seen, state)}`,
		);
	return `object:${keys.length}:{${fields.join(",")}}`;
}

function boundedHashValue(
	value: unknown,
	depth = 0,
	seen = new Set<object>(),
	state?: BoundedHashState,
): string {
	const hashState = state ?? { contentTruncated: false, incomplete: false };
	if (value === null || typeof value !== "object") {
		return boundedHashScalar(value, hashState);
	}
	if (depth >= 3) {
		hashState.contentTruncated = true;
		return "[depth-limit]";
	}
	if (seen.has(value)) {
		hashState.incomplete = true;
		return "[cycle]";
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return boundedHashArray(value, depth, seen, hashState);
		}
		return boundedHashObject(
			value as Record<string, unknown>,
			depth,
			seen,
			hashState,
		);
	} catch {
		hashState.incomplete = true;
		return "[unreadable]";
	} finally {
		seen.delete(value);
	}
}

function hashMessageSequence(messages: ReadonlyArray<ContextMessageLike>): {
	hash: string;
	truncated: boolean;
	contentTruncated: boolean;
	incomplete: boolean;
} {
	const hash = createHash("sha256");
	const state: BoundedHashState = {
		contentTruncated: false,
		incomplete: false,
	};
	let messageCount: number;
	try {
		messageCount = messages.length;
		if (!Number.isSafeInteger(messageCount) || messageCount < 0) {
			throw new Error("invalid message count");
		}
	} catch {
		state.incomplete = true;
		hash.update("message-count:[unreadable];");
		return {
			hash: hash.digest("hex"),
			truncated: false,
			contentTruncated: false,
			incomplete: true,
		};
	}
	hash.update(`message-count:${messageCount};`);
	const sampled = Math.min(messageCount, MAX_HASHED_MESSAGES);
	for (let i = 0; i < sampled; i++) {
		const seen = new Set<object>();
		let role: unknown;
		let content: unknown;
		try {
			const message = messages[i];
			role = message?.role;
			content = message?.content;
		} catch {
			state.incomplete = true;
			role = "[unreadable]";
			content = "[unreadable]";
		}
		hash.update(
			`${i}|role:${boundedHashValue(role, 0, seen, state)}|content:${boundedHashValue(content, 0, seen, state)};`,
		);
	}
	const truncated = messageCount > sampled;
	if (truncated) hash.update(`truncated-after:${sampled};`);
	return {
		hash: hash.digest("hex"),
		truncated,
		contentTruncated: state.contentTruncated,
		incomplete: state.incomplete,
	};
}

/** Bytes kept per message by {@link rollingMessageDigests}. */
const ROLLING_DIGEST_BYTES = 8;

/**
 * #4743: bounds on the rolling digest. A transcript past either bound gets no
 * digest, so the divergence reads `unavailable` and a retained injection is
 * not re-sent. 10,000 messages is `MAX_REPORTED_MESSAGES`; 16 Mi characters
 * is four times a one-million-token context at four characters per token.
 */
export const MAX_ROLLING_DIGEST_MESSAGES = MAX_REPORTED_MESSAGES;
export const MAX_ROLLING_DIGEST_CHARS = 16 * 1024 * 1024;

/** Why {@link rollingMessageDigests} returned no digest. */
export type RollingDigestGap =
	| "too-many-messages"
	| "too-many-chars"
	| "unserializable";

export type RollingDigests =
	| { complete: true; count: number; digests: Buffer }
	| { complete: false; gap: RollingDigestGap };

/**
 * A rolling digest of a message list (#4743): entry `i` hashes messages
 * `0..i`, each serialized the way a provider receives it (`JSON.stringify`,
 * insertion order, every field), so two lists share digest `i` exactly when
 * they share their first `i + 1` messages. Unbounded per message, unlike the
 * sampled `hashMessageSequence`: one long tool result must not hide where a
 * request stopped repeating the one before it. Never throws.
 */
export function rollingMessageDigests(
	messages: ReadonlyArray<unknown>,
): RollingDigests {
	try {
		const count = messages.length;
		if (count > MAX_ROLLING_DIGEST_MESSAGES)
			return { complete: false, gap: "too-many-messages" };
		const digests = Buffer.alloc(count * ROLLING_DIGEST_BYTES);
		const hash = createHash("sha256");
		let chars = 0;
		for (let index = 0; index < count; index++) {
			const serialized = JSON.stringify(messages[index]) ?? "undefined";
			chars += serialized.length;
			if (chars > MAX_ROLLING_DIGEST_CHARS)
				return { complete: false, gap: "too-many-chars" };
			hash.update(serialized).update("\u0000");
			hash
				.copy()
				.digest()
				.copy(digests, index * ROLLING_DIGEST_BYTES, 0, ROLLING_DIGEST_BYTES);
		}
		return { complete: true, count, digests };
	} catch {
		// none: a cycle, a BigInt or a throwing getter leaves the list without a
		// digest; the gap is the return value, and both callers record it
		// (cache_context's `rollingDigestGap`, the ledger's
		// `context-injection-retain-declined` row).
		return { complete: false, gap: "unserializable" };
	}
}

/** Digest of messages `0..index` as hex, or undefined past the list. */
export function rollingDigestAt(
	digests: RollingDigests,
	index: number,
): string | undefined {
	if (!digests.complete || index < 0 || index >= digests.count) return;
	const start = index * ROLLING_DIGEST_BYTES;
	return digests.digests.toString("hex", start, start + ROLLING_DIGEST_BYTES);
}

/**
 * The first message index where `current` stops repeating `previous`, or
 * undefined when `previous` is a whole prefix of `current` (append-only).
 */
function firstDifferingMessageIndex(
	previous: Buffer,
	current: Buffer,
): number | undefined {
	const previousCount = previous.length / ROLLING_DIGEST_BYTES;
	const currentCount = current.length / ROLLING_DIGEST_BYTES;
	const shared = Math.min(previousCount, currentCount);
	for (let index = 0; index < shared; index++) {
		const start = index * ROLLING_DIGEST_BYTES;
		if (
			previous.compare(
				current,
				start,
				start + ROLLING_DIGEST_BYTES,
				start,
				start + ROLLING_DIGEST_BYTES,
			) !== 0
		)
			return index;
	}
	return currentCount < previousCount ? currentCount : undefined;
}

/**
 * Where this request stops repeating the session's previous one (#4743).
 * `baseline`: no earlier request; `append-only`: the earlier request is a
 * whole prefix of this one; `diverged`: they differ from
 * `firstDifferingMessageIndex` on; `unavailable`: either list has no digest.
 */
type PrefixDivergence = "baseline" | "append-only" | "diverged" | "unavailable";

/** Per-measurement bounds, so the caller picks the population's own cap. */
interface MeasureLimits {
	maxChars: number;
	maxBytes: number;
}

/** Bounds for reporting an injected payload's size in the record. */
const INJECTED_LIMITS: MeasureLimits = {
	maxChars: MAX_INJECTED_CHARS,
	maxBytes: MAX_INJECTED_BYTES,
};

/** Bounds for the transcript-growth accumulator that feeds the verdict. */
const TRANSCRIPT_LIMITS: MeasureLimits = {
	maxChars: MAX_ATTRIBUTION_CHARS,
	maxBytes: MAX_ATTRIBUTION_BYTES,
};

function messageTextSize(
	content: unknown,
	limits: MeasureLimits,
): { chars: number; bytes: number } {
	if (typeof content === "string") {
		const chars = Math.min(content.length, limits.maxChars);
		return {
			chars,
			bytes: Math.min(
				Buffer.byteLength(content.slice(0, chars), "utf8"),
				limits.maxBytes,
			),
		};
	}
	const bounded = boundedHashValue(content, 0, new Set<object>(), {
		contentTruncated: false,
		incomplete: false,
	});
	return {
		chars: Math.min(bounded.length, limits.maxChars),
		bytes: Math.min(
			Buffer.byteLength(bounded.slice(0, limits.maxChars), "utf8"),
			limits.maxBytes,
		),
	};
}

function measureMessages(
	messages: ReadonlyArray<ContextMessageLike>,
	limits: MeasureLimits,
): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	let chars = 0;
	let bytes = 0;
	const measuredCount = Math.min(messages.length, MAX_REPORTED_MESSAGES);
	for (let i = 0; i < measuredCount; i++) {
		const message = messages[i];
		const size = messageTextSize(message?.content, limits);
		chars = Math.min(limits.maxChars, chars + size.chars);
		bytes = Math.min(limits.maxBytes, bytes + size.bytes);
		if (chars === limits.maxChars || bytes === limits.maxBytes) break;
	}
	return {
		chars,
		bytes,
		capped: chars >= limits.maxChars || bytes >= limits.maxBytes,
	};
}

/** Size of an injected payload, bounded for reporting. */
function measureInjectedMessages(messages: ReadonlyArray<ContextMessageLike>): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	return measureMessages(messages, INJECTED_LIMITS);
}

/**
 * Size of the transcript's own growth, bounded far higher. A routine tool
 * result is an order of magnitude past the injection cap, and measuring it
 * through that cap made `partial-eviction` near-unreachable (#1071 review
 * round 1, F2).
 */
function measureTranscriptGrowth(messages: ReadonlyArray<ContextMessageLike>): {
	chars: number;
	bytes: number;
	capped: boolean;
} {
	return measureMessages(messages, TRANSCRIPT_LIMITS);
}

function sessionKey(sessionId?: string): string {
	return sessionId?.trim() ? sessionId.trim() : NO_SESSION_KEY;
}

/**
 * A stable host session id is the only safe cross-event identity. When it is
 * absent, keep primary and concurrent-secondary observations in separate
 * buckets and let classification fail closed instead of allowing a secondary
 * to overwrite the primary's baseline.
 */
function attributionKey(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): string {
	const key = sessionKey(sessionId);
	if (key !== NO_SESSION_KEY) return key;
	return `${sessionRole ?? "unknown"}:${key}`;
}

/** #4743: the retained-injection ledger's work on one request. */
export interface CacheContextRetention {
	/** Retained entries re-sent on this request. */
	reemitted: number;
	/** Their rendered bytes. */
	reemittedBytes: number;
	/** Entries deleted because the transcript before their anchor changed. */
	pruned: number;
	/** This request's new injection was added to the ledger. */
	retainedNew: boolean;
	/** Why a new injection was not retained, or the ledger was cleared. */
	declined?: string;
}

/**
 * Compare this request's rolling digest with the session's previous request
 * and arm `injection-dropped` when the first difference lands where dm-lens
 * had added a span (#4743). Returns the bounded record fields.
 */
function observePrefixDivergence(
	state: SessionAttributionState,
	resultMessages: ReadonlyArray<ContextMessageLike>,
	injectedPositions: readonly number[],
): {
	prefixDivergence: PrefixDivergence;
	firstDifferingMessageIndex: number | null;
	previousRequestMessageCount: number | null;
	divergedAtInjection: boolean;
	rollingDigestGap: RollingDigestGap | null;
	injectedSpanCount: number;
} {
	const current = rollingMessageDigests(resultMessages);
	const previous = state.lastRequestDigests;
	const previousPositions = state.lastInjectedPositions ?? [];
	state.lastRequestDigests = current.complete ? current.digests : null;
	state.lastInjectedPositions = current.complete
		? injectedPositions
		: undefined;
	const base = {
		previousRequestMessageCount: previous
			? previous.length / ROLLING_DIGEST_BYTES
			: null,
		rollingDigestGap: current.complete ? null : current.gap,
		injectedSpanCount: injectedPositions.length,
	};
	if (!current.complete || previous === null)
		return {
			...base,
			prefixDivergence: "unavailable",
			firstDifferingMessageIndex: null,
			divergedAtInjection: false,
		};
	if (previous === undefined)
		return {
			...base,
			prefixDivergence: "baseline",
			firstDifferingMessageIndex: null,
			divergedAtInjection: false,
		};
	const index = firstDifferingMessageIndex(previous, current.digests);
	if (index === undefined)
		return {
			...base,
			prefixDivergence: "append-only",
			firstDifferingMessageIndex: null,
			divergedAtInjection: false,
		};
	const atInjection = previousPositions.includes(index);
	if (atInjection) state.injectionDroppedSinceLastUsage = true;
	return {
		...base,
		prefixDivergence: "diverged",
		firstDifferingMessageIndex: index,
		divergedAtInjection: atInjection,
	};
}

/**
 * Log one bounded request-side observation for every `context` call. This is
 * deliberately a separate phase from `cache_prefix_break`: it describes the
 * messages dm-lens saw and returned from its own context handler, not the final
 * provider request after other context handlers and not whether a provider
 * reused or missed a prompt cache. `observationId` is local to this process; the
 * host currently exposes no request id on ContextEvent/MessageEndEvent. A
 * RuntimeCoordinator turn is process-global, so it is explicitly scoped as
 * such and is omitted for concurrent secondary sessions.
 */
export function observeCacheContext(args: {
	existingMessages?: ReadonlyArray<ContextMessageLike>;
	resultMessages?: ReadonlyArray<ContextMessageLike>;
	sessionId?: string;
	sessionRole?: "primary" | "concurrent-secondary";
	turnIndex: number;
	injectionEnabled: boolean;
	/**
	 * The payload, split by contributing source. This is the SINGLE source of
	 * truth for the record's `injectionSources`, counts, and sizes: the flat
	 * message list and the source-name list are both derived here, so a caller
	 * cannot report a source it did not actually contribute (#1071).
	 */
	injectionSlices?: ReadonlyArray<CacheContextInjectionSlice>;
	placement?: CacheContextPlacement;
	/** The request hook that carried this observation (#4631). */
	injectionHook?: CacheContextInjectionHook;
	/**
	 * #4743: positions in `resultMessages` where a dm-lens span begins (a
	 * modified message or the first of an inserted run), new or retained. The
	 * NEXT request's first differing index is attributed to a dropped injection
	 * when it lands on one of these.
	 */
	injectedPositions?: readonly number[];
	/** #4743: what the retained-injection ledger did, when its flag is on. */
	retention?: CacheContextRetention;
	dbg?: (msg: string) => void;
}): void {
	try {
		const existingMessages = args.existingMessages ?? [];
		const resultMessages = args.resultMessages ?? existingMessages;
		// Drop empty slices before deriving anything: a source that contributed
		// no message is not a contributor, and listing it would overstate the
		// payload's provenance.
		const injectionSlices = (args.injectionSlices ?? []).filter(
			(slice) => slice.messages.length > 0,
		);
		const injectedMessages = injectionSlices.flatMap((slice) => slice.messages);
		const placement = args.placement ?? "none";
		const beforeSequence = hashMessageSequence(existingMessages);
		const afterSequence = hashMessageSequence(resultMessages);
		const sizes = measureInjectedMessages(injectedMessages);
		// Per-source split of a mixed payload (#1071 AC 2). The old record named
		// which sources fired but attributed cost by CALL, so a turn carrying
		// turn-findings plus an agent nudge was one undivided number.
		const sourceBreakdown = injectionSlices.map((slice) => {
			const sliceSize = measureInjectedMessages(slice.messages);
			return {
				source: slice.source,
				messageCount: Math.min(slice.messages.length, MAX_REPORTED_MESSAGES),
				chars: sliceSize.chars,
				bytes: sliceSize.bytes,
				estimatedTokens: estimateTokens(sliceSize.chars),
				countsCapped: sliceSize.capped,
			};
		});
		const state = attributionFor(
			attributionKey(args.sessionId, args.sessionRole),
		);
		for (const slice of injectionSlices) {
			const key = sourceKey(slice.source);
			const bytes = measureInjectedMessages(slice.messages).bytes;
			state.injectedBytes[key] += bytes;
			for (const message of slice.messages) {
				for (const identity of findingIdentities(
					typeof message.content === "string" ? message.content : "",
				)) {
					if (state.findingIdentities.has(identity)) {
						state.injectedFindingsRepeated += 1;
						continue;
					}
					if (state.findingIdentities.size >= MAX_FINDING_IDENTITIES) {
						if (!state.findingIdentityCapRecorded) {
							state.findingIdentityCapRecorded = true;
							logLatency({
								type: "phase",
								filePath: "<dm-lens>",
								phase: "injected_finding_identity_cap",
								durationMs: 0,
								metadata: { cap: MAX_FINDING_IDENTITIES },
							});
						}
						continue;
					}
					state.findingIdentities.add(identity);
				}
			}
		}
		const messageCountCapped =
			existingMessages.length > MAX_REPORTED_MESSAGES ||
			resultMessages.length > MAX_REPORTED_MESSAGES;
		recordContextAttribution(
			attributionKey(args.sessionId, args.sessionRole),
			existingMessages,
			sizes,
		);
		state.sequenceHashTruncatedSinceLastUsage ||=
			beforeSequence.truncated ||
			beforeSequence.contentTruncated ||
			afterSequence.truncated ||
			afterSequence.contentTruncated;
		state.requestEvidenceIncompleteSinceLastUsage ||=
			beforeSequence.incomplete || afterSequence.incomplete;
		const divergence = observePrefixDivergence(
			state,
			resultMessages,
			args.injectedPositions ?? [],
		);

		logLatency({
			type: "phase",
			filePath: "<dm-lens>",
			phase: "cache_context",
			durationMs: 0,
			metadata: {
				version: 1,
				observedStage: "dm-lens-context-handler",
				// #4631: `context` on a pre-0.87 host, `context_with_system` on
				// 0.87+. The two see different message lists, so a reader needs
				// this to compare an observation against a host generation.
				injectionHook: args.injectionHook ?? null,
				observationId: `ctx-${(++contextObservationCounter).toString(36)}`,
				sessionId: sessionKey(args.sessionId),
				sessionRole: args.sessionRole,
				...(args.sessionRole === "concurrent-secondary"
					? { turnScope: SECONDARY_TURN_SCOPE }
					: { turnIndex: args.turnIndex, turnScope: PROCESS_TURN_SCOPE }),
				injectionEnabled: args.injectionEnabled,
				injectionSources: sourceBreakdown.map((entry) => entry.source),
				injectionSourceBreakdown: sourceBreakdown,
				injectionOccurred: injectedMessages.length > 0,
				injectedMessageCount: Math.min(
					injectedMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				injectedMessageCountCapped:
					injectedMessages.length > MAX_REPORTED_MESSAGES,
				injectedChars: sizes.chars,
				injectedBytes: sizes.bytes,
				injectedBytesBySource: Object.fromEntries(
					sourceBreakdown.map((entry) => [
						sourceKey(entry.source),
						entry.bytes,
					]),
				),
				injectedEstimatedTokens: estimateTokens(sizes.chars),
				injectedTokenBasis: "chars-per-token-4-estimate-not-provider-measured",
				injectedCountsCapped: sizes.capped,
				existingMessageCount: Math.min(
					existingMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				resultMessageCount: Math.min(
					resultMessages.length,
					MAX_REPORTED_MESSAGES,
				),
				messageCountCapped,
				placement,
				beforeSequenceHash: beforeSequence.hash,
				afterSequenceHash: afterSequence.hash,
				sequenceHashTruncated:
					beforeSequence.truncated ||
					afterSequence.truncated ||
					beforeSequence.contentTruncated ||
					afterSequence.contentTruncated,
				sequenceMessageCountTruncated:
					beforeSequence.truncated || afterSequence.truncated,
				sequenceContentHashTruncated:
					beforeSequence.contentTruncated || afterSequence.contentTruncated,
				sequenceHashIncomplete:
					beforeSequence.incomplete || afterSequence.incomplete,
				// #4743: where this request stopped repeating the previous one.
				...divergence,
				...(args.retention ? { retention: args.retention } : {}),
			},
		});
	} catch (err) {
		// The context event still occurred at request time. Preserve that clock but
		// fail the evidence closed so a later usage row cannot infer TTL/eviction
		// from an observation whose hashing/measurement never completed.
		try {
			const state = attributionFor(
				attributionKey(args.sessionId, args.sessionRole),
			);
			state.lastContextAtMs = Date.now();
			state.requestEvidenceIncompleteSinceLastUsage = true;
		} catch {
			// The outer contract is no-throw; there is no safe attribution key left.
		}
		args.dbg?.(`cache-context: failed to log context observation: ${err}`);
	}
}

/**
 * Part 1 — log one `cache_usage` record for an assistant `message_end` that
 * carries a `usage`. Provider/model come straight off the message itself
 * (`AssistantMessage.provider` / `.model` in pi-ai) — no dependency on the
 * runtime telemetry identity. Skips silently (no record) when the message is
 * not an assistant message or has no usage; never logs a zeros-only record for
 * a message that simply lacks usage.
 */
export function logCacheUsage(
	message: unknown,
	dbg?: (msg: string) => void,
	context?: CacheUsageContext,
): void {
	try {
		if (!message || typeof message !== "object") return;
		const msg = message as AssistantMessageLike;
		// Only assistant messages carry LLM usage; tool-result / user messages
		// (and unknown custom AgentMessage variants) are skipped.
		if (msg.role !== "assistant") return;
		const usage = msg.usage;
		if (!usage || typeof usage !== "object") return;
		// SAFETY: `usage` is verified non-null object above; widening to an
		// indexable record is only so the numeric-evidence readers can probe
		// each field defensively. Every read re-validates its own type.
		const usageRecord = usage as unknown as Record<string, unknown>;
		// #1071: attribute the shortfall in-process, from state this module already
		// keeps, so nothing re-reads latency.log.
		const stateKey = attributionKey(context?.sessionId, context?.sessionRole);
		const state = attributionFor(stateKey);
		const nowMs = Date.now();
		const gap = resolveInterTurnGap(state, nowMs);
		const interTurnGapMs = gap.gapMs;
		const ttlMs = getProviderCacheTtlMs();
		const inputEvidence = readNumericEvidence(usageRecord, "input");
		const outputEvidence = readNumericEvidence(usageRecord, "output");
		const cacheReadEvidence = readNumericEvidence(usageRecord, "cacheRead");
		const cacheWriteEvidence = readNumericEvidence(usageRecord, "cacheWrite");
		let costEvidence: NumericEvidence;
		try {
			const cost = usageRecord.cost;
			costEvidence =
				cost === undefined
					? { status: "absent" }
					: cost && typeof cost === "object"
						? readNumericEvidence(cost as Record<string, unknown>, "total")
						: { status: "malformed" };
		} catch {
			costEvidence = { status: "malformed" };
		}
		const usageEvidenceFields: ReadonlyArray<
			readonly [string, NumericEvidence]
		> = [
			["input", inputEvidence],
			["output", outputEvidence],
			["cacheRead", cacheReadEvidence],
			["cacheWrite", cacheWriteEvidence],
			["cost.total", costEvidence],
		];
		const malformedProviderUsageFields = usageEvidenceFields
			.filter(([, evidence]) => evidence.status === "malformed")
			.map(([field]) => field);
		const providerUsageMalformed = malformedProviderUsageFields.length > 0;
		const cacheRead = cacheReadEvidence.value;
		const priorCacheReadValue = readableTokenCount(state.lastHealthyCacheRead);
		// SAFETY: `msg` passed the AssistantMessageLike role check above; the
		// record view backs only the guarded identity-field probes below, each
		// re-validated by `identityEvidence` at its own boundary.
		const messageRecord = msg as unknown as Record<string, unknown>;
		const safeMessageField = (key: string): IdentityEvidence => {
			try {
				return identityEvidence(messageRecord[key]);
			} catch {
				return { status: "unavailable" };
			}
		};
		const currentProvider = safeMessageField("provider");
		const responseModel = safeMessageField("responseModel");
		const currentModel =
			responseModel.hash !== undefined
				? responseModel
				: safeMessageField("model");
		const modelProviderEvidenceAvailable = Boolean(
			currentProvider.hash &&
			currentModel.hash &&
			state.lastProviderIdentityHash &&
			state.lastModelIdentityHash,
		);
		const modelProviderChanged = Boolean(
			modelProviderEvidenceAvailable &&
			(currentProvider.hash !== state.lastProviderIdentityHash ||
				currentModel.hash !== state.lastModelIdentityHash),
		);
		const estimatedNewTokens = estimateTokens(
			state.injectedCharsSinceLastUsage +
				state.newTranscriptCharsSinceLastUsage,
		);
		// One derivation read by both the classifier and the unexplained-miss
		// counter (#4718 review F5).
		const stableSessionIdentity =
			sessionKey(context?.sessionId) !== NO_SESSION_KEY;
		// One derivation read by the classifier (the `prefix-shrunk` cause) and by
		// the baseline rule (`shrunk`), so the two can never disagree (#4718
		// review F7). The raw `input` is passed: a missing one must not read as 0.
		const shrank = promptShrank({
			cacheRead,
			input: inputEvidence.value,
			cacheWrite: cacheWriteEvidence.value,
			priorCacheRead: priorCacheReadValue,
		});
		const verdict = classifyCacheMiss({
			cacheRead,
			// Every uncached prompt token, wherever the provider puts it (see
			// `promptShrank`). Missing/malformed counts cannot prove fresh-input
			// pressure; the explicit malformed gate keeps every heuristic fail-closed.
			input: (inputEvidence.value ?? 0) + (cacheWriteEvidence.value ?? 0),
			priorCacheRead: priorCacheReadValue,
			interTurnGapMs,
			gapBasis: gap.basis,
			ttlMs,
			prefixBroke: state.prefixBrokeSinceLastUsage,
			toolSetChanged: state.toolSetChangedSinceLastUsage,
			systemPromptChanged: state.systemPromptChangedSinceLastUsage,
			prefixStable: state.prefixStableSinceLastUsage,
			sequenceHashTruncated: state.sequenceHashTruncatedSinceLastUsage,
			requestEvidenceIncomplete: state.requestEvidenceIncompleteSinceLastUsage,
			stableSessionIdentity,
			modelProviderChanged,
			modelProviderEvidenceAvailable,
			providerUsageMalformed,
			estimatedNewTokens,
			attributionCharsCapped: state.attributionCharsCapped,
			promptShrank: shrank,
			injectionDropped: state.injectionDroppedSinceLastUsage,
		});
		const unknownReason: CacheMissUnknownReason | undefined =
			providerUsageMalformed
				? "malformed-provider-usage"
				: cacheRead === undefined
					? "cache-read-unavailable"
					: priorCacheReadValue === undefined && cacheRead === 0
						? "no-prior-sample"
						: verdict?.unknownReason;
		recordCacheUsageSummary({
			state,
			cacheRead,
			priorCacheRead: priorCacheReadValue,
			verdict,
			unknownReason,
		});
		// #4718 review F5: without a stable session id every miss lands in one
		// shared `<no-session>` bucket, so two different sessions would combine
		// toward the second-miss row and the row would claim "no local cause" for
		// what is really a telemetry gap. The classifier already fails such a
		// record closed (`request-correlation-unavailable`); the ledger simply
		// does not count it.
		if (verdict?.cause === "unknown" && stableSessionIdentity) {
			recordUnexplainedMiss(
				state,
				sessionKey(context?.sessionId),
				unknownReason,
			);
		}
		const priorCacheRead = priorCacheReadValue ?? null;
		const injectedCharsSinceLastTurn = state.injectedCharsSinceLastUsage;
		const newTranscriptCharsSinceLastTurn =
			state.newTranscriptCharsSinceLastUsage;
		const attributionCharsCapped = state.attributionCharsCapped;
		const injectedBytes = {
			...state.injectedBytes,
			turnEndAdvisory:
				state.turnEndAdvisoryBytes + state.injectedBytes.turnEndAdvisory,
		};
		const injectedFindingsRepeated = state.injectedFindingsRepeated;
		const toolResultBytes = state.toolResultBytes;
		const toolResultsTruncated = state.toolResultsTruncated;
		// This record is the turn boundary: reset the per-turn accumulators and
		// re-arm the prefix-break flag so the next verdict describes the NEXT gap.
		state.lastUsageAtMs = nowMs;
		// #1071 review round 1, F4: a record whose `cacheRead` is absent or
		// non-finite carries no baseline, so clear the stored one rather than
		// keeping it. #4687 item 3: a MISS does not replace the baseline, so a
		// second consecutive rewrite is measured against the last healthy read
		// instead of against the previous miss's remainder. #4718 review F1: a
		// durable SHRINK does replace it, or every later turn re-reports a
		// shortfall against a prefix the provider no longer holds; and a model or
		// provider switch clears it, because the new provider's prefix is its own.
		// `nextCacheBaseline` owns that rule and names the decision it took.
		const cacheBaseline = nextCacheBaseline({
			cacheRead,
			priorCacheRead: priorCacheReadValue,
			kind: verdict?.kind,
			modelProviderChanged,
			promptShrank: shrank,
		});
		state.lastHealthyCacheRead = cacheBaseline.baseline;
		state.lastProviderIdentityHash = currentProvider.hash;
		state.lastModelIdentityHash = currentModel.hash;
		state.prefixBrokeSinceLastUsage = false;
		state.prefixStableSinceLastUsage = false;
		state.toolSetChangedSinceLastUsage = false;
		state.systemPromptChangedSinceLastUsage = false;
		state.injectionDroppedSinceLastUsage = false;
		state.sequenceHashTruncatedSinceLastUsage = false;
		state.requestEvidenceIncompleteSinceLastUsage = false;
		state.injectedCharsSinceLastUsage = 0;
		state.newTranscriptCharsSinceLastUsage = 0;
		state.attributionCharsCapped = false;
		state.injectedBytes = emptyInjectedBytes();
		state.injectedFindingsRepeated = 0;
		state.turnEndAdvisoryBytes = 0;
		state.toolResultBytes = 0;
		state.toolResultsTruncated = 0;
		// Clear the request stamp too: the next turn measures from ITS request, and
		// a turn whose `context` call dm-lens never saw must fall back rather than
		// reuse this one.
		state.lastContextAtMs = undefined;
		logLatency({
			type: "phase",
			filePath: "<dm-lens>",
			phase: "cache_usage",
			durationMs: 0,
			metadata: {
				provider: currentProvider.display,
				model: currentModel.display,
				providerIdentityHash: currentProvider.hash,
				modelIdentityHash: currentModel.hash,
				providerIdentityStatus: currentProvider.status,
				modelIdentityStatus: currentModel.status,
				providerIdentityTruncated: currentProvider.status === "truncated",
				modelIdentityTruncated: currentModel.status === "truncated",
				cacheRead: cacheReadEvidence.value ?? null,
				cacheWrite: cacheWriteEvidence.value ?? null,
				// What this record did to the baseline the NEXT shortfall is measured
				// against (#4718 review F1). `held` keeps the last healthy read;
				// `shrunk` replaces it with this record's smaller read.
				cacheBaseline: cacheBaseline.decision,
				input: inputEvidence.value ?? null,
				output: outputEvidence.value ?? null,
				// `Usage.cost` is a breakdown object; the total is the headline number.
				cost: costEvidence.value ?? null,
				providerUsageMalformedFields: malformedProviderUsageFields,
				// Idle milliseconds before this turn's request, or null for the first
				// record in the session. This is the field the 2026-08-21
				// investigation had to reconstruct by hand-joining timestamps.
				interTurnGapMs,
				gapBasis: gap.basis,
				// null means "nothing to explain", not "cause unknown"; `unknown` is
				// the explicit no-local-explanation verdict.
				cacheMissCause: verdict?.cause ?? null,
				cacheMissKind: verdict?.kind ?? null,
				cacheMissUnknownReason: unknownReason ?? null,
				modelProviderChanged,
				cacheTtlThresholdMs: ttlMs,
				priorCacheRead,
				injectedCharsSinceLastTurn,
				newTranscriptCharsSinceLastTurn,
				attributionCharsCapped,
				injectedBytes,
				injectedFindingsRepeated,
				// Delivered tool-result aggregation over the turn (#2800 item 7):
				// the sum of each delivered footer's bytes= figure and the count
				// of results whose bound fired.
				toolResultBytes,
				toolResultsTruncated,
				...(context
					? {
							// MessageEndEvent has no request/context id in the host API. These
							// fields permit session correlation without inventing an exact
							// provider-request linkage. The process-global turn is omitted
							// for a concurrent secondary session.
							sessionId: sessionKey(context.sessionId),
							...(context.sessionRole === "concurrent-secondary"
								? { turnScope: SECONDARY_TURN_SCOPE }
								: {
										turnIndex: context.turnIndex,
										turnScope: PROCESS_TURN_SCOPE,
									}),
							contextCorrelation: context.sessionId
								? "session-only-no-request-id"
								: "no-stable-session-id",
						}
					: {}),
			},
		});
	} catch (err) {
		dbg?.(`cache-usage: failed to log message_end usage: ${err}`);
	}
}

/**
 * Hash of the first transcript message, over EVERY field the message carries.
 *
 * #4631 round 5 (F1): it must be the whole message, not a projection. The
 * signal answers "did what the provider caches first change", and on pi 0.87+
 * `messages[0]` is the SYSTEM head: the prompt lives in `sections`, the tool
 * table in `toolsAdded`, and `content` is an empty string. A `{ role, content }`
 * projection therefore hashed the constant `{"role":"system","content":""}` on
 * the exact generation #4631 is about, so a rebuilt head read as a stable
 * prefix: `prefixStableSinceLastUsage` stayed true and the miss verdict stayed
 * `unknown`. Measured on the built twin: a head whose `sections`, `toolsAdded`
 * and `timestamp` had all moved answered `unchanged`, while a `content` change
 * was visible.
 *
 * Enumerating the fields at fault would re-create the same shape for the next
 * host field, so the serialization covers whatever the message carries. The
 * parameter's DECLARED shape stays the two fields its callers are guaranteed to
 * have; the runtime object is the host's whole message, and the serializer
 * reads every own field of it, not the declared two. A stable head stays stable
 * — pi hands the transcript's own object across turns, and the tier-2 cells pin
 * that byte-for-byte — and a rebuilt one is visible whatever recency field the
 * host re-stamps.
 *
 * #4687 item 6: keys are serialized in canonical (ordinal) order, so a head
 * whose fields were rebuilt in a different insertion order is the SAME head.
 * `JSON.stringify` follows insertion order, so an equal host object could hash
 * differently and read as a prefix break.
 */

/**
 * JSON-shaped serialization with object keys in canonical order.
 *
 * Mirrors `JSON.stringify`'s value rules (undefined-valued object keys are
 * omitted, array holes/undefined/functions/NaN/Infinity become `null`) while
 * sorting each object's own keys, so two equal values built in a different key
 * order produce the same string. A cycle or a throwing getter propagates to the
 * caller's guard instead of being silently normalized away.
 */
function canonicalJsonValue(value: unknown, seen: Set<object>): string {
	if (value === null) return "null";
	const kind = typeof value;
	if (kind === "string") return JSON.stringify(value);
	if (kind === "number")
		return Number.isFinite(value as number) ? String(value) : "null";
	if (kind === "boolean") return (value as boolean) ? "true" : "false";
	if (kind === "bigint") return JSON.stringify(String(value));
	// undefined, function and symbol serialize as absent (object) or null
	// (array); both callers below decide which, matching JSON.stringify.
	if (kind !== "object") return "null";
	const object = value as object;
	if (seen.has(object)) return '"[cycle]"';
	seen.add(object);
	try {
		const toJSON = (object as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function")
			return canonicalJsonValue(toJSON.call(object), seen);
		if (Array.isArray(object)) {
			return `[${object
				.map((item) =>
					item === undefined || typeof item === "function"
						? "null"
						: canonicalJsonValue(item, seen),
				)
				.join(",")}]`;
		}
		const entries = object as Record<string, unknown>;
		const fields: string[] = [];
		for (const key of Object.keys(entries).sort(compareOrdinal)) {
			const item = entries[key];
			if (item === undefined || typeof item === "function") continue;
			fields.push(`${JSON.stringify(key)}:${canonicalJsonValue(item, seen)}`);
		}
		return `{${fields.join(",")}}`;
	} finally {
		seen.delete(object);
	}
}

function hashFirstMessage(first: {
	role?: unknown;
	content?: unknown;
}): string {
	// Keep the original full local hash semantics for the existing
	// `cache_prefix_break` signal — every field, no truncation — with canonical
	// key order so an equal head cannot read as changed (#4687 item 6).
	const serialized = canonicalJsonValue(first, new Set<object>());
	return createHash("sha256").update(serialized).digest("hex");
}

/**
 * The tool names one system message adds or removes. pi writes the loadout
 * delta into these arrays (see `tests/support/pi-session.ts`'s
 * `replayToolNames` and `tests/index-4632-s6-dynamic-tooling.test.ts`); anything
 * else on the message is ignored.
 */
function toolNamesFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const entry of value) {
		const name =
			entry && typeof entry === "object"
				? (entry as { name?: unknown }).name
				: undefined;
		if (typeof name === "string") names.push(name);
	}
	return names;
}

/**
 * Hash the ORDERED set of system messages the provider receives, unbounded, and
 * fold the tool loadout they declare (#4687 item 2).
 *
 * Bounded hashing is what produced `unknown / sequence-hash-truncated` on a
 * real activation: one ordinary long tool result pushed the sequence past its
 * content cap, so the miss after dm-lens's own `tool_set_mutation` had no
 * cause. This hash never truncates, and it covers every system message rather
 * than `messages[0]`, because pi appends a tool/prompt delta as a NEW system
 * message mid-transcript — the head the first-message hash watches never moves.
 *
 * The loadout is folded in message order with pi's own replay rule (a removal
 * deletes, an addition appends), so a reordered tool table is a change while a
 * system message that only carries prompt text is not.
 */
function hashSystemMessages(messages: ReadonlyArray<ContextMessageLike>): {
	hash: string;
	toolLoadout: string;
} {
	const hash = createHash("sha256");
	const loadout = new Map<string, true>();
	for (const message of messages) {
		if (!message || typeof message !== "object" || message.role !== "system")
			continue;
		hash.update(canonicalJsonValue(message, new Set<object>())).update(";");
		const entry = message as {
			toolsAdded?: unknown;
			toolsRemoved?: unknown;
		};
		for (const name of toolNamesFrom(entry.toolsRemoved)) loadout.delete(name);
		for (const name of toolNamesFrom(entry.toolsAdded)) loadout.set(name, true);
	}
	return {
		hash: hash.digest("hex"),
		toolLoadout: [...loadout.keys()].join("\n"),
	};
}

/**
 * Per-session baseline hash of `messages[0]`, keyed by the STABLE pi session id
 * (`ctx.sessionManager.getSessionId()`). A single module-scoped var was wrong:
 * in ONE process, multiple logical conversations touch this module, and they
 * must not share a baseline —
 *   - new / fork / a concurrent in-process subagent (#473) is a DIFFERENT id →
 *     its OWN independent baseline, never compared against another id's (else a
 *     benign session boundary logs a spurious `cache_prefix_break`, and a
 *     concurrent subagent + its parent stomp each other's baseline, each
 *     emitting a false positive — fatal for a signal whose value is trust);
 *   - an IN-PROCESS reload / resume reuses the SAME id → the baseline is still in
 *     this map, so a genuine break is caught (no blinding reset). NOTE: a full
 *     process restart (quit → `pi --session <id>`) starts a NEW process with an
 *     empty map, so the first post-restart `context` re-anchors a fresh baseline
 *     rather than comparing across the restart. That's acceptable here — this is a
 *     pure observability signal (at worst a missed `cache_prefix_break` log on the
 *     first post-restart turn, never a user-facing action) — unlike genuine
 *     session state (read guard #1041, widget #190) which IS rehydrated from the
 *     sidecar.
 *
 * Bounded as insertion-ordered FIFO (evict oldest-inserted past the cap,
 * refreshed on every WRITE by {@link recordSessionHash}'s delete+set — a
 * plain read never reorders) so a long-lived process cycling through many
 * sessions can't grow this unbounded. Shares {@link MAX_TRACKED_SESSIONS}
 * with `attributionBySession` above.
 */
const prefixHashBySession = new BoundedFifoMap<string, string>(
	MAX_TRACKED_SESSIONS,
);

/**
 * Reported key used when no session id is available (undefined/empty). Internal
 * attribution additionally separates primary and concurrent-secondary roles;
 * neither role may overwrite the other's baseline when stable identity is
 * absent.
 */
const NO_SESSION_KEY = "<no-session>";

/**
 * Store `hash` for `key`, refreshing its LRU recency (re-insert moves it to the
 * newest position since `Map` preserves insertion order) and evicting the
 * oldest-inserted entries once the cap is exceeded.
 */
function recordSessionHash(key: string, hash: string): void {
	prefixHashBySession.delete(key);
	prefixHashBySession.set(key, hash);
}

/**
 * Part 2 — observe `messages[0]` stability turn-over-turn, keyed by session id.
 * Logs a baseline the first time it sees a non-empty transcript FOR A GIVEN
 * session id, then logs a `cache_prefix_break` whenever that same session's
 * first-message hash changes. Pure observation: it never inspects or mutates
 * anything but its own per-session hash map, and never throws.
 *
 * `sessionId` should be pi's STABLE id (`ctx.sessionManager.getSessionId()`),
 * which uniquely identifies the CURRENTLY-firing session: a concurrent
 * in-process subagent runs its own `AgentSession`/`sessionManager`, so its
 * `context` calls carry a DIFFERENT id than the parent's and get their own
 * baseline. (`runtime.telemetrySessionId` cannot be used here: per the #473
 * guard a concurrent secondary skips `updateRuntimeIdentityFromEvent`, so that
 * process-global singleton stays pinned to the PARENT — it would collapse
 * parent and subagent onto one baseline.) If the host does NOT supply a stable
 * id, primary and secondary roles still use separate fallback buckets, but
 * multiple same-role sessions cannot be correlated. Miss attribution therefore
 * fails closed with `request-correlation-unavailable`.
 *
 * Does nothing on an empty transcript (nothing to anchor a prefix to yet).
 *
 * #4631: the caller must pass the message list the PROVIDER receives first, so
 * this runs in whichever request hook sees it — `context_with_system` on pi
 * 0.87+, whose `context` event filters system messages out — and never in the
 * hook that sees only the conversation. Observing the conversation there hashed
 * a message the provider does not send first, so a rewritten SYSTEM head read as
 * a stable prefix and every affected turn ended in `cacheMissCause: unknown`.
 * `firstMessageRole` names which message the prefix is anchored to, so a head
 * rewrite is readable as one.
 */
export function observeCachePrefix(
	messages: ReadonlyArray<{ role?: unknown; content?: unknown }> | undefined,
	turnIndex: number,
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
	dbg?: (msg: string) => void,
): CachePrefixObservation {
	try {
		if (!messages || messages.length === 0) return "empty";
		const first = messages[0];
		if (!first || typeof first !== "object") return "empty";
		const firstMessageRole =
			typeof first.role === "string" ? first.role : "unknown";
		const key = attributionKey(sessionId, sessionRole);
		const reportedSessionId = sessionKey(sessionId);
		const currentHash = hashFirstMessage(first);
		const previousHash = prefixHashBySession.get(key);
		const state = attributionFor(key);
		// #4687 item 2: the ordered system-message set is the signal a mid-list
		// tool/prompt delta moves; the head hash above never sees it. The tool
		// loadout folded from those messages decides WHICH of the two new causes
		// applies.
		const systemEvidence = hashSystemMessages(messages);
		if (
			state.lastSystemSetHash !== undefined &&
			state.lastSystemSetHash !== systemEvidence.hash
		) {
			state.systemPromptChangedSinceLastUsage = true;
			if (state.lastToolLoadout !== systemEvidence.toolLoadout) {
				state.toolSetChangedSinceLastUsage = true;
			}
		}
		state.lastSystemSetHash = systemEvidence.hash;
		state.lastToolLoadout = systemEvidence.toolLoadout;
		if (previousHash === undefined) {
			// Baseline: record this session's starting prefix so a later break has a
			// reference point in the log. `previousHash: null` marks the baseline.
			recordSessionHash(key, currentHash);
			state.prefixStableSinceLastUsage = true;
			logLatency({
				type: "phase",
				filePath: "<dm-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					...(sessionRole === "concurrent-secondary"
						? { turnScope: SECONDARY_TURN_SCOPE }
						: { turnIndex, turnScope: PROCESS_TURN_SCOPE }),
					previousHash: null,
					currentHash,
					baseline: true,
					firstMessageRole,
					sessionId: reportedSessionId,
					sessionRole,
				},
			});
			return "baseline";
		}
		if (currentHash !== previousHash) {
			// #1071: arm the direct-cause flag the next `cache_usage` verdict reads.
			// A locally observed prefix change outranks the timing heuristics.
			state.prefixBrokeSinceLastUsage = true;
			state.prefixStableSinceLastUsage = false;
			logLatency({
				type: "phase",
				filePath: "<dm-lens>",
				phase: "cache_prefix_break",
				durationMs: 0,
				metadata: {
					...(sessionRole === "concurrent-secondary"
						? { turnScope: SECONDARY_TURN_SCOPE }
						: { turnIndex, turnScope: PROCESS_TURN_SCOPE }),
					previousHash,
					currentHash,
					firstMessageRole,
					sessionId: reportedSessionId,
					sessionRole,
				},
			});
		}
		if (currentHash === previousHash) {
			state.prefixStableSinceLastUsage = true;
		}
		// Refresh recency (and update the stored hash after a break) so an active
		// session stays warm in the LRU and isn't evicted while still in use.
		recordSessionHash(key, currentHash);
		return currentHash === previousHash ? "unchanged" : "changed";
	} catch (err) {
		dbg?.(`cache-prefix: failed to observe messages[0]: ${err}`);
		return "empty";
	}
}

/**
 * Drop a single session's prefix baseline and attribution state. Called from
 * both role-specific `session_shutdown` paths so an ended conversation is
 * reclaimed promptly rather than only when the LRU evicts it. Idempotent and
 * never throws.
 */
export function clearCachePrefixSession(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): void {
	const key = attributionKey(sessionId, sessionRole);
	prefixHashBySession.delete(key);
	// The miss-attribution state has the same lifetime and the same reason to be
	// reclaimed at session end; leaving it would let a reused session id inherit
	// a stale gap baseline and a stale prefix-break flag.
	attributionBySession.delete(key);
}

/** Record the exact quiet-window summary content handed to pi.sendMessage. */
export function recordTurnEndAdvisoryBytes(
	sessionId: string | undefined,
	bytes: number,
	sessionRole: "primary" | "concurrent-secondary" = "primary",
): void {
	const state = attributionFor(attributionKey(sessionId, sessionRole));
	state.turnEndAdvisoryBytes = Math.min(
		MAX_INJECTED_BYTES,
		state.turnEndAdvisoryBytes + Math.max(0, bytes),
	);
}

/**
 * Fold one delivered tool result into the per-turn aggregation the
 * `cache_usage` row reports as `toolResultBytes` / `toolResultsTruncated`
 * (#2800 item 7). `bytes` is the delivered payload's UTF-8 byte count as
 * stamped in the result's own footer, and `truncated` is the footer's
 * truncated flag. Called from each host adapter's delivery seam; the row is
 * emitted by `logCacheUsage`, which resets both figures at the turn boundary.
 * The byte sum saturates at the attribution bound so the row stays bounded.
 */
export function recordToolResultDelivery(args: {
	sessionId?: string;
	sessionRole?: "primary" | "concurrent-secondary";
	bytes: number;
	truncated: boolean;
}): void {
	const state = attributionFor(
		attributionKey(args.sessionId, args.sessionRole),
	);
	const bytes = Number.isFinite(args.bytes)
		? Math.max(0, Math.floor(args.bytes))
		: 0;
	state.toolResultBytes = Math.min(
		MAX_ATTRIBUTION_BYTES,
		state.toolResultBytes + bytes,
	);
	if (args.truncated === true) state.toolResultsTruncated += 1;
}

/**
 * Emit one bounded session summary and retire its attribution state. The
 * summary contains fixed-key counters only; it never serializes transcript or
 * context content. A session with no usage records emits nothing.
 */
export function emitCacheUsageSummaryAtSessionEnd(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): void {
	const key = attributionKey(sessionId, sessionRole);
	const state = attributionBySession.get(key);
	if (!state || state.summary.usageRecords === 0) return;
	logLatency({
		type: "phase",
		filePath: "<dm-lens>",
		phase: "cache_usage_summary",
		durationMs: 0,
		metadata: {
			version: 1,
			sessionId: sessionKey(sessionId),
			sessionRole,
			usageRecords: state.summary.usageRecords,
			cacheHits: state.summary.cacheHits,
			missObservations: state.summary.missObservations,
			cacheMissCauses: { ...state.summary.cacheMissCauses },
			unknownEvidenceReasons: {
				...state.summary.unknownEvidenceReasons,
			},
		},
	});
	attributionBySession.delete(key);
}

/**
 * Clear all per-session prefix hashes and miss-attribution state. For tests and
 * session boundaries. Both maps are cleared together so a test can never start
 * with a half-reset session.
 */
export function resetCachePrefixObservation(): void {
	prefixHashBySession.clear();
	attributionBySession.clear();
}

export function resetCacheFindingIdentitiesSession(
	sessionId?: string,
	sessionRole?: "primary" | "concurrent-secondary",
): void {
	const state = attributionBySession.get(
		attributionKey(sessionId, sessionRole),
	);
	if (!state) return;
	state.findingIdentities.clear();
	state.findingIdentityCapRecorded = false;
}

export function _attributionBySessionHasForTests(key: string): boolean {
	return attributionBySession.has(key);
}
export function _prefixHashBySessionHasForTests(key: string): boolean {
	return prefixHashBySession.has(key);
}
/** #2442 test-only: drive attributionFor's fetch-or-create touch directly
 *  (every call refreshes LRU recency, matching production — see
 *  attributionFor's own doc comment). */
export function _touchAttributionForTests(key: string): void {
	attributionFor(key);
}
/** #2442 test-only: drive recordSessionHash's write-refresh directly. */
export function _recordSessionHashForTests(key: string, hash: string): void {
	recordSessionHash(key, hash);
}
/**
 * #2442 test-only: the exact `prefixHashBySession.get(key)` that
 * `observeCachePrefix` performs to fetch a session's previous hash. A
 * `.has()` reorders nothing on either bounded class, so only a real `get`
 * can pin FIFO-vs-LRU behavior (#2442 review F4).
 */
export function _prefixHashBySessionGetForTests(
	key: string,
): string | undefined {
	return prefixHashBySession.get(key);
}
