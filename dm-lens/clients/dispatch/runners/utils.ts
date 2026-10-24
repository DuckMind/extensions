/**
 * Shared utilities for runners
 */

import * as fs from "node:fs";

/**
 * A file's current content, or `undefined` when it cannot be read.
 *
 * The one fail-open reader the finding policy's callers share (#1634, #4459
 * review F3): `undefined` becomes `FindingPolicyOptions.content`'s documented
 * `""` input, so inline suppression is a no-op and a STRICT `false-positive`
 * anchor cannot match. A read error never hides a finding (AGENTS.md shape
 * 48). Synchronous on purpose: the cascade neighbour render and the probe
 * replay call it from synchronous loops (see `clients/cascade-format.ts`).
 */
export function readFileContent(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}
