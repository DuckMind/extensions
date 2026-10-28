import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@duckmind/dm-tui";
import { initTheme } from "@duckmind/dm-coding-agent";
import {
	parseSupervisorReplyData, parseSupervisorRequestDetails, supervisorReplyHint,
	SUPERVISOR_REPLY_ENTRY_TYPE, SUPERVISOR_REQUEST_MESSAGE_TYPE,
} from "../../src/intercom/supervisor-ui.ts";
import { renderSubagentEntry, renderSubagentMessage } from "../../src/tui/subagent-messages.ts";
initTheme("dark");
const identityTheme = {
	fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("native supervisor UI on DM", () => {
	it("renders the decision request and its exact reply hint from the model-visible content", () => {
		const hint = supervisorReplyHint("request-123456");
		const details = { id: "request-123456", reason: "interview_request" as const, agent: "worker", expectsReply: true, replyHint: hint };
		const content = `Should this change be applied?\nReply with: ${hint}`;
		const component = renderSubagentMessage({ customType: SUPERVISOR_REQUEST_MESSAGE_TYPE, details, content }, { expanded: true }, identityTheme as never);
		assert.ok(component);
		const text = component.render(100).join("\n");
		assert.match(text, /worker asks for structured answers/);
		assert.match(text, /Should this change be applied/);
		assert.match(text, /request-123456/);
	});

	it("renders a progress update without a reply hint and durable reply metadata", () => {
		const progress = renderSubagentMessage({
			customType: SUPERVISOR_REQUEST_MESSAGE_TYPE, details: { reason: "progress_update", agent: "reviewer" }, content: "Progress is continuing.",
		}, { expanded: true }, identityTheme as never);
		assert.ok(progress);
		assert.doesNotMatch(progress.render(100).join("\n"), /Reply with:/);
		const reply = renderSubagentEntry({
			customType: SUPERVISOR_REPLY_ENTRY_TYPE,
			data: { requestId: "request-1", runId: "run-1", agent: "worker", childIndex: 1, childTarget: "child-worker", message: "Approved; continue.", createdAt: 123 },
		}, { expanded: true }, identityTheme as never);
		assert.ok(reply);
		const text = reply.render(100).join("\n");
		assert.match(text, /reply sent to worker/);
		assert.match(text, /request-1/);
		assert.match(text, /Approved; continue/);
		assert.match(text, /child-worker/);
	});

	it("rejects malformed metadata without rendering untrusted structured fields", () => {
		assert.equal(parseSupervisorRequestDetails({ id: "request-1", replyHint: ["bad"] }), undefined);
		assert.equal(parseSupervisorReplyData({ requestId: "request-1", runId: "run-1", agent: "worker", childIndex: 0, message: ["bad"], createdAt: 123 }), undefined);
	});

	it("bounds collapsed untrusted content to terminal width", () => {
		const component = renderSubagentMessage({
			customType: SUPERVISOR_REQUEST_MESSAGE_TYPE, details: { reason: "need_decision", agent: "worker" },
			content: `\u0001${"untrusted ".repeat(400)}`,
		}, { expanded: false }, identityTheme as never);
		assert.ok(component);
		const lines = component.render(24);
		assert.ok(lines.length <= 3);
		for (const line of lines) assert.ok(visibleWidth(line) <= 24);
		assert.doesNotMatch(lines.join("\n"), /\u0001/);
	});

	it("shows long blocking requests in expanded mode", () => {
		const content = `${Array.from({ length: 45 }, (_, index) => `decision line ${index + 1}`).join("\n")}\nEND_BODY`;
		const component = renderSubagentMessage({ customType: SUPERVISOR_REQUEST_MESSAGE_TYPE, details: { reason: "need_decision", agent: "worker" }, content }, { expanded: true }, identityTheme as never);
		assert.ok(component);
		const text = component.render(120).join("\n");
		assert.match(text, /decision line 45/);
		assert.match(text, /END_BODY/);
	});
});
