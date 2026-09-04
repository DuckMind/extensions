import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const INSTALL_POLL_ATTEMPTS = 5;
const INSTALL_POLL_DELAY_MS = 1000;

function windowsJoin(...parts) {
	return path.win32.join(...parts);
}

function addCandidate(candidates, candidate) {
	if (candidate && !candidates.includes(candidate)) {
		candidates.push(candidate);
	}
}

function pathCandidates(env, platformName, executableNames) {
	const searchPath = env.PATH ?? env.Path ?? env.path ?? "";
	const separator = platformName === "win32" ? ";" : path.delimiter;
	const extensions =
		platformName === "win32"
			? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
					.split(";")
					.filter(Boolean)
			: [""];
	const candidates = [];

	for (const directory of searchPath.split(separator).filter(Boolean)) {
		for (const executableName of executableNames) {
			if (platformName === "win32" && path.win32.extname(executableName)) {
				addCandidate(candidates, windowsJoin(directory, executableName));
				continue;
			}
			for (const extension of extensions) {
				const name =
					platformName === "win32"
						? `${executableName}${extension.toLowerCase()}`
						: executableName;
				addCandidate(
					candidates,
					platformName === "win32"
						? windowsJoin(directory, name)
						: path.join(directory, name),
				);
			}
		}
	}

	return candidates;
}

export function resolveChromeExecutable({
	env = process.env,
	platformName = platform(),
	homeDir = homedir(),
	exists = existsSync,
} = {}) {
	const candidates = [];

	if (platformName === "win32") {
		for (const root of [
			env.LOCALAPPDATA,
			env.ProgramFiles,
			env["ProgramFiles(x86)"],
		]) {
			if (!root) continue;
			addCandidate(
				candidates,
				windowsJoin(root, "Google", "Chrome", "Application", "chrome.exe"),
			);
			addCandidate(
				candidates,
				windowsJoin(root, "Chromium", "Application", "chrome.exe"),
			);
		}
		addCandidate(
			candidates,
			homeDir
				? windowsJoin(
						homeDir,
						"AppData",
						"Local",
						"Google",
						"Chrome",
						"Application",
						"chrome.exe",
					)
				: undefined,
		);
		candidates.push(
			...pathCandidates(env, platformName, ["chrome", "chromium"]),
		);
	} else if (platformName === "darwin") {
		for (const appRoot of ["/Applications", path.join(homeDir, "Applications")]) {
			addCandidate(
				candidates,
				path.join(
					appRoot,
					"Google Chrome.app",
					"Contents",
					"MacOS",
					"Google Chrome",
				),
			);
			addCandidate(
				candidates,
				path.join(
					appRoot,
					"Chromium.app",
					"Contents",
					"MacOS",
					"Chromium",
				),
			);
		}
		candidates.push(
			...pathCandidates(env, platformName, [
				"google-chrome-stable",
				"google-chrome",
				"chromium",
				"chromium-browser",
			]),
		);
	} else if (platformName === "linux") {
		for (const candidate of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/usr/local/bin/google-chrome",
			"/usr/local/bin/chromium",
		]) {
			addCandidate(candidates, candidate);
		}
		candidates.push(
			...pathCandidates(env, platformName, [
				"google-chrome-stable",
				"google-chrome",
				"chromium",
				"chromium-browser",
			]),
		);
	}

	return candidates.find((candidate) => exists(candidate));
}

function command(commandName, ...args) {
	return { command: commandName, args };
}

function withLinuxPrivilege(commands, uid) {
	if (uid === 0) return commands;
	return commands.map(({ command: commandName, args }) =>
		command("sudo", "-n", commandName, ...args),
	);
}

