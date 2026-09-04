import { basename } from "node:path";

/**
 * Return a real Node.js command for launching DM CUA helper .mjs files.
 * A compiled DM process has process.execPath=<dm binary>, not Node.js.
 */
export function nodeRuntimeCommand(
	env = process.env,
	execPath = process.execPath,
) {
	const configured = env.DM_CUA_NODE || env.GREEDY_SEARCH_NODE || env.NODE_BINARY || env.NODE;
	if (configured?.trim()) return configured.trim();

	const name = basename(execPath || "").toLowerCase();
	if (name === "node" || name === "node.exe") return execPath;
	return "node";
}
