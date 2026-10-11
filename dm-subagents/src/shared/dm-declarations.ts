import type { Message, Tool } from "@duckmind/dm-ai";
import type { TSchema } from "typebox";

// DM 0.80 does not yet record system declarations as transcript messages.
// When a newer host does, pin only previously declared fields; never invent pins.
export type SystemMessage = {
  role: "system";
  toolsAdded?: Array<Tool & { constrainedSampling?: unknown }>;
  sections?: Record<string, string | null>;
};

export function getCurrentSystemMessage(messages: Message[]): SystemMessage | undefined {
  return [...messages].reverse().find((message) => (message as { role: string }).role === "system") as SystemMessage | undefined;
}

export function toToolDeclaration(tool: Tool & { constrainedSampling?: unknown }): Tool & { constrainedSampling?: unknown } {
  return { name: tool.name, description: tool.description, parameters: tool.parameters as TSchema,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }) };
}

export function declarationsEqual(left: Tool & { constrainedSampling?: unknown }, right: Tool & { constrainedSampling?: unknown }): boolean {
  return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}
