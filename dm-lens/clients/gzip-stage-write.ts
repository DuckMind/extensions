import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort } from "node:worker_threads";
import { createGzip } from "node:zlib";
import { stagePathFor } from "./atomic-write-staging.js";

export interface GzipStageWriteMetrics {
	/** Uncompressed byte length of the serialized JSON. */
	rawBytes: number;
	/** On-disk size of the gzipped stage file. */
	gzBytes: number;
	serializeMs: number;
	writeMs: number;
	/** Wall-clock duration of the complete stage operation. */
	durationMs: number;
	/** Optional semantic digest derived from the serialized JSON. */
	semanticFingerprint?: string;
	/** True when the digest matched and no gzip or stage write ran. */
	skippedUnchanged?: boolean;
}

export interface GzipStageWriteOptions {
	/** Runs on the worker thread over the serialized body, never on the caller. */
	semanticFingerprint?: (body: string | Uint8Array) => string;
	/** Return before gzip/write when the derived digest equals one of these. */
	skipIfFingerprints?: readonly string[];
}

/** Common request envelope every gzip-stage persist worker receives. Concrete
 * workers extend this with their own routing fields (e.g. `cwd`, `elements`). */
export interface GzipStageWorkerRequest {
	id: number;
	generation: number;
	stagePath: string;
	/**
	 * Either an object the worker serializes itself (the structured clone of the
	 * whole graph rides the message), or already-serialized JSON as UTF-8 bytes
	 * whose `ArrayBuffer` the caller lists in `postMessage`'s transfer list, so
	 * the body crosses the thread boundary zero-copy (#3789). The project
	 * snapshot uses the bytes form; the review graph still sends objects.
	 */
	data: unknown;
	testDelayMs?: number;
}

/** Common result envelope: the routing fields the worker echoes back, plus the
 * write metrics (all optional — absent together with `error` set on failure). */
export interface GzipStageWorkerResult {
	id: number;
	generation: number;
	/**
	 * Optional on purpose (#4400): this is wire data from another thread, and a
	 * worker that failed before staging (or a build that does not echo it) leaves
	 * it out. A host cleans up the path it sent in its own request record and
	 * reads this only for a result with no such record.
	 */
	stagePath?: string;
	rawBytes?: number;
	gzBytes?: number;
	serializeMs?: number;
	writeMs?: number;
	durationMs?: number;
	semanticFingerprint?: string;
	skippedUnchanged?: boolean;
	error?: string;
}

/**
 * The routing fields every gzip-stage request and result carries, or why the
 * value has none (#4402). Never throws on a value that structured clone can
 * deliver; a host or worker `message` listener runs it inside its own try.
 */
function routingFields(
	value: unknown,
): Pick<GzipStageWorkerResult, "id" | "generation" | "stagePath"> | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return `not a routable object (${value === null ? "null" : Array.isArray(value) ? "array" : typeof value})`;
	}
	const wire = value as Record<string, unknown>;
	const missing: string[] = [];
	const id = requiredNumber(wire, "id", missing);
	const generation = requiredNumber(wire, "generation", missing);
	if (missing.length > 0) return `no numeric ${missing.join(" and ")}`;
	return {
		id,
		generation,
		...fieldEntry(wire, "stagePath", "string", []),
	};
}

function requiredNumber(
	wire: Record<string, unknown>,
	key: string,
	missing: string[],
): number {
	const field = wire[key];
	if (typeof field === "number") return field;
	missing.push(key);
	return Number.NaN;
}

interface FieldTypes {
	number: number;
	string: string;
	boolean: boolean;
}

/** `{ [key]: value }` when the field has `type`, `{}` when it is absent. */
function fieldEntry<K extends string, T extends keyof FieldTypes>(
	wire: Record<string, unknown>,
	key: K,
	type: T,
	malformed: string[],
): Partial<Record<K, FieldTypes[T]>> {
	const field = wire[key];
	if (typeof field === type) {
		return { [key]: field } as Partial<Record<K, FieldTypes[T]>>;
	}
	if (field !== undefined) malformed.push(key);
	return {};
}

/**
 * The host's shape check for a persist worker `message` (#4402). A message is
 * wire data from another thread (#4400), so the listener's parameter is
 * `unknown` and this is the only reader of its fields.
 *
 * Returns why the message cannot be routed (not an object, or no numeric `id`
 * and `generation`); the host drops and counts it. Otherwise returns a result
 * whose every field has its declared type. A field of the wrong type is not
 * trusted as a metric: the result carries an `error` instead, so the host
 * takes its existing error path (the main-thread write) for that request.
 */
