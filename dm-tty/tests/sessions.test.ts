import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, chmodSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverTerminalSessions, parseScreenListing, sessionCommand, validSessionName } from "../sessions.ts";

test("screen 5 timestamped listings, statuses, invalid targets and session bounds", () => {
	const listed = parseScreenListing([
		"There are screens on:",
		"\t1234.one\t(10/11/2026 09:30:17 AM)\t(Detached)",
		"\t5678.two\t(2026-10-11 09:30:17)\t(Attached)",
		"\t3333.three\t(Detached)",
		"\t7777.bad;command\t(Attached)",
		"4 Sockets in /tmp/example.",
	].join("\n"));
	assert.deepEqual(listed.map(({ id, attached }) => [id, attached]), [
		["screen:1234.one", false], ["screen:5678.two", true], ["screen:3333.three", false],
	]);
	assert.equal(parseScreenListing(Array.from({ length: 200 }, (_, n) => `${n + 1}.s\t(Detached)`).join("\n")).length, 127);
	assert.deepEqual(sessionCommand(listed[0]!), ["screen", "-x", "1234.one"]);
	assert.equal(sessionCommand({ ...listed[0]!, id: "screen:one;bad" }), undefined);
});

test("screen listings with nonzero exit still produce sessions; invalid names and targets fail closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dm-tty-list-"));
	const script = join(dir, "screen");
	writeFileSync(script, "#!/bin/sh\nprintf '\\t7777.named\\t(10/11/2026 09:00 AM)\\t(Detached)\\n'\nexit 1\n");
	chmodSync(script, 0o700);
	try {
		const sessions = await discoverTerminalSessions({}, { PATH: dir });
		assert.deepEqual(sessions.map((session) => session.id), ["shell", "screen:7777.named"]);
	} finally {
		unlinkSync(script);
		rmdirSync(dir);
	}
	for (const name of ["", "-bad", "a b", "a;echo", "x".repeat(65), "nested/name"]) {
		assert.equal(validSessionName(name), false, name);
	}
	assert.equal(validSessionName("abc_-12.xyz"), true);
	assert.deepEqual(sessionCommand({
		id: "tmux:$12", backend: "tmux", name: "has:colon", label: "tmux · has:colon", attached: false,
	}, { tmuxSocket: "/tmp/test-only-tmux" }), ["tmux", "-S", "/tmp/test-only-tmux", "attach-session", "-t", "$12"]);
	assert.equal(sessionCommand({ id: "tmux:prefix", backend: "tmux", name: "safe", label: "", attached: false }), undefined);
});
