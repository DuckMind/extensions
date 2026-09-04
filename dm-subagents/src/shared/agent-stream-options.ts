import type { StreamFn } from "@duckmind/dm-agent-core";

export function agentStreamOptions(streamFn: StreamFn): { streamFunction: StreamFn; streamFn: StreamFn } {
	return { streamFunction: streamFn, streamFn };
}