export function readGzipStageWorkerResult(
	value: unknown,
): GzipStageWorkerResult | string {
	const routing = routingFields(value);
	if (typeof routing === "string") return routing;
	const wire = value as Record<string, unknown>;
	const malformed: string[] = [];
	const result: GzipStageWorkerResult = {
		...routing,
		...fieldEntry(wire, "rawBytes", "number", malformed),
		...fieldEntry(wire, "gzBytes", "number", malformed),
		...fieldEntry(wire, "serializeMs", "number", malformed),
		...fieldEntry(wire, "writeMs", "number", malformed),
		...fieldEntry(wire, "durationMs", "number", malformed),
		...fieldEntry(wire, "semanticFingerprint", "string", malformed),
		...fieldEntry(wire, "skippedUnchanged", "boolean", malformed),
		...fieldEntry(wire, "error", "string", malformed),
	};
	if (malformed.length === 0) return result;
	return {
		...routing,
		error: `malformed worker result: ${malformed.join(", ")}`,
	};
}

/**
 * The worker's shape check for a request (#4402): the envelope this loop
 * reads before staging. A worker's own fields (`cwd`, `generatedAt`, …) are
 * read only inside the loop's try, so a wrong one becomes an error result.
 */
function isGzipStageWorkerRequest<Req extends GzipStageWorkerRequest>(
	value: unknown,
): value is Req {
	const routing = routingFields(value);
	return typeof routing !== "string" && routing.stagePath !== undefined;
}

/**
 * Host-side reap of a stage file that a worker `message` listener no longer
 * needs. `force` suppresses ENOENT but not EISDIR or EBUSY/EPERM (Windows AV
 * or backup can briefly hold the handle), and a throw out of that listener is
 * an uncaught exception that ends the host (#1361, #4400). Returns the failure
 * so each host records it in its own sink. What a failed removal leaves stays
 * on disk for the rest of this process: the startup stage sweep reclaims only
 * a dead pid's `.stage-<pid>-<gen>` files, so the next process removes it.
 */
