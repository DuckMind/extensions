import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseStandalone } from "../standalone.ts";
import { isTtyInvocation } from "../../../dm-mono/packages/coding-agent/src/tty-invocation.ts";

test("standalone options are strict and -- ends tty dispatch", () => {
	assert.equal(isTtyInvocation(["--host=127.0.0.1"]), true);
	assert.equal(isTtyInvocation(["--", "--host"]), false);
	assert.equal(isTtyInvocation(["--model", "free"]), false);
	assert.equal(parseStandalone(["--host", "0.0.0.0"]).port, 8765);
	assert.equal(parseStandalone(["--host=::1", "--port=0"]).port, 0);
	for (const args of [
		["--host"], ["--host="], ["--host", "a", "--host", "b"],
		["--host", "a", "--port", "-1"], ["--host", "a", "--port", "65536"],
		["--host", "a", "--model", "free"], ["--host", "a", "prompt"],
	]) assert.throws(() => parseStandalone(args));
});

test("standalone runs with closed stdin, private token and signal cleanup", { timeout: 20000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dm-tty-standalone-"));
	const tokenFile = join(cwd, "token");
	const entry = new URL("../standalone.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
		`import {runStandalone} from ${JSON.stringify(entry)}; await runStandalone(process.argv.slice(1));`,
		"--", "--host", "127.0.0.1", "--port", "0", "--token-file", tokenFile], {
		cwd, env: { ...process.env, SHELL: "/bin/sh" }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "", errors = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { errors += chunk; });
	const exited = new Promise<number | null>((done) => child.once("exit", done));
	try {
		const deadline = Date.now() + 10000;
		while (!output.includes("http://") && child.exitCode === null && Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 25));
		}
		assert.match(output, /http:\/\/127\.0\.0\.1:\d+\//);
		assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
		const token = readFileSync(tokenFile, "utf8").trim();
		assert.equal(token.length, 32);
		assert.ok(!output.includes(token) && !errors.includes(token));
		const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
		assert.equal((await fetch(url)).status, 200);
		child.kill("SIGTERM");
		assert.equal(await exited, 0);
		assert.equal(existsSync(tokenFile), false);
		await assert.rejects(fetch(url));
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});

test("standalone wildcard host reports the bind and a distinct local browser URL", { timeout: 20000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "dm-tty-wildcard-"));
	const tokenFile = join(cwd, "token");
	const entry = new URL("../standalone.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
		`import {runStandalone} from ${JSON.stringify(entry)}; await runStandalone(process.argv.slice(1));`,
		"--", "--host", "0.0.0.0", "--port", "0", "--token-file", tokenFile], {
		cwd, env: { ...process.env, SHELL: "/bin/sh" }, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "", errors = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { errors += chunk; });
	const exited = new Promise<number | null>((done) => child.once("exit", done));
	try {
		const deadline = Date.now() + 10000;
		while (!output.includes("http://") && child.exitCode === null && Date.now() < deadline) {
			await new Promise((done) => setTimeout(done, 25));
		}
		const port = Number(output.match(/dm-tty: http:\/\/0\.0\.0\.0:(\d+)\//)?.[1]);
		assert.ok(port > 0, `Missing wildcard URL: ${output} ${errors}`);
		assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
		assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
		assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
		assert.ok(!output.includes(readFileSync(tokenFile, "utf8").trim()));
		child.kill("SIGTERM");
		assert.equal(await exited, 0);
		assert.equal(existsSync(tokenFile), false);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});
