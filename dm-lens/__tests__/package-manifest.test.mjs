import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("DM Lens package identity and entry contract", () => {
  assert.equal(manifest.name, "dm-lens");
  assert.deepEqual(manifest.dm.extensions, ["./index.ts"]);
  assert.equal(manifest.peerDependencies["@duckmind/dm-coding-agent"], "*");
  assert.equal(manifest.peerDependencies["@duckmind/dm-tui"], "*");
  assert.ok(!JSON.stringify(manifest).includes(["@earendil-works", "pi-"].join("/")));
});
