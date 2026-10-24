/**
 * #4535: the consumers the detectors used to call by hand, now subscribers of
 * the disk-change publisher.
 *
 * Before the publisher, `clients/out-of-band-changes.ts` knew both of them by
 * name: it moved the diagnostics-cache clock, restarted the root's primary
 * clients, recorded the created/edited/deleted paths, and sent the exact-URI
 * watched-files events itself. That fan-out is the repeated part #4535 is
 * about, so the detector now publishes one record and these two subscribe.
 *
 * Slice 2 folds the other two wired call sites onto the same seam. The HEAD
 * look (`clients/runtime-tool-result.ts` `lookAtHead`) and the bash write path
 * (`handleToolResult`'s bash branch) each used to name the LSP service and
 * drive two phases itself: a held-primary send that the next check has to see,
 * then a detached drift pass. Those two phases are the LSP consumer's
 * {@link resyncHeldDocuments} now, and neither detector names a consumer.
 *
 * Order matters and is registration order: the diagnostics cache records the
 * change BEFORE the servers are told about it, so a cache read that a
 * notification triggers cannot miss the refusal it owes. Inside the LSP
 * consumer the primary phase always settles before the drift pass starts: the
 * pass is created after the primary `await`, and a caller only ever receives
 * the promise it returns.
 *
 * Registration is idempotent per consumer id, so a caller may call
 * {@link ensureDiskChangeSubscribers} on every publish.
 */
import * as nodeFs from "node:fs";
import { hashContentBytes } from "./content-stamp.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { type DiskChange, subscribeDiskChange } from "./disk-changes.js";
import type { DriftDisposition } from "./lsp/document-drift.js";
import { HOOK_WALL_BUDGET_MS } from "./hook-budgets.js";
import { peekLSPService } from "./lsp/capabilities.js";
import {
	noteWorkspaceDependenciesChanged,
	noteWorkspaceFilesChangedOnDisk,
} from "./lsp/workspace-diagnostics-session.js";

/**
 * A path's typed change, in the detector's own spelling: the LSP watched-files
 * event is a URI and wants the path as the server's file was named, while
 * `DiskChange.paths` carries the normalized population the cache stores.
 */
export interface DiskPathChangeEvent {
	filePath: string;
	type: "created" | "changed" | "deleted";
}

/** `file.uri`-typed watched-files events: Created=1, Changed=2, Deleted=3. */
const WATCHED_FILE_TYPE: Record<DiskPathChangeEvent["type"], number> = {
	created: 1,
	changed: 2,
	deleted: 3,
};

/**
 * The diagnostics-cache consumer: a dependency install refuses every entry
 * scanned before it, and a changed path (created, edited or deleted on disk,
 * with no client involved) refuses the entries whose dependency scope holds
 * it. Both use the publish's one `at`, so the record's clock and the record's
 * sequence name the same event.
 *
 * A look can hold both, and an unknown population is never read as an empty
 * one: `"unknown"` is either a dependency install (which cannot be enumerated)
 * or a publish over the recorded cap, and in both cases refusing everything
 * scanned before `at` is the only direction that cannot serve a stale entry.
 * Naming the recorded 64 of 70 changed declarations would refuse strictly less
 * than the detector's full list did before #4535 (catalog shape 10).
 */
function diagnosticsCacheSubscriber(change: DiskChange): void {
	if (change.origin !== "out-of-band") return;
	if (change.sources.includes("install") || change.paths === "unknown")
		noteWorkspaceDependenciesChanged(change.at);
	if (change.paths === "unknown") return;
	if (change.paths.length === 0) return;
	noteWorkspaceFilesChangedOnDisk(change.root, change.paths, change.at);
}

/**
 * A bash write path's publish carries which of its two phases this record is
 * for: `bash-write` is the population every written path feeds (the primary
 * phase, awaited before the synthetic dispatches), and `recovered-drift` is
 * the recovered subset's follow-up (the detached full resync). The populations
 * differ, so the labels do too; both are the same origin, published by the
 * same detector branch.
 */
export const BASH_WRITE_SOURCE = "bash-write";
export const BASH_RECOVERY_DRIFT_SOURCE = "recovered-drift";

