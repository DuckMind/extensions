import assert from "node:assert/strict";
import { test } from "node:test";
import { dmRetryDelay, implementationMutationError, implementationToolsError } from "../../src/shared/dm-safeguards.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const failed = { exitCode: 1, error: "", finalOutput: "", messages: [], toolCount: 0, durationMs: 20, usage };

test("implementation tool contract is enforced, but reviews remain read-only", () => {
	assert.match(implementationToolsError("worker", "implement the patch", ["read"]) ?? "", /no mutation-capable tools/);
	assert.equal(implementationToolsError("reviewer", "review only, do not edit the fix", ["read"]), undefined);
	assert.match(implementationToolsError("worker", "Do not edit tests; implement the fix", ["read"]) ?? "", /no mutation-capable tools/);
	assert.equal(implementationToolsError("writer", "Write a report on this fix", ["read"]), undefined);
	assert.equal(implementationToolsError("worker", "implement the patch", ["read", "edit"]), undefined);
	assert.match(implementationMutationError({ agent: "worker", task: "implement the fix", tools: ["edit"], attempted: false }) ?? "", /without attempting a mutation/);
	assert.equal(implementationMutationError({ agent: "worker", task: "implement the fix", tools: ["edit"], attempted: true }), undefined);
});

test("startup and provider retries are bounded and cannot replay tool work", () => {
	assert.deepEqual([0, 1, 2, 3].map(attempt => dmRetryDelay(failed, attempt)), [250, 750, 1500, undefined]);
	assert.equal(dmRetryDelay({ ...failed, durationMs: 2500 }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, toolCount: 1 }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, usage: { ...usage, input: 1 } }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, observedMutationAttempt: true }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, error: "no output", completionDiagnostic: true }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, error: "Required file-only output was not produced", completionDiagnostic: true }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, interrupted: true }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, error: "connection reset" }, 0), 250);
	assert.equal(dmRetryDelay({ ...failed, error: "bash failed (exit 1): connection reset" }, 0), undefined);
	assert.equal(dmRetryDelay({ ...failed, error: "connection reset", messages: [{ role: "toolResult" }] }, 0), undefined);
});
