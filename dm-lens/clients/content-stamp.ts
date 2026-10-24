import { createHash } from "node:crypto";
import * as fs from "node:fs";

/** One bounded content-hash budget shared by byte-identity callers. */
export const CONTENT_HASH_MAX_BYTES = 4 * 1024 * 1024;

export interface ContentStamp {
	size: number;
	mtimeMs: number;
	sha256?: string;
}

export function hashContentBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function hashFileBytes(filePath: string): string {
	return hashContentBytes(fs.readFileSync(filePath));
}

export function stampContentBytes(
	bytes: Uint8Array,
	mtimeMs: number,
): ContentStamp {
	return {
		size: bytes.byteLength,
		mtimeMs,
		...(bytes.byteLength <= CONTENT_HASH_MAX_BYTES
			? { sha256: hashContentBytes(bytes) }
			: {}),
	};
}
