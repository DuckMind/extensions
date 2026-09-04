#!/usr/bin/env node
// browser-launch.mjs — start a dedicated Chrome instance for DM CUA
//
// This Chrome instance uses --disable-features=DevToolsPrivacyUI which suppresses
// the "Allow remote debugging?" dialog entirely. It runs on port 9222 so it doesn't
// conflict with your main Chrome session (which may use port 9223).
//
// DM CUA passes CDP_PROFILE_DIR so cdp.mjs targets this dedicated Chrome
// without ever touching the user's main Chrome DevToolsActivePort file.
//
// Usage:
//   node launch.mjs          — launch (or report if already running)
//   node launch.mjs --headless — launch in headless mode (no GUI window)
//   node launch.mjs --kill   — stop and restore original DevToolsActivePort
//   node launch.mjs --status — check if running
//
// Environment:
//   DM_CUA_VISIBLE=1         — Show Chrome window (disables headless mode)
//   CHROME_PATH              — Path to Chrome executable

import { execFileSync, execSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { httpGet } from "../src/browser-helpers/minimize.mjs";
import {
	ACTIVE_PORT_FILE,
	CHROME_MODE_FILE,
	GREEDY_PID_FILE,
	GREEDY_PORT,
	GREEDY_PROFILE_DIR,
} from "../src/browser-helpers/constants.mjs";
import { findListeningProcessPid } from "../src/browser-helpers/port-pid.mjs";
import { resolveSystemCmd } from "../src/browser-helpers/system-cmds.mjs";

const PORT = GREEDY_PORT;
const PROFILE_DIR = GREEDY_PROFILE_DIR;
const ACTIVE_PORT = ACTIVE_PORT_FILE;
const PID_FILE = GREEDY_PID_FILE;
const MODE_FILE = CHROME_MODE_FILE;

function findChrome() {
	const os = platform();
	const candidates =
		os === "win32"
			? [
					"C:/Program Files/Google/Chrome/Application/chrome.exe",
					"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
				]
			: os === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium-browser",
						"/usr/bin/chromium",
						"/snap/bin/chromium",
					];
	return candidates.find(existsSync) || null;
}

const visibleMode = () => process.env.DM_CUA_VISIBLE ?? process.env.GREEDY_SEARCH_VISIBLE;
const isHeadless = () => visibleMode() !== "1";

const BASE_CHROME_FLAGS = [
	`--remote-debugging-port=${PORT}`,
	"--disable-features=DevToolsPrivacyUI",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-default-apps",
	// Anti-detection: suppress the AutomationControlled flag that exposes CDP usage.
	// Must be set for BOTH headless and visible — Cloudflare / DataDome detect it.
	"--disable-blink-features=AutomationControlled",
	`--user-data-dir=${PROFILE_DIR}`,
	"--profile-directory=Default",
	"--window-size=1920,1080",
	"--lang=en-US",
	"--force-color-profile=srgb",
	// Background-tab throttling kills parallel extractions: Chrome clamps
	// setTimeout to ~1Hz in unfocused tabs, so a streaming response that
	// finishes in 5s solo takes 60s+ when 4 engines share one Chrome.
	// The trio below restores full-speed JS in every tab. Safe for our
	// anti-bot stealth — Cloudflare detects CDP/webdriver artifacts, not
	// timer-throttling behavior. Same flags Playwright/Puppeteer add.
	"--disable-background-timer-throttling",
	"--disable-renderer-backgrounding",
	"--disable-backgrounding-occluded-windows",
];

function getChromeVersion(chromePath) {
	// Primary: versioned sub-directory inside the Chrome Application folder.
	// Chrome always creates one (e.g. "148.0.7778.168") — works on all platforms,
	// avoids launching the GUI process just to read a version string.
	try {
		const appDir = join(chromePath, "..");
		const entries = readdirSync(appDir);
		const ver = entries.find((e) =>
			/^\d{1,10}\.\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(e),
		);
		if (ver) return ver.split(".")[0];
	} catch {}

	// Fallback: `chrome --version` — works on macOS/Linux where Chrome is a CLI process.
	try {
		const out = execSync(`"${chromePath}" --version`, {
			encoding: "utf8",
			timeout: 5000,
		}).trim();
		const m = out.match(/(\d{1,10})\.\d{1,10}\.\d{1,10}/);
		if (m) return m[1];
	} catch {}

	return null;
}

