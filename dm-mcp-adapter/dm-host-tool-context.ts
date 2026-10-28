import type { AgentToolResult, ExtensionContext } from "@duckmind/dm-coding-agent";

/** Nested dispatch is available only through the session-guarded DM host context. */
export type DmHostToolContext = ExtensionContext & {
  readonly hasLiveParentToolCall?: boolean;
  tools: readonly { name: string }[];
  executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ result: AgentToolResult<unknown>; isError: boolean }>;
};
