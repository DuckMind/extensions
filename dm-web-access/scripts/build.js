#!/usr/bin/env node
// Standalone MCP bundles typebox; DM host packages stay external for extension loading.
import { chmodSync, readFileSync } from "node:fs";
import { buildSync } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const externals = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
const options = { bundle: true, format: "esm", platform: "node", target: "node20", outdir: "dist", outbase: "." };
buildSync({ ...options, entryPoints: ["index.ts"], external: externals });
buildSync({ ...options, entryPoints: ["mcp-cli.ts"], external: externals.filter(name => name !== "typebox") });
chmodSync("dist/mcp-cli.js", 0o755);
