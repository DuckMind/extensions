import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureChromeAvailable } from "./browser-install.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DEFAULT_CUA_PORT_BASE = 9322;
const DEFAULT_CUA_PORT_RANGE = 400;
const DEFAULT_TIMEOUT_MS = 60000;
const URLISH_PATTERN = /^(about:|https?:\/\/|file:|chrome-error:\/\/)/i;
const BROWSER_DISPLAY_NAMES = {
	chrome: "Chrome",
	cloak: "CloakBrowser",
};

function parsePort(value) {
	const port = Number.parseInt(String(value ?? ""), 10);
	return Number.isInteger(port) && port > 1024 && port < 65535 ? port : null;
}

function hashScope(value) {
	return createHash("sha256").update(String(value || "default")).digest("hex");
}

function normalizeBrowserKind(value) {
	const raw = String(value || "chrome").trim().toLowerCase();
	if (raw === "cloakbrowser" || raw === "cloak-browser") return "cloak";
	if (raw === "chromium" || raw === "google-chrome" || raw === "chrome") return "chrome";
	return raw.replace(/[^a-z0-9_.-]/g, "-") || "chrome";
}

function resolveBrowserExecutablePath(env, browserKind) {
	const explicit =
		env.DM_CUA_BROWSER_PATH
		|| (browserKind === "cloak" ? env.DM_CUA_CLOAK_PATH || env.CLOAKBROWSER_BINARY_PATH : undefined)
		|| env.CHROME_PATH;
	return explicit ? resolve(String(explicit)) : undefined;
}

export function resolveBrowserRuntimeConfig(env = process.env, scope = process.cwd()) {
	const rawScope = env.DM_CUA_SCOPE || env.DM_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || scope;
	const scopeHash = hashScope(resolve(String(rawScope || ".")));
	const instanceId = String(env.DM_CUA_INSTANCE_ID || scopeHash.slice(0, 12)).replace(/[^a-zA-Z0-9_.-]/g, "-");
	const browserKind = normalizeBrowserKind(env.DM_CUA_BROWSER || env.DM_BROWSER_CUA_BROWSER || env.DM_CUA_BROWSER_KIND);
	const browserDisplayName = env.DM_CUA_BROWSER_DISPLAY_NAME || BROWSER_DISPLAY_NAMES[browserKind] || browserKind;
	const browserExecutablePath = resolveBrowserExecutablePath(env, browserKind);
		const port =
			parsePort(env.DM_CUA_PORT)
			?? parsePort(env.GREEDY_SEARCH_PORT)
		?? DEFAULT_CUA_PORT_BASE + (Number.parseInt(scopeHash.slice(0, 8), 16) % DEFAULT_CUA_PORT_RANGE);
	const profileSuffix = browserKind === "chrome" ? "chrome" : browserKind;
	const defaultProfileDir =
		env.DM_CUA_EPHEMERAL === "1"
			? join(tmpdir(), `dm-cua-${profileSuffix}-profile-${instanceId}`)
			: join(resolveAgentDir(env), "cua", "profiles", `${profileSuffix}-${scopeHash}`);
	const profileDir = resolve(env.DM_CUA_PROFILE_DIR || defaultProfileDir);
	const socketBaseDir = platform() === "win32" ? tmpdir() : "/tmp";
	return {
		instanceId,
		browserKind,
		browserDisplayName,
		browserExecutablePath,
		browserExecutableIsExplicit: Boolean(browserExecutablePath),
		browserInstallation: undefined,
		port,
		profileDir,
		pidFile: join(profileDir, "chrome.pid"),
		modeFile: join(profileDir, "chrome-mode"),
		pagesCache: join(profileDir, "cdp-pages.json"),
		socketDir: join(socketBaseDir, `dm-cua-cdp-${instanceId}`),
	};
}

const BROWSER_CONFIG = resolveBrowserRuntimeConfig();
const CHROME_PORT = BROWSER_CONFIG.port;

export const BROWSER_PROFILE_DIR = BROWSER_CONFIG.profileDir;

function browserSummary() {
	return {
		kind: BROWSER_CONFIG.browserKind,
		displayName: BROWSER_CONFIG.browserDisplayName,
		executablePath: BROWSER_CONFIG.browserExecutablePath,
		installation: BROWSER_CONFIG.browserInstallation ?? null,
		profileDir: BROWSER_CONFIG.profileDir,
		port: BROWSER_CONFIG.port,
	};
}

