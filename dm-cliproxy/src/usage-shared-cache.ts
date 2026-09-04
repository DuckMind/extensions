// File-based shared cache for /api/usage — multiple DM instances read the same
// file, and a file lock prevents thundering-herd fetches.
//
// Flow (per DM instance):
//   1. readUsageCache() → { doc, ageMs } | null
//   2. if fresh (ageMs < TTL_MS) → use doc, no network
//   3. if stale or missing → tryAcquireLock()
//      a. lock acquired → fetchUsage(force) → writeUsageCache → releaseLock
//      b. lock NOT acquired (another instance fetching) → use stale doc or null
//
// Lock: O_EXCL create (atomic on POSIX). Contains pid + timestamp. Stale locks
// (older than LOCK_STALE_MS) are removed to recover from crashed processes.

import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
	CONFIG_DIR,
	ensurePrivateDirectory,
	ensurePrivateFile,
} from "./config.ts";
import type { UsageDocument } from "./fetch-usage.ts";
import { log } from "./log.ts";

export const USAGE_CACHE_PATH = join(CONFIG_DIR, "usage-cache.json");
export const USAGE_LOCK_PATH = join(CONFIG_DIR, "usage-cache.lock");

/** Minimum interval between network fetches, shared across all DM instances. */
export const USAGE_CACHE_TTL_MS = 120_000; // 2 minutes
/** A lock file older than this is considered stale (process crashed). */
const LOCK_STALE_MS = 30_000;

interface CacheEnvelope {
	fetchedAt: number; // epoch ms
	doc: UsageDocument;
}

export interface CachedUsage {
	doc: UsageDocument;
	ageMs: number;
}

export function usageCachePaths(
	endpoint: string,
	resolvedUsageKey: string,
	configDir = CONFIG_DIR,
): { cachePath: string; lockPath: string } {
	const scope = createHash("sha256")
		.update(endpoint.trim().replace(/\/+$/, ""))
		.update("\0")
		.update(resolvedUsageKey)
		.digest("hex")
		.slice(0, 24);
	return {
		cachePath: join(configDir, `usage-cache-${scope}.json`),
		lockPath: join(configDir, `usage-cache-${scope}.lock`),
	};
}

/** Read the shared cache file. Returns null if missing/corrupt. */
export function readUsageCache(cachePath = USAGE_CACHE_PATH): CachedUsage | null {
	if (!existsSync(cachePath)) return null;
	try {
		ensurePrivateDirectory(dirname(cachePath));
		ensurePrivateFile(cachePath);
		const env = JSON.parse(
			readFileSync(cachePath, "utf8"),
		) as CacheEnvelope;
		if (
			!env ||
			typeof env.fetchedAt !== "number" ||
			!env.doc ||
			!Array.isArray(env.doc.accounts)
		) {
			return null;
		}
		return { doc: env.doc, ageMs: Date.now() - env.fetchedAt };
	} catch (err) {
		log.warn("failed to read usage cache:", (err as Error).message);
		return null;
	}
}

/** Is the cached data fresh enough to skip a network fetch? */
export function isUsageFresh(ageMs: number): boolean {
	return ageMs < USAGE_CACHE_TTL_MS;
}

/** Write fresh usage data + timestamp to the shared cache file. */
export function writeUsageCache(
	doc: UsageDocument,
	cachePath = USAGE_CACHE_PATH,
): void {
	try {
		ensurePrivateDirectory(dirname(cachePath));
		const env: CacheEnvelope = { fetchedAt: Date.now(), doc };
		writeFileSync(cachePath, JSON.stringify(env), {
			encoding: "utf8",
			mode: 0o600,
		});
		ensurePrivateFile(cachePath);
	} catch (err) {
		log.warn("failed to write usage cache:", (err as Error).message);
	}
}

/**
 * Try to acquire an exclusive lock for fetching usage.
 * Returns the lock token if this instance should fetch, null if another is
 * already doing so. Stale locks (crashed process) are cleaned up automatically.
 * The token must be passed to {@link releaseUsageLock} so we only remove a
 * lock we still own.
 */
export function tryAcquireUsageLock(
	lockPath = USAGE_LOCK_PATH,
): string | null {
	const token = `${process.pid}@${Date.now()}`;
	// Clean up stale lock from a crashed process
	if (existsSync(lockPath)) {
		try {
			ensurePrivateDirectory(dirname(lockPath));
			ensurePrivateFile(lockPath);
			const stat = statSync(lockPath);
			if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
				log.debug("removing stale usage lock");
				unlinkSync(lockPath);
			} else {
				return null; // someone else holds a live lock
			}
		} catch {
			// stat/unlink race — treat as locked to be safe
			return null;
		}
	}
	// O_EXCL ("wx") — atomically creates only if the file does not exist
	try {
		ensurePrivateDirectory(dirname(lockPath));
		writeFileSync(lockPath, token, { flag: "wx", mode: 0o600 });
		ensurePrivateFile(lockPath);
		return token;
	} catch {
		// race: another instance created the lock between our check and create
		return null;
	}
}

export function releaseUsageLock(
	ourToken: string,
	lockPath = USAGE_LOCK_PATH,
): boolean {
	try {
		ensurePrivateFile(lockPath);
		const content = readFileSync(lockPath, "utf8").trim();
		// Only remove the lock if it still belongs to us. If another process
		// acquired it after our stale-cleanup, leave it alone.
		if (content === ourToken) {
			unlinkSync(lockPath);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}
