import type { ExtensionAPI } from "@duckmind/dm-coding-agent";
import type {} from "./src/types/dm-runtime-compat.d.ts";

const registerParentExtension = process.env.DM_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(dm: ExtensionAPI): void {
	registerParentExtension?.(dm);
}
