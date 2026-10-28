import { openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createTtyToken, DmTtyServer } from "./server.ts";

const USAGE = "dm --host HOST [--port PORT] [--cwd PATH] [--token-file PATH]";

export function parseStandalone(args: string[]) {
	const options = { host: "", port: 8765, cwd: process.cwd(), tokenFile: "" };
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const split = arg.indexOf("=");
		const key = split < 0 ? arg : arg.slice(0, split);
		const value = split < 0 ? args[++index] : arg.slice(split + 1);
		if (!value || value.startsWith("--") || seen.has(key)) throw new Error(`Invalid option: ${key}. ${USAGE}`);
		seen.add(key);
		if (key === "--host") options.host = value;
		else if (key === "--port" && /^\d+$/.test(value)) options.port = Number(value);
		else if (key === "--cwd") options.cwd = resolve(value);
		else if (key === "--token-file") options.tokenFile = resolve(value);
		else throw new Error(`Unknown option: ${key}. ${USAGE}`);
	}
	if (!options.host || /[\s/]/.test(options.host)) throw new Error(`Invalid host. ${USAGE}`);
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid port");
	return options;
}

export async function runStandalone(args: string[]): Promise<void> {
	const options = parseStandalone(args);
	if (!process.stderr.isTTY && !options.tokenFile) {
		throw new Error("Use --token-file PATH when stderr is not a terminal; tokens must not enter service logs.");
	}
	const token = createTtyToken();
	let tokenCreated = false;
	let server: DmTtyServer | undefined;
	let stop: (() => void) | undefined;
	const stopped = new Promise<void>((done) => { stop = done; });
	process.once("SIGINT", stop!);
	process.once("SIGTERM", stop!);
	try {
		if (options.tokenFile) {
			// Exclusive creation refuses existing files and symlinks; never overwrite a secret.
			const descriptor = openSync(options.tokenFile, "wx", 0o600);
			tokenCreated = true;
			try { writeFileSync(descriptor, `${token}\n`); } finally { closeSync(descriptor); }
		}
		server = new DmTtyServer({ ...options, token });
		const info = await server.start();
		const host = info.host;
		console.log(`dm-tty: http://${host.includes(":") ? `[${host}]` : host}:${info.port}/`);
		const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : "";
		if (localHost) console.log(`Local browser: http://${localHost}:${info.port}/`);
		console.error(`Listening on ${info.host}:${info.port}. Full OS-user shell access; use SSH/HTTPS, never public HTTP.`);
		if (options.tokenFile) console.error("Access token written to the requested private file; removed on shutdown.");
		else console.error(`Token: ${token}`);
		await Promise.race([stopped, server.closed]);
	} finally {
		process.removeListener("SIGINT", stop!);
		process.removeListener("SIGTERM", stop!);
		await server?.close();
		if (tokenCreated) unlinkSync(options.tokenFile);
	}
}
