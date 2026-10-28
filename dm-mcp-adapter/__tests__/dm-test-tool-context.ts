import type { createAgentSession, ExtensionRunner } from "@duckmind/dm-coding-agent";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
const sessions = new WeakMap<ExtensionRunner, Session>();

/** Register a test's simulated model turn; authorization remains in the real DM session. */
export function registerTestSession(session: Session): void {
  sessions.set(session.extensionRunner, session);
}

export function createTestToolContext(runner: ExtensionRunner, id: string, signal?: AbortSignal) {
  const session = sessions.get(runner);
  if (!session) throw new Error("Test session not registered");
  const message = [...session.agent.state.messages].reverse().find(item => item.role === "assistant");
  if (!message || message.role !== "assistant") throw new Error("Test model turn missing");
  if (!message.content.some(part => part.type === "toolCall" && part.id === id)) {
    message.content.push({ type: "toolCall", id, name: "mcp", arguments: {} });
  }
  let nestedCalls = 0;
  return runner.createContext({
    id,
    signal,
    isActive: () => !signal?.aborted,
    nextId: () => `${id}/${++nestedCalls}`,
  });
}
