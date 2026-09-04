import { expect, mock, test } from "bun:test";

mock.module("@duckmind/dm-ai", () => ({}));
mock.module("@duckmind/dm-ai/compat", () => ({
	completeSimple: async (_model: unknown, _context: unknown, options: unknown) => ({
		content: [{ type: "text", text: "generated" }],
		options,
	}),
}));

const { completeSimple } = await import("../extensions/skills-manager/dm-ai-compat.ts");

test("completeSimple falls back to the pi-ai compat entrypoint", async () => {
	const result = await completeSimple({}, {}, { reasoning: "high" });
	expect(result.content[0]?.text).toBe("generated");
	expect(result.options).toEqual({ reasoning: "high" });
});

test("completeSimple prefers the legacy root export", async () => {
	const result = await completeSimple("model", "context", "options", {
		root: { completeSimple: async (...args: unknown[]) => args },
		loadCompat: async () => { throw new Error("compat should not load"); },
	});
	expect(result).toEqual(["model", "context", "options"]);
});