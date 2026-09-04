import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { migrateLegacyConfig } from "../src/config.ts";
import { setLogQuiet } from "../src/log.ts";

setLogQuiet(true);
const root = mkdtempSync(join(tmpdir(), "dm-cliproxy-migration-"));

try {
	for (const localCheckout of [true, false]) {
		const legacy = join(root, String(localCheckout), "legacy", "config.json");
		const missing = join(root, String(localCheckout), "missing", "config.json");
		const current = join(root, String(localCheckout), "current", "config.json");
		const config = Buffer.from(
			JSON.stringify(
				{
					proxy: {
						apiKey: `!cat ${join(dirname(legacy), "key")}`,
						usageKey: `!cat ${join(dirname(legacy), "usage-key")}`,
					},
				},
				null,
				2,
			) + "\n",
		);
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, config);
		chmodSync(legacy, 0o640);
		for (const sidecar of ["key", "usage-key"]) {
			writeFileSync(join(dirname(legacy), sidecar), `${sidecar}\n`);
		}

		migrateLegacyConfig([missing, legacy], current, localCheckout);

		assert.deepEqual(readFileSync(current), config);
		assert.equal(statSync(current).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(current)).mode & 0o777, 0o700);
		assert.equal(existsSync(legacy), true);
		assert.equal(statSync(legacy).mode & 0o777, 0o600);
		for (const sidecar of ["key", "usage-key"]) {
			assert.equal(
				readFileSync(join(dirname(legacy), sidecar), "utf8"),
				`${sidecar}\n`,
			);
			assert.equal(
				statSync(join(dirname(legacy), sidecar)).mode & 0o777,
				0o600,
			);
			assert.equal(existsSync(join(dirname(current), sidecar)), false);
		}
	}

	const legacy = join(root, "no-overwrite", "legacy", "config.json");
	const current = join(root, "no-overwrite", "current", "config.json");
	mkdirSync(dirname(legacy), { recursive: true });
	mkdirSync(dirname(current), { recursive: true });
	writeFileSync(legacy, "legacy\n");
	writeFileSync(current, "current\n");

	migrateLegacyConfig(legacy, current, false);

	assert.equal(readFileSync(current, "utf8"), "current\n");
	assert.equal(readFileSync(legacy, "utf8"), "legacy\n");
	console.log("dm-cliproxy config migration check: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