function buildChromeFlags(chromePath) {
	const flags = [...BASE_CHROME_FLAGS];
	if (isHeadless()) {
		flags.push("--headless=new");
		const major = getChromeVersion(chromePath) || "136";
		flags.push(
			`--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
		);
	}
	flags.push("about:blank");
	return flags;
}

const isVisible = () => visibleMode() === "1";

/** Check if the running Chrome was launched headless from the mode marker file */
function isModeFileHeadless() {
	try {
		if (!existsSync(MODE_FILE)) return true; // default: assume headless
		return readFileSync(MODE_FILE, "utf8").trim() === "headless";
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Chrome process management
// ---------------------------------------------------------------------------

function getProcessCommandLine(pid) {
	try {
		if (platform() === "win32") {
			const output = execFileSync(
				resolveSystemCmd("powershell"),
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
				],
				{ encoding: "utf8", windowsHide: true, timeout: 5000 },
			);
			return output.trim() || null;
		}
		const output = execFileSync(
			resolveSystemCmd("ps"),
			["-p", String(pid), "-o", "command="],
			{ encoding: "utf8", timeout: 5000 },
		);
		return output.trim() || null;
	} catch {
		return null;
	}
}

export function commandLineMatchesGreedyBrowser(
	commandLine,
	profileDir = PROFILE_DIR,
	port = PORT,
) {
	const normalized = String(commandLine || "").replaceAll("\\", "/");
	const normalizedProfile = String(profileDir || "").replaceAll("\\", "/");
	return (
		normalized.includes(`--remote-debugging-port=${port}`) &&
		normalized.includes(`--user-data-dir=${normalizedProfile}`) &&
		!normalized.includes("--type=")
	);
}

function isOwnedBrowserPid(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return commandLineMatchesGreedyBrowser(getProcessCommandLine(pid));
}

function isRunning() {
	if (!existsSync(PID_FILE)) return false;
	const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
	return isOwnedBrowserPid(pid) ? pid : false;
}

function getPortPid(port) {
	return findListeningProcessPid(port);
}

function getOwnedPortPid() {
	const pid = getPortPid(PORT);
	return isOwnedBrowserPid(pid) ? pid : null;
}

function killProcess(pid) {
	if (!isOwnedBrowserPid(pid)) return false;
	try {
		if (platform() === "win32") {
			execFileSync(resolveSystemCmd("taskkill"), ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
		} else {
			process.kill(pid, "SIGTERM");
		}
		return true;
	} catch {
		return false;
	}
}

function cleanupGhostChrome() {
	const portPid = getPortPid(PORT);
	if (!portPid) return true;
	const trackedPid = isRunning();
	if (trackedPid && portPid === trackedPid) return true;
	if (isOwnedBrowserPid(portPid)) {
		writeFileSync(PID_FILE, String(portPid), "utf8");
		return true;
	}
	console.error(
		`Browser/CDP port ${PORT} is owned by unverified pid ${portPid}; ` +
				"refusing to kill it. Set DM_CUA_PORT to a free port.",
	);
	return false;
}
async function writePortFile(timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { ok, body } = await httpGet(
			`http://localhost:${PORT}/json/version`,
			1500,
		);
		if (ok) {
			try {
				const { webSocketDebuggerUrl } = JSON.parse(body);
				const wsPath = new URL(webSocketDebuggerUrl).pathname;
				writeFileSync(ACTIVE_PORT, `${PORT}\n${wsPath}`, "utf8");
				return true;
			} catch {
				/* ignore */
			}
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const arg = process.argv[2];

	if (!cleanupGhostChrome()) {
		process.exitCode = 1;
		return;
	}

	if (arg === "--kill") {
		const pid = isRunning() || getOwnedPortPid();
		if (pid) {
			const ok = killProcess(pid);
			console.log(
				ok ? `Stopped Chrome (pid ${pid}).` : `Failed to stop pid ${pid}.`,
			);
		} else {
			console.log("DM CUA Chrome is not running.");
		}
		try {
			unlinkSync(PID_FILE);
		} catch {}
		try {
			unlinkSync(ACTIVE_PORT);
		} catch {}
		try {
			unlinkSync(MODE_FILE);
		} catch {}
		return;
	}

	if (arg === "--status") {
		const pid = isRunning();
		if (pid) {
			console.log(`Running — pid ${pid}, port ${PORT}`);
		} else {
			console.log("Not running.");
		}
		return;
	}

	const existing = isRunning();
	if (existing) {
		// Mode check: if caller wants visible but Chrome is headless, kill and relaunch
		const isWantingVisible =
				visibleMode() === "1" &&
			!process.argv.includes("--headless");
		if (isWantingVisible && isModeFileHeadless()) {
			console.log(
				`Headless Chrome running (pid ${existing}) but visible requested — killing...`,
			);
			killProcess(existing);
			try {
				unlinkSync(PID_FILE);
			} catch {}
			try {
				unlinkSync(MODE_FILE);
			} catch {}
			// Fall through to fresh launch below
		} else {
			const ready = await writePortFile(5000);
			if (ready) {
					console.log(`DM CUA Chrome already running (pid ${existing}).`);
				return;
			}
			console.log(`Stale PID ${existing} — launching fresh.`);
			try {
				unlinkSync(PID_FILE);
			} catch {}
		}
	}

	const CHROME_EXE = process.env.CHROME_PATH || findChrome();
	if (!CHROME_EXE) {
		console.error("Chrome not found. Set CHROME_PATH env var.");
		process.exit(1);
	}

	mkdirSync(PROFILE_DIR, { recursive: true });

	console.log(`Launching DM CUA Chrome on port ${PORT}...`);
	if (isHeadless()) {
		console.log("Headless mode — no window will be shown");
	} else if (!isVisible()) {
		console.log("Window will be minimized");
	}

	const proc = spawn(CHROME_EXE, buildChromeFlags(CHROME_EXE), {
		detached: true,
		stdio: "ignore",
	});
	proc.unref();
	writeFileSync(PID_FILE, String(proc.pid));
	// Write mode marker so ensureChrome() can detect headless vs visible
	writeFileSync(MODE_FILE, isHeadless() ? "headless" : "visible", "utf8");

	const portFileReady = await writePortFile();
	if (!portFileReady) {
		console.error("Chrome did not become ready within 15s.");
		process.exit(1);
	}

	if (isHeadless()) {
		// No window to minimize in headless mode
		console.log("Ready (headless).");
	} else {
		console.log("Ready (visible).");
	}
}

main();
