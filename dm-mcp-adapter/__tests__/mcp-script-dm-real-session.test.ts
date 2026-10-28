import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@duckmind/dm-coding-agent";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

describe("QuickJS mcpScript in a real DM session", () => {
  it.each(["allow_once", "deny"] as const)("routes %s through MCP approval, retaining a bounded worker", async decision => {
    const root = await mkdtemp(join(tmpdir(), "dm-quickjs-real-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    const argv = [...process.argv];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const configPath = join(agentDir, "mcp-adapter.json");
      await writeFile(configPath, JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/mcp-code-server.mjs")], lifecycle: "eager" } },
        settings: { scriptMode: true, approveTools: true, sampling: false, elicitation: false },
      }));
      process.argv.push("--mcp-config", configPath);
      const approvals: McpToolApprovalRequest[] = [];
      const errors: string[] = [];
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
        extensionFactories: [pi => {
          pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, request => {
            approvals.push(request);
            request.claim(() => decision);
          });
        }],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd, agentDir, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
      }));
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
      await session.extensionRunner.emit({ type: "agent_start" });
      const runner = session.extensionRunner;
      await vi.waitFor(() => expect(runner.getAllRegisteredTools().map(tool => tool.definition.name)).toContain("mcpScript"), { timeout: 10_000 });
      await vi.waitFor(() => expect(runner.getAllRegisteredTools().map(tool => tool.definition.name)).toContain("mcp__fixture"), { timeout: 10_000 });
      const tool = runner.getAllRegisteredTools().find(tool => tool.definition.name === "mcpScript")!.definition;
      const result = await tool.execute("script-real", {
        code: 'return (await tools.call("fixture_echo", {value:"hello"}));',
        timeoutMs: 5000,
      }, undefined, undefined, runner.createContext());
      expect(result.details.mode).toBe("script");
      expect(result.details.calls).toEqual(expect.arrayContaining([expect.objectContaining({ operation: "call", ok: decision === "allow_once" })]));
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ serverName: "fixture", originalToolName: "echo", origin: "script" });
      expect(errors).toEqual([]);
    } finally {
      try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" }); }
      finally {
        session?.dispose();
        process.argv.splice(0, process.argv.length, ...argv);
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 25_000);
});
