import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { createTtyToken, DmTtyServer } from "../server.ts";
import { PtyProcess } from "../pty.ts";

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("terminal condition timeout");
		await delay(10);
	}
}

async function fixture(t: TestContext, extra: { tmuxSocket?: string } = {}) {
	const token = createTtyToken();
	const server = new DmTtyServer({ host: "127.0.0.1", port: 0, cwd: process.cwd(), shell: "/bin/sh", token, ...extra });
	t.after(() => server.close());
	const info = await server.start();
	const url = `http://127.0.0.1:${info.port}`;
	async function connect(authToken = token) {
		const socket = new WebSocket(`${url.replace("http:", "ws:")}/terminal`, { origin: url });
		t.after(() => socket.terminate());
		const messages: Record<string, unknown>[] = [];
		socket.on("message", (data: RawData) => messages.push(JSON.parse(data.toString())));
		await once(socket, "open", { signal: AbortSignal.timeout(3_000) });
		socket.send(JSON.stringify({ v: 1, type: "auth", token: authToken }));
		return { socket, messages, output: () => messages.filter((m) => m.type === "output").map((m) => m.data).join("") };
	}
	return { server, info, token, url, connect };
}

test("browser assets are local, token-free and protected against framing", { timeout: 10_000 }, async (t) => {
	const { url, token } = await fixture(t);
	const page = await fetch(url);
	assert.equal(page.status, 200);
	assert.equal(page.headers.get("x-frame-options"), "DENY");
	assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
	const html = await page.text();
	assert.match(html, /DM TTY/);
	assert.ok(!html.includes(token));
	for (const asset of ["/client.js", "/style.css", "/xterm.js", "/xterm.css", "/addon-fit.js"]) {
		const response = await fetch(url + asset);
		assert.equal(response.status, 200, asset);
		assert.ok((await response.text()).length > 0);
	}
	assert.equal((await fetch(url + "/../server.ts")).status, 404);
	assert.equal((await fetch(url + "/?token=" + token)).status, 404);
});

test("wildcard listener accepts non-loopback HTTP and same-origin authenticated WebSockets", { timeout: 10_000 }, async (t) => {
	const address = Object.values(networkInterfaces()).flat()
		.find((value) => value?.family === "IPv4" && !value.internal && !value.address.startsWith("169.254."))?.address;
	if (!address) return void t.skip("No non-loopback IPv4 interface available");
	const token = createTtyToken();
	const server = new DmTtyServer({ host: "0.0.0.0", port: 0, cwd: process.cwd(), shell: "/bin/sh", token });
	t.after(() => server.close());
	const info = await server.start();
	assert.equal(info.host, "0.0.0.0");
	const url = `http://${address}:${info.port}`;
	assert.equal((await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })).status, 200);
	const socket = new WebSocket(`${url.replace("http:", "ws:")}/terminal`, { origin: url });
	t.after(() => socket.terminate());
	await once(socket, "open", { signal: AbortSignal.timeout(3_000) });
	const ready = once(socket, "message", { signal: AbortSignal.timeout(3_000) });
	socket.send(JSON.stringify({ v: 1, type: "auth", token }));
	assert.equal(JSON.parse(String((await ready)[0])).type, "ready");
	const foreign = new WebSocket(`${url.replace("http:", "ws:")}/terminal`, { origin: "https://untrusted.invalid" });
	t.after(() => foreign.terminate());
	const error = await once(foreign, "error", { signal: AbortSignal.timeout(3_000) });
	assert.match(String(error[0]), /403/);
});

test("authentication rejects a wrong token without leaking replay", { timeout: 10_000 }, async (t) => {
	const { connect } = await fixture(t);
	const client = await connect("wrong-token");
	const [code] = await once(client.socket, "close", { signal: AbortSignal.timeout(3_000) });
	assert.equal(code, 1008);
	assert.equal(client.messages.length, 0);
});

