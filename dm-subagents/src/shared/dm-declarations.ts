import type { Message, Tool } from "@duckmind/dm-ai";
import type { TSchema } from "typebox";

// DM 0.80 does not yet record system declarations as transcript messages.
// When a newer host does, pin only previously declared fields; never invent pins.
export type SystemMessage = {
  role: "system";
  content?: string | Array<{ text?: string }>;
  timestamp?: number;
  toolsAdded?: Array<Tool & { constrainedSampling?: unknown }>;
  toolsRemoved?: Array<{ name: string }>;
  sections?: Record<string, string | null>;
};

export type TranscriptMessages = readonly { role: string }[];

export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
  const systems = messages.filter((message) => message.role === "system") as SystemMessage[];
  if (!systems.length) return undefined;
  return { ...systems[0]!, sections: Object.assign({}, ...systems.map((entry) => entry.sections ?? {})) };
}

export function getCurrentTools(messages: TranscriptMessages): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const system = message as SystemMessage;
    for (const removed of system.toolsRemoved ?? []) tools.delete(removed.name);
    for (const added of system.toolsAdded ?? []) tools.set(added.name, added);
  }
  return [...tools.values()];
}

/** Fold a request's system declaration deltas while preserving the first system-message position. */
export function collapseSystemMessages<T extends { messages: Array<{ role: string }> }>(context: T): T {
  const first = context.messages.findIndex((message) => message.role === "system");
  if (first < 0) return context;
  const system = getCurrentSystemMessage(context.messages)!;
  const toolsAdded = getCurrentTools(context.messages);
  const messages = context.messages.filter((message) => message.role !== "system");
  const declaration = { ...system, toolsAdded };
  messages.splice(first, 0, declaration);
  return { ...context, messages };
}

export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
  const system = getCurrentSystemMessage(messages);
  const content = system?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";
  return [text, ...Object.values(system?.sections ?? {}).filter((value): value is string => typeof value === "string")].filter(Boolean).join("\n\n");
}

export function toToolDeclaration(tool: Tool & { constrainedSampling?: unknown }): Tool & { constrainedSampling?: unknown } {
  return { name: tool.name, description: tool.description, parameters: tool.parameters as TSchema,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }) };
}

export function declarationsEqual(left: Tool & { constrainedSampling?: unknown }, right: Tool & { constrainedSampling?: unknown }): boolean {
  return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}
