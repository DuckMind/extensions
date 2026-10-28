import assert from "node:assert/strict";
import { test } from "node:test";
import { dmRetryDelay, implementationMutationError, implementationToolsError } from "../../src/shared/dm-safeguards.ts";

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
const emptyRun = () => ({
	exitCode: 1, messages: [], toolCount: 0, durationMs: 100, usage: usage(),
});

test("retries only an unbilled transient startup/provider failure, at most three times", () => {
	assert.deepEqual([0, 1, 2, 3].map(attempt => dmRetryDelay(emptyRun(), attempt)), [250, 750, 1500, undefined]);
	assert.equal(dmRetryDelay({ ...emptyRun(), error: "model unavailable" }, 0), 250);
	assert.equal(dmRetryDelay({
		...emptyRun(), error: "connection reset",
		messages: [{ errorMessage: "connection reset" }],
	}, 0), 250);
	assert.equal(dmRetryDelay({ ...emptyRun(), error: "invalid request" }, 0), undefined);
	assert.equal(dmRetryDelay({ ...emptyRun(), durationMs: 3000 }, 0), undefined);
});

test("never retries paid work, observed mutations, output, completion diagnostics, or stop", () => {
	for (const patch of [
		{ usage: { ...usage(), input: 1 } },
		{ usage: { ...usage(), cost: 0.01 } },
		{ toolCount: 1 },
		{ observedMutationAttempt: true },
		{ finalOutput: "saved result" },
		{ completionDiagnostic: true },
		{ stopped: true }, { timedOut: true }, { interrupted: true },
		{ exitCode: 0 },
		{ error: "read failed (exit 1): network error" },
		{ error: "connection reset", messages: [{ errorMessage: "unrelated" }] },
	]) {
		assert.equal(dmRetryDelay({ ...emptyRun(), error: "connection reset", ...patch }, 0),
			undefined, JSON.stringify(patch));
	}
});

test("implementation allowlists and missing mutation fail closed while explicit no-edit survives", () => {
	assert.match(implementationToolsError("worker", "Implement the parser fix", ["read"]) ?? "", /no mutation-capable tools/);
	assert.match(implementationMutationError({
		agent: "worker", task: "Fix the parser", tools: ["read", "write"], attempted: false,
	}) ?? "", /without attempting a mutation/);
	assert.equal(implementationMutationError({
		agent: "worker", task: "Fix the parser", tools: ["read", "write"], attempted: true,
	}), undefined);
	assert.equal(implementationToolsError("worker", "Review only; do not edit the parser", ["read"]), undefined);
});
