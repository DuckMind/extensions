import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBunPiExecutable } from "../../src/runs/shared/dm-spawn.ts";

for (const [argv1, execPath] of [
	["/$bunfs/root/dm-native", "/opt/standalone/dm-native"],
	["B:/~BUN/root/dm-native.exe", "C:\\Program Files\\dm\\dm-native.exe"],
	["B:\\~BUN\\root\\dm-native.exe", "C:\\Program Files\\dm\\dm-native.exe"],
]) describe(`compiled background host detection: ${argv1}`, () => {
	const host = { execPath, argv1, bunVersion: "1.4.2", env: {} };

	it("uses the actual image even when renamed", () => {
		assert.equal(resolveBunPiExecutable(host), host.execPath);
	});

	it("honors a nonempty override, otherwise retaining the actual image", () => {
		assert.equal(resolveBunPiExecutable({ ...host, env: { DM_SUBAGENT_PI_BINARY: " /custom/dm " } }), "/custom/dm");
		assert.equal(resolveBunPiExecutable({ ...host, env: { DM_SUBAGENT_PI_BINARY: " " } }), host.execPath);
	});

	it("does not treat an ordinary Bun script or Node as a compiled host", () => {
		for (const entry of ["", "/work/script.ts", "B:/work/script.ts", "/$bunfs-other/dm", "B:/~BUN-other/dm.exe", "C:/~BUN/root/dm.exe", "/work/B:/~BUN/dm.exe"]) {
			assert.equal(resolveBunPiExecutable({ ...host, argv1: entry }), undefined, entry);
		}
		assert.equal(resolveBunPiExecutable({ ...host, bunVersion: "" }), undefined);
	});
});
