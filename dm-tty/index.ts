import type { ExtensionAPI } from "@duckmind/dm-coding-agent";
import { resolve } from "node:path";
import { createTtyToken, DmTtyServer, type TtyServerInfo } from "./server.ts";
import { stopTtyServices } from "./control.ts";

type TtyCommand = { action: "start" | "stop" | "status"; host: string; port: number; cwd: string };
const USAGE = 'usage: /tty start|status|stop [--host HOST] [--port PORT] [--cwd "PATH"]';

export function parseCommand(args: string, cwd: string): TtyCommand {
	const values: string[] = [];
	let current = "", quote = "", escaped = false, present = false;
	for (const character of args.trim()) {
		if (escaped) { current += character; escaped = false; }
		else if (character === "\\" && quote !== "'") { escaped = true; present = true; }
		else if (quote) { if (character === quote) quote = ""; else current += character; }
		else if (character === '"' || character === "'") { quote = character; present = true; }
		else if (/\s/.test(character)) { if (present) values.push(current); current = ""; present = false; }
		else { current += character; present = true; }
	}
	if (quote || escaped) throw new Error("Unclosed quote or escape in /tty arguments");
	if (present) values.push(current);
	const action = values.shift() ?? "status";
	if (action !== "start" && action !== "stop" && action !== "status") throw new Error(USAGE);
	if (action === "status" && values.length) throw new Error(USAGE);
	// Zero means "this session's port, otherwise 8765" only for implicit stop.
	const result: TtyCommand = { action, host: "0.0.0.0", port: action === "stop" ? 0 : 8765, cwd };
	const seen = new Set<string>();
	for (let index = 0; index < values.length; index++) {
		const value = values[index]!;
		const split = value.indexOf("=");
		const key = split < 0 ? value : value.slice(0, split);
		const next = split < 0 ? values[++index] : value.slice(split + 1);
		if (seen.has(key) || !next || next.startsWith("--")) throw new Error(`Invalid or duplicate option: ${key}`);
		if (action === "stop" && key !== "--port") throw new Error(USAGE);
		seen.add(key);
		if (key === "--host") result.host = next;
		else if (key === "--port" && /^\d+$/.test(next)) result.port = Number(next);
		else if (key === "--cwd") result.cwd = resolve(cwd, next);
		else throw new Error(`Unknown or incomplete option: ${key}. ${USAGE}`);
	}
	if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error("Port must be an integer from 0 through 65535");
	if (action === "stop" && seen.has("--port") && result.port === 0) throw new Error("Stop requires a port from 1 through 65535");
	return result;
}

function describe(info: TtyServerInfo): string {
	const host = info.host.includes(":") ? `[${info.host}]` : info.host;
	const localHost = info.host === "0.0.0.0" ? "127.0.0.1" : info.host === "::" ? "[::1]" : "";
	return `dm-tty: http://${host}:${info.port}/${localHost ? `\nLocal browser: http://${localHost}:${info.port}/` : ""}\nToken: ${info.token}\nShell ${info.running ? `running (pid ${info.pid})` : "exited; use /tty stop then /tty start"}; cwd: ${info.cwd}\nThis opens a separate shell, not a mirror of this DM session. Run dm in the browser to start a new session.\nThe token grants full shell access as your OS user. Use an SSH tunnel or HTTPS for remote access; never expose this HTTP listener to the public Internet.${localHost ? "\nListening on all interfaces; use this machine's reachable address in the browser. Use --host 127.0.0.1 to restrict access to this machine." : ""}`;
}

export default function dmTty(dm: ExtensionAPI): void {
	let server: DmTtyServer | undefined;
	let operations = Promise.resolve();
	dm.registerCommand("tty", {
		description: "Authenticated browser terminal: /tty start|status|stop",
		handler: async (args, ctx) => {
			operations = operations.then(async () => {
				try {
					const command = parseCommand(args, ctx.cwd);
					if (command.action === "stop") {
						const port = command.port || server?.info().port || 8765;
						const owned = server?.info().port === port;
						if (owned) {
							await server!.close();
							server = undefined;
						}
						const stopped = await stopTtyServices(port);
						return ctx.ui.notify(owned || stopped ? `dm-tty stopped; port ${port} is free` : `dm-tty is not running on port ${port}`, "info");
					}
					if (command.action === "status" || server) {
						return ctx.ui.notify(server ? describe(server.info()) : "dm-tty is not running; use /tty start", "info");
					}
					if (!ctx.hasUI) throw new Error("/tty start requires an interactive DM session to display the access token");
					const candidate = new DmTtyServer({ ...command, token: createTtyToken() });
					const info = await candidate.start();
					server = candidate;
					void candidate.closed.then(() => { if (server === candidate) server = undefined; });
					ctx.ui.notify(describe(info), "info");
				} catch (error) {
					ctx.ui.notify(`dm-tty: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			});
			await operations;
		},
	});
	dm.on("session_shutdown", async () => {
		await operations;
		await server?.close();
		server = undefined;
	});
}
