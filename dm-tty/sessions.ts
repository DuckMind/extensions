import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 1_500;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SESSIONS = 128;

export type TtySessionBackend = "shell" | "screen" | "tmux";
export type TtySession = {
	id: string;
	backend: TtySessionBackend;
	name: string;
	label: string;
	attached: boolean;
};

export type SessionDiscoveryOptions = { tmuxSocket?: string };

export function validSessionName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

function validScreenTarget(target: string): boolean {
	return /^\d+\.[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(target);
}

async function commandOutput(command: string, args: string[], env: NodeJS.ProcessEnv, allowNonzero = false): Promise<string> {
	try {
		const result = await execFileAsync(command, args, {
			env,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			windowsHide: true,
		});
		return result.stdout;
	} catch (error) {
		// GNU screen -ls can return nonzero while still listing valid sessions.
		const failure = error as { code?: number | string; killed?: boolean; signal?: string; stdout?: string };
		return allowNonzero && typeof failure.code === "number" && !failure.killed && !failure.signal
			? failure.stdout ?? "" : "";
	}
}

function tmuxArgs(options: SessionDiscoveryOptions, args: string[]): string[] {
	return options.tmuxSocket ? ["-S", options.tmuxSocket, ...args] : args;
}

export function shellSession(): TtySession {
	return { id: "shell", backend: "shell", name: "shell", label: "New shell", attached: false };
}

export function parseScreenListing(output: string): TtySession[] {
	const sessions: TtySession[] = [];
	for (const line of output.split(/\r?\n/)) {
		// GNU screen 5 may insert a timestamp between the socket name and status.
		const match = /^\s*(\d+\.[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})\s+(?:\([^)]*\)\s+)?\((Attached|Detached)\)\s*$/.exec(line);
		const target = match?.[1];
		if (!target || !validScreenTarget(target)) continue;
		if (sessions.length >= MAX_SESSIONS - 1) break;
		const name = target.slice(target.indexOf(".") + 1);
		sessions.push({
			id: `screen:${target}`, backend: "screen", name,
			label: `screen · ${name}`, attached: match?.[2] === "Attached",
		});
	}
	return sessions;
}

export async function discoverTerminalSessions(
	options: SessionDiscoveryOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<TtySession[]> {
	const sessions: TtySession[] = [shellSession()];
	const tmux = await commandOutput("tmux", tmuxArgs(options, ["list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_attached}"]), env);
	for (const line of tmux.split(/\r?\n/)) {
		const [target, name, attached] = line.split("\t");
		if (!target || !/^\$[0-9]+$/.test(target) || !name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) continue;
		if (sessions.length >= MAX_SESSIONS) break;
		sessions.push({
			id: `tmux:${target}`,
			backend: "tmux",
			name,
			label: `tmux · ${name}`,
			attached: attached === "1",
		});
	}
	const screen = await commandOutput("screen", ["-ls"], env, true);
	for (const found of parseScreenListing(screen)) {
		if (sessions.length >= MAX_SESSIONS) break;
		sessions.push(found);
	}
	return sessions;
}

export function sessionCommand(session: TtySession, options: SessionDiscoveryOptions = {}): [string, ...string[]] | undefined {
	if (session.backend === "tmux" && /^tmux:\$[0-9]+$/.test(session.id)) {
		// tmux resolves $IDs before names or prefixes, even if a name contains ':'.
		return ["tmux", ...tmuxArgs(options, ["attach-session", "-t", session.id.slice(5)])];
	}
	if (session.backend === "screen" && validScreenTarget(session.id.slice(7)) && session.id === `screen:${session.id.slice(7)}`) {
		return ["screen", "-x", session.id.slice(7)];
	}
	return undefined;
}

export async function createTerminalSession(
	backend: "screen" | "tmux", name: string, cwd: string, options: SessionDiscoveryOptions = {},
): Promise<void> {
	if (!validSessionName(name)) throw new Error("Session name must be 1–64 letters, digits, dots, hyphens or underscores, starting with a letter or digit.");
	const env = { ...process.env };
	delete env.DM_TTY_TOKEN;
	delete env.STY;
	delete env.WINDOW;
	delete env.TMUX;
	const [command, args] = backend === "tmux"
		? ["tmux", tmuxArgs(options, ["new-session", "-d", "-s", name, "-c", cwd])]
		: ["screen", ["-dmS", name, "/bin/sh", "-i"]];
	await execFileAsync(command, args, { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
}
