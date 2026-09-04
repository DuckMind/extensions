import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
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
