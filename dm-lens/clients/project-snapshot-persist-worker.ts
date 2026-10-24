import { parentPort } from "node:worker_threads";
import {
	type GzipStageWorkerRequest,
	type GzipStageWorkerResult,
	serveGzipStageWorker,
} from "./gzip-stage-write.js";
import { fingerprintProjectSnapshotJson } from "./project-snapshot-fingerprint.js";

/**
 * Worker-thread persist for the project snapshot BODY (#958 item 2). The parent
 * (project-snapshot.ts) serializes the snapshot once and posts the UTF-8 bytes
 * (`data`, ArrayBuffer transferred, never structured-cloned, #3789) plus a
 * monotonic `generation` and a per-generation `stagePath`; the fingerprint and
 * streamed gzip run entirely off the main thread via the shared gzip-stage
 * worker loop (clients/gzip-stage-write.ts, also used by the review-graph
 * persist worker).
 * The parent does the generation-gated promotion (rename stage → canonical) so
 * a slow write for an older generation can never clobber a newer snapshot.
 * The request also carries the last successfully published fingerprint so the
 * worker can skip gzip and staging when only `generatedAt` changed.
 */
export interface ProjectSnapshotPersistWorkerRequest extends GzipStageWorkerRequest {
	/** Last body digest known to have reached canonical storage. */
	priorFingerprints?: string[];
	/** The snapshot's `generatedAt`, so the worker never parses the body for it. */
	generatedAt: string;
}

export type ProjectSnapshotPersistWorkerResult = GzipStageWorkerResult;

/**
 * Hash the serialized body while replacing only the top-level volatile
 * `generatedAt` value with a stable sentinel. It never walks the snapshot on
 * the extension host's event loop.
 */
function semanticSnapshotFingerprint(
	request: ProjectSnapshotPersistWorkerRequest,
	body: string | Uint8Array,
): string {
	return fingerprintProjectSnapshotJson(body, request.generatedAt);
}

// Smoke seam (#4401): the RPC session smoke (scripts/rpc-load-check.mjs
// --fail-worker) sets this to make the worker fail the way #4400's reporter's
// did, an `{ id, generation, error }` answer with no `stagePath`, so it can
// prove pi survives a failing worker. Inert unless the variable is set, and
// what it costs a user who sets it is the main-thread snapshot write.
// The handler is in the contained form tests/clients/worker-message-boundary-
// ratchet.test.ts enforces (#4402): an `unknown` message, narrowed before any
// field read, inside one try. A message that fails the check gets no answer.
function serveForcedFailure(): void {
	parentPort?.on("message", (message: unknown) => {
		try {
			if (
				typeof message !== "object" ||
				message === null ||
				!("id" in message) ||
				!("generation" in message)
			)
				return;
			parentPort?.postMessage({
				id: message.id,
				generation: message.generation,
				error:
					"forced snapshot worker failure (DM_LENS_TEST_SNAPSHOT_WORKER_FAIL)",
			});
		} catch {
			// Test-only seam: a message that cannot be answered is dropped.
		}
	});
}

if (process.env.DM_LENS_TEST_SNAPSHOT_WORKER_FAIL === "no-stage-path") {
	serveForcedFailure();
} else {
	serveGzipStageWorker<
		ProjectSnapshotPersistWorkerRequest,
		ProjectSnapshotPersistWorkerResult
	>(
		(request) => ({
			id: request.id,
			generation: request.generation,
			stagePath: request.stagePath,
		}),
		{
			semanticFingerprint: semanticSnapshotFingerprint,
			skipIfFingerprints: (request) => request.priorFingerprints,
		},
	);
}
