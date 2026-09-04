import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { resolveSystemCmd } from "./system-cmds.mjs";

function defaultRun(command, args) {
	return execFileSync(resolveSystemCmd(command), args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5000,
	});
}

function firstPid(text) {
	const match = String(text || "").match(/\b(\d+)\b/);
	return match ? Number.parseInt(match[1], 10) : null;
}

export function parseLsofPid(output) {
	return firstPid(output);
}

export function parseSsPid(output, port) {
	for (const line of String(output || "").split(/\r?\n/)) {
		if (!/\bLISTEN\b/i.test(line)) continue;
		const localFields = line.trim().split(/\s+/).slice(0, 6);
		if (!localFields.some((field) => field.endsWith(`:${port}`))) continue;
		const match = line.match(/\bpid=(\d+)\b/);
		if (match) return Number.parseInt(match[1], 10);
	}
	return null;
}

export function parseNetstatPid(output, port) {
	for (const line of String(output || "").split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5 || fields[0].toUpperCase() !== "TCP") continue;
		if (!fields.at(-2)?.toUpperCase().startsWith("LISTEN")) continue;
		if (!fields[1].endsWith(`:${port}`)) continue;
		const pid = Number.parseInt(fields.at(-1), 10);
		if (Number.isInteger(pid) && pid > 0) return pid;
	}
	return null;
}

function runQuiet(run, command, args) {
	try {
		return run(command, args);
	} catch {
		return null;
	}
}

export function findListeningProcessPid(
	port,
	{ platformName = platform(), run = defaultRun } = {},
) {
	if (platformName === "win32") {
		return parseNetstatPid(runQuiet(run, "netstat", ["-ano", "-p", "TCP"]), port);
	}
	const lsof = runQuiet(run, "lsof", [
		"-nP",
		`-iTCP:${port}`,
		"-sTCP:LISTEN",
		"-t",
	]);
	const lsofPid = parseLsofPid(lsof);
	if (lsofPid) return lsofPid;
	if (platformName !== "linux") return null;
	return parseSsPid(runQuiet(run, "ss", ["-ltnp"]), port);
}
