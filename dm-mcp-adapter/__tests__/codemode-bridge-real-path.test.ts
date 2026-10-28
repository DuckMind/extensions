import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@duckmind/dm-coding-agent";
import { createTestToolContext, registerTestSession } from "./dm-test-tool-context.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

// Real DM session, registered tools, nested-call pipeline, and stdio MCP transport.
// Also loads a probe extension whose `bridge_probe` tool runs its script through codemode-bridge.ts.
async function withPiSession(
  options: { codemode?: boolean; extend?: (pi: ExtensionAPI) => void },
  run: (pi: { session: Session; toolCalls: Array<{ name: string; id: string; parent: string | undefined }> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-codemode-bridge-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalArgv = [...process.argv];
  let session: Session | undefined;
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = join(agentDir, "mcp-adapter.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/structured-echo-server.mjs")] },
      },
      settings: { sampling: false, elicitation: false },
    }));
    process.argv.push("--mcp-config", configPath);
    const errors: string[] = [];
    const toolCalls: Array<{ name: string; id: string; parent: string | undefined }> = [];
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      additionalExtensionPaths: [resolve("index.ts"), resolve("__tests__/fixtures/codemode-bridge-extension.ts")],
      extensionFactories: [
        ...(options.codemode ? [createCodemodeExtension()] : []),
        (pi) => {
          pi.on("tool_call", (event) => {
            toolCalls.push({ name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId });
          });
          options.extend?.(pi);
        },
      ],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
    await session.extensionRunner.emit({ type: "agent_start" });
    // DM runs a nested call on behalf of the assistant message that issued the calling tool.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    registerTestSession(session);
    await run({ session, toolCalls });
    expect(errors).toEqual([]);
  } finally {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session?.dispose();
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(block => block.type === "text" ? block.text ?? "" : "").join("");
}

async function waitForEcho(session: Session): Promise<void> {
  await vi.waitFor(() => expect(createTestToolContext(session.extensionRunner, "probe").tools.map(tool => tool.name))
    .toContain("mcp__fixture__echo"), { timeout: 10_000 });
}

async function runProbe(session: Session, toolCallId: string, params: { source: string; input: Record<string, unknown> }) {
  const runner = session.extensionRunner;
  const probe = runner.getAllRegisteredTools().find(tool => tool.definition.name === "bridge_probe")!.definition;
  return probe.execute(toolCallId, params, undefined, undefined, createTestToolContext(runner, toolCallId)) as Promise<any>;
}

// Needs the suite's environment (`env -u MCP_DIRECT_TOOLS`): with MCP_DIRECT_TOOLS=__none__ the kill switch would register no mcp__<ns>__<tool>.
describe("reaching DM codemode from an extension tool", () => {
  // Case 1 is why the bridge exists; case 2 is the mechanism the bridge is built on.
  it("cannot call codemode through ctx.executeTool, but can run its captured definition", async () => {
    await withPiSession({ codemode: true }, async ({ session, toolCalls }) => {
      // Its own caller id: the refused call still takes nested id `<caller>/1`.
      const ctx = createTestToolContext(session.extensionRunner, "st-0");

      // Case 1: the negative control.
      expect(ctx.tools.map(tool => tool.name)).not.toContain("codemode");
      await expect(ctx.executeTool("codemode", { code: "return 1" }))
        .rejects.toThrow("Tool codemode not found");

      // Case 2: the mechanism.
      const { createCodemodeExtension: factory } = await import("@duckmind/dm-coding-agent");
      let captured: any;
      const shim = {
        registerTool: (tool: any) => { captured = tool; },
        getSettings: () => (session as any).getSettings?.() ?? {},
        getAllTools: () => session.getAllTools(),
        appendEntry: () => {},
      };
      factory({ models: false })(shim as any);
      await waitForEcho(session);

      const result = await captured.execute(
        "st-1",
        { code: 'const input = JSON.parse("{\\"value\\":\\"hi\\"}");\nreturn await tools.mcp__fixture__echo(input);' },
        undefined,
        undefined,
        createTestToolContext(session.extensionRunner, "st-1"),
      );

      expect(captured).toBeDefined();
      expect(typeof captured.execute).toBe("function");
      expect(textOf(result)).toContain("Script completed");
      expect(toolCalls).toContainEqual({ name: "mcp__fixture__echo", id: "st-1/1", parent: "st-1" });
      expect(result.details.calls).toHaveLength(1);
      expect(result.details.calls[0]).toMatchObject({ name: "mcp__fixture__echo", status: "ok" });
    });
  }, 20_000);
});

