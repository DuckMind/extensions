// Shared compatibility constants for the DM CUA browser helper.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function parseBrowserPort(value, fallback = 9222) {
	const port = Number.parseInt(String(value ?? ""), 10);
	return Number.isInteger(port) && port > 1024 && port < 65535 ? port : fallback;
}

const GREEDY_TMP = tmpdir().replaceAll("\\", "/");
export const GREEDY_PORT = parseBrowserPort(process.env.DM_CUA_PORT ?? process.env.GREEDY_SEARCH_PORT);
export const GREEDY_PROFILE_DIR = (
	process.env.DM_CUA_PROFILE_DIR ||
	process.env.GREEDY_SEARCH_PROFILE_DIR ||
	process.env.CDP_PROFILE_DIR ||
	`${GREEDY_TMP}/dm-cua-chrome-profile`
).replaceAll("\\", "/");
export const ACTIVE_PORT_FILE = `${GREEDY_PROFILE_DIR}/DevToolsActivePort`;
export const GREEDY_PID_FILE =
	process.env.DM_CUA_PID_FILE || process.env.GREEDY_SEARCH_PID_FILE || `${GREEDY_PROFILE_DIR}/browser.pid`;
export const PAGES_CACHE =
	process.env.CDP_PAGES_CACHE || `${GREEDY_PROFILE_DIR}/cdp-pages.json`;
export const CHROME_MODE_FILE =
	process.env.DM_CUA_MODE_FILE || process.env.GREEDY_SEARCH_MODE_FILE || `${GREEDY_PROFILE_DIR}/browser-mode`;
export const GREEDY_METADATA_FILE =
	process.env.GREEDY_SEARCH_METADATA_FILE ||
	`${GREEDY_PROFILE_DIR}/browser-metadata.json`;
export const GREEDY_LAUNCH_LOCK_FILE =
	process.env.GREEDY_SEARCH_LAUNCH_LOCK_FILE ||
	`${GREEDY_PROFILE_DIR}/browser-launch.lock`;
export const GREEDY_ACTIVITY_FILE =
	process.env.GREEDY_SEARCH_ACTIVITY_FILE ||
	`${GREEDY_PROFILE_DIR}/browser-last-activity`;
const GREEDY_SOCKET_SCOPE = createHash("sha256")
	.update(GREEDY_PROFILE_DIR)
	.digest("hex")
	.slice(0, 16);
const GREEDY_SOCKET_BASE = platform() === "win32" ? GREEDY_TMP : "/tmp";
export const GREEDY_CDP_SOCKET_DIR = (
	process.env.CDP_SOCKET_DIR || `${GREEDY_SOCKET_BASE}/dm-gs-${GREEDY_SOCKET_SCOPE}`
).replaceAll("\\", "/");
export const VISIBLE_RECOVERY_LOG =
	`${GREEDY_PROFILE_DIR}/visible-recovery.jsonl`;

// ── User config: ~/.dm/greedyconfig ────────────────────────────────────────
// Users can override which engines participate in the "all" fan-out and which
// engine performs optional synthesis.
// Default engines: perplexity, google, chatgpt; synthesizer: gemini

const CONFIG_DIR = join(homedir(), ".dm");
const CONFIG_FILE = join(CONFIG_DIR, "greedyconfig");

// Default engines that participate in the "all" fan-out for normal
// (non-research) searches. Opt-in research/academic engines like
// `semantic-scholar` are deliberately excluded — they belong in research
// mode, not casual web search. Users who want them in normal `engine:all`
// runs can add them via ~/.dm/greedyconfig (see ensureDefaultConfig()).
export const DEFAULT_ENGINES = ["perplexity", "google", "chatgpt", "gemini"];
export const DEFAULT_SYNTHESIZER = "gemini";

