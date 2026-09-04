import type { AgentToolResult } from "@duckmind/dm-agent-core";

/**
 * Convert dm-subagents' internal logical-error result into the rejection DM's
 * public tool boundary uses to emit a canonical errored ToolResult.
 *
 * Keep this at registered tool boundaries. Internal workflows intentionally
 * retain their return-based error handling.
 */
export function finalizeToolResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	if (result.isError !== true) return result;

	const message = result.content
		.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : [])
		.join("\n")
		.trim();

	throw new Error(message || "dm-subagents reported a logical tool failure.");
}
