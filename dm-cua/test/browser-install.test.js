import test from "node:test";
import assert from "node:assert/strict";

import {
	ensureChromeAvailable,
	isChromeAutoInstallEnabled,
	resolveChromeExecutable,
	resolveChromeInstallCandidates,
	runInstallCommand,
} from "../src/browser-install.mjs";

test("resolveChromeExecutable finds Windows user-local Chrome", () => {
	const expected = String.raw`C:\Users\Tester\AppData\Local\Google\Chrome\Application\chrome.exe`;
	const resolved = resolveChromeExecutable({
		platformName: "win32",
		homeDir: String.raw`C:\Users\Tester`,
		env: {
			LOCALAPPDATA: String.raw`C:\Users\Tester\AppData\Local`,
			ProgramFiles: String.raw`C:\Program Files`,
			"ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
		},
		exists: (candidate) => candidate === expected,
	});
	assert.equal(resolved, expected);
});

test("resolveChromeExecutable searches PATH for Linux Chromium", () => {
	const resolved = resolveChromeExecutable({
		platformName: "linux",
		env: { PATH: "/custom/bin:/usr/local/bin" },
		exists: (candidate) => candidate === "/custom/bin/chromium",
	});
	assert.equal(resolved, "/custom/bin/chromium");
});

test("installer plans are non-interactive on macOS and Windows", () => {
	const mac = resolveChromeInstallCandidates({ platformName: "darwin" });
	assert.deepEqual(mac[0], {
		id: "homebrew-google-chrome",
		commands: [
			{
				command: "brew",
				args: ["install", "--cask", "google-chrome"],
			},
		],
	});

	const windows = resolveChromeInstallCandidates({ platformName: "win32" });
	assert.equal(windows[0].id, "winget-user-google-chrome");
	assert.deepEqual(windows[0].commands[0], {
		command: "winget",
		args: [
			"install",
			"--id",
			"Google.Chrome",
			"-e",
			"--scope",
			"user",
			"--silent",
			"--accept-package-agreements",
			"--accept-source-agreements",
			"--disable-interactivity",
		],
	});
	assert.equal(windows[1].id, "winget-machine-google-chrome");
	assert.deepEqual(windows[2], {
		id: "chocolatey-google-chrome",
		commands: [
			{
				command: "choco",
				args: ["install", "googlechrome", "-y", "--no-progress"],
			},
		],
	});
});

test("Linux installer plans use root or passwordless sudo", () => {
	const root = resolveChromeInstallCandidates({
		platformName: "linux",
		uid: 0,
	});
	assert.deepEqual(root[0].commands[0], {
		command: "apt-get",
		args: ["update"],
	});
	assert.deepEqual(root[0].commands[1], {
		command: "apt-get",
		args: ["install", "-y", "chromium"],
	});

	const user = resolveChromeInstallCandidates({
		platformName: "linux",
		uid: 1000,
	});
	assert.deepEqual(user[0].commands[0], {
		command: "sudo",
		args: ["-n", "apt-get", "update"],
	});
	assert.equal(user[1].id, "apt-chromium-browser");
	assert.deepEqual(user[4].commands[0], {
		command: "sudo",
		args: ["-n", "pacman", "-S", "--noconfirm", "--needed", "chromium"],
	});
});

test("ensureChromeAvailable falls back after a failed installer", async () => {
	let installed = false;
	const calls = [];
	const result = await ensureChromeAvailable({
		platformName: "win32",
		env: {},
		findExecutable: () =>
			installed
				? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`
				: undefined,
		runCommand: async (command, args) => {
			calls.push([command, args]);
			if (args.includes("--scope")) {
				return {
					status: "failed",
					exitCode: 1,
					message: "user scope unsupported",
				};
			}
			installed = true;
			return { status: "ok", exitCode: 0, message: "" };
		},
		sleep: async () => {},
	});

	assert.equal(result.status, "installed");
	assert.equal(result.method, "winget-machine-google-chrome");
	assert.match(result.path, /Google\\Chrome\\Application\\chrome\.exe$/);
	assert.equal(calls.length, 2);
	assert.equal(result.attempts[0].status, "failed");
	assert.equal(result.attempts[1].status, "installed");
});

test("ensureChromeAvailable retries when installer exits zero before path appears", async () => {
	let attempt = 0;
	const result = await ensureChromeAvailable({
		platformName: "darwin",
		env: {},
		findExecutable: () => {
			attempt += 1;
			return attempt >= 4
				? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
				: undefined;
		},
		runCommand: async () => ({ status: "ok", exitCode: 0, message: "" }),
		sleep: async () => {},
	});
	assert.equal(result.status, "installed");
	assert.equal(result.method, "homebrew-google-chrome");
});

test("explicit opt-out prevents installer side effects", async () => {
	let called = false;
	assert.equal(isChromeAutoInstallEnabled({ DM_CUA_AUTO_INSTALL: "0" }), false);
	await assert.rejects(
		ensureChromeAvailable({
			platformName: "linux",
			env: { DM_CUA_AUTO_INSTALL: "false" },
			findExecutable: () => undefined,
			runCommand: async () => {
				called = true;
				return { status: "ok", exitCode: 0, message: "" };
			},
		}),
		/automatic installation is disabled/i,
	);
	assert.equal(called, false);
});

test("installer success without a browser path fails with attempt evidence", async () => {
	await assert.rejects(
		ensureChromeAvailable({
			platformName: "darwin",
			env: {},
			findExecutable: () => undefined,
			runCommand: async () => ({ status: "ok", exitCode: 0, message: "" }),
			sleep: async () => {},
		}),
		/Homebrew reported success, but Chrome was not found/i,
	);
});

test("unsupported operating systems fail without running a command", async () => {
	let called = false;
	await assert.rejects(
		ensureChromeAvailable({
			platformName: "freebsd",
			env: {},
			findExecutable: () => undefined,
			runCommand: async () => {
				called = true;
				return { status: "ok", exitCode: 0, message: "" };
			},
		}),
		/no automatic Chrome installer is defined for freebsd/i,
	);
	assert.equal(called, false);
});

test("runInstallCommand terminates a stalled installer at the configured timeout", async () => {
	const result = await runInstallCommand(
		process.execPath,
		["-e", "setTimeout(() => {}, 1000)"],
		{ timeoutMs: 20 },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.exitCode, null);
	assert.match(result.message, /timed out after 20ms/);
});