export async function ensureBrowserSelectionUsable(
	config = BROWSER_CONFIG,
	{
		env = process.env,
		exists = existsSync,
		ensureChrome = ensureChromeAvailable,
	} = {},
) {
	if (config.browserKind === "cloak" && !config.browserExecutablePath) {
		throw new Error(
			[
				"CloakBrowser selected for browser CUA, but no executable path was provided.",
				"Install/pre-download CloakBrowser yourself, then set DM_CUA_BROWSER_PATH, DM_CUA_CLOAK_PATH, CLOAKBROWSER_BINARY_PATH, or CHROME_PATH.",
				"DM does not bundle the compiled CloakBrowser binary because its upstream license allows use but not redistribution.",
			].join(" "),
		);
	}
	if (config.browserExecutablePath && !exists(config.browserExecutablePath)) {
		throw new Error(`${config.browserDisplayName} executable not found: ${config.browserExecutablePath}`);
	}
	if (config.browserExecutablePath) return config;
	if (config.browserKind !== "chrome") {
		throw new Error(
			`${config.browserDisplayName} browser CUA requires an explicit executable path via DM_CUA_BROWSER_PATH.`,
		);
	}

	const selection = await ensureChrome({ env });
	config.browserExecutablePath = selection.path;
	config.browserInstallation = {
		status: selection.status,
		method: selection.method,
		attempts: selection.attempts.map(({ id, status, exitCode }) => ({
			id,
			status,
			exitCode,
		})),
	};
	return config;
}

let browserSelectionPromise;

async function ensureConfiguredBrowserSelectionUsable() {
	if (!browserSelectionPromise) {
		browserSelectionPromise = ensureBrowserSelectionUsable(BROWSER_CONFIG).catch((error) => {
			browserSelectionPromise = undefined;
			throw error;
		});
	}
	return browserSelectionPromise;
}

export function resolveBrowserHelperPaths() {
	const candidates = [{
		launchScript: resolve(__dirname, "..", "bin", "browser-launch.mjs"),
		cdpScript: resolve(__dirname, "..", "bin", "browser-cdp.mjs"),
	}];
	for (const candidate of candidates) {
		if (existsSync(candidate.launchScript) && existsSync(candidate.cdpScript)) {
			return candidate;
		}
	}
	// Bundling can inline this module into index.js or bin/browser-cua.mjs,
	// changing import.meta.url. Return the first candidate so callers still get
	// a stable, debuggable error if neither source nor bundled layout is present.
	return candidates[0];
}

export function resolveBrowserProcessEnv(config = BROWSER_CONFIG, env = process.env, { visible } = {}) {
		const visibleMode =
			visible === true
				? "1"
				: visible === false
					? "0"
					: env.DM_CUA_VISIBLE ??
						env.DM_BROWSER_CUA_VISIBLE ??
						env.GREEDY_SEARCH_VISIBLE;
	return {
		...env,
		...(config.browserExecutablePath ? { CHROME_PATH: config.browserExecutablePath } : {}),
		DM_CUA_BROWSER_LABEL: config.browserDisplayName,
		DM_CUA_PORT: String(config.port),
		DM_CUA_PROFILE_DIR: config.profileDir.replace(/\\/g, "/"),
		DM_CUA_PID_FILE: config.pidFile.replace(/\\/g, "/"),
		DM_CUA_MODE_FILE: config.modeFile.replace(/\\/g, "/"),
		DM_CUA_ALLOW_PORT_CLEANUP: env.DM_CUA_ALLOW_PORT_CLEANUP ?? env.GREEDY_SEARCH_ALLOW_PORT_CLEANUP ?? "0",
		CDP_PROFILE_DIR: config.profileDir.replace(/\\/g, "/"),
		CDP_PAGES_CACHE: config.pagesCache.replace(/\\/g, "/"),
		CDP_SOCKET_DIR: config.socketDir.replace(/\\/g, "/"),
		// Browser helper snapshots created before DM CUA used this legacy namespace.
		// Keep it only as a compatibility bridge while DM_CUA_* is authoritative.
		GREEDY_SEARCH_BROWSER_LABEL: config.browserDisplayName,
		GREEDY_SEARCH_PORT: String(config.port),
		GREEDY_SEARCH_PROFILE_DIR: config.profileDir.replace(/\\/g, "/"),
		GREEDY_SEARCH_PID_FILE: config.pidFile.replace(/\\/g, "/"),
		GREEDY_SEARCH_MODE_FILE: config.modeFile.replace(/\\/g, "/"),
		GREEDY_SEARCH_ALLOW_PORT_CLEANUP: env.DM_CUA_ALLOW_PORT_CLEANUP ?? env.GREEDY_SEARCH_ALLOW_PORT_CLEANUP ?? "0",
		...(visibleMode === undefined ? {} : {
			DM_CUA_VISIBLE: visibleMode,
			GREEDY_SEARCH_VISIBLE: visibleMode,
		}),
	};
}

