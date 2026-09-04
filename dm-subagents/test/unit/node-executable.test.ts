import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveNodeExecutable } from "../../src/shared/node-executable.ts";

describe("Node executable resolution", () => {
	it("uses an executable Node path", () => {
		assert.equal(resolveNodeExecutable(process.execPath), process.execPath);
	});

	it("falls back to PATH node for a standalone DM executable", () => {
		assert.equal(resolveNodeExecutable(path.join(os.tmpdir(), process.platform === "win32" ? "dm.exe" : "dm")), process.platform === "win32" ? "node.exe" : "node");
	});

	it("falls back to PATH node for a stale Node path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-node-executable-"));
		try {
			const staleNode = path.join(root, process.platform === "win32" ? "node.exe" : "node");
			assert.equal(resolveNodeExecutable(staleNode), process.platform === "win32" ? "node.exe" : "node");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
