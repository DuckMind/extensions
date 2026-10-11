import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const MAX_INPUT = 256 * 1024;
const MAX_LINE = 256 * 1024;
const START_TIMEOUT = 6_000;
const CLOSE_TIMEOUT = 1_000;
const BRIDGE = fileURLToPath(new URL("./pty_bridge.py", import.meta.url));

type RecordMessage = { type?: unknown; pid?: unknown; data?: unknown; code?: unknown; signal?: unknown; message?: unknown };

export class PtyProcess extends EventEmitter {
	private readonly options: { cwd: string; shell?: string; command?: readonly [string, ...string[]] };
	private child: ChildProcessWithoutNullStreams | undefined;
	private shellPid: number | undefined;
	private active = false;
	private stopped = false;
	private exitEmitted = false;
	private startPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(options: { cwd: string; shell?: string; command?: readonly [string, ...string[]] }) {
		super();
		this.options = options;
	}

	get pid(): number | undefined { return this.shellPid; }
	get running(): boolean { return this.active; }

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		if (this.stopped) return Promise.reject(new Error("PTY is closed"));
		if (process.platform === "win32") return Promise.reject(new Error("dm-tty PTY requires POSIX; native Windows is unsupported (use WSL)"));
		const env = { ...process.env };
		delete env.DM_TTY_TOKEN;
		if (this.options.command) {
			delete env.STY;
			delete env.WINDOW;
			delete env.TMUX;
		}
		const python = process.env.DM_TTY_PYTHON || "python3";
		const shell = this.options.shell ?? process.env.SHELL ?? "/bin/sh";
		const [program, ...args] = this.options.command ?? [shell, "-i"];
		const mode = this.options.command ? "mux" : "shell";
		this.startPromise = new Promise<void>((resolve, reject) => {
			let settled = false;
			let buffer = "";
			let diagnostic = "";
			const child = spawn(python, ["-u", BRIDGE, mode, program, this.options.cwd, ...args], {
				env, stdio: ["pipe", "pipe", "pipe"],
			});
			this.child = child;
			const fail = (error: Error) => {
				if (!settled) {
					settled = true;
					clearTimeout(deadline);
					reject(error);
					void this.close();
				} else if (!this.stopped) {
					this.emit("error", error);
					void this.close();
				}
			};
			const deadline = setTimeout(() => fail(new Error(`PTY startup timed out: ${python}`)), START_TIMEOUT);
			child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096); });
			child.stdin.on("error", (error: Error) => {
				if (!this.stopped) fail(error);
			});
			child.on("error", (error) => fail(new Error(`Cannot start dm-tty PTY with ${python}: ${error.message}`)));
			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
					fail(new Error("PTY bridge output frame exceeds 256 KiB"));
					return;
				}
				let end: number;
				while ((end = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (line.length > MAX_LINE) {
						fail(new Error("PTY bridge output frame exceeds 256 KiB"));
						return;
					}
					let msg: RecordMessage;
					try { msg = JSON.parse(line) as RecordMessage; } catch { fail(new Error("Invalid PTY bridge response")); return; }
					if (!msg || typeof msg !== "object") { fail(new Error("Invalid PTY bridge response")); return; }
					if (msg.type === "ready" && !settled && Number.isSafeInteger(msg.pid) && (msg.pid as number) > 0) {
						this.shellPid = msg.pid as number;
						this.active = true;
						settled = true;
						clearTimeout(deadline);
						if (this.stopped) { reject(new Error("PTY closed during startup")); void this.close(); }
						else resolve();
					} else if (msg.type === "output" && typeof msg.data === "string" && settled && this.active) {
						this.emit("output", msg.data);
					} else if (msg.type === "exit" && settled && this.active) {
						this.active = false;
						this.exitEmitted = true;
						this.emit("exit", typeof msg.code === "number" ? msg.code : null, typeof msg.signal === "string" ? msg.signal : null);
					} else if (msg.type === "error" && typeof msg.message === "string") {
						fail(new Error(`PTY bridge: ${msg.message}`));
					} else {
						fail(new Error("Unexpected PTY bridge response"));
						return;
					}
				}
			});
			child.on("close", (code, signal) => {
				this.child = undefined;
				this.active = false;
				if (!settled) {
					settled = true;
					clearTimeout(deadline);
					reject(new Error(`PTY bridge exited before ready (${signal ?? code}): ${diagnostic}`));
				} else if (this.shellPid && !this.stopped && !this.exitEmitted) {
					this.exitEmitted = true;
					this.emit("exit", code, signal);
				}
				this.shellPid = undefined;
			});
		});
		return this.startPromise;
	}

	write(data: string): boolean {
		if (!this.running || !this.child || typeof data !== "string") return false;
		const frame = Buffer.from(JSON.stringify({ type: "input", data }) + "\n");
		if (frame.length > MAX_INPUT || this.child.stdin.writableLength + frame.length > MAX_INPUT || this.child.stdin.destroyed) return false;
		this.child.stdin.write(frame);
		return true;
	}

	resize(cols: number, rows: number): void {
		if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200) {
			throw new RangeError("PTY dimensions must be integer cols 2..500 and rows 1..200");
		}
		if (this.running && this.child) {
			const stdin = this.child.stdin;
			const frame = JSON.stringify({ type: "resize", cols, rows }) + "\n";
			if (stdin.destroyed || stdin.writableLength + Buffer.byteLength(frame) > MAX_INPUT) {
				throw new Error("PTY input queue is full");
			}
			stdin.write(frame);
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.stopped = true;
		this.active = false;
		const child = this.child;
		const mode = this.options.command ? "mux" : "shell";
		this.closePromise = (async () => {
			if (!child) return;
			child.stdin.end();
			if (child.exitCode !== null || child.signalCode !== null) return;
			await new Promise<void>((resolve) => {
				let finished = false;
				let kill: NodeJS.Timeout | undefined;
				const finish = () => {
					if (finished) return;
					finished = true;
					clearTimeout(timeout);
					if (kill) clearTimeout(kill);
					resolve();
				};
				const timeout = setTimeout(() => {
					child.kill("SIGTERM");
					kill = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) {
							child.kill("SIGKILL");
							if (mode === "shell" && this.shellPid) {
								try { process.kill(-this.shellPid, "SIGKILL"); } catch { /* already reaped */ }
							}
						}
						finish();
					}, CLOSE_TIMEOUT);
					kill.unref();
				}, CLOSE_TIMEOUT);
				timeout.unref();
				child.once("close", finish);
			});
		})();
		return this.closePromise;
	}
}