test("real PTY supports shell input, terminal dimensions and reconnect replay", { timeout: 10_000 }, async (t) => {
	const { connect } = await fixture(t);
	const client = await connect();
	await waitFor(() => client.messages.some((m) => m.type === "ready"));
	client.socket.send(JSON.stringify({ v: 1, type: "resize", sessionId: "shell", cols: 100, rows: 32 }));
	client.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: "shell", data: "test -t 0 && test -t 1 && printf 'tty-%s\\n' verified; stty size\n" }));
	await waitFor(() => client.output().includes("tty-verified") && client.output().includes("32 100"));
	client.socket.terminate();
	const replacement = await connect();
	await waitFor(() => replacement.messages.some((m) => m.type === "ready"));
	const ready = replacement.messages.find((m) => m.type === "ready")!;
	assert.match(String(ready.replay), /tty-verified/);
	assert.ok(Buffer.byteLength(String(ready.replay)) <= 256 * 1024);
});

test("authenticated tabs discover and attach a tmux session without shell injection", { timeout: 15_000 }, async (t) => {
	if (spawnSync("tmux", ["-V"]).error) return void t.skip("tmux is not installed");
	const socketPath = `/tmp/dm-tty-test-${process.pid}-${Date.now()}`;
	const sessionName = `dm_tab_${process.pid}`;
	execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", sessionName, "/bin/sh"]);
	const owned = [sessionName];
	t.after(() => {
		for (const name of owned) {
			try { execFileSync("tmux", ["-S", socketPath, "send-keys", "-t", `${name}:0`, "exit", "Enter"]); } catch { /* already exited */ }
		}
	});
	const { connect, server } = await fixture(t, { tmuxSocket: socketPath });
	const client = await connect();
	await waitFor(() => client.messages.some((message) => message.type === "ready"));
	const initial = client.messages.find((message) => message.type === "ready")!;
	const tab = (initial.sessions as Array<{ id: string; backend: string; name: string }>).find((session) =>
		session.backend === "tmux" && session.name === sessionName);
	assert.ok(tab, "tmux session should be listed as a selectable tab");
	const shellPid = server.info().pid;
	client.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: tab.id }));
	await waitFor(() => client.messages.some((message) => message.type === "ready" && (message.activeSession as { id?: string })?.id === tab.id));
	client.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: tab.id, data: "printf 'tmux-tab-%s\\n' attached\n" }));
	await waitFor(() => client.output().includes("tmux-tab-attached"));
	const createdName = `dm_created_${process.pid}`;
	client.socket.send(JSON.stringify({ v: 1, type: "create", backend: "tmux", name: createdName }));
	owned.push(createdName);
	await waitFor(() => client.messages.some((message) => message.type === "ready"
		&& (message.activeSession as { name?: string })?.name === createdName));
	const created = [...client.messages].reverse().find((message) => message.type === "ready")!;
	const createdId = (created.activeSession as { id: string }).id;
	assert.equal((created.sessions as Array<{ id: string; attached: boolean }>).find((s) => s.id === createdId)?.attached, true);
	const reconnected = await connect();
	await waitFor(() => reconnected.messages.some((message) => message.type === "ready"));
	const snapshot = reconnected.messages.find((message) => message.type === "ready")!;
	assert.equal((snapshot.activeSession as { id: string }).id, createdId);
	assert.equal(reconnected.messages.filter((message) => message.type === "output").length, 0,
		"reconnect replay must not also arrive as live output");
	client.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: "shell" }));
	// The old controller cannot switch tabs after takeover.
	assert.equal(reconnected.messages.some((message) => message.type === "switching"), false);
	reconnected.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: "shell" }));
	await waitFor(() => reconnected.messages.some((message) => message.type === "ready"
		&& (message.activeSession as { id?: string })?.id === "shell"));
	assert.equal(server.info().pid, shellPid, "shell PTY must persist across mux switches");
	await server.close();
	const remaining = execFileSync("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
	assert.ok(remaining.includes(sessionName) && remaining.includes(createdName), "server shutdown must preserve mux sessions");
});

