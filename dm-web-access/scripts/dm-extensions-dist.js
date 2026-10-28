#!/usr/bin/env node
// Switches dm.extensions in package.json to the entry given as argv[2].
//
// Used by the publish lifecycle so published installs load the precompiled
// bundle while development keeps jiti live-transpiling TypeScript:
//   prepublishOnly -> node scripts/dm-extensions-dist.js dist
//   postpublish    -> node scripts/dm-extensions-dist.js index.ts
//
// npm applies publishConfig only to a known field set (registry, access,
// tag, ...), so the nested dm.extensions switch is done by rewriting the
// manifest before the tarball is packed. If a publish is interrupted between
// prepublishOnly and postpublish, package.json is left pointing at ./dist;
// restore the original manifest from version control if necessary.
import { readFileSync, writeFileSync } from "node:fs";

const entry = process.argv[2];
if (!entry) {
  console.error("usage: node scripts/dm-extensions-dist.js <entry>");
  process.exit(1);
}

const manifestPath = "package.json"; // npm lifecycle scripts run at package root
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!pkg.dm || !Array.isArray(pkg.dm.extensions)) {
  console.error("package.json has no dm.extensions array");
  process.exit(1);
}

pkg.dm.extensions = [entry.startsWith("./") ? entry : `./${entry}`];
writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`dm.extensions -> ${pkg.dm.extensions[0]}`);
