import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";

describe("DM host extension loading", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dm-mcp-host-loading-")));
    vi.stubEnv("HOME", root);
    vi.stubEnv("DM_PACKAGE_DIR", "");
    vi.stubEnv("DM_CODING_AGENT_DIR", join(root, "agent"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(options: { additionalExtensionPaths?: string[]; config?: boolean }) {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const { DefaultResourceLoader, SettingsManager } = await import("@duckmind/dm-coding-agent");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      bundledPackageRoots: [],
      noExtensions: true,
      additionalExtensionPaths: options.additionalExtensionPaths ?? [],
      extensionFactories: options.config ? [createMcpAdapter({ config: { mcpServers: {} } })] : [],
    });
    await loader.reload();
    return loader.getExtensions();
  }

  it("registers /mcp on the current DM host without a built-in MCP extension", async () => {
    const adapterPath = join(process.cwd(), "index.ts");
    const { extensions, errors } = await load({ additionalExtensionPaths: [adapterPath] });

    expect(errors).toEqual([]);
    expect(extensions.map((extension) => extension.path)).not.toContain("builtin:mcp");
    expect(extensions.find((extension) => extension.path === adapterPath)?.commands.has("mcp")).toBe(true);
  }, 20_000);

  it("keeps /mcp available when the host supplies an in-memory config", async () => {
    const { extensions, errors } = await load({ config: true });

    expect(errors).toEqual([]);
    const adapter = extensions.find((extension) => extension.path === "<inline:1>");
    expect(adapter?.commands.has("mcp-adapter")).toBe(true);
    expect(adapter?.commands.has("mcp")).toBe(true);
  }, 20_000);
});