/**
 * #4502: the branch label of a same-HEAD discard. `git stash`,
 * `git checkout .` and `git restore` rewrite working-tree bytes without moving
 * HEAD and leave no dirty entry behind, so the head-move detector's two
 * signals both stay silent while an open document keeps the reverted bytes.
 * The bash `tool_result` reads the set from the call's own baseline (dirty
 * before, clean after) and publishes it as a `head-move` change carrying this
 * source: one delivery seam, one new input, no new detector.
 */
export const SAME_HEAD_DISCARD_SOURCE = "same-head-discard";

/**
 * Primaries one held-document pass sends to. A pass that reaches the cap
 * leaves the remaining stale documents to the next look, and the detector's
 * row still reports every target it found.
 */
const HELD_PRIMARY_CAP = 64;

/**
 * Forced drift passes a HEAD move may run, serially, while a target it queued
 * is still waiting. A move rewrites many documents at once, and each pass
 * keeps the per-pass `DRIFT_RESYNC_BATCH` cap.
 */
const HEAD_MOVE_RESYNC_MAX_PASSES = 16;

/**
 * What the LSP consumer answers for a publish whose population a server may
 * hold. The detector's own row keeps reporting these fields, so the two
 * phases stay observable without either detector knowing the service.
 */
export interface HeldDocumentsAnswer {
	/**
	 * Candidates the consumer considered. With an enumerable population this is
	 * "the publish's paths a live client holds"; with `paths: "unknown"` it is
	 * EVERY held document of the root, which is a superset of the change, not an
	 * intersection with it — so a row reading `held` on a capped-or-unlistable
	 * population is reporting a different population than on a listed one (review
	 * round 2, F5). `-1` says the consumer never answered (it threw), so no
	 * document was checked at all.
	 */
	held: number;
	/** Held documents whose disk bytes differ from the server's copy. */
	targets: string[];
	/** Documents this pass sent to a primary. */
	primary: number;
	/** A primary send threw; the next check may read a stale view. */
	failed: boolean;
	/** Every client that took a send answered its drain probe in time. */
	drained: boolean;
	/**
	 * The detached pass over {@link targets}, when there was one to run. The
	 * caller attaches its reporter; the pass itself is never awaited by a hook.
	 */
	drift?: Promise<ReadonlyMap<string, DriftDisposition>>;
}

const NO_HELD_DOCUMENTS: HeldDocumentsAnswer = {
	held: 0,
	targets: [],
	primary: 0,
	failed: false,
	drained: true,
};

/**
 * The LSP consumer threw: no document was looked at, so the answer says
 * `failed` and carries `held: -1` rather than the `0` a clean look would report
 * (review round 2, F3).
 */
const UNCHECKED_HELD_DOCUMENTS: HeldDocumentsAnswer = {
	held: -1,
	targets: [],
	primary: 0,
	failed: true,
	drained: false,
};

/**
 * #4493 r2: push the disk bytes of `filePaths` to the PRIMARY servers that
 * already hold them, and to no auxiliary. A HEAD move's resync runs this
 * first: the primary's view is the one the next read or edit's dispatch reads,
 * and an auxiliary's #1714 pacing barrier, waiting out a scanner still busy
 * with earlier changes, held the primary's later didChanges back past the hook
 * bound when every server went per file (review r1 F1). Primaries are not
 * gated, so this costs one write per document. The auxiliaries, the importers
 * and the drift records are left to {@link resyncHeldDocuments}'s drift pass,
 * which the caller runs after this. Never spawns: a server not holding the
 * document is excluded, and the dispatch opens a document the command created.
 */
async function sendToHeldPrimaries(
	root: string,
	candidates: readonly string[],
	drainMs: number,
): Promise<{
	targets: string[];
	primary: number;
	failed: boolean;
	drained: boolean;
}> {
	const service = peekLSPService();
	if (!service || candidates.length === 0)
		return { targets: [], primary: 0, failed: false, drained: true };
	const held = new Set(service.getOpenDocumentPaths(root));
	const targets = (
		await Promise.all(
			candidates.map(async (filePath) => {
				if (!held.has(filePath)) return undefined;
				const sent = service.getTrackedContent(filePath, root)?.hash;
				try {
					const disk = await nodeFs.promises.readFile(filePath, "utf8");
					return sent === hashContentBytes(Buffer.from(disk, "utf8"))
						? undefined
						: filePath;
				} catch {
					return filePath;
				}
			}),
		)
	).filter((filePath): filePath is string => filePath !== undefined);
	if (targets.length === 0)
		return { targets, primary: 0, failed: false, drained: true };
	try {
		const { sent, drained } = await service.resyncHeldPrimaries(
			targets.slice(0, HELD_PRIMARY_CAP),
			drainMs,
		);
		return { targets, primary: sent, failed: false, drained };
	} catch {
		return { targets, primary: 0, failed: true, drained: false };
	}
}

