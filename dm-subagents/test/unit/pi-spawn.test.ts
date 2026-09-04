import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	getPiSpawnCommand,
	resolvePiCliScript,
	type PiSpawnDeps,
} from "../../src/runs/shared/dm-spawn.ts";

function makeDeps(input: {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existing?: string[];
	packageJsonPath?: string;
	packageJsonContent?: string;
	packageEntry?: string;
	env?: NodeJS.ProcessEnv;
}): PiSpawnDeps {
	const existing = new Set(input.existing ?? []);
	const packageJsonPath = input.packageJsonPath;
	const packageJsonContent = input.packageJsonContent;
	return {
		platform: input.platform,
		execPath: input.execPath,
		argv1: input.argv1,
		existsSync: (filePath) => existing.has(filePath),
		readFileSync: (_filePath, _encoding) => {
			if (!packageJsonPath || !packageJsonContent) {
				throw new Error("package json not configured");
			}
			return packageJsonContent;
		},
		resolvePackageJson: packageJsonPath ? () => packageJsonPath : undefined,
		resolvePackageEntry: input.packageEntry
			? () => input.packageEntry!
			: undefined,
		env: input.env ?? {},
	};
}

describe("getPiSpawnCommand", () => {
	it("honors explicit DM_SUBAGENT_PI_BINARY override on any platform", () => {
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, {
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1: "/tmp/dm-entry.mjs",
			env: {
				DM_SUBAGENT_PI_BINARY: "/nix/store/dm-wrapper/bin/nhost-code-agent",
			},
			existsSync: () => true,
		});
		assert.deepEqual(result, {
			command: "/nix/store/dm-wrapper/bin/nhost-code-agent",
			args,
		});
	});

	it("ignores a blank DM_SUBAGENT_PI_BINARY override", () => {
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, {
			platform: "darwin",
			argv1: "/missing/host.js",
			existsSync: () => false,
			resolvePackageJson: () => {
				throw new Error("DM package unavailable");
			},
			env: { DM_SUBAGENT_PI_BINARY: "   " },
		});
		assert.deepEqual(result, { command: "dm", args });
	});

	for (const [platform, execPath] of [
		["darwin", "/opt/dm/dm"],
		["linux", "/opt/dm/dm"],
		["win32", "C:\\Program Files\\DM\\dm.exe"],
	] as const) {
		it(`uses the standalone DM executable directly on ${platform}`, () => {
			const packageJsonPath = "/opt/dm-package/package.json";
			const cliPath = path.resolve(
				path.dirname(packageJsonPath),
				"dist/cli.js",
			);
			const deps = makeDeps({
				platform,
				execPath,
				argv1: "/missing/host.js",
				packageJsonPath,
				packageJsonContent: JSON.stringify({ bin: { dm: "dist/cli.js" } }),
				existing: [packageJsonPath, cliPath],
			});
			const args = ["--mode", "json", "-p", "Task: review diff"];
			assert.deepEqual(getPiSpawnCommand(args, deps), {
				command: execPath,
				args,
			});
		});
	}

	for (const platform of ["darwin", "linux", "win32"] as const) {
		it(`uses node + argv1 on ${platform} when argv1 belongs to the DM package`, () => {
			const tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "dm-spawn-argv-entry-"),
			);
			try {
				const argv1 = path.join(tempDir, "dist", "cli.js");
				fs.mkdirSync(path.dirname(argv1), { recursive: true });
				fs.writeFileSync(argv1, "#!/usr/bin/env node\n");
				fs.writeFileSync(
					path.join(tempDir, "package.json"),
					JSON.stringify({ name: "@duckmind/dm-coding-agent" }),
				);
				const args = ["--mode", "json", 'Task: review "quotes" & pipes | too'];
				const result = getPiSpawnCommand(args, {
					platform,
					execPath: "/usr/local/bin/node",
					argv1,
					env: {},
				});
				assert.deepEqual(result, {
					command: "/usr/local/bin/node",
					args: [fs.realpathSync(argv1), ...args],
				});
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	}

	it("uses node + package bin on POSIX when argv1 is not a verified DM entry", () => {
		const packageJsonPath = "/opt/dm/package.json";
		const cliPath = path.resolve(
			path.dirname(packageJsonPath),
			"dist/cli/index.js",
		);
		const deps = makeDeps({
			platform: "darwin",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/dm/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { dm: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, {
			command: "/usr/local/bin/node",
			args: [cliPath, ...args],
		});
	});

	it("falls back to plain dm command on POSIX when CLI script cannot be resolved", () => {
		const args = ["--mode", "json", "Task: check output"];
		const result = getPiSpawnCommand(args, {
			platform: "darwin",
			argv1: "/missing/host.js",
			existsSync: () => false,
			resolvePackageJson: () => {
				throw new Error("DM package unavailable");
			},
			env: {},
		});
		assert.deepEqual(result, { command: "dm", args });
	});

	it("ignores embedded host entry points and resolves the DM package bin on every platform", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "dm-spawn-embedded-host-"),
		);
		try {
			const hostRoot = path.join(tempDir, "dm-web");
			const hostEntry = path.join(hostRoot, "dist", "server.js");
			const hostPackageJson = path.join(hostRoot, "package.json");
			const piRoot = path.join(
				tempDir,
				"node_modules",
				"@earendil-works",
				"dm-coding-agent",
			);
			const piCli = path.join(piRoot, "dist", "cli.js");
			fs.mkdirSync(path.dirname(hostEntry), { recursive: true });
			fs.mkdirSync(path.dirname(piCli), { recursive: true });
			fs.writeFileSync(hostEntry, "export {};\n");
			fs.writeFileSync(
				hostPackageJson,
				JSON.stringify({ name: "@jmfederico/dm-web" }),
			);
			fs.writeFileSync(piCli, "#!/usr/bin/env node\n");
			fs.writeFileSync(
				path.join(piRoot, "package.json"),
				JSON.stringify({
					name: "@duckmind/dm-coding-agent",
					bin: { dm: "dist/cli.js" },
				}),
			);

			for (const platform of ["darwin", "linux", "win32"] as const) {
				const result = getPiSpawnCommand(["-p", "Task: hello"], {
					platform,
					execPath: "/usr/local/bin/node",
					argv1: hostEntry,
					resolvePackageJson: () => path.join(piRoot, "package.json"),
					env: {},
				});
				assert.deepEqual(result, {
					command: "/usr/local/bin/node",
					args: [piCli, "-p", "Task: hello"],
				});
			}

			fs.writeFileSync(hostPackageJson, "{");
			for (const platform of ["darwin", "linux", "win32"] as const) {
				const malformedHostResult = getPiSpawnCommand(["-p", "Task: hello"], {
					platform,
					execPath: "/usr/local/bin/node",
					argv1: hostEntry,
					resolvePackageJson: () => path.join(piRoot, "package.json"),
					env: {},
				});
				assert.deepEqual(malformedHostResult, {
					command: "/usr/local/bin/node",
					args: [piCli, "-p", "Task: hello"],
				});
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("validates argv1 ownership against its canonical target", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "dm-spawn-canonical-entry-"),
		);
		try {
			const hostRoot = path.join(tempDir, "embedded-host");
			const hostEntry = path.join(hostRoot, "dist", "server.js");
			const piRoot = path.join(tempDir, "node_modules", "@earendil-works", "dm-coding-agent");
			const disguisedEntry = path.join(piRoot, "dist", "cli.js");
			const piCli = path.join(piRoot, "dist", "real-cli.js");
			fs.mkdirSync(path.dirname(hostEntry), { recursive: true });
			fs.mkdirSync(path.dirname(piCli), { recursive: true });
			fs.writeFileSync(hostEntry, "export {};\n");
			fs.writeFileSync(path.join(hostRoot, "package.json"), JSON.stringify({ name: "embedded-host" }));
			fs.writeFileSync(piCli, "#!/usr/bin/env node\n");
			fs.writeFileSync(path.join(piRoot, "package.json"), JSON.stringify({
				name: "@duckmind/dm-coding-agent",
				bin: { dm: "dist/real-cli.js" },
			}));

			const result = getPiSpawnCommand(["-p", "Task: hello"], {
				execPath: "/usr/local/bin/node",
				argv1: disguisedEntry,
				existsSync: (filePath) => filePath === disguisedEntry || fs.existsSync(filePath),
				realpathSync: (filePath) => filePath === disguisedEntry ? hostEntry : fs.realpathSync(filePath),
				resolvePackageJson: () => path.join(piRoot, "package.json"),
				env: {},
			});
			assert.deepEqual(result, {
				command: "/usr/local/bin/node",
				args: [piCli, "-p", "Task: hello"],
			});
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves CLI script from package bin when argv1 is not runnable JS", () => {
		const packageJsonPath = "/opt/dm/package.json";
		// Compute expected path the same way the production code does:
		// path.resolve(path.dirname(packageJsonPath), binPath) — which on Windows
		// prepends the current drive letter to POSIX absolute paths.
		const cliPath = path.resolve(
			path.dirname(packageJsonPath),
			"dist/cli/index.js",
		);
		const deps = makeDeps({
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/dm/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { dm: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		const result = getPiSpawnCommand(["-p", "Task: hello"], deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], cliPath);
	});

	it("falls back to dm when Windows CLI script cannot be resolved", () => {
		const deps = makeDeps({
			platform: "win32",
			argv1: "/opt/dm/subagent-runner.ts",
			existing: [],
		});
		const args = ["-p", "Task: hello"];
		const result = getPiSpawnCommand(args, deps);
		assert.deepEqual(result, { command: "dm", args });
	});

	it("walks from package main entry to resolve package bin", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "dm-spawn-package-root-"),
		);
		try {
			const packageRoot = path.join(
				tempDir,
				"node_modules",
				"@earendil-works",
				"dm-coding-agent",
			);
			const entry = path.join(packageRoot, "dist", "index.js");
			const cliPath = path.join(packageRoot, "dist", "cli", "index.js");
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.mkdirSync(path.dirname(cliPath), { recursive: true });
			fs.writeFileSync(entry, "export {};\n");
			fs.writeFileSync(cliPath, "#!/usr/bin/env node\n");
			fs.writeFileSync(
				path.join(packageRoot, "package.json"),
				JSON.stringify({
					name: "@duckmind/dm-coding-agent",
					bin: { dm: "dist/cli/index.js" },
				}),
			);
			const result = getPiSpawnCommand(["-p", "Task: hello"], {
				platform: "win32",
				execPath: "/usr/local/bin/node",
				argv1: "/opt/dm/subagent-runner.ts",
				resolvePackageEntry: () => entry,
				env: {},
			});
			assert.equal(result.command, "/usr/local/bin/node");
			assert.equal(result.args[0], cliPath);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("getPiSpawnCommand with piPackageRoot", () => {
	it("resolves CLI script via piPackageRoot when argv1 is not runnable", () => {
		const packageJsonPath = "/opt/dm/package.json";
		const cliPath = path.resolve(
			path.dirname(packageJsonPath),
			"dist/cli/index.js",
		);
		const deps = makeDeps({
			platform: "win32",
			execPath: "/usr/local/bin/node",
			argv1: "/opt/dm/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: { dm: "dist/cli/index.js" } }),
			existing: [packageJsonPath, cliPath],
		});
		deps.piPackageRoot = "/opt/dm";
		const result = getPiSpawnCommand(["-p", "Task: hello"], deps);
		assert.equal(result.command, "/usr/local/bin/node");
		assert.equal(result.args[0], cliPath);
	});
});

describe("resolvePiCliScript", () => {
	it("supports package bin as string", () => {
		const packageJsonPath = "/opt/dm/package.json";
		const cliPath = path.resolve(
			path.dirname(packageJsonPath),
			"dist/cli/index.mjs",
		);
		const deps = makeDeps({
			platform: "win32",
			argv1: "/opt/dm/subagent-runner.ts",
			packageJsonPath,
			packageJsonContent: JSON.stringify({ bin: "dist/cli/index.mjs" }),
			existing: [packageJsonPath, cliPath],
		});
		assert.equal(resolvePiCliScript(deps), cliPath);
	});
});
