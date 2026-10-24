import { incrementDegradationCount } from "./degradation-ledger.js";

/** Common V8 heap snapshot shape for the two long-lived persist workers. */
export interface PersistWorkerHeapStatistics {
	heapUsedBytes: number;
	heapTotalBytes: number;
	heapSizeLimitBytes: number;
}

export interface WorkerHeapStatisticsSource {
	getHeapStatistics?: () => Promise<{
		used_heap_size: number;
		total_heap_size: number;
		heap_size_limit: number;
	}>;
}

export async function readWorkerHeapStatistics(
	worker: WorkerHeapStatisticsSource,
): Promise<PersistWorkerHeapStatistics> {
	const stats = await worker.getHeapStatistics!();
	return {
		heapUsedBytes: stats.used_heap_size,
		heapTotalBytes: stats.total_heap_size,
		heapSizeLimitBytes: stats.heap_size_limit,
	};
}

/**
 * Count a persist worker `message` the host contained (#4402): one it could
 * not route (`rejected`, the reason from `readGzipStageWorkerResult`) or one
 * whose handling threw (`threw`). One ledger entry per host and event per
 * session, carrying the count. It runs inside the listener's catch, so it
 * never stringifies an unknown thrown value (a throwing `toString` would
 * leave the listener), and the ledger itself never throws.
 */
export function notePersistWorkerMessageFault(
	host: "project-snapshot" | "review-graph",
	fault: "rejected" | "threw",
	detail: unknown,
): void {
	incrementDegradationCount({
		kind: "persist-worker-message-contained",
		subject: `${host} persist worker: ${fault}`,
		reason:
			typeof detail === "string"
				? detail
				: detail instanceof Error
					? detail.message
					: `non-Error ${typeof detail}`,
	});
}