/**
 * D2/D1: the held-document phase of a disk change. The candidates are the
 * publish's own population, narrowed to what a live client holds:
 *
 * - `paths: "unknown"` (a HEAD delta git could not list) leaves the whole
 *   held set as the candidates, because a stale view is the harm and an
 *   unenumerable change has no other evidence (shape 48, #4493 review r1 F6);
 * - otherwise only the published paths are considered, so a move's unheld
 *   files cost no read.
 *
 * The drift pass is created here, after the primary phase, and returned to the
 * caller rather than awaited: the hook waits for the primary view and the
 * paced auxiliaries heal afterwards (see {@link HeldDocumentsAnswer.drift}).
 */
async function resyncHeldDocuments(
	change: DiskChange,
	options: { drift: boolean; maxPasses?: number; drainMs: number },
): Promise<HeldDocumentsAnswer> {
	const service = peekLSPService();
	if (!service) return NO_HELD_DOCUMENTS;
	const held = new Set(service.getOpenDocumentPaths(change.root));
	const candidates =
		change.paths === "unknown"
			? [...held]
			: change.paths.filter((filePath) => held.has(filePath));
	const { targets, primary, failed, drained } = await sendToHeldPrimaries(
		change.root,
		candidates,
		options.drainMs,
	);
	const answer: HeldDocumentsAnswer = {
		held: candidates.length,
		targets,
		primary,
		failed,
		drained,
	};
	if (!options.drift || targets.length === 0 || failed) return answer;
	answer.drift = service.resyncGitChangedFiles(
		targets,
		options.maxPasses === undefined ? {} : { maxPasses: options.maxPasses },
	);
	return answer;
}

/**
 * The detached full resync of a recovered population: every holding server
 * (the paced auxiliaries), the held importers, and the drift records. Never
 * awaited by a hook, and never a primary phase: the write path's primary sends
 * already ran under `bash-write`.
 *
 * An unenumerable population takes every held document, the same conservative
 * direction `resyncHeldDocuments` takes (shape 48): the stale views are the
 * harm. The detector publishes in `DISK_CHANGE_MAX_RECORDED_PATHS` chunks, so
 * the publisher's cap never lands here; this branch answers a publish made
 * from somewhere else, and dropping it would be the silent no-op review round
 * 2 filed as F2.
 */
function driftRecoveredFiles(change: DiskChange): HeldDocumentsAnswer {
	const service = peekLSPService();
	if (!service) return NO_HELD_DOCUMENTS;
	const population =
		change.paths === "unknown"
			? service.getOpenDocumentPaths(change.root)
			: change.paths;
	if (population.length === 0) return NO_HELD_DOCUMENTS;
	return {
		...NO_HELD_DOCUMENTS,
		drift: service.resyncGitChangedFiles(population),
	};
}

/**
 * The out-of-band consumer: an install restarts the root's live primary
 * clients (a server that registered client watchers re-reads a closed file
 * only on an exact-URI event or a restart), and a declaration file changed
 * outside dm-lens goes out as that exact-URI watched-files event now, not after
 * the debounce window. A look can hold both, and both are delivered: the
 * install restarts the clients of that root, while a live client of the same
 * server outside the restarted root re-reads a closed declaration only on its
 * event (the pre-#4535 detector ran both halves for one look, and so does
 * this). Returns the restart count so the detector's own row keeps reporting
 * it.
 */
async function outOfBandLsp(
	change: DiskChange,
): Promise<{ restarted: number }> {
	const service = peekLSPService();
	if (!service) return { restarted: 0 };
	let restarted = 0;
	if (change.sources.includes("install"))
		restarted = (await service.restartPrimaryClientsUnder(change.root)) ?? 0;
	const events = change.pathChanges ?? [];
	if (events.length === 0) return { restarted };
	service.notifyOutOfBandFileChanges(
		events.map((event) => ({
			filePath: event.filePath,
			type: WATCHED_FILE_TYPE[event.type],
		})),
	);
	return { restarted };
}

