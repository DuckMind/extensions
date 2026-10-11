import type { ExtensionAPI, ExtensionContext } from "@duckmind/dm-coding-agent";

// DM 0.80 emits agent_end before checking extension-queued continuation messages.
type SettlementMessage = {
  role: string;
  customType?: string;
  details?: unknown;
  content: string | Array<{ type: string; text?: string }>;
};
export type AgentBeforeSettleEvent = {
  outcome: string;
  continue?: boolean;
  context: { pendingMessages: unknown[]; contextMessages: SettlementMessage[] };
  entries: Array<Record<string, unknown>>;
};
export type AgentBeforeSettleEventResult = {
  entries: Array<Record<string, unknown>>;
  continue?: boolean;
};
type SettleHandler = (event: AgentBeforeSettleEvent) => AgentBeforeSettleEventResult | undefined;
export function onDmBeforeSettle(
  dm: Pick<ExtensionAPI, "sendMessage"> & Partial<Pick<ExtensionAPI, "on">>,
  handler: SettleHandler,
): () => void {
  let active = true;
  if (!dm.on) return () => { active = false; };
  // Newer hosts expose the original settlement hook. DM 0.80 uses agent_end.
  const host = dm as unknown as {
    on: (name: "agent_before_settle", fn: SettleHandler) => void | (() => void);
  };
  const unsubscribe = host.on("agent_before_settle", (event) => active ? handler(event) : undefined);
  dm.on("agent_end", (event, ctx: ExtensionContext) => {
    if (!active || !ctx || ctx.signal?.aborted || (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages())) return;
    const final = [...event.messages].reverse().find(message => message.role === "assistant");
    if (!final || final.stopReason !== "stop") return;
    const contextMessages = (ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? []).flatMap(entry => {
      if (entry.type === "message") return [entry.message as SettlementMessage];
      if (entry.type === "custom_message") return [{
        role: "custom", customType: entry.customType, content: entry.content, details: entry.details,
      } as SettlementMessage];
      return [];
    });
    const result = handler({
      outcome: "completed",
      context: { pendingMessages: [], contextMessages },
      entries: [],
    });
    for (const entry of result?.entries ?? []) {
      if (entry.type !== "custom_message" || typeof entry.customType !== "string"
          || typeof entry.content !== "string") continue;
      dm.sendMessage({
        customType: entry.customType,
        content: entry.content,
        display: entry.display === true,
        details: entry.details,
      }, { triggerTurn: result?.continue === true });
    }
  });
  return () => { active = false; if (typeof unsubscribe === "function") unsubscribe(); };
}