function loadUserEngines() {
	try {
		if (existsSync(CONFIG_FILE)) {
			const raw = readFileSync(CONFIG_FILE, "utf8");
			const config = JSON.parse(raw);
			if (
				Array.isArray(config.engines) &&
				config.engines.length > 0 &&
				config.engines.every((e) => typeof e === "string")
			) {
				// Validate each engine exists in ENGINES. Unknown names are
				// silently dropped — but at least once we tell the user about
				// it so a typo in ~/.dm/greedyconfig doesn't quietly shrink
				// the all-search fan-out.
				const valid = config.engines.filter((e) => ENGINES[e]);
				const invalid = config.engines.filter((e) => !ENGINES[e]);
				if (invalid.length > 0) {
					process.stderr.write(
							`[dm-cua] Warning: ignoring unknown engine(s) in ${CONFIG_FILE}: ${invalid.join(", ")}\n` +
								`[dm-cua] Available engines: ${Object.keys(ENGINES).join(", ")}\n`,
					);
				}
				if (valid.length > 0) return valid;
				process.stderr.write(
						`[dm-cua] Warning: no valid engines in ${CONFIG_FILE}, falling back to defaults: ${DEFAULT_ENGINES.join(", ")}\n`,
				);
			}
		}
	} catch {
		// Ignore parse/read errors — fall through to default
	}
	return DEFAULT_ENGINES;
}

function ensureDefaultConfig() {
	try {
		if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
		if (!existsSync(CONFIG_FILE)) {
			writeFileSync(
				CONFIG_FILE,
				JSON.stringify(
					{ engines: DEFAULT_ENGINES, synthesizer: DEFAULT_SYNTHESIZER },
					null,
					2,
				) + "\n",
				"utf8",
			);
		}
	} catch {
		// Best-effort — don't crash if we can't write the config file
	}
}

ensureDefaultConfig();

export const SUPPORTED_SYNTHESIZERS = ["gemini", "chatgpt"];

function loadUserSynthesizer() {
	try {
		if (existsSync(CONFIG_FILE)) {
			const raw = readFileSync(CONFIG_FILE, "utf8");
			const config = JSON.parse(raw);
			if (typeof config.synthesizer === "string") {
				const normalized = config.synthesizer.toLowerCase();
				if (SUPPORTED_SYNTHESIZERS.includes(normalized)) return normalized;
				process.stderr.write(
						`[dm-cua] Warning: unknown synthesizer "${config.synthesizer}" in ${CONFIG_FILE}\n` +
							`[dm-cua] Available synthesizers: ${SUPPORTED_SYNTHESIZERS.join(", ")}\n` +
							`[dm-cua] Falling back to default: ${DEFAULT_SYNTHESIZER}\n`,
				);
			}
		}
	} catch {
		// Ignore parse/read errors — fall through to default
	}
	return DEFAULT_SYNTHESIZER;
}

export const ENGINE_DOMAINS = {
	perplexity: "perplexity.ai",
	bing: "copilot.microsoft.com",
	google: "google.com",
	gemini: "gemini.google.com",
	chatgpt: "chatgpt.com",
	"semantic-scholar": "semanticscholar.org",
	semanticscholar: "semanticscholar.org",
	s2: "semanticscholar.org",
	logically: "logically.app",
};

export const ENGINES = {
	perplexity: "perplexity.mjs",
	p: "perplexity.mjs",
	bing: "bing-copilot.mjs",
	b: "bing-copilot.mjs",
	google: "google-ai.mjs",
	g: "google-ai.mjs",
	gemini: "gemini.mjs",
	gem: "gemini.mjs",
	chatgpt: "chatgpt.mjs",
	gpt: "chatgpt.mjs",
	"semantic-scholar": "semantic-scholar.mjs",
	semanticscholar: "semantic-scholar.mjs",
	s2: "semantic-scholar.mjs",
	logically: "logically.mjs",
	log: "logically.mjs",
};

// ALL_ENGINES drives the "all" fan-out. Edit ~/.dm/greedyconfig to customize.
export const ALL_ENGINES = loadUserEngines();

// Research child searches intentionally reuse the normal configured fan-out.
// Gemini remains the research planner/final-report synthesizer.
export const RESEARCH_ENGINES = ALL_ENGINES;

// SYNTHESIZER drives optional all-search synthesis. Edit ~/.dm/greedyconfig to customize.
export const SYNTHESIZER = loadUserSynthesizer();

export const SOURCE_FETCH_CONCURRENCY = Math.max(
	1,
	Number.parseInt(process.env.GREEDY_FETCH_CONCURRENCY || "5", 10) || 5,
);

// Tell cdp.mjs to prefer DM CUA's dedicated Chrome profile.
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;
