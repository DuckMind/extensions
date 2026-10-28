import assert from "node:assert/strict";
import { it } from "node:test";
import { onDmBeforeSettle } from "../../src/shared/dm-settlement.ts";

function harness() {
	const final = { role: "assistant", stopReason: "stop", content: [] as unknown[] };
	const entries: Array<{ type: string; customType?: string; content?: string; display?: boolean; message?: typeof final }> = [
		{ type: "custom_message", customType: "subagent-notify", content: "finished", display: true },
		{ type: "message", message: final },
	];
	const ctx = {
		hasPendingMessages: () => false,
		signal: undefined as AbortSignal | undefined,
		sessionManager: { getBranch: () => entries },
	};
	const queued: Array<{ message: unknown; options: unknown }> = [];
	let listener: ((event: { messages: Array<typeof final> }, context: typeof ctx) => void) | undefined;
	const dm = {
		on(name: string, fn: typeof listener) {
			if (name === "agent_end") listener = fn;
		},
		sendMessage(message: unknown, options: unknown) {
			queued.push({ message, options });
		},
	};
	const end = () => listener?.({ messages: [final] }, ctx);
	return { dm, ctx, entries, queued, final, end };
}

it("queues one continuation from a completed agent_end, with branch-local context", () => {
	const h = harness();
	const dispose = onDmBeforeSettle(h.dm as unknown as Parameters<typeof onDmBeforeSettle>[0], event => {
		assert.equal(event.outcome, "completed");
		assert.equal(event.context.contextMessages[0]?.customType, "subagent-notify");
		assert.equal(event.context.contextMessages[1]?.role, "assistant");
		return { entries: [{ type: "custom_message", customType: "subagent-reminder", content: "check results", display: true }], continue: true };
	});
	h.end();
	assert.deepEqual(h.queued, [{ message: { customType: "subagent-reminder", content: "check results", display: true, details: undefined }, options: { triggerTurn: true } }]);
	dispose();
	h.end();
	assert.equal(h.queued.length, 1);
});

it("does not revive aborted, failed, pending, or former-session reminders", () => {
	const h = harness();
	let calls = 0;
	const dispose = onDmBeforeSettle(h.dm as unknown as Parameters<typeof onDmBeforeSettle>[0], () => {
		calls++;
		return { entries: [{ type: "custom_message", customType: "warning", content: "blocked" }] };
	});
	h.ctx.signal = AbortSignal.abort();
	h.end();
	h.ctx.signal = undefined;
	h.final.stopReason = "error";
	h.end();
	h.final.stopReason = "stop";
	h.ctx.hasPendingMessages = () => true;
	h.end();
	assert.equal(calls, 0);
	h.ctx.hasPendingMessages = () => false;
	h.end();
	assert.deepEqual(h.queued[0]?.options, { triggerTurn: false });
	dispose();
	h.entries.splice(0);
	h.end();
	assert.equal(calls, 1);
});
