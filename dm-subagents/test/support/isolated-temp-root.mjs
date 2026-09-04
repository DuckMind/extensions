import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.DM_SUBAGENTS_TEMP_ROOT) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dm-subagents-test-root-"));
	process.env.DM_SUBAGENTS_TEMP_ROOT = tempRoot;
	process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
}
