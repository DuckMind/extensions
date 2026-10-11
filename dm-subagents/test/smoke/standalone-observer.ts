import fs from "node:fs";
import type { ExtensionAPI } from "@duckmind/dm-coding-agent";

export default function observeBootstrap(dm: ExtensionAPI) {
	const record = (event: string) => fs.appendFileSync("/stage/bootstrap-observer.jsonl", JSON.stringify({ case: process.env.PI_STANDALONE_CASE, event, pid: process.pid }) + "\n");
	record("observer-ready");
	dm.on("session_start", () => { record("session-start"); });
}