test("tmux tab multiattaches without disconnecting an existing controller", { timeout: 15_000 }, async (t) => {
	if (spawnSync("tmux", ["-V"]).error) return void t.skip("tmux is not installed");
	const socketPath = `/tmp/dm-tty-shared-${process.pid}-${Date.now()}`;
	const name = `dm_shared_${process.pid}`;
	execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", name, "/bin/sh"]);
	const external = new PtyProcess({ cwd: process.cwd(), command: ["tmux", "-S", socketPath, "attach-session", "-t", name] });
	t.after(async () => {
		await external.close();
		try { execFileSync("tmux", ["-S", socketPath, "send-keys", "-t", `${name}:0`, "exit", "Enter"]); } catch { /* test-owned session already exited */ }
	});
	await external.start();
	await waitFor(() => execFileSync("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_attached}"], { encoding: "utf8" }).trim() === "1");
	const { connect, server } = await fixture(t, { tmuxSocket: socketPath });
	const client = await connect();
	await waitFor(() => client.messages.some((message) => message.type === "ready"));
	const tab = (client.messages.find((message) => message.type === "ready")?.sessions as Array<{ id: string; attached: boolean }>)
		.find((session) => session.id.startsWith("tmux:"));
	assert.equal(tab?.attached, true);
	client.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: tab.id }));
	await waitFor(() => client.messages.some((message) => message.type === "ready"
		&& (message.activeSession as { id?: string })?.id === tab.id));
	assert.equal(external.running, true, "existing tmux controller must remain connected");
	await server.close();
	assert.equal(external.running, true, "server shutdown must not detach the other controller");
	assert.equal(execFileSync("tmux", ["-S", socketPath, "list-sessions", "-F", "#{session_attached}"], { encoding: "utf8" }).trim(), "1");
});

test("isolated GNU screen sessions survive switches and shutdown; shell tab retains state", { timeout: 20_000 }, async (t) => {
	if (spawnSync("screen", ["--version"]).error) return void t.skip("screen is not installed");
	const previousDir = process.env.SCREENDIR;
	const dir = mkdtempSync(join(tmpdir(), "dm-tty-screen-"));
	chmodSync(dir, 0o700);
	process.env.SCREENDIR = dir;
	const name = `dm_tab_${process.pid}`;
	const createdName = `dm_created_${process.pid}`;
	const owned = [name];
	let server: DmTtyServer | undefined;
	t.after(async () => {
		await server?.close();
		for (const target of owned) {
			try { execFileSync("screen", ["-S", target, "-X", "quit"]); } catch { /* already exited */ }
		}
		if (previousDir === undefined) delete process.env.SCREENDIR;
		else process.env.SCREENDIR = previousDir;
	});
	execFileSync("screen", ["-dmS", name, "/bin/sh", "-i"]);
	const fixtureResult = await fixture(t);
	server = fixtureResult.server;
	const client = await fixtureResult.connect();
	await waitFor(() => client.messages.some((m) => m.type === "ready"));
	const ready = client.messages.find((m) => m.type === "ready")!;
	const tab = (ready.sessions as Array<{ id: string; name: string; backend: string }>).find((s) => s.backend === "screen" && s.name === name);
	assert.ok(tab, "real screen session must be discovered");
	client.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: "shell", data: "printf 'SHELL_STATE_%s\\n' kept\n" }));
	await waitFor(() => client.output().includes("SHELL_STATE_kept"));
	const shellPid = server.info().pid;
	client.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: tab.id }));
	await waitFor(() => client.messages.some((m) => m.type === "ready" && (m.activeSession as { id?: string })?.id === tab.id));
	client.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: tab.id, data: "printf 'SCREEN_ACTIVE_%s\\n' yes\n" }));
	await waitFor(() => client.output().includes("SCREEN_ACTIVE_yes"));
	client.socket.send(JSON.stringify({ v: 1, type: "create", backend: "screen", name: createdName }));
	owned.push(createdName);
	await waitFor(() => client.messages.some((m) => m.type === "ready" && (m.activeSession as { name?: string })?.name === createdName));
	client.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: "shell" }));
	await waitFor(() => client.messages.some((m) => m.type === "ready"
		&& (m.activeSession as { id?: string })?.id === "shell" && m !== ready));
	assert.equal(server.info().pid, shellPid);
	assert.match(String([...client.messages].reverse().find((m) => m.type === "ready")?.replay), /SHELL_STATE_kept/);
	await server.close();
	const output = execFileSync("screen", ["-ls"], { encoding: "utf8" });
	assert.match(output, new RegExp(`\\d+\\.${name}\\b`));
	assert.match(output, new RegExp(`\\d+\\.${createdName}\\b`));
});

