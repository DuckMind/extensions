import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { PtyProcess } from "./pty.ts";
import { startTtyControl } from "./control.ts";
import { createTerminalSession, discoverTerminalSessions, sessionCommand, shellSession, validSessionName, type SessionDiscoveryOptions, type TtySession } from "./sessions.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 16;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_OPERATIONS = 32;

export type TtyServerOptions = { host: string; port: number; cwd: string; token: string; shell?: string; tmuxSocket?: string };
export type TtyServerInfo = { host: string; port: number; cwd: string; pid: number | undefined; token: string; running: boolean };

function extractMessage(data: RawData): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(data.toString("utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

export function createTtyToken(): string {
	return randomBytes(24).toString("base64url");
}

function dependencyAsset(relativePath: string): string {
	// Compiled Bun cannot reliably resolve external packages via createRequire.
	// These paths belong to our exact pinned versions; support npm hoisting.
	let root = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = resolve(root, "node_modules", relativePath);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		const parent = dirname(root);
		if (parent === root) throw new Error(`Missing dm-tty browser asset: ${relativePath}`);
		root = parent;
	}
}

/** One explicitly started shell; browser authentication never creates another. */
export class DmTtyServer {
	private readonly options: TtyServerOptions;
	private readonly http: HttpServer;
	private readonly sockets: WebSocketServer;
	private pty: PtyProcess | undefined;
	private shellPty: PtyProcess | undefined;
	private readonly sessionOptions: SessionDiscoveryOptions;
	private sessions: TtySession[] = [shellSession()];
	private activeSession: TtySession = shellSession();
	private readonly replays = new Map<string, Buffer>();
	private operations = Promise.resolve();
	private pendingOperations = 0;
	private pendingSwitches = 0;
	private switching = false;
	private readonly assets = new Map<string, { type: string; data: Buffer }>();
	private activeSocket: WebSocket | undefined;
	private readySocket: WebSocket | undefined;
	private boundPort: number | undefined;
	private started = false;
	private closing: Promise<void> | undefined;
	private stopControl: (() => void) | undefined;
	private finishClose!: () => void;
	readonly closed = new Promise<void>((done) => { this.finishClose = done; });

	constructor(options: TtyServerOptions) {
		if (options.token.length < 32 || options.token.length > 256) throw new Error("TTY token must contain 32–256 characters");
		if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid TTY port");
		if (!options.host || /[\s/]/.test(options.host)) throw new Error("Invalid TTY host");
		if (!statSync(options.cwd).isDirectory()) throw new Error("TTY cwd must be a directory");
		this.options = { ...options, cwd: resolve(options.cwd) };
		this.sessionOptions = { tmuxSocket: options.tmuxSocket };
		this.http = createServer((request, response) => this.handleHttp(request, response));
		this.sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES * 6 + 1024, perMessageDeflate: false });
		this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
		this.http.on("clientError", (_error, socket) => socket.destroy());
		this.sockets.on("connection", (socket) => this.handleConnection(socket));
	}

	async start(): Promise<TtyServerInfo> {
		if (this.started || this.closing) throw new Error("TTY server has already been started or closed");
		this.started = true;
		try {
			for (const [route, type, path] of [
				["/", "text/html", new URL("./web/index.html", import.meta.url)],
				["/client.js", "text/javascript", new URL("./web/client.js", import.meta.url)],
				["/style.css", "text/css", new URL("./web/style.css", import.meta.url)],
				["/xterm.js", "text/javascript", dependencyAsset("@xterm/xterm/lib/xterm.js")],
				["/xterm.css", "text/css", dependencyAsset("@xterm/xterm/css/xterm.css")],
				["/addon-fit.js", "text/javascript", dependencyAsset("@xterm/addon-fit/lib/addon-fit.js")],
			] as const) this.assets.set(route, { type, data: readFileSync(path) });
			await new Promise<void>((resolvePromise, reject) => {
				this.http.once("error", reject);
				this.http.listen(this.options.port, this.options.host, () => {
					this.http.off("error", reject);
					const address = this.http.address();
					if (!address || typeof address === "string") return reject(new Error("TTY listener did not expose a port"));
					this.boundPort = address.port;
					resolvePromise();
				});
			});
			await this.startSession(this.activeSession, true);
			this.stopControl = await startTtyControl(this.boundPort!, () => this.close());
			return this.info();
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	close(): Promise<void> {
		this.closing ??= this.dispose().finally(() => this.finishClose());
		return this.closing;
	}

	private async dispose(): Promise<void> {
		this.stopControl?.();
		await this.operations;
		this.activeSocket = undefined;
		this.readySocket = undefined;
		// Terminate all sockets, including unauthenticated and half-closed peers.
		for (const socket of this.sockets.clients) socket.terminate();
		await Promise.all([
			this.pty?.close(),
			this.shellPty !== this.pty ? this.shellPty?.close() : undefined,
			new Promise<void>((done) => this.sockets.close(() => done())),
			new Promise<void>((done) => {
				this.http.close(() => done());
				this.http.closeAllConnections();
			}),
		]);
		this.boundPort = undefined;
		this.assets.clear();
		this.replays.clear();
	}

	info(): TtyServerInfo {
		if (this.boundPort === undefined) throw new Error("TTY server is not running");
		return { host: this.options.host, port: this.boundPort, cwd: this.options.cwd, pid: this.pty?.pid, token: this.options.token, running: this.pty?.running ?? false };
	}

	private async refreshSessions(): Promise<TtySession[]> {
		this.sessions = await discoverTerminalSessions(this.sessionOptions);
		if (!this.sessions.some((session) => session.id === this.activeSession.id) && this.pty?.running) this.sessions.unshift(this.activeSession);
		const ids = new Set(this.sessions.map((session) => session.id));
		for (const id of this.replays.keys()) if (!ids.has(id)) this.replays.delete(id);
		return this.sessions;
	}

	private createPty(session: TtySession): PtyProcess {
		const command = sessionCommand(session, this.sessionOptions);
		const pty = new PtyProcess({ cwd: this.options.cwd, shell: this.options.shell, command });
		pty.on("output", (text: string) => {
			this.broadcastOutput(text, session.id, this.pty === pty && !this.switching && this.readySocket === this.activeSocket);
		});
		pty.on("exit", (code: number | null, signal: string | null) => { if (this.pty === pty && !this.switching) this.broadcast({ type: "exit", code, signal }); });
		pty.on("error", () => { if (this.pty === pty) this.broadcast({ type: "error", message: "Terminal process failed; stop and restart /tty." }); });
		return pty;
	}

	private async startSession(session: TtySession, resetReplay: boolean): Promise<void> {
		if (resetReplay) this.replays.set(session.id, Buffer.alloc(0));
		const pty = this.createPty(session);
		this.pty = pty;
		this.activeSession = session;
		if (session.backend === "shell") this.shellPty = pty;
		await pty.start();
	}

	private enqueue(socket: WebSocket, operation: () => Promise<void>, changesAttachment = false): void {
		if (this.pendingOperations >= MAX_OPERATIONS) return void this.send(socket, { type: "error", message: "Too many pending session operations." });
		this.pendingOperations++;
		if (changesAttachment) this.switching = ++this.pendingSwitches > 0;
		this.operations = this.operations.then(async () => {
			if (socket !== this.activeSocket || this.closing) return;
			try {
				await operation();
			} catch {
				if (socket === this.activeSocket) this.send(socket, { type: "error", message: "Terminal session operation failed; choose another tab." });
			}
		}).finally(() => {
			this.pendingOperations--;
			if (changesAttachment) this.switching = --this.pendingSwitches > 0;
		});
	}

	private sendReady(socket: WebSocket): void {
		if (socket !== this.activeSocket || this.closing) return;
		this.send(socket, {
			type: "ready",
			replay: (this.replays.get(this.activeSession.id) ?? Buffer.alloc(0)).toString("utf8"),
			running: this.pty?.running ?? false,
			sessions: this.sessions,
			activeSession: this.activeSession,
		});
		this.readySocket = socket;
	}

	private sendSessions(socket: WebSocket): void {
		this.send(socket, { type: "sessions", sessions: this.sessions, activeSession: this.activeSession });
	}

	private async selectSession(socket: WebSocket, id: string): Promise<void> {
		if (socket !== this.activeSocket) return;
		await this.refreshSessions();
		if (socket !== this.activeSocket || this.closing) return;
		const session = this.sessions.find((candidate) => candidate.id === id);
		if (!session) return void this.send(socket, { type: "error", message: "That terminal session is no longer available." });
		this.send(socket, { type: "switching", session });
		if (session.id !== this.activeSession.id) {
			const previous = this.pty;
			let candidate = session.backend === "shell" ? this.shellPty : undefined;
			if (!candidate) {
				candidate = this.createPty(session);
				try {
					await candidate.start();
					if (!candidate.running) throw new Error("Session exited during attachment");
				} catch {
					await candidate.close();
					if (socket === this.activeSocket && !this.closing) {
						this.send(socket, { type: "error", message: "Cannot attach terminal session." });
						this.sendReady(socket);
					}
					return;
				}
			}
			if (socket !== this.activeSocket || this.closing) {
				if (candidate !== this.shellPty) await candidate.close();
				return;
			}
			this.pty = candidate;
			this.activeSession = session;
			if (previous && previous !== this.shellPty) await previous.close();
			if (socket !== this.activeSocket || this.closing) return;
			await this.refreshSessions();
		}
		if (socket !== this.activeSocket || this.closing) return;
		this.sendReady(socket);
	}

	private async createSession(socket: WebSocket, backend: "tmux" | "screen", name: string): Promise<void> {
		if (!validSessionName(name)) return void this.send(socket, { type: "error", message: "Invalid session name (1–64 letters, digits, dots, hyphens or underscores)." });
		const before = await this.refreshSessions();
		if (socket !== this.activeSocket || this.closing) return;
		if (before.some((session) => session.backend === backend && session.name === name)) {
			return void this.send(socket, { type: "error", message: "Session name already exists." });
		}
		await createTerminalSession(backend, name, this.options.cwd, this.sessionOptions);
		if (socket !== this.activeSocket || this.closing) return;
		const after = await this.refreshSessions();
		if (socket !== this.activeSocket || this.closing) return;
		const created = after.find((session) => session.backend === backend && !before.some((old) => old.id === session.id)
			&& session.name === name);
		if (!created) throw new Error("Created session not found");
		await this.selectSession(socket, created.id);
	}

	private handleHttp(request: IncomingMessage, response: ServerResponse): void {
		const headers = {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
			"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
		};
		const asset = this.assets.get(request.url ?? "");
		if ((request.method === "GET" || request.method === "HEAD") && asset) {
			response.writeHead(200, { ...headers, "content-type": `${asset.type}; charset=utf-8` });
			response.end(request.method === "HEAD" ? undefined : asset.data);
		} else if (request.method === "GET" && request.url === "/health") {
			response.writeHead(200, { ...headers, "content-type": "application/json" });
			response.end(JSON.stringify({ status: "ok", running: this.pty?.running ?? false }));
		} else {
			response.writeHead(404, headers);
			response.end("Not found");
		}
	}

	private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		let originAllowed = request.headers.origin === undefined;
		if (request.headers.origin) {
			try {
				const origin = new URL(request.headers.origin);
				originAllowed = ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host;
			} catch { /* Invalid origins fail closed. */ }
		}
		if (!originAllowed || request.url !== "/terminal" || this.closing || this.sockets.clients.size >= MAX_CONNECTIONS) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		this.sockets.handleUpgrade(request, socket, head, (websocket) => this.sockets.emit("connection", websocket));
	}

	private handleConnection(socket: WebSocket): void {
		let authenticated = false;
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const reject = (code: number, reason: string): void => {
			if (closeTimer) return;
			socket.close(code, reason);
			closeTimer = setTimeout(() => socket.terminate(), 500);
			closeTimer.unref();
		};
		const authTimer = setTimeout(() => reject(1008, "authentication required"), AUTH_TIMEOUT_MS);
		authTimer.unref();
		socket.on("error", (error: Error & { code?: string }) => {
			// ws sends its own 1009 close frame after a maxPayload error.
			if (error.code !== "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") socket.terminate();
		});
		socket.on("message", (data, isBinary) => {
			if (closeTimer) return;
			const message = isBinary ? null : extractMessage(data);
			if (!message || message.v !== 1) return reject(1003, "invalid protocol message");
			if (!authenticated) {
				const token = typeof message.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
				const expected = Buffer.from(this.options.token);
				if (message.type !== "auth" || token.length !== expected.length || !timingSafeEqual(token, expected)) {
					return reject(1008, "authentication failed");
				}
				authenticated = true;
				clearTimeout(authTimer);
				const previous = this.activeSocket;
				this.activeSocket = socket;
				this.readySocket = undefined;
				previous?.close(1012, "replaced by a new controller");
				if (previous) {
					const timer = setTimeout(() => previous.terminate(), 500);
					timer.unref();
					previous.once("close", () => clearTimeout(timer));
				}
				// Discover host sessions only after authentication, serialized with switches.
				this.enqueue(socket, async () => {
					await this.refreshSessions();
					if (socket === this.activeSocket && !this.closing) this.sendReady(socket);
				});
				return;
			}
			if (socket !== this.activeSocket) return reject(1008, "controller replaced");
			if (message.type === "input" && typeof message.data === "string") {
				if (Buffer.byteLength(message.data) > MAX_INPUT_BYTES) return reject(1009, "input limit exceeded");
				// Identity is mandatory: a delayed frame from the previous tab must never reach this PTY.
				if (this.switching || message.sessionId !== this.activeSession.id) return;
				if (!this.pty?.running) return this.send(socket, { type: "error", message: "Terminal session exited; choose another tab." });
				if (!this.pty.write(message.data)) reject(1008, "terminal input is congested");
			} else if (message.type === "resize") {
				const { cols, rows } = message;
				if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 200) {
					return reject(1008, "invalid terminal dimensions");
				}
				if (this.switching || message.sessionId !== this.activeSession.id) return;
				try {
					this.pty?.resize(cols, rows);
				} catch {
					reject(1008, "terminal input is congested");
				}
			} else if (message.type === "sessions") {
				this.enqueue(socket, async () => { await this.refreshSessions(); if (socket === this.activeSocket && !this.closing) this.sendSessions(socket); });
			} else if (message.type === "select" && typeof message.sessionId === "string" && message.sessionId.length <= 160) {
				const id = message.sessionId;
				this.enqueue(socket, () => this.selectSession(socket, id), true);
			} else if (message.type === "create" && (message.backend === "tmux" || message.backend === "screen") && typeof message.name === "string" && message.name.length <= 64) {
				const { backend, name } = message as { backend: "tmux" | "screen"; name: string };
				this.enqueue(socket, () => this.createSession(socket, backend, name), true);
			} else if (message.type === "ping") {
				this.send(socket, { type: "pong" });
			} else reject(1003, "unknown terminal message");
		});
		socket.on("close", () => {
			clearTimeout(authTimer);
			clearTimeout(closeTimer);
			if (this.activeSocket === socket) this.activeSocket = undefined;
			if (this.readySocket === socket) this.readySocket = undefined;
		});
	}

	private broadcastOutput(text: string, id: string, visible: boolean): void {
		if (!text || this.closing) return;
		const combined = Buffer.concat([this.replays.get(id) ?? Buffer.alloc(0), Buffer.from(text)]);
		let start = Math.max(0, combined.length - MAX_REPLAY_BYTES);
		// Never start a reconnect snapshot in the middle of a UTF-8 codepoint.
		while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
		this.replays.set(id, Buffer.from(combined.subarray(start)));
		if (visible) this.broadcast({ type: "output", data: text });
	}

	private send(socket: WebSocket, message: Record<string, unknown>): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		if (socket.bufferedAmount > MAX_PENDING_BYTES) {
			socket.terminate();
			return;
		}
		socket.send(JSON.stringify({ v: 1, ...message }));
	}

	private broadcast(message: Record<string, unknown>): void {
		if (this.activeSocket) this.send(this.activeSocket, message);
	}
}
