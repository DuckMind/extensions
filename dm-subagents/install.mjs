#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const repo = "https://github.com/DuckMind/extensions.git";
const target = path.join(os.homedir(), ".dm", "agent", "extensions", "subagent");
const marker = ".dm-subagents-source";
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`dm-subagents: install or update ${target}; --remove removes an installer-managed copy`);
  process.exit(0);
}
if (args.some((arg) => !["--remove", "-r"].includes(arg))) {
  console.error("Usage: dm-subagents [--remove | --help]");
  process.exit(1);
}
if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() ||
    !fs.existsSync(path.join(target, marker)) ||
    fs.readFileSync(path.join(target, marker), "utf8").trim() !== repo)) {
  console.error(`Refusing to replace an installation not managed by this installer: ${target}`);
  process.exit(1);
}
if (args.includes("--remove") || args.includes("-r")) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  console.log("dm-subagents removed");
  process.exit(0);
}

const parent = path.dirname(target);
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, ".dm-subagents-install-"));
const checkout = path.join(scratch, "checkout");
const staged = path.join(scratch, "subagent");
const backup = path.join(scratch, "backup");
try {
  execFileSync("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", repo, checkout],
    { stdio: "inherit" });
  execFileSync("git", ["-C", checkout, "sparse-checkout", "set", "dm-subagents"],
    { stdio: "inherit" });
  const source = path.join(checkout, "dm-subagents");
  if (!fs.existsSync(path.join(source, "package.json"))) {
    throw new Error("DuckMind/extensions has not exported dm-subagents yet");
  }
  fs.cpSync(source, staged, { recursive: true });
  fs.writeFileSync(path.join(staged, marker), repo + "\n");
  const hadPrevious = fs.existsSync(target);
  if (hadPrevious) fs.renameSync(target, backup);
  try {
    fs.renameSync(staged, target);
  } catch (error) {
    if (hadPrevious) fs.renameSync(backup, target);
    throw error;
  }
  console.log(`dm-subagents ${hadPrevious ? "updated" : "installed"} at ${target}`);
} catch (error) {
  console.error(`dm-subagents install failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