function browserEnv(options) {
	return resolveBrowserProcessEnv(BROWSER_CONFIG, process.env, options);
}

function looksLikeUrl(value) {
	return URLISH_PATTERN.test(value);
}

export function parseListOutput(output) {
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const parts = line.trim().split(/\s{2,}/).filter(Boolean);
			if (parts.length === 0) {
				return null;
			}
			const target = parts[0];
			if (parts.length === 1) {
				return { target, title: "", url: "" };
			}
			if (parts.length === 2 && looksLikeUrl(parts[1])) {
				return { target, title: "", url: parts[1] };
			}
			const url = parts.at(-1) ?? "";
			const title = parts.slice(1, -1).join("  ");
			return { target, title, url };
		})
		.filter(Boolean);
}

export function validateBrowserSelector(selector) {
	const value = String(selector ?? "").trim();
	if (!value) {
		throw new Error("selector is required for action=click");
	}
	if (/:contains\s*\(/i.test(value)) {
		throw new Error(
			":contains(...) is not a standard CSS selector. Use browser_cua(snapshot) to inspect a standard selector, or browser_cua(evaluate) for text matching.",
		);
	}
	return value;
}

function resolveAgentDir(env = process.env) {
	const explicit = env.DM_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR;
	return explicit ? resolve(explicit) : join(homedir(), ".dm", "agent");
}

function defaultScreenshotPath() {
	const dir = join(resolveAgentDir(), "cua", "screenshots");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(dir, `browser-${stamp}.png`);
}

function runNodeScript(scriptPath, args, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("node", [scriptPath, ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			rejectPromise(new Error(`Timed out running ${scriptPath}`));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectPromise(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code !== 0) {
				rejectPromise(new Error((stderr || stdout || `exit ${code}`).trim()));
				return;
			}
			resolvePromise({ stdout, stderr });
		});
	});
}

function requestJson(method, requestPath) {
	return new Promise((resolvePromise, rejectPromise) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: CHROME_PORT,
				path: requestPath,
				method,
			},
			(response) => {
				let body = "";
				response.on("data", (chunk) => {
					body += chunk.toString();
				});
				response.on("end", () => {
					if ((response.statusCode ?? 500) >= 400) {
						rejectPromise(new Error(`Browser CDP HTTP ${response.statusCode}: ${body.trim()}`));
						return;
					}
					try {
						resolvePromise(body ? JSON.parse(body) : {});
					} catch (error) {
						rejectPromise(error);
					}
				});
			},
		);
		req.on("error", rejectPromise);
		req.end();
	});
}

async function createBlankTarget(url = "about:blank") {
	return requestJson("PUT", `/json/new?${encodeURIComponent(url)}`);
}

