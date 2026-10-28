import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@duckmind/dm-coding-agent";
import dmTty, { parseCommand } from "../index.ts";

test("tty command parses quoted paths and rejects malformed or duplicate options", () => {
	assert.equal(parseCommand("start", "/tmp").host, "0.0.0.0");
	assert.equal(parseCommand("start --host 127.0.0.1", "/tmp").host, "127.0.0.1");
	assert.deepEqual(parseCommand('start --cwd "/tmp/a b" --port=0 --host 127.0.0.1', "/tmp"), {
		action: "start", cwd: "/tmp/a b", port: 0, host: "127.0.0.1",
	});
	assert.equal(parseCommand("", "/tmp").action, "status");
	assert.equal(parseCommand("stop --port 8765", "/tmp").port, 8765);
	for (const input of ["start --port -1", "start --port 65536", "start --port 1.5",
		"start --host", "start --port 1 --port 2", 'start --cwd "bad', "stop --port 0", "stop --host localhost",
		"start --token secret", "restart"]) assert.throws(() => parseCommand(input, "/tmp"), input);
});

function harness() {
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let shutdown: () => Promise<void>;
	const notices: string[] = [];
	dmTty({
		registerCommand(name: string, command: { handler: typeof handler }) {
			assert.equal(name, "tty");
			handler = command.handler;
		},
		on(name: string, callback: typeof shutdown) {
			assert.equal(name, "session_shutdown");
			shutdown = callback;
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: process.cwd(), hasUI: true,
		ui: { notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionCommandContext;
	return { notices, ctx, run: (args: string) => handler(args, ctx), close: () => shutdown() };
}

test("tty lifecycle starts once, stops, restarts and shuts down with the session", { timeout: 10_000 }, async (t) => {
	const h = harness();
	t.after(() => h.close());
	await h.run("status");
	assert.match(h.notices.at(-1)!, /not running/);
	await h.run("start --port 0 --host 127.0.0.1");
	const first = h.notices.at(-1)!;
	assert.match(first, /Shell running/);
	const url = first.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
	assert.equal((await fetch(url + "health")).status, 200);
	await h.run("start --port 0 --host 127.0.0.1");
	assert.equal(h.notices.at(-1), first);
	await h.run("stop");
	await assert.rejects(fetch(url));
	await h.run("start --port 0 --host 127.0.0.1");
	const next = h.notices.at(-1)!;
	assert.match(next, /Shell running/);
	assert.notEqual(next.match(/Token: (\S+)/)![1], first.match(/Token: (\S+)/)![1]);
	const nextUrl = next.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
	await h.close();
	await assert.rejects(fetch(nextUrl));
});

test("default /tty host advertises its wildcard bind before the local browser link", { timeout: 10_000 }, async (t) => {
	const h = harness();
	t.after(() => h.close());
	assert.equal(parseCommand("start", process.cwd()).port, 8765);
	await h.run("start --port 0");
	const first = h.notices.at(-1)!;
	const port = Number(first.match(/dm-tty: http:\/\/0\.0\.0\.0:(\d+)\//)?.[1]);
	assert.ok(port > 0, first);
	assert.match(first, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
	assert.match(first, /Listening on all interfaces/);
	assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
	await h.run("status");
	assert.equal(h.notices.at(-1), first);
});

test("tty refuses noninteractive startup before creating a listener", async () => {
	const h = harness();
	h.ctx.hasUI = false;
	await h.run("start --port 0");
	assert.match(h.notices.at(-1)!, /requires an interactive DM session/);
	assert.ok(h.notices.every((text) => !text.includes("Token:")));
	await h.close();
});

test("tty stop from another session closes the listener and lets its owner restart", { timeout: 15_000 }, async (t) => {
	const owner = harness(), controller = harness();
	t.after(() => owner.close());
	t.after(() => controller.close());
	await owner.run("start --port 0 --host 127.0.0.1");
	const url = owner.notices.at(-1)!.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
	const port = new URL(url).port;
	await controller.run(`stop --port ${port}`);
	assert.match(controller.notices.at(-1)!, /stopped/);
	await assert.rejects(fetch(url));
	await owner.run("status");
	assert.match(owner.notices.at(-1)!, /not running/);
	await owner.run(`start --port ${port} --host 127.0.0.1`);
	assert.equal((await fetch(url + "health")).status, 200);
	await controller.run(`stop --port ${port}`);
	await assert.rejects(fetch(url));
	await controller.run(`stop --port ${port}`);
	assert.match(controller.notices.at(-1)!, /not running/);
});

test("tty stop never reports success or kills an unrelated port listener", { timeout: 10_000 }, async (t) => {
	const other = createServer((_request, response) => response.end("unrelated"));
	await new Promise<void>((done) => other.listen(0, "127.0.0.1", () => done()));
	t.after(() => new Promise<void>((done) => { other.close(() => done()); other.closeAllConnections(); }));
	const address = other.address();
	assert.ok(address && typeof address !== "string");
	const h = harness();
	t.after(() => h.close());
	await h.run(`stop --port ${address.port}`);
	assert.match(h.notices.at(-1)!, /occupied|unmanaged|not.*managed/i);
	assert.doesNotMatch(h.notices.at(-1)!, /dm-tty stopped;/);
	assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`)).text(), "unrelated");
});

test("interactive stop shuts down a separate standalone TTY process and releases its port", { timeout: 20_000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "dm-tty-cross-stop-"));
	const tokenFile = join(cwd, "token");
	const entry = new URL("../standalone.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
		`import {runStandalone} from ${JSON.stringify(entry)}; await runStandalone(process.argv.slice(1));`,
		"--", "--host", "127.0.0.1", "--port", "0", "--token-file", tokenFile], {
		cwd, env: { ...process.env, SHELL: "/bin/sh" }, stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	let output = "", errors = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { errors += chunk; });
	const exited = new Promise<number | null>((done) => child.once("exit", done));
	const deadline = Date.now() + 10_000;
	while (!output.includes("http://") && child.exitCode === null && Date.now() < deadline) {
		await new Promise((done) => setTimeout(done, 25));
	}
	const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
	assert.ok(url, `Standalone did not start: ${errors.slice(0, 300)}`);
	assert.ok(existsSync(tokenFile));
	assert.equal((await fetch(url + "health")).status, 200);
	const h = harness();
	t.after(() => h.close());
	await h.run(`stop --port ${new URL(url).port}`);
	assert.match(h.notices.at(-1)!, /dm-tty stopped; port \d+ is free/);
	assert.equal(await exited, 0);
	assert.equal(existsSync(tokenFile), false);
	await assert.rejects(fetch(url));
});
