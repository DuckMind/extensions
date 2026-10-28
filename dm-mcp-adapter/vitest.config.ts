import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const testHome = mkdtempSync(join(tmpdir(), "dm-mcp-test-home-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      // Never write test session state into the developer's real DM agent dir.
      HOME: testHome,
      DM_CODING_AGENT_DIR: "",
      PI_CODING_AGENT_DIR: "",
      DM_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
      // Cache tests opt in explicitly to keep existing tests platform-neutral.
      DM_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1",
    },
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["*.ts"],
      exclude: ["__tests__/**", "vitest.config.ts", "cli.js"],
    },
  },
});