async function runCdp(args, options = {}) {
	const { cdpScript } = resolveBrowserHelperPaths();
	return runNodeScript(cdpScript, args, {
		env: browserEnv({ visible: options.visible }),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
}

async function listPages() {
	const result = await runCdp(["list"]);
	return parseListOutput(result.stdout);
}

function findPage(pages, prefix) {
	if (!prefix) return pages[0] ?? null;
	const upper = prefix.toUpperCase();
	return pages.find((page) => page.target.toUpperCase().startsWith(upper)) ?? null;
}

async function ensureBrowserHelpersExist() {
	const { launchScript, cdpScript } = resolveBrowserHelperPaths();
	if (!existsSync(launchScript) || !existsSync(cdpScript)) {
		throw new Error("Bundled DM CUA browser helpers are missing. Rebuild DM to restore them.");
	}
	return { launchScript, cdpScript };
}

export async function ensureBrowserReady({ visible = false } = {}) {
	const { launchScript } = await ensureBrowserHelpersExist();
	await ensureConfiguredBrowserSelectionUsable();
	await runNodeScript(launchScript, [], {
		env: browserEnv({ visible }),
		timeoutMs: DEFAULT_TIMEOUT_MS,
	});
	let pages = await listPages();
	if (pages.length === 0) {
		await createBlankTarget("about:blank");
		pages = await listPages();
	}
	return pages;
}

async function resolveTabContext(tabPrefix) {
	const pages = await ensureBrowserReady();
	const page = findPage(pages, tabPrefix);
	if (!page) {
		if (tabPrefix) {
			throw new Error(`No browser tab matching prefix "${tabPrefix}". Run browser_cua(list) first.`);
		}
		throw new Error("No browser tab available after browser bootstrap.");
	}
	return { tab: page.target, page, pages };
}

export function classifyHumanInteraction(value) {
	const text = String(value ?? "");
	const match = text.match(
		/cloudflare|turnstile|recaptcha|hcaptcha|aws waf|geetest|verify (?:you are )?human|just a moment|checking your browser|login required|sign[ -]?in required|authentication required/i,
	);
	return match
		? {
				needed: true,
				reason: match[0],
			}
		: {
				needed: false,
				reason: null,
			};
}

export async function runBrowserAction({
	action,
	tab,
	url,
	selector,
	x,
	y,
	text,
	expression,
	outputPath,
} = {}) {
	switch (action) {
		case "list": {
			const pages = await ensureBrowserReady();
			return { status: "ok", action, browser: browserSummary(), pages };
		}
		case "navigate": {
			if (!url) throw new Error("url is required for action=navigate");
			const context = await resolveTabContext(tab);
			const result = await runCdp(["nav", context.tab, url], { timeoutMs: 90000 });
			const pages = await listPages();
			const page = findPage(pages, context.tab) ?? context.page;
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				tab: context.tab,
				url: page?.url || url,
				title: page?.title || "",
				message: result.stdout.trim(),
				pages,
			};
		}
			case "snapshot": {
				const context = await resolveTabContext(tab);
				const result = await runCdp(["snap", context.tab]);
				const snapshot = result.stdout.trim();
				return {
					status: "ok",
					action,
					browser: browserSummary(),
					tab: context.tab,
					title: context.page?.title || "",
					url: context.page?.url || "",
					snapshot,
					humanInteraction: classifyHumanInteraction(
						`${context.page?.title || ""}\n${context.page?.url || ""}\n${snapshot}`,
					),
				};
			}
			case "handoff": {
				// A visible handoff can replace a headless owned Chrome process. Stop
				// its per-tab CDP daemons first so they cannot retain a dead WebSocket.
				try {
					await runCdp(["stop"]);
				} catch {
					// No existing daemon is normal on a fresh browser profile.
				}
				const pages = await ensureBrowserReady({ visible: true });
				const page = findPage(pages, tab);
				if (!page) {
					throw new Error(
						tab
							? `No browser tab matching prefix "${tab}". Run browser_cua(list) first.`
							: "No browser tab available after browser bootstrap.",
					);
				}
				const snapshot = await runCdp(["snap", page.target], { visible: true }).then((result) =>
					result.stdout.trim(),
				);
				return {
					status: "ok",
					action,
					browser: browserSummary(),
					tab: page.target,
					title: page.title || "",
					url: page.url || "",
					humanInteraction: classifyHumanInteraction(
						`${page.title || ""}\n${page.url || ""}\n${snapshot}`,
					),
					message:
						"Opened the dedicated DM browser window for human interaction. Complete only the site interaction you authorize, then return to DM; this scoped profile is retained for future CUA sessions.",
				};
			}
		case "screenshot": {
			const context = await resolveTabContext(tab);
			const imagePath = outputPath ? resolve(outputPath) : defaultScreenshotPath();
			mkdirSync(dirname(imagePath), { recursive: true });
			const result = await runCdp(["shot", context.tab, imagePath], { timeoutMs: 120000 });
			const imageBase64 = readFileSync(imagePath).toString("base64");
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				tab: context.tab,
				title: context.page?.title || "",
				url: context.page?.url || "",
				imagePath,
				imageBase64,
				mimeType: "image/png",
				message: result.stdout.trim(),
			};
		}
		case "click": {
			const safeSelector = validateBrowserSelector(selector);
			const context = await resolveTabContext(tab);
			const result = await runCdp(["click", context.tab, safeSelector]);
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				tab: context.tab,
				selector: safeSelector,
				message: result.stdout.trim(),
			};
		}
		case "click_xy": {
			if (typeof x !== "number" || Number.isNaN(x) || typeof y !== "number" || Number.isNaN(y)) {
				throw new Error("x and y are required numbers for action=click_xy");
			}
			const context = await resolveTabContext(tab);
			const result = await runCdp(["clickxy", context.tab, String(x), String(y)]);
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				tab: context.tab,
				x,
				y,
				message: result.stdout.trim(),
			};
		}
		case "type": {
			if (text == null || text === "") throw new Error("text is required for action=type");
			const context = await resolveTabContext(tab);
			const result = await runCdp(["type", context.tab, text]);
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				tab: context.tab,
				textLength: text.length,
				message: result.stdout.trim(),
			};
		}
		case "evaluate": {
			if (!expression) throw new Error("expression is required for action=evaluate");
			const context = await resolveTabContext(tab);
			const result = await runCdp(["eval", context.tab, expression]);
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				tab: context.tab,
				value: result.stdout.trim(),
			};
		}
			case "stop": {
			const { launchScript } = await ensureBrowserHelpersExist();
			try {
				await runCdp(["stop"]);
			} catch {
				// Ignore missing daemon/socket state; launch --kill is the real cleanup.
			}
			const result = await runNodeScript(launchScript, ["--kill"], { env: browserEnv(), timeoutMs: 30000 });
			return {
				status: "ok",
				action,
				browser: browserSummary(),
				message: (result.stdout || "Stopped browser CUA lane.").trim(),
			};
		}
		default:
			throw new Error(`Unsupported browser action: ${action}`);
	}
}