/**
 * The LSP consumer, one branch per origin. The drain budget each branch hands
 * the primary phase is the hook bound its own detector used before #4535 slice
 * 2: a HEAD look runs on a read-only `tool_call` most of the time, while a bash
 * write is an edit and is measured against the edit bound (#4528 r4).
 */
async function lspSubscriber(change: DiskChange): Promise<unknown> {
	switch (change.origin) {
		case "out-of-band":
			return outOfBandLsp(change);
		case "head-move":
			return resyncHeldDocuments(change, {
				drift: true,
				maxPasses: HEAD_MOVE_RESYNC_MAX_PASSES,
				drainMs: HOOK_WALL_BUDGET_MS.tool_result_read_only,
			});
		case "bash-recovery":
			return change.sources.includes(BASH_RECOVERY_DRIFT_SOURCE)
				? driftRecoveredFiles(change)
				: resyncHeldDocuments(change, {
						drift: false,
						drainMs: HOOK_WALL_BUDGET_MS.tool_result_edit,
					});
		case "settled-sweep":
		case "drift-heartbeat":
			// Slice 3 folds these detector origins onto this consumer.
			return undefined;
	}
	const unreachable: never = change.origin;
	return unreachable;
}

/** Consumer id of the diagnostics-cache subscriber (census + tests). */
export const DIAGNOSTICS_CACHE_CONSUMER = "diagnostics-cache";
/** Consumer id of the LSP subscriber (census + tests). */
export const LSP_CONSUMER = "lsp";

/**
 * The LSP consumer's answer for one publish, as a detector reads it.
 *
 * A detector that drove these phases itself used to hold the whole answer
 * directly, so the ways this can still go wrong would otherwise read as "no
 * held document was stale": the exact shape that leaves a stale view in place.
 * They are two different failures and the detector's own row must tell them
 * apart (review round 2, F3):
 *
 * - `failedSubscribers` holds this consumer, so it answered and threw. The
 *   answer is {@link UNCHECKED_HELD_DOCUMENTS}: `failed`, `held: -1`, never
 *   checked, never a clean zero. `fanOut` already recorded
 *   `disk-change-subscriber-failed`.
 * - Neither, so the publish reached no LSP consumer at all: the registry was
 *   never seeded or a second module copy owns it. That is recorded once per
 *   root per session, and only that case is
 *   `disk-change-lsp-consumer-missing` (F7).
 *
 * An answer of `undefined` is neither: the `settled-sweep` and
 * `drift-heartbeat` branches of {@link lspSubscriber} answer it on purpose
 * (they have no held-document policy until slice 3). `results.has` is the
 * discriminator, so a consumer that ANSWERED is never reported as one that was
 * never asked (review round 3, p3-2).
 */
export function readHeldDocumentsAnswer(
	results: ReadonlyMap<string, unknown>,
	root: string,
	failedSubscribers: ReadonlySet<string>,
): HeldDocumentsAnswer {
	const answer = results.get(LSP_CONSUMER) as HeldDocumentsAnswer | undefined;
	if (answer !== undefined) return answer;
	if (failedSubscribers.has(LSP_CONSUMER)) return UNCHECKED_HELD_DOCUMENTS;
	if (results.has(LSP_CONSUMER)) return NO_HELD_DOCUMENTS;
	recordDegradationOnce({
		kind: "disk-change-lsp-consumer-missing",
		subject: root,
		reason:
			"a disk change was published but no LSP subscriber answered it, so no held document was checked for stale bytes",
	});
	return NO_HELD_DOCUMENTS;
}

let registered = false;

/**
 * Register the publisher's consumers. Idempotent (the registry replaces one
 * consumer id rather than duplicating it), so every publisher entry point can
 * call it, including the MCP route slices 2 and 3 add.
 */
export function ensureDiskChangeSubscribers(): void {
	if (registered) return;
	registered = true;
	subscribeDiskChange(DIAGNOSTICS_CACHE_CONSUMER, diagnosticsCacheSubscriber);
	subscribeDiskChange(LSP_CONSUMER, lspSubscriber);
}
