import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dmHost from "@duckmind/dm-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@duckmind/dm-coding-agent";
import { describe, expect, it } from "vitest";
import { runScriptTool } from "../script-tool-surface.ts";

describe("script tools against the installed DM SDK", () => {
  it("fails closed when the adapter cannot capture a codemode tool from its host context", async () => {
    expect(Reflect.get(dmHost, "createCodemodeExtension")).toEqual(expect.any(Function));
    const root = await mkdtemp(join(tmpdir(), "dm-mcp-codemode-host-"));
    try {
      const file = join(root, "script.js");
      await writeFile(file, 'throw new Error("script was executed without a sandbox");');
      const result = await runScriptTool({
        pi: {} as ExtensionAPI,
        ctx: { cwd: root } as ExtensionContext,
        toolCallId: "host-script-probe",
        signal: undefined,
        onUpdate: undefined,
        spec: { name: "probe", toolName: "mcp__script__probe", definition: { file, description: "Probe" } },
        input: {},
        settings: undefined,
      });
      expect(result.details).toEqual({ mode: "script_tool", tool: "probe", error: "codemode_unavailable" });
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("does not expose a codemode sandbox"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
