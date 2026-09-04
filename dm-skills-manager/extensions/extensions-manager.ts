/**
 * Interactive installer for the reviewed DuckMind extension bundle.
 *
 * The remote is deliberately fixed. An explicit user action is required before
 * Git is invoked, and all writes stay beneath DM's standard extension roots.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@duckmind/dm-coding-agent";

const execFileAsync = promisify(execFile);

export const DUCKMIND_EXTENSIONS_REMOTE = "https://github.com/DuckMind/extensions.git";
const REMOTE_BRANCH = "main";
const REGISTRY_FILE = ".duckmind-installed-extensions.json";
const SKIPPED_COPY_ENTRIES = new Set([".git", ".m", "node_modules"]);

type ExtensionScope = "global" | "project";

export type ManagedExtension = {
	id: string;
	scope: ExtensionScope;
	path: string;
	source: "local" | "duckmind";
	revision?: string;
};

type InstallRegistry = {
	version: 1;
	extensions: Record<string, { source: "local" | "duckmind"; revision?: string }>;
};

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 220 ? `${message.slice(0, 219)}…` : message;
}

export function validateExtensionId(value: string): string {
	if (!/^dm-[a-z0-9][a-z0-9-]*$/.test(value)) {
		throw new Error(`Invalid DM extension id: ${value}`);
	}
	return value;
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function extensionRootFor(scope: ExtensionScope, cwd: string, agentDir = getAgentDir()): string {
	return scope === "project" ? join(resolve(cwd), CONFIG_DIR_NAME, "extensions") : join(resolve(agentDir), "extensions");
}

function registryPath(extensionRoot: string): string {
	return join(extensionRoot, REGISTRY_FILE);
}

async function readRegistry(extensionRoot: string): Promise<InstallRegistry> {
	try {
		const value: unknown = JSON.parse(await fs.readFile(registryPath(extensionRoot), "utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			(value as { version?: unknown }).version === 1 &&
			typeof (value as { extensions?: unknown }).extensions === "object" &&
			(value as { extensions?: unknown }).extensions !== null
		) {
			return value as InstallRegistry;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Could not read extension registry: ${errorMessage(error)}`);
		}
	}
	return { version: 1, extensions: {} };
}

async function writeRegistry(extensionRoot: string, registry: InstallRegistry): Promise<void> {
	const staging = `${registryPath(extensionRoot)}.${randomUUID()}.tmp`;
	await fs.writeFile(staging, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.rename(staging, registryPath(extensionRoot));
}

async function readPackageManifest(packageDir: string): Promise<{ name: string; extensions: string[] }> {
	let manifest: unknown;
	try {
		manifest = JSON.parse(await fs.readFile(join(packageDir, "package.json"), "utf8"));
	} catch (error) {
		throw new Error(`Could not read package.json: ${errorMessage(error)}`);
	}
	const candidate = manifest as { name?: unknown; dm?: { extensions?: unknown } };
	if (typeof candidate.name !== "string") throw new Error("package.json must declare a string name.");
	const extensions = candidate.dm?.extensions;
	if (!Array.isArray(extensions) || extensions.length === 0 || !extensions.every((entry) => typeof entry === "string")) {
		throw new Error("package.json must declare a non-empty dm.extensions array.");
	}
	for (const entry of extensions) {
		const target = resolve(packageDir, entry);
		if (!isWithin(packageDir, target)) throw new Error(`Extension entry escapes its package: ${entry}`);
		const stat = await fs.lstat(target).catch(() => undefined);
		if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Extension entry is missing or unsafe: ${entry}`);
	}
	return { name: candidate.name, extensions };
}

async function copyDirectory(source: string, destination: string): Promise<void> {
	const sourceStat = await fs.lstat(source);
	if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Extension source must be a real directory.");
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });
	for (const entry of await fs.readdir(source, { withFileTypes: true })) {
		if (SKIPPED_COPY_ENTRIES.has(entry.name)) continue;
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Extension source contains an unsupported symlink: ${entry.name}`);
		if (entry.isDirectory()) {
			await copyDirectory(from, to);
		} else if (entry.isFile()) {
			await fs.copyFile(from, to);
			const mode = (await fs.stat(from)).mode & 0o777;
			await fs.chmod(to, mode);
		} else {
			throw new Error(`Extension source contains an unsupported entry: ${entry.name}`);
		}
	}
}

export async function listInstalledExtensions(cwd: string, agentDir = getAgentDir()): Promise<ManagedExtension[]> {
	const result: ManagedExtension[] = [];
	for (const scope of ["global", "project"] as const) {
		const root = extensionRootFor(scope, cwd, agentDir);
		const registry = await readRegistry(root);
		const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		});
		if (!entries) continue;
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || !/^dm-/.test(entry.name)) continue;
			try {
				const manifest = await readPackageManifest(join(root, entry.name));
				if (manifest.name !== entry.name) continue;
				const origin = registry.extensions[entry.name];
				result.push({
					id: entry.name,
					scope,
					path: join(root, entry.name),
					source: origin?.source ?? "local",
					revision: origin?.revision,
				});
			} catch {
				// Other local files remain untouched and outside this manager's scope.
			}
		}
	}
	return result.sort((left, right) => left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id));
}

export async function installExtensionDirectory(
	sourceDirectory: string,
	extensionRoot: string,
	options: { expectedId?: string; scope: ExtensionScope; source: "local" | "duckmind"; revision?: string },
): Promise<ManagedExtension> {
	const source = resolve(sourceDirectory);
	const manifest = await readPackageManifest(source);
	const id = validateExtensionId(manifest.name);
	if (options.expectedId && id !== options.expectedId) {
		throw new Error(`Remote directory ${options.expectedId} declares ${id} instead.`);
	}
	const root = resolve(extensionRoot);
	const destination = join(root, id);
	if (!isWithin(root, destination)) throw new Error("Extension destination escapes its configured root.");
	if (await fs.lstat(destination).catch(() => undefined)) {
		throw new Error(`${id} is already installed at ${destination}. Remove it before importing a replacement.`);
	}
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const staging = join(root, `.${id}.install-${randomUUID()}`);
	try {
		await copyDirectory(source, staging);
		const copied = await readPackageManifest(staging);
		if (copied.name !== id) throw new Error("Copied extension manifest changed unexpectedly.");
		await fs.rename(staging, destination);
		const registry = await readRegistry(root);
		registry.extensions[id] = { source: options.source, revision: options.revision };
		await writeRegistry(root, registry);
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
		if (await fs.lstat(destination).catch(() => undefined)) {
			await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
		}
		throw error;
	}
	return { id, scope: options.scope, path: destination, source: options.source, revision: options.revision };
}

export async function removeInstalledExtension(extension: ManagedExtension, cwd: string, agentDir = getAgentDir()): Promise<void> {
	const root = extensionRootFor(extension.scope, cwd, agentDir);
	const target = resolve(extension.path);
	if (!isWithin(root, target) || target === root || basename(target) !== extension.id) {
		throw new Error("Refusing to remove an extension outside DM's managed extension roots.");
	}
	const stat = await fs.lstat(target).catch(() => undefined);
	if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Installed extension is unavailable: ${extension.id}`);
	await fs.rm(target, { recursive: true, force: false });
	const registry = await readRegistry(root);
	delete registry.extensions[extension.id];
	await writeRegistry(root, registry);
}

async function withRemoteSnapshot<T>(action: (snapshot: { root: string; revision: string }) => Promise<T>): Promise<T> {
	const workRoot = await fs.mkdtemp(join(tmpdir(), "dm-extensions-"));
	const checkout = join(workRoot, "checkout");
	try {
		await execFileAsync("git", ["clone", "--depth", "1", "--branch", REMOTE_BRANCH, DUCKMIND_EXTENSIONS_REMOTE, checkout], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});
		const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { timeout: 10_000 });
		const revision = stdout.trim();
		if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("DuckMind extensions repository returned an invalid revision.");
		return await action({ root: checkout, revision });
	} finally {
		await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function chooseScope(ctx: ExtensionCommandContext): Promise<ExtensionScope | undefined> {
	const selected = await ctx.ui.select("Install extension for", [
		"Global — available in every DM workspace",
		"Project — available only in this workspace",
	]);
	if (!selected) return undefined;
	if (selected.startsWith("Project")) {
		if (!ctx.isProjectTrusted()) {
			ctx.ui.notify("Trust this project before writing .dm/extensions.", "warning");
			return undefined;
		}
		return "project";
	}
	return "global";
}

async function reloadAfterMutation(ctx: ExtensionCommandContext, message: string): Promise<void> {
	ctx.ui.notify(`${message} Reloading DM resources…`, "info");
	await ctx.reload();
}

async function installRemoteExtension(ctx: ExtensionCommandContext): Promise<void> {
	await withRemoteSnapshot(async ({ root, revision }) => {
		const candidates = (await fs.readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^dm-/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		const id = await ctx.ui.select("Install from DuckMind extensions", candidates);
		if (!id) return;
		const scope = await chooseScope(ctx);
		if (!scope) return;
		const confirmed = await ctx.ui.confirm(
			`Install ${id}?`,
			`DM will copy ${id} from the reviewed DuckMind extensions repository at ${revision.slice(0, 12)} into ${scope} extensions.`,
		);
		if (!confirmed) return;
		const targetRoot = extensionRootFor(scope, ctx.cwd);
		await installExtensionDirectory(join(root, id), targetRoot, { expectedId: id, scope, source: "duckmind", revision });
		await reloadAfterMutation(ctx, `Installed ${id}.`);
	});
}

async function installLocalExtension(ctx: ExtensionCommandContext): Promise<void> {
	const input = await ctx.ui.input("Local DM extension directory", "Path containing package.json with dm.extensions");
	if (!input?.trim()) return;
	const source = resolve(ctx.cwd, input.trim());
	const manifest = await readPackageManifest(source);
	const id = validateExtensionId(manifest.name);
	const scope = await chooseScope(ctx);
	if (!scope) return;
	const confirmed = await ctx.ui.confirm(
		`Install ${id}?`,
		`DM will copy the local directory into ${scope} extensions. Symlinks and node_modules are rejected.`,
	);
	if (!confirmed) return;
	await installExtensionDirectory(source, extensionRootFor(scope, ctx.cwd), { scope, source: "local" });
	await reloadAfterMutation(ctx, `Installed ${id}.`);
}

async function removeLocalExtension(ctx: ExtensionCommandContext): Promise<void> {
	const installed = await listInstalledExtensions(ctx.cwd);
	if (installed.length === 0) {
		ctx.ui.notify("No locally installed DM extension packages were found.", "info");
		return;
	}
	const labels = installed.map((extension) => `[${extension.scope}] ${extension.id} — ${extension.source}`);
	const selected = await ctx.ui.select("Remove installed DM extension", labels);
	if (!selected) return;
	const extension = installed[labels.indexOf(selected)];
	if (!extension) return;
	if (extension.scope === "project" && !ctx.isProjectTrusted()) {
		ctx.ui.notify("Trust this project before removing its .dm/extensions entry.", "warning");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		`Remove ${extension.id}?`,
		`This permanently deletes only ${extension.path}, beneath DM's ${extension.scope} extension root.`,
	);
	if (!confirmed) return;
	await removeInstalledExtension(extension, ctx.cwd);
	await reloadAfterMutation(ctx, `Removed ${extension.id}.`);
}

async function showInstalledExtensions(ctx: ExtensionCommandContext): Promise<void> {
	const installed = await listInstalledExtensions(ctx.cwd);
	if (installed.length === 0) {
		ctx.ui.notify("No locally installed DM extension packages were found.", "info");
		return;
	}
	await ctx.ui.select(
		"Installed DM extensions",
		installed.map((extension) => `[${extension.scope}] ${extension.id} — ${extension.source}${extension.revision ? ` @ ${extension.revision.slice(0, 12)}` : ""}`),
	);
}

export default function extensionsManager(dm: ExtensionAPI): void {
	dm.registerCommand("extensions", {
		description: "Install, inspect, or remove local DM extension packages.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Use /extensions with no arguments to open the extension manager.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/extensions manager requires interactive mode.", "warning");
				return;
			}
			try {
				const action = await ctx.ui.select("DM Extensions", [
					"Install from DuckMind extensions",
					"Install a local extension directory",
					"Remove an installed local extension",
					"List installed local extensions",
				]);
				switch (action) {
					case "Install from DuckMind extensions":
						await installRemoteExtension(ctx);
						break;
					case "Install a local extension directory":
						await installLocalExtension(ctx);
						break;
					case "Remove an installed local extension":
						await removeLocalExtension(ctx);
						break;
					case "List installed local extensions":
						await showInstalledExtensions(ctx);
						break;
				}
			} catch (error) {
				ctx.ui.notify(`Extensions manager failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}