export function resolveChromeInstallCandidates({
	platformName = platform(),
	uid = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) {
	if (platformName === "darwin") {
		return [
			{
				id: "homebrew-google-chrome",
				commands: [command("brew", "install", "--cask", "google-chrome")],
			},
		];
	}

	if (platformName === "win32") {
		const wingetArgs = [
			"install",
			"--id",
			"Google.Chrome",
			"-e",
			"--silent",
			"--accept-package-agreements",
			"--accept-source-agreements",
			"--disable-interactivity",
		];
		return [
			{
				id: "winget-user-google-chrome",
				commands: [
					command(
						"winget",
						...wingetArgs.slice(0, 4),
						"--scope",
						"user",
						...wingetArgs.slice(4),
					),
				],
			},
			{
				id: "winget-machine-google-chrome",
				commands: [command("winget", ...wingetArgs)],
			},
			{
				id: "chocolatey-google-chrome",
				commands: [
					command(
						"choco",
						"install",
						"googlechrome",
						"-y",
						"--no-progress",
					),
				],
			},
		];
	}

	if (platformName === "linux") {
		return [
			{
				id: "apt-chromium",
				commands: withLinuxPrivilege(
					[
						command("apt-get", "update"),
						command("apt-get", "install", "-y", "chromium"),
					],
					uid,
				),
			},
			{
				id: "apt-chromium-browser",
				commands: withLinuxPrivilege(
					[
						command("apt-get", "update"),
						command("apt-get", "install", "-y", "chromium-browser"),
					],
					uid,
				),
			},
			{
				id: "dnf-chromium",
				commands: withLinuxPrivilege(
					[command("dnf", "install", "-y", "chromium")],
					uid,
				),
			},
			{
				id: "yum-chromium",
				commands: withLinuxPrivilege(
					[command("yum", "install", "-y", "chromium")],
					uid,
				),
			},
				{
					id: "pacman-chromium",
					commands: withLinuxPrivilege(
						[command("pacman", "-S", "--noconfirm", "--needed", "chromium")],
						uid,
					),
				},
			{
				id: "zypper-chromium",
				commands: withLinuxPrivilege(
					[
						command(
							"zypper",
							"--non-interactive",
							"install",
							"chromium",
						),
					],
					uid,
				),
			},
			{
				id: "apk-chromium",
				commands: withLinuxPrivilege(
					[command("apk", "add", "chromium")],
					uid,
				),
			},
		];
	}

	return [];
}

export function isChromeAutoInstallEnabled(env = process.env) {
	const value = env.DM_CUA_AUTO_INSTALL;
	if (value === undefined) return true;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function parseInstallTimeout(env) {
	const configured = Number(env.DM_CUA_INSTALL_TIMEOUT_MS);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_INSTALL_TIMEOUT_MS;
}

function appendBounded(current, chunk) {
	const combined = `${current}${chunk}`;
	if (Buffer.byteLength(combined) <= MAX_COMMAND_OUTPUT_BYTES) return combined;
	return combined.slice(-MAX_COMMAND_OUTPUT_BYTES);
}

export function runInstallCommand(
	commandName,
	args,
	{ env = process.env, timeoutMs = parseInstallTimeout(env) } = {},
) {
	return new Promise((resolve) => {
		let settled = false;
		let output = "";
		let timer;
		const child = spawn(commandName, args, {
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.stdout?.on("data", (chunk) => {
			output = appendBounded(output, chunk.toString());
		});
		child.stderr?.on("data", (chunk) => {
			output = appendBounded(output, chunk.toString());
		});
		child.on("error", (error) => {
			finish({
				status: error.code === "ENOENT" ? "unavailable" : "failed",
				exitCode: null,
				message: `${error.message}${output ? `\n${output.trim()}` : ""}`,
			});
		});
		child.on("close", (exitCode, signal) => {
			finish({
				status: exitCode === 0 ? "ok" : "failed",
				exitCode,
				message:
					output.trim() ||
					(signal ? `installer terminated by signal ${signal}` : ""),
			});
		});

		timer = setTimeout(() => {
			child.kill();
			finish({
				status: "timeout",
				exitCode: null,
				message: `installer timed out after ${timeoutMs}ms`,
			});
		}, timeoutMs);
	});
}

function installerLabel(candidateId) {
	if (candidateId.startsWith("homebrew-")) return "Homebrew";
	if (candidateId.startsWith("winget-")) return "winget";
	return candidateId.split("-")[0];
}

function attemptFailureMessage(attempt) {
	const evidence = attempt.message ? `: ${attempt.message}` : "";
	return `${attempt.id} ${attempt.status}${evidence}`;
}

export async function ensureChromeAvailable({
	env = process.env,
	platformName = platform(),
	uid = typeof process.getuid === "function" ? process.getuid() : undefined,
	findExecutable = () =>
		resolveChromeExecutable({ env, platformName, homeDir: homedir() }),
	runCommand = (commandName, args) =>
		runInstallCommand(commandName, args, { env }),
	sleep = (delayMs) =>
		new Promise((resolve) => {
			setTimeout(resolve, delayMs);
		}),
} = {}) {
	const existingPath = findExecutable();
	if (existingPath) {
		return {
			status: "existing",
			path: existingPath,
			method: null,
			attempts: [],
		};
	}

	if (!isChromeAutoInstallEnabled(env)) {
		throw new Error(
			"Chrome was not found and automatic installation is disabled by DM_CUA_AUTO_INSTALL.",
		);
	}

	const candidates = resolveChromeInstallCandidates({ platformName, uid });
	if (candidates.length === 0) {
		throw new Error(
			`Chrome was not found and no automatic Chrome installer is defined for ${platformName}.`,
		);
	}

	const attempts = [];
	for (const candidate of candidates) {
		let commandResult = { status: "ok", exitCode: 0, message: "" };
		for (const installCommand of candidate.commands) {
			commandResult = await runCommand(
				installCommand.command,
				installCommand.args,
			);
			if (commandResult.status !== "ok") break;
		}

		if (commandResult.status !== "ok") {
			attempts.push({
				id: candidate.id,
				status: commandResult.status,
				exitCode: commandResult.exitCode,
				message: commandResult.message,
			});
			continue;
		}

		let installedPath;
		for (let pollAttempt = 0; pollAttempt < INSTALL_POLL_ATTEMPTS; pollAttempt += 1) {
			installedPath = findExecutable();
			if (installedPath) break;
			if (pollAttempt < INSTALL_POLL_ATTEMPTS - 1) {
				await sleep(INSTALL_POLL_DELAY_MS);
			}
		}

		if (installedPath) {
			attempts.push({
				id: candidate.id,
				status: "installed",
				exitCode: commandResult.exitCode,
				message: commandResult.message,
			});
			return {
				status: "installed",
				path: installedPath,
				method: candidate.id,
				attempts,
			};
		}

		attempts.push({
			id: candidate.id,
			status: "missing-after-success",
			exitCode: commandResult.exitCode,
			message: `${installerLabel(candidate.id)} reported success, but Chrome was not found`,
		});
	}

	const evidence = attempts.map(attemptFailureMessage).join("; ");
	throw new Error(`Chrome automatic installation failed. ${evidence}`);
}