// The session does not load DM's codemode extension: the bridge needs only the package export.
describe("runCodemodeScript in a real session", () => {
  it("runs the script as nested calls of the calling tool and returns codemode's result", async () => {
    await withPiSession({}, async ({ session, toolCalls }) => {
      await waitForEcho(session);

      const result = await runProbe(session, "st-2", {
        source: "return (await tools.mcp__fixture__echo({ value: input.repo })).structuredContent.value;",
        input: { repo: "a/b" },
      });

      expect(textOf(result)).toContain("Script completed");
      expect(textOf(result)).toContain("a/b");
      expect(toolCalls).toEqual([{ name: "mcp__fixture__echo", id: "st-2/1", parent: "st-2" }]);
      expect(result.details.calls).toHaveLength(1);
      expect(result.details.calls[0]).toMatchObject({ id: "st-2/1", name: "mcp__fixture__echo", status: "ok" });
    });
  }, 20_000);

  it("gives the script its arguments unchanged, with or without an options line", async () => {
    const input = {
      quote: 'say "hi"',
      newline: "line one\nline two",
      loneSurrogate: "x\ud800y",
      nested: { list: [1, "two", { three: [true, null] }], empty: {} },
      separators: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`,
    };
    const sent: unknown[] = [];
    const extend = (pi: ExtensionAPI) => pi.on("tool_call", (event) => { sent.push(event.input); });
    await withPiSession({ extend }, async ({ session, toolCalls }) => {
      await waitForEcho(session);
      const body = "await tools.mcp__fixture__echo({ value: JSON.stringify(input) });\nreturn input.loneSurrogate.length;";

      const plain = await runProbe(session, "st-3", { source: body, input });
      const withOptions = await runProbe(session, "st-4", { source: `// @options: {"timeout_ms": 30000}\n${body}`, input });

      for (const result of [plain, withOptions]) {
        expect(textOf(result)).toContain("Script completed");
        expect(textOf(result)).toContain("3");
      }
      expect(toolCalls).toEqual([
        { name: "mcp__fixture__echo", id: "st-3/1", parent: "st-3" },
        { name: "mcp__fixture__echo", id: "st-4/1", parent: "st-4" },
      ]);
      // What the script saw as `input`, serialized inside the sandbox.
      expect(sent).toEqual([{ value: JSON.stringify(input) }, { value: JSON.stringify(input) }]);
      expect(JSON.parse((sent[0] as { value: string }).value)).toEqual(input);
    });
  }, 20_000);

  // Tiny timeouts have a bounded startup floor; they must not fail a valid script before WASM is ready.
  it("accepts a leading options line with a tiny timeout", async () => {
    await withPiSession({}, async ({ session }) => {
      await waitForEcho(session);

      const result = await runProbe(session, "st-5", {
        source: '// @options: {"timeout_ms": 1}\nreturn (await tools.mcp__fixture__echo({ value: input.repo })).structuredContent.value;',
        input: { repo: "a/b" },
      });

      expect(textOf(result)).toContain('Script completed:\n"a/b"');
    });
  }, 20_000);

  it("enforces the timeout floor on an infinite script", async () => {
    await withPiSession({}, async ({ session }) => {
      const result = await runProbe(session, "st-timeout", {
        source: '// @options: {"timeout_ms": 1}\nfor (;;) {}',
        input: {},
      });
      expect(textOf(result)).toContain("Codemode timed out");
      expect(result.details.error).toBe("codemode_failed");
    });
  }, 20_000);
});
