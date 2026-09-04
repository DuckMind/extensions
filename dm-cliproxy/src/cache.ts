// Disk cache for Discovery — stale-while-revalidate.
//
// The well-known/v1-models round-trip costs ~5s on every DM startup (the proxy
// answers /.well-known/pi slowly), and DM re-spawns the agent for every
// provider-feature probe, so that cost is paid constantly. We persist the last
// good Discovery and serve it instantly on boot, then revalidate over the
// network in the background.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	CONFIG_DIR,
	ensurePrivateDirectory,
	ensurePrivateFile,
} from "./config.ts";
import type { Discovery } from "./fetch-models.ts";
import { log } from "./log.ts";

export const DISCOVERY_CACHE_PATH = join(CONFIG_DIR, "discovery-cache.json");

interface CacheEnvelope {
	savedAt: number;
	scope: string;
	discovery: Discovery;
}

export interface CachedDiscovery {
	discovery: Discovery;
	ageMs: number;
}

export function discoveryCacheScope(
	endpoint: string,
	resolvedKey: string,
): string {
	return createHash("sha256")
		.update(endpoint.trim().replace(/\/+$/, ""))
		.update("\0")
		.update(resolvedKey)
		.digest("hex");
}

export function readDiscoveryCache(
	expectedScope: string,
	cachePath = DISCOVERY_CACHE_PATH,
): CachedDiscovery | null {
	if (!existsSync(cachePath)) return null;
	try {
		ensurePrivateDirectory(dirname(cachePath));
		ensurePrivateFile(cachePath);
		const env = JSON.parse(
			readFileSync(cachePath, "utf8"),
		) as CacheEnvelope;
		if (
			!env ||
			typeof env.savedAt !== "number" ||
			env.scope !== expectedScope ||
			!env.discovery ||
			!Array.isArray(env.discovery.builtinProviders) ||
			!Array.isArray(env.discovery.customPool)
		) {
			return null;
		}
		return { discovery: env.discovery, ageMs: Date.now() - env.savedAt };
	} catch (err) {
		log.warn("failed to read discovery cache:", (err as Error).message);
		return null;
	}
}

export function writeDiscoveryCache(
	discovery: Discovery,
	scope: string,
	cachePath = DISCOVERY_CACHE_PATH,
): void {
	try {
		ensurePrivateDirectory(dirname(cachePath));
		const env: CacheEnvelope = { savedAt: Date.now(), scope, discovery };
		writeFileSync(cachePath, JSON.stringify(env), {
			encoding: "utf8",
			mode: 0o600,
		});
		ensurePrivateFile(cachePath);
	} catch (err) {
		log.warn("failed to write discovery cache:", (err as Error).message);
	}
}