export function renderBrowserActionText(result) {
	switch (result.action) {
		case "list": {
			if (!Array.isArray(result.pages) || result.pages.length === 0) {
				return "Browser CUA is ready, but no pages are open.";
			}
			return [
				"Open browser tabs:",
				...result.pages.map((page) =>
					page.url
						? `${page.target}  ${page.title || "(untitled)"}  ${page.url}`
						: `${page.target}  ${page.title || "(untitled)"}`,
				),
			].join("\n");
		}
		case "navigate":
			return [`Navigated browser tab ${result.tab} to ${result.url || "(unknown URL)"}`, result.title ? `Title: ${result.title}` : ""]
				.filter(Boolean)
				.join("\n");
			case "snapshot":
				return [
					`Browser snapshot for ${result.tab}`,
					result.snapshot || "(empty snapshot)",
					result.humanInteraction?.needed
						? `Human interaction may be required: ${result.humanInteraction.reason}. Use browser_cua(handoff) to open the DM browser window.`
						: "",
				]
					.filter(Boolean)
					.join("\n");
			case "handoff":
				return [
					result.message,
					result.humanInteraction?.needed
						? `Detected: ${result.humanInteraction.reason}.`
						: "No known verification marker was detected; the visible browser remains available if the page still needs you.",
					"DM does not solve challenges or enter credentials for you.",
				].join("\n");
		case "screenshot":
			return [
				`Saved browser screenshot for ${result.tab} at ${result.imagePath}`,
				result.title ? `Title: ${result.title}` : "",
				result.url ? `URL: ${result.url}` : "",
			]
				.filter(Boolean)
				.join("\n");
		case "click":
			return `Clicked selector ${JSON.stringify(result.selector)} on browser tab ${result.tab}`;
		case "click_xy":
			return `Clicked browser tab ${result.tab} at CSS coordinates (${result.x}, ${result.y})`;
		case "type":
			return `Typed ${result.textLength} characters into browser tab ${result.tab}`;
		case "evaluate":
			return `Browser evaluate result for ${result.tab}: ${result.value}`;
		case "stop":
			return result.message || "Stopped browser CUA lane.";
		default:
			return JSON.stringify(result, null, 2);
	}
}
