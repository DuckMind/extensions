import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	extensionRootFor,
	installExtensionDirectory,
	listInstalledExtensions,
	removeInstalledExtension,
	validateExtensionId,
} from "../extensions/extensions-manager.ts";

async function writeExtension(directory: string, id = "dm-example"): Promise<void> {
	await mkdir(join(directory, "extensions"), { recursive: true });
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({ name: id, dm: { extensions: ["./extensions/index.ts"] } }),
	);
	await writeFile(join(directory, "extensions", "index.ts"), "export default () => {};\n");
}

test("validates only canonical DM extension identifiers", () => {
	assert.equal(validateExtensionId("dm-example-2"), "dm-example-2");
	for (const invalid of ["example", "dm-../../escape", "dm-Example", "dm-"]) {
		assert.throws(() => validateExtensionId(invalid));
	}
});

test("installs, inventories, and removes a local extension only below its DM root", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "dm-extension-manager-test-"));
	try {
		const source = join(workspace, "source");
		const agentDir = join(workspace, "agent");
		await writeExtension(source);
		const root = extensionRootFor("global", workspace, agentDir);
		const installed = await installExtensionDirectory(source, root, { scope: "global", source: "local" });
		assert.equal(installed.id, "dm-example");
		assert.equal(await readFile(join(root, "dm-example", "extensions", "index.ts"), "utf8"), "export default () => {};\n");

		const listed = await listInstalledExtensions(workspace, agentDir);
		assert.deepEqual(listed.map(({ id, scope, source: origin }) => ({ id, scope, origin })), [
			{ id: "dm-example", scope: "global", origin: "local" },
		]);
		await removeInstalledExtension(listed[0]!, workspace, agentDir);
		assert.equal((await listInstalledExtensions(workspace, agentDir)).length, 0);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("fails closed when a local extension contains a symlink", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "dm-extension-manager-test-"));
	try {
		const source = join(workspace, "source");
		await writeExtension(source);
		await symlink(join(source, "extensions", "index.ts"), join(source, "linked.ts"));
		await assert.rejects(
			installExtensionDirectory(source, extensionRootFor("global", workspace, join(workspace, "agent")), { scope: "global", source: "local" }),
			/unsupported symlink/,
		);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