test("session operations require authentication; missing IDs do not replace active shell", { timeout: 10_000 }, async (t) => {
	const { connect, url } = await fixture(t);
	const unauth = new WebSocket(`${url.replace("http:", "ws:")}/terminal`, { origin: url });
	t.after(() => unauth.terminate());
	await once(unauth, "open");
	const denied = once(unauth, "close", { signal: AbortSignal.timeout(3_000) });
	unauth.send(JSON.stringify({ v: 1, type: "sessions" }));
	assert.equal((await denied)[0], 1008);
	const client = await connect();
	await waitFor(() => client.messages.some((m) => m.type === "ready"));
	const first = client.messages.find((m) => m.type === "ready")!;
	assert.equal((first.activeSession as { id: string }).id, "shell");
	client.socket.send(JSON.stringify({ v: 1, type: "sessions" }));
	await waitFor(() => client.messages.some((m) => m.type === "sessions"));
	assert.deepEqual([...client.messages].reverse().find((m) => m.type === "sessions")?.sessions, first.sessions);
	client.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: "tmux:$999999999" }));
	await waitFor(() => client.messages.some((m) => m.type === "error"));
	assert.equal(client.messages.some((m) => m.type === "switching"), false);
	client.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: "shell", data: "printf 'STILL_ACTIVE_%s\\n' yes\n" }));
	await waitFor(() => client.output().includes("STILL_ACTIVE_yes"));
});

test("controller takeover during pending attach leaves shell available to new owner", { timeout: 12_000 }, async (t) => {
	if (spawnSync("tmux", ["-V"]).error) return void t.skip("tmux is not installed");
	const path = `/tmp/dm-tty-race-${process.pid}-${Date.now()}`;
	const name = `dm_race_${process.pid}`;
	execFileSync("tmux", ["-S", path, "new-session", "-d", "-s", name, "/bin/sh"]);
	t.after(() => { try { execFileSync("tmux", ["-S", path, "send-keys", "-t", `${name}:0`, "exit", "Enter"]); } catch { /* exited */ } });
	const { connect } = await fixture(t, { tmuxSocket: path });
	const first = await connect();
	await waitFor(() => first.messages.some((m) => m.type === "ready"));
	const tab = (first.messages.find((m) => m.type === "ready")?.sessions as Array<{ id: string }>).find((s) => s.id.startsWith("tmux:"))!;
	assert.ok(tab);
	const originalStart = PtyProcess.prototype.start;
	let release!: () => void;
	const gated = new Promise<void>((done) => { release = done; });
	PtyProcess.prototype.start = async function () { await gated; return originalStart.call(this); };
	try {
		first.socket.send(JSON.stringify({ v: 1, type: "select", sessionId: tab.id }));
		await waitFor(() => first.messages.some((m) => m.type === "switching"));
		first.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: tab.id, data: "printf 'WRONG_TAB_INPUT\\n'\n" }));
		first.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: "shell", data: "printf 'WRONG_SHELL_INPUT\\n'\n" }));
		const replacement = await connect();
		release();
		await waitFor(() => replacement.messages.some((m) => m.type === "ready"));
		const ready = replacement.messages.find((m) => m.type === "ready")!;
		assert.equal((ready.activeSession as { id: string }).id, "shell");
		replacement.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: "shell", data: "printf 'RACE_SAFE_%s\\n' yes\n" }));
		await waitFor(() => replacement.output().includes("RACE_SAFE_yes"));
		assert.doesNotMatch(String(ready.replay) + replacement.output(), /WRONG_(TAB|SHELL)_INPUT/);
		assert.equal(first.messages.some((m) => m.type === "ready" && (m.activeSession as { id?: string })?.id === tab.id), false);
	} finally {
		release();
		PtyProcess.prototype.start = originalStart;
	}
});

