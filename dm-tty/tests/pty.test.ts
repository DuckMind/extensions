import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PtyProcess } from "../pty.ts";

function waitFor(check: () => boolean, timeout = 4_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeout;
		const tick = () => {
			if (check()) return resolve();
			if (Date.now() >= deadline) return reject(new Error("PTY test timed out"));
			setTimeout(tick, 20);
		};
		tick();
	});
}

function shell(cwd = process.cwd(), executable = "/bin/sh"): { pty: PtyProcess; output: () => string } {
	const pty = new PtyProcess({ cwd, shell: executable });
	let text = "";
	pty.on("error", () => {});
	pty.on("output", (chunk: string) => { text += chunk; });
	return { pty, output: () => text };
}

test("interactive shell has controlling tty, UTF-8 output, and resize works", async () => {
	const { pty, output } = shell();
	try {
		await pty.start();
		assert.ok(pty.pid && pty.running);
		pty.resize(103, 37);
		assert.equal(pty.write("test -t 0 && printf 'TTY_YES\\n'; stty size; printf '\\303\\251\\n'\n"), true);
		await waitFor(() => output().includes("TTY_YES") && output().includes("37 103") && output().includes("é"));
		assert.equal(pty.write("x".repeat(256 * 1024)), false);
		assert.throws(() => pty.resize(1, 10), RangeError);
		assert.throws(() => pty.resize(20.5, 10), RangeError);
		assert.throws(() => pty.resize(20, 201), RangeError);
	} finally {
		await pty.close();
	}
});

test("browser PTY advertises xterm even when DM runs inside screen", async () => {
	const previous = process.env.TERM;
	process.env.TERM = "screen-256color";
	const { pty, output } = shell();
	try {
		await pty.start();
		assert.equal(pty.write("printf 'BROWSER_TERM=%s\\n' \"$TERM\"\n"), true);
		await waitFor(() => output().includes("BROWSER_TERM=xterm-256color"));
	} finally {
		await pty.close();
		if (previous === undefined) delete process.env.TERM;
		else process.env.TERM = previous;
	}
});

test("Ctrl-C interrupts foreground sleep and leaves shell alive", async () => {
	const { pty, output } = shell();
	try {
		await pty.start();
		assert.equal(pty.write("sleep 30\n"), true);
		await waitFor(() => output().includes("sleep 30"));
		// Wait until the shell has assigned the foreground job its terminal.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(pty.write("\u0003"), true);
		assert.equal(pty.write("printf 'AFTER_INTERRUPT\\n'\n"), true);
		await waitFor(() => output().split("AFTER_INTERRUPT").length >= 3, 3_000);
		assert.equal(pty.running, true);
	} finally {
		await pty.close();
	}
});

test("missing shell, cwd, and Python reject start without leaving a running process", async () => {
	for (const [cwd, executable, python] of [
		[process.cwd(), "/nonexistent/dm-tty-shell", undefined],
		["/nonexistent/dm-tty-cwd", "/bin/sh", undefined],
		[process.cwd(), "/bin/sh", "/nonexistent/dm-tty-python"],
	] as const) {
		const previous = process.env.DM_TTY_PYTHON;
		if (python) process.env.DM_TTY_PYTHON = python;
		try {
			const { pty } = shell(cwd, executable);
			await assert.rejects(pty.start(), /exec failed|Cannot start dm-tty PTY/);
			await pty.close();
			assert.equal(pty.running, false);
		} finally {
			if (previous === undefined) delete process.env.DM_TTY_PYTHON;
			else process.env.DM_TTY_PYTHON = previous;
		}
	}
});

test("shutdown is idempotent and cleans foreground and shell groups", async () => {
	const { pty, output } = shell();
	await pty.start();
	const pid = pty.pid!;
	try {
		pty.write("sleep 30\n");
		await waitFor(() => output().includes("sleep 30"));
		await new Promise((resolve) => setTimeout(resolve, 200));
		const first = pty.close();
		assert.equal(first, pty.close());
		await first;
		assert.equal(pty.running, false);
		await waitFor(() => {
			try { process.kill(pid, 0); return false; } catch { return true; }
		});
	} finally {
		await pty.close();
	}
});

test("shell exit is reported once and token is absent from shell environment", async () => {
	const previous = process.env.DM_TTY_TOKEN;
	process.env.DM_TTY_TOKEN = "should-not-reach-shell";
	const { pty, output } = shell();
	const exits: Array<[number | null, string | null]> = [];
	pty.on("exit", (code: number | null, signal: string | null) => { exits.push([code, signal]); });
	try {
		await pty.start();
		pty.write("test -z \"${DM_TTY_TOKEN+x}\" && printf 'TOKEN_CLEAN\\n'; exit 7\n");
		await waitFor(() => exits.length > 0);
		assert.ok(output().split("TOKEN_CLEAN").length >= 3, "shell must actually print token-clean result");
		assert.deepEqual(exits, [[7, null]]);
		await pty.close();
		assert.deepEqual(exits, [[7, null]]);
	} finally {
		await pty.close();
		if (previous === undefined) delete process.env.DM_TTY_TOKEN;
		else process.env.DM_TTY_TOKEN = previous;
	}
});

test("bridge detects parent stdin EOF and reaps shell", async () => {
	const bridge = fileURLToPath(new URL("../pty_bridge.py", import.meta.url));
	const child = spawn(process.env.DM_TTY_PYTHON || "python3", ["-u", bridge, "shell", "/bin/sh", process.cwd()], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let text = "";
	let pid = 0;
	let stderr = "";
	const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
	try {
		child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		await waitFor(() => text.includes("\n"));
		pid = (JSON.parse(text.split("\n")[0]!) as { pid: number }).pid;
		assert.ok(pid > 0);
		assert.equal(child.exitCode, null, `bridge exited before EOF: ${stderr}`);
		child.stdin.end();
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				closed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						let state = "";
						try { state = execFileSync("ps", ["-o", "pid,ppid,pgid,stat,command", "-p", `${child.pid},${pid}`], { encoding: "utf8" }); } catch { /* exited */ }
						reject(new Error(`bridge did not exit on EOF; status=${child.exitCode} stdin=${child.stdin.writableFinished} stderr=${stderr} processes=${state}`));
					}, 3_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		await waitFor(() => {
			try { process.kill(pid, 0); return false; } catch { return true; }
		});
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});
