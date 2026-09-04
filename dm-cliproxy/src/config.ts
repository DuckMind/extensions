// ~/.dm/agent/dm-cliproxy/config.json — migrate, load, validate, persist.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Api } from "@duckmind/dm-ai";

import { log } from "./log.ts";

export const CONFIG_DIR = join(homedir(), ".dm", "agent", "dm-cliproxy");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const LEGACY_CONFIG_PATHS = [
	join(homedir(), ".pi", "agent", "pi-cliproxyapi", "config.json"),
	join(homedir(), ".config", "pi-cliproxyapi", "config.json"),
] as const;

export function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

export function ensurePrivateFile(path: string): void {
	if (existsSync(path)) chmodSync(path, 0o600);
}

function hardenReferencedSecretFiles(configPath: string): void {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		return;
	}
	const proxy =
		raw && typeof raw === "object"
			? (raw as { proxy?: { apiKey?: unknown; usageKey?: unknown } }).proxy
			: undefined;
	for (const value of [proxy?.apiKey, proxy?.usageKey]) {
		if (typeof value !== "string") continue;
		const match = /^!cat\s+((?:~\/|\/)[^\s;&|`]+)$/.exec(value.trim());
		if (!match) continue;
		const secretPath = match[1]!.replace(/^~/, homedir());
		ensurePrivateFile(secretPath);
	}
}

export function isLocalCheckout(): boolean {
	return existsSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", ".git"),
	);
}

export function migrateLegacyConfig(
	legacyPaths: string | readonly string[] = LEGACY_CONFIG_PATHS,
	configPath = CONFIG_PATH,
	_localCheckout = isLocalCheckout(),
): void {
	if (existsSync(configPath)) return;
	const candidates =
		typeof legacyPaths === "string" ? [legacyPaths] : [...legacyPaths];
	const legacyPath = candidates.find((candidate) => existsSync(candidate));
	if (!legacyPath) return;

	let temporaryPath: string | undefined;
	try {
		ensurePrivateFile(legacyPath);
		hardenReferencedSecretFiles(legacyPath);
		ensurePrivateDirectory(dirname(configPath));
		temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
		copyFileSync(legacyPath, temporaryPath, constants.COPYFILE_EXCL);
		chmodSync(temporaryPath, 0o600);
		linkSync(temporaryPath, configPath);
		rmSync(temporaryPath);
		temporaryPath = undefined;
		log.info("legacy config copied to", configPath);
	} catch (err) {
		if (temporaryPath) {
			try {
				rmSync(temporaryPath, { force: true });
			} catch (cleanupErr) {
				log.warn("failed to clean temporary config:", cleanupErr);
			}
		}
		log.warn("failed to migrate legacy config:", err);
	}
}

export interface BuiltinProviderConfig {
	enabled: boolean;
	apiOverride?: Api | null;
	models: string[];
}

export interface CustomProviderModelConfig {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface CustomProviderConfig {
	api: Api;
	models: CustomProviderModelConfig[];
}

export interface ProxyConfig {
	proxy: {
		endpoint: string;
		apiKey: string;
		usageKey?: string;
		/** Prefix used for default custom-provider slugs. */
		providerPrefix?: string;
	};
	builtinProviders: Record<string, BuiltinProviderConfig>;
	customProviders: Record<string, CustomProviderConfig>;
	discoveryExcludes: string[];
	overrides: Record<string, Partial<CustomProviderModelConfig>>;
	refreshIntervalMinutes: number;
	usageCacheTtlMs: number;
}

const DEFAULT_CONFIG: ProxyConfig = {
	proxy: {
		endpoint: "",
		apiKey: "",
	},
	builtinProviders: {},
	customProviders: {},
	discoveryExcludes: ["*:*"],
	overrides: {},
	refreshIntervalMinutes: 0,
	usageCacheTtlMs: 30_000,
};

export function loadConfig(): ProxyConfig {
	migrateLegacyConfig();
	if (!existsSync(CONFIG_PATH)) {
		log.debug("config not found, using defaults at", CONFIG_PATH);
		return structuredClone(DEFAULT_CONFIG);
	}
	try {
		ensurePrivateDirectory(dirname(CONFIG_PATH));
		ensurePrivateFile(CONFIG_PATH);
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return normalizeConfig(raw);
	} catch (err) {
		log.error("failed to read config:", err, "— using defaults");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfigAtPath(
	cfg: ProxyConfig,
	configPath = CONFIG_PATH,
): void {
	ensurePrivateDirectory(dirname(configPath));
	const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
	let fileDescriptor: number | undefined;
	try {
		fileDescriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(fileDescriptor, JSON.stringify(cfg, null, 2) + "\n", {
			encoding: "utf8",
		});
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		renameSync(temporaryPath, configPath);
		ensurePrivateFile(configPath);
	} finally {
		if (fileDescriptor !== undefined) closeSync(fileDescriptor);
		rmSync(temporaryPath, { force: true });
	}
}

export function saveConfig(cfg: ProxyConfig): void {
	saveConfigAtPath(cfg);
	log.info("config saved to", CONFIG_PATH);
}

function normalizeConfig(raw: unknown): ProxyConfig {
	if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_CONFIG);
	const r = raw as Record<string, unknown>;
	const merged = structuredClone(DEFAULT_CONFIG);
	const proxyBlock = (r.proxy as Record<string, unknown> | undefined) ?? {};
	merged.proxy.endpoint =
		typeof proxyBlock.endpoint === "string"
			? proxyBlock.endpoint
			: merged.proxy.endpoint;
	merged.proxy.apiKey =
		typeof proxyBlock.apiKey === "string" ? proxyBlock.apiKey : "";
	if (typeof proxyBlock.usageKey === "string")
		merged.proxy.usageKey = proxyBlock.usageKey;
	if (
		typeof proxyBlock.providerPrefix === "string" &&
		proxyBlock.providerPrefix.trim()
	) {
		merged.proxy.providerPrefix = proxyBlock.providerPrefix.trim();
	}

	if (r.builtinProviders && typeof r.builtinProviders === "object") {
		merged.builtinProviders = r.builtinProviders as Record<
			string,
			BuiltinProviderConfig
		>;
	}
	if (r.customProviders && typeof r.customProviders === "object") {
		merged.customProviders = r.customProviders as Record<
			string,
			CustomProviderConfig
		>;
	}
	if (Array.isArray(r.discoveryExcludes)) {
		merged.discoveryExcludes = r.discoveryExcludes.filter(
			(x): x is string => typeof x === "string",
		);
	}
	if (r.overrides && typeof r.overrides === "object") {
		merged.overrides = r.overrides as Record<
			string,
			Partial<CustomProviderModelConfig>
		>;
	}
	if (typeof r.refreshIntervalMinutes === "number")
		merged.refreshIntervalMinutes = r.refreshIntervalMinutes;
	if (typeof r.usageCacheTtlMs === "number")
		merged.usageCacheTtlMs = r.usageCacheTtlMs;
	return merged;
}

/**
 * Resolve a config value using DM's supported key forms:
 * `!cmd` runs a command, `$ENV_VAR` reads an environment variable, and any
 * other value is used literally.
 */
export function resolveConfigValue(raw: string | undefined | null): string {
	if (!raw) return "";
	const value = raw.trim();
	if (value.startsWith("!")) {
		try {
			return execSync(value.slice(1), {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch (err) {
			const status = (err as { status?: number | null })?.status;
			const suffix =
				typeof status === "number" ? ` (exit ${status})` : "";
			log.warn(`failed to resolve "!" config value${suffix}`);
			return "";
		}
	}
	if (value.startsWith("$")) {
		return process.env[value.slice(1)] ?? "";
	}
	return value;
}
