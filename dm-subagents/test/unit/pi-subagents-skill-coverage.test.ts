import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readSubagentGuide } from "../../src/extension/subagent-guide.ts";
import { SubagentParams } from "../../src/extension/schemas.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

const skillDir = path.resolve(import.meta.dirname, "..", "..", "skills", "dm-subagents");
const skillFiles = ["SKILL.md", ...fs.readdirSync(path.join(skillDir, "references")).map((name) => path.join("references", name))];
const read = (file: string): string => fs.readFileSync(path.join(skillDir, file), "utf-8");

// The skill points agents at tool lookups instead of copying them, so every name it uses must exist in the tool.
describe("dm-subagents skill names resolve in the tool", () => {
	for (const file of skillFiles) {
		it(`${file} names only real guide sections, actions, links, and call fields`, () => {
			const text = read(file);
			for (const [, address] of text.matchAll(/`([a-z][a-z-]*\/[a-z0-9-]+)`/g)) {
				assert.doesNotMatch(readSubagentGuide(address!), /^Unknown (subagents guide topic|section)/, `${file}: guide section ${address}`);
			}
			for (const match of text.matchAll(/action: "([^"]+)"/g)) {
				const lineStart = text.lastIndexOf("\n", match.index) + 1;
				const prefix = text.slice(lineStart, match.index);
				const owner = /\b(subagent_supervisor|intercom)\(\{[^\n]*$/.exec(prefix)?.[1];
				const allowed = owner === "subagent_supervisor"
					? ["list", "pending", "status", "reply"] // native-supervisor-channel.ts
					: owner === "intercom"
						? ["send"] // external intercom target in the preserved skill
						: SUBAGENT_ACTIONS as readonly string[];
				assert.ok(allowed.includes(match[1]!), `${file}: ${owner ?? "subagent"} action ${match[1]}`);
			}
			for (const [, target] of text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
				assert.ok(fs.existsSync(path.resolve(skillDir, path.dirname(file), target!)), `${file}: link ${target}`);
			}
			for (const [, args] of text.matchAll(/^subagent\(\{ ([^\n]*?) \}\)/gm)) {
				// Quoted messages may contain commas or braces; only split fields
				// after masking string contents, not user-authored task text.
				let topLevel = args!.replace(/"(?:\\.|[^"\\])*"/g, '""');
				while (/\{[^{}]*\}|\[[^[\]]*\]/.test(topLevel)) topLevel = topLevel.replace(/\{[^{}]*\}|\[[^[\]]*\]/g, "");
				for (const entry of topLevel.split(",")) {
					const field = /^\s*([a-zA-Z]+)/.exec(entry)![1]!;
					assert.ok(Object.hasOwn(SubagentParams.properties, field), `${file}: subagent field ${field}`);
				}
			}
		});
	}
});