test("only the newest authenticated browser controls the shell", { timeout: 10_000 }, async (t) => {
	const { connect } = await fixture(t);
	const first = await connect();
	await waitFor(() => first.messages.some((m) => m.type === "ready"));
	const closed = once(first.socket, "close", { signal: AbortSignal.timeout(3_000) });
	const second = await connect();
	await waitFor(() => second.messages.some((m) => m.type === "ready"));
	assert.equal((await closed)[0], 1012);
	second.socket.send(JSON.stringify({ v: 1, type: "input", sessionId: "shell", data: "printf 'owner-%s\\n' second\n" }));
	await waitFor(() => second.output().includes("owner-second"));
});

test("malformed and oversized websocket messages cannot crash the server", { timeout: 10_000 }, async (t) => {
	const { connect, url } = await fixture(t);
	for (const [index, payload] of ["{", JSON.stringify({ v: 1, type: "input", data: "x".repeat(65_537) }), "x".repeat(400_000)].entries()) {
		const client = await connect();
		await waitFor(() => client.messages.some((m) => m.type === "ready"));
		const closed = once(client.socket, "close", { signal: AbortSignal.timeout(3_000) });
		client.socket.send(payload);
		const [code] = await closed;
		assert.ok([1003, 1008, 1009].includes(Number(code)), `payload ${index} closed with ${code}`);
	}
	assert.equal((await fetch(url + "/health")).status, 200);
});

test("shutdown closes unauthenticated clients and is idempotent", { timeout: 10_000 }, async (t) => {
	const { server, url } = await fixture(t);
	const socket = new WebSocket(url.replace("http:", "ws:") + "/terminal");
	t.after(() => socket.terminate());
	await once(socket, "open");
	const closed = once(socket, "close", { signal: AbortSignal.timeout(3_000) });
	await server.close();
	await closed;
	await server.close();
	await assert.rejects(fetch(url));
});

test("resize queue congestion closes the controller without crashing the server", { timeout: 10_000 }, async (t) => {
	const { connect, url } = await fixture(t);
	const client = await connect();
	await waitFor(() => client.messages.some((m) => m.type === "ready"));
	const resize = PtyProcess.prototype.resize;
	PtyProcess.prototype.resize = () => { throw new Error("PTY input queue is full"); };
	try {
		const closed = once(client.socket, "close", { signal: AbortSignal.timeout(3_000) });
		client.socket.send(JSON.stringify({ v: 1, type: "resize", sessionId: "shell", cols: 80, rows: 24 }));
		assert.equal((await closed)[0], 1008);
		assert.equal((await fetch(url + "/health")).status, 200);
	} finally {
		PtyProcess.prototype.resize = resize;
	}
});

test("cross-origin browser upgrades are denied before authentication", { timeout: 10_000 }, async (t) => {
	const { url } = await fixture(t);
	const socket = new WebSocket(url.replace("http:", "ws:") + "/terminal", { origin: "https://untrusted.invalid" });
	t.after(() => socket.terminate());
	const error = await once(socket, "error", { signal: AbortSignal.timeout(3_000) });
	assert.match(String(error[0]), /403/);
});

test("failed shell startup rejects rather than advertising a dead terminal", { timeout: 10_000 }, async () => {
	const server = new DmTtyServer({ host: "127.0.0.1", port: 0, cwd: process.cwd(), shell: "/nonexistent/dm-shell", token: createTtyToken() });
	try {
		await assert.rejects(server.start());
	} finally {
		await server.close();
	}
});