export function reapStageFile(stagePath: string): Error | undefined {
	try {
		fs.rmSync(stagePath, { force: true });
		return undefined;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * Shared worker-thread body-persist core (#958, single source of truth #883):
 * `JSON.stringify` (or pre-serialized bytes, #3789) → chunked `createGzip`
 * pipeline → a per-call staging file
 * from `atomic-write.ts`'s {@link stagePathFor} → atomic rename to
 * `stagePath`, returning byte/timing metrics. Both
 * `clients/review-graph/persist-worker.ts` and
 * `clients/project-snapshot-persist-worker.ts` call this so the streamed-gzip
 * write lives in exactly one place; each worker's `parentPort` wiring owns its
 * own request/result envelope and maps a thrown error onto its own `error`
 * field. The chunked generator keeps the whole JSON string off a single giant
 * Buffer (the whole reason the write is on a worker thread — a naïve sync gzip
 * on the main save path regressed host memory by +656MB, per the #950 review).
 *
 * On failure the partial `.tmp` is removed and the error is rethrown for the
 * caller to record; the `stagePath` itself is only ever created by the atomic
 * rename, so a crash mid-write can never leave a torn stage file behind.
 *
 * That crash-safety is NOT the same as concurrency isolation, and this
 * docstring used to conflate the two (#1217). The staging name is what keeps
 * two concurrent calls on one `stagePath` from writing into a shared inode,
 * and it has to come from `stagePathFor` rather than a local
 * `${stagePath}.tmp-${process.pid}`: this module runs on worker threads, which
 * share `process.pid` with the main thread and with each other, so pid alone
 * isolates nothing here (#1205's per-pid tear, verbatim). Callers normally
 * pass a per-generation `stagePath`, which makes the overlap rare — a retry, a
 * re-queued persist, a repeated generation, or a future non-generational
 * caller makes it exact. Beyond tear-freedom this offers nothing: two calls on
 * one `stagePath` are still unordered and last-rename-wins on POSIX — on
 * Windows, MoveFileEx's REPLACE_EXISTING does not serialize concurrent replaces
 * of the same destination, so one rename can fail with EPERM instead, which
 * the caller must treat as a persist failure (both persist workers fall back
 * to a main-thread rewrite on an error result).
 */
export async function writeGzipStageFile(
	data: unknown,
	stagePath: string,
	testDelayMs?: number,
	options?: GzipStageWriteOptions,
): Promise<GzipStageWriteMetrics> {
	// Worker-path duration starts inside this stage, so it includes the worker's
	// test delay, serialization, gzip, and rename, but excludes postMessage queue
	// latency. Main-thread callers measure from their inclusive persist entry.
	const startedAt = performance.now();
	const tmpPath = stagePathFor(stagePath);
	try {
		if (testDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, testDelayMs));
		}
		const serializeStarted = performance.now();
		// Pre-serialized bytes cost the worker no stringify and no copy (#3789).
		const body = data instanceof Uint8Array ? data : JSON.stringify(data);
		const serializeMs = performance.now() - serializeStarted;
		const rawBytes = Buffer.byteLength(body);
		const semanticFingerprint = options?.semanticFingerprint?.(body);
		if (
			semanticFingerprint !== undefined &&
			options?.skipIfFingerprints?.includes(semanticFingerprint)
		) {
			return {
				rawBytes,
				gzBytes: 0,
				serializeMs,
				writeMs: 0,
				durationMs: performance.now() - startedAt,
				semanticFingerprint,
				skippedUnchanged: true,
			};
		}

		const writeStarted = performance.now();
		await fs.promises.mkdir(path.dirname(stagePath), { recursive: true });
		const chunks = function* () {
			const chunkSize = 256 * 1024;
			let offset = 0;
			while (offset < body.length) {
				let end = Math.min(offset + chunkSize, body.length);
				// A string chunk is encoded on its own, so a surrogate pair split
				// across two chunks would become two U+FFFD (#3913). JSON.stringify
				// escapes lone surrogates, so a high surrogate ending a chunk always
				// pairs with the next unit: end the chunk one unit early instead.
				if (typeof body === "string" && end < body.length) {
					const last = body.charCodeAt(end - 1);
					if (last >= 0xd800 && last <= 0xdbff) end--;
				}
				yield typeof body === "string"
					? body.slice(offset, end)
					: body.subarray(offset, end);
				offset = end;
			}
		};
		await pipeline(
			Readable.from(chunks()),
			createGzip(),
			fs.createWriteStream(tmpPath),
		);
		await fs.promises.rename(tmpPath, stagePath);
		const writeMs = performance.now() - writeStarted;
		const gzBytes = (await fs.promises.stat(stagePath)).size;
		return {
			rawBytes,
			gzBytes,
			serializeMs,
			writeMs,
			durationMs: performance.now() - startedAt,
			semanticFingerprint,
		};
	} catch (err) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw err;
	}
}

/**
 * Install the standard gzip-stage persist worker message loop on `parentPort`:
 * for each request, build the routing-field base result, run the shared
 * {@link writeGzipStageFile}, and post back the base merged with either the
 * write metrics or an `error`. Both persist workers (review-graph,
 * project-snapshot) use this so the loop + error mapping live in one place;
 * each supplies only how to derive its own result's routing fields from the
 * request. Throws immediately if loaded outside a worker thread.
 */
export function serveGzipStageWorker<
	Req extends GzipStageWorkerRequest,
	Base extends { id: number; generation: number },
>(
	// The worker must echo `stagePath`; its host may not rely on that (#4400).
	buildBaseResult: (request: Req) => Base & { stagePath: string },
	options?: {
		semanticFingerprint?: (request: Req, body: string | Uint8Array) => string;
		skipIfFingerprints?: (request: Req) => readonly string[] | undefined;
	},
): void {
	const port = parentPort;
	if (!port) {
		throw new Error("gzip stage persist worker requires a parent port");
	}
	// #4402: a throw or rejection here ends the worker thread, and every
	// request still in flight falls back. Everything that reads the request
	// runs in one try; a request that fails the shape check, or a step that
	// throws, is answered with an error result carrying whatever routing fields
	// it had, so the host falls back for that request or counts a message it
	// cannot route.
	port.on("message", (message: unknown) => {
		void (async () => {
			try {
				if (!isGzipStageWorkerRequest<Req>(message)) {
					const routing = routingFields(message);
					throw new Error(
						`malformed persist request: ${typeof routing === "string" ? routing : "no stage path"}`,
					);
				}
				const request = message;
				const result: Base & GzipStageWorkerResult = {
					...buildBaseResult(request),
				};
				try {
					const fingerprint = options?.semanticFingerprint;
					const metrics = await writeGzipStageFile(
						request.data,
						request.stagePath,
						request.testDelayMs,
						{
							semanticFingerprint: fingerprint
								? (body) => fingerprint(request, body)
								: undefined,
							skipIfFingerprints: options?.skipIfFingerprints?.(request),
						},
					);
					result.rawBytes = metrics.rawBytes;
					result.gzBytes = metrics.gzBytes;
					result.serializeMs = metrics.serializeMs;
					result.writeMs = metrics.writeMs;
					result.durationMs = metrics.durationMs;
					result.semanticFingerprint = metrics.semanticFingerprint;
					result.skippedUnchanged = metrics.skippedUnchanged;
				} catch (err) {
					result.error = err instanceof Error ? err.message : String(err);
				}
				port.postMessage(result);
			} catch (err) {
				const routing = routingFields(message);
				port.postMessage({
					...(typeof routing === "string" ? {} : routing),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		})();
	});
}
