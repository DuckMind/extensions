import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The root test process starts with no inherited DM runtime env: a host DM shell (PI_PACKAGE_DIR, ...) or a
// dm-subagents child shell (DM_SUBAGENT_CHILD, ...) would otherwise change what the tests exercise.
// Kept: harness inputs that CI or a developer passes in on purpose. Nested test processes inherit the cleaned env.
const harnessInput = /^DM_SUBAGENTS_(TEMP_ROOT|TERMINAL_EVIDENCE_DIR|NATIVE_PI_ROOT|NATIVE_SDK|\w+_SMOKE(_\w+)?)$/;
if (process.env.DM_SUBAGENTS_TEST_LOADER === undefined) {
	for (const name of Object.keys(process.env)) if (name.startsWith("PI_") && !harnessInput.test(name)) delete process.env[name];
}

const configuredTempRoot = process.env.DM_SUBAGENTS_TEMP_ROOT?.trim();
const tempRoot = configuredTempRoot
	? path.resolve(configuredTempRoot)
	// Short on purpose: under macOS's /var/folders/<hash>/T/, a longer name pushes nested Unix socket
	// paths past the 104-byte limit. Shared /tmp is no alternative; its stray package.json and .dm leak into ancestor walks.
	: fs.mkdtempSync(path.join(os.tmpdir(), "pst-"));
fs.mkdirSync(tempRoot, { recursive: true });
if (process.platform === "darwin") fs.closeSync(fs.openSync(path.join(tempRoot, ".metadata_never_index"), "a"));
process.env.DM_SUBAGENTS_TEMP_ROOT = tempRoot;
process.env.TMPDIR = tempRoot;
process.env.TMP = tempRoot;
process.env.TEMP = tempRoot;

const loaderState = process.env.DM_SUBAGENTS_TEST_LOADER;
const nestedTestProcess = loaderState !== undefined;
const testFileProcess = process.env.NODE_TEST_CONTEXT !== undefined && loaderState !== "test-file";
if (!nestedTestProcess || testFileProcess) process.env.DM_SUBAGENTS_TEST_PARENT_PID = String(process.pid);
const isolatedHome = path.join(tempRoot, "home");
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
if (!nestedTestProcess) delete process.env.DM_CODING_AGENT_DIR;
process.env.DM_SUBAGENTS_TEST_LOADER = testFileProcess ? "test-file" : "loaded";

if (!configuredTempRoot) {
	// Housekeeping for a root no other process shares: a Windows handle or a leftover
	// descendant must not turn a test file whose tests all passed into a failed file.
	process.on("exit", () => {
		try {
			fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch (error) {
			try {
				fs.writeSync(2, `warning: test temp root not removed: ${tempRoot} (${error?.code ?? error})\n`);
			} catch {}
		}
	});
}
