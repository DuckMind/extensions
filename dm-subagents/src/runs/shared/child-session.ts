/**
 * In-process child sessions.
 *
 * A child is a dm `AgentSession` created inside the process that owns it: the
 * parent dm process for foreground children, the detached runner process for
 * background children. The factory is injectable so tests can script a child
 * without the real runtime; the default implementation wraps
 * `createAgentSession` from a dm package module.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentMessage } from "@duckmind/dm-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@duckmind/dm-coding-agent";
import { CHILD_COMMAND_TOOL, createChildCommandRuntime } from "./child-commands.ts";
import { supervisorChannelDir } from "./child-tool-plan.ts";
import { pinChildCacheRetention } from "../../shared/child-cache-retention.ts";
import { splitKnownThinkingSuffix, type ThinkingLevel } from "../../shared/model-info.ts";
import { getAgentDir, DM_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { resolvePackageSubpath } from "../background/runner-aliases.ts";
import { DM_CODING_AGENT_PACKAGE, resolveHostPiPackageRoot } from "./dm-spawn.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import type { RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
import type { PlacementMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";

export interface ChildSessionEvent {
	type: string;
	[key: string]: unknown;
}

/** Mirror dm's JSON event projection: `message_update` drops the partial message. */
export function projectChildSessionEventForJson(event: ChildSessionEvent): unknown {
	if (event.type !== "message_update") return event;
	const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
	if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return event;
	const { partial: _partial, ...delta } = assistantMessageEvent;
	return { type: "message_update", usage: (event.message as { usage?: unknown } | undefined)?.usage, assistantMessageEvent: delta };
}

export interface ChildSessionExtensionError {
	extensionPath: string;
	event: string;
	error: unknown;
}

export interface ChildHookExtension {
	name: string;
	factory: (dm: ExtensionAPI) => void;
}

export type ChildSessionStorage =
	| { kind: "file"; sessionFile: string }
	| { kind: "dir"; sessionDir: string }
	| { kind: "default" }
	| { kind: "memory" };

export interface ChildSessionLaunch {
	cwd: string;
	/** Resolved pane-native placement. Local launches omit this field. */
	machine?: PlacementMachineReference;
	/** The launching session's project trust; undefined keeps DM's default for hosts without trust. */
	projectTrusted?: boolean;
	/** Process-local provider source owned by the invoking foreground parent. */
	parentProviderRegistry?: ParentProviderRegistry;
	/** Logical names resolved only by the remote ambient package. */
	remoteResources?: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false };
	storage: ChildSessionStorage;
	/** The launching session's file, recorded as the new child session's `parentSession` header like DM's forks. */
	parentSessionFile?: string;
	/** Model reference as the agent config names it (`provider/id`, optionally `:thinking`). */
	model?: string;
	/** Explicit tool allowlist; undefined keeps dm's defaults. */
	tools?: string[];
	/** Tools of DM's built-in MCP extension the child must declare to its model directly, with the `mcp:` selector that granted each; `tools` names them too. */
	builtinMcpTools?: Array<{ name: string; selector: string }>;
	/** Cancels startup before a child exists to receive abort(), including its MCP connection wait. */
	signal?: AbortSignal;
	excludeTools?: string[];
	/** Extension files loaded for this child in addition to the inline hooks. */
	extensionPaths: string[];
	/** Canonical required paths and safe evidence identities for fail-closed loading. */
	requiredExtensions?: RequiredChildExtensionSnapshot;
	/**
	 * Discover the ambient extensions (agent dir, project, settings) the way a
	 * `dm` process would. False loads only `extensionPaths` and `hooks`.
	 */
	ambientExtensions: boolean;
	hooks: ChildHookExtension[];
	noSkills: boolean;
	noContextFiles: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/**
	 * Environment values that extensions loaded into the child read from
	 * `process.env`. Applied to the hosting process while the session is created
	 * and its extensions load and start; launches in one process take that
	 * window one at a time. An undefined value removes the variable.
	 */
	processEnv?: Record<string, string | undefined>;
	/** Restore parent environment after in-process child startup. */
	restoreProcessEnv?: boolean;
	/** The typed runtime config the hooks were built from; informational for factories. */
	runtime: ChildRuntimeConfig;
	onExtensionError?: (error: ChildSessionExtensionError) => void;
}

export interface ChildSession {
	subscribe(listener: (event: ChildSessionEvent) => void): () => void;
	/** Resolves when the run ends, including after abort. */
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Emits `session_shutdown` to the child's extensions and disposes the session; resolves once that shutdown work is done. */
	dispose(): Promise<void>;
	/** Final settlement check for commands owned by this child; unfinished commands are cancelled and reject completion. */
	finishCommands?(): Promise<void>;
	/** True while DM still has steering or follow-up input that has not started a turn. */
	hasQueuedMessages?(): boolean;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly modelId: string | undefined;
	/** Provider id of the selected model when this child inherited that provider from the parent's registry instead of loading its extension. */
	readonly inheritedProvider?: string;
	/** Live provider/id of the selected model when DM marks it virtual (`api === "dm-virtual"`); assistant messages then name the dispatched physical model. */
	readonly virtualModelId?: string;
	readonly contextWindow?: number;
	readonly machineEvidence?: { provider: PlacementMachineReference["provider"]; machineId: string; initial?: HerdrRemoteGitStatus; final?: HerdrRemoteGitStatus };
	/** Event-updated pane-native status; reading it performs no network work. */
	readonly placementSnapshot?: unknown;
	/** Set by the foreground host once the run detached; `factory.dispose()` leaves such children running. */
	detached?: boolean;
	/** Set by `factory.dispose()` before it aborts the child, so the host can report the stop truthfully. */
	shutDown?: boolean;
}

export function childSessionHasQueuedMessages(session: ChildSession | undefined): boolean {
	try {
		return session?.hasQueuedMessages?.() === true;
	} catch {
		return false;
	}
}

export interface ChildSessionFactory {
	create(launch: ChildSessionLaunch): Promise<ChildSession>;
	/** Abort and dispose every live attached child; detached children keep running and hold the shared runtime. */
	dispose(): Promise<void>;
}

export type PiCodingAgentModule = typeof import("@duckmind/dm-coding-agent");

export interface DefaultChildSessionFactoryOptions {
	/**
	 * Loads the dm package the sessions are created from. The parent process
	 * uses the host's in-process module; the detached runner imports the
	 * installed package by absolute path.
	 */
	loadPiCodingAgent?: () => Promise<PiCodingAgentModule>;
	/** Upper bound on a disposed child's `session_shutdown` handlers before the session is dropped anyway. */
	shutdownTimeoutMs?: number;
}

type ModelRegistryInstance = ReturnType<PiCodingAgentModule["ModelRegistry"]["create"]>;
type ProviderConfig = Parameters<ModelRegistryInstance["registerProvider"]>[1];
type ModelRuntimeInstance = {
	registerProvider(name: string, config: ProviderConfig): void;
	registerNativeProvider(provider: { id: string }): void;
	refresh(options?: unknown): Promise<void> | void;
};
type LegacyModule = PiCodingAgentModule & {
	ModelRuntime?: { create(): Promise<ModelRuntimeInstance> };
	resolveCliModel?: (options: { cliModel: string; modelRuntime: ModelRuntimeInstance }) => { model?: import("@duckmind/dm-ai").Model<any>; thinkingLevel?: ThinkingLevel; error?: string };
};
type LegacyParentRegistry = {
	getRegisteredProviderIds(): readonly string[];
	getRegisteredProviderConfig(id: string): ProviderConfig | undefined;
	getRegisteredNativeProvider(id: string): { id: string } | undefined;
};
export type ParentProviderRegistry = ModelRegistryInstance | LegacyParentRegistry;

function childRegistry(dm: PiCodingAgentModule, agentDir: string, parentProviders?: ParentProviderRegistry, model?: string): ModelRegistryInstance {
	// Keep runtime-only Ultra auth and account rotation in process; never copy credentials to child storage.
	const authStorage = parentProviders && "authStorage" in parentProviders
		? parentProviders.authStorage
		: model?.startsWith("openai-codex/") && (process.env.auth_file || process.env.AUTHS_DIR)
			? dm.createUltraAuthStorage()
		: dm.AuthStorage.create(path.join(agentDir, "auth.json"));
	return dm.ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
}

function childRuntime(dm: PiCodingAgentModule, agentDir: string, parentProviders?: ParentProviderRegistry, model?: string): Promise<{ runtime: ModelRuntimeInstance; registry?: ModelRegistryInstance }> {
	const legacy = (dm as LegacyModule).ModelRuntime;
	if (legacy?.create) return legacy.create().then((runtime) => ({
		runtime,
		...(typeof (runtime as ModelRegistryInstance).find === "function" ? { registry: runtime as ModelRegistryInstance } : {}),
	}));
	const registry = childRegistry(dm, agentDir, parentProviders, model);
	return Promise.resolve({
		registry,
		runtime: {
			registerProvider: (name, config) => registry.registerProvider(name, config),
			registerNativeProvider: (provider) => { throw new Error(`DM cannot inherit native provider '${provider.id}' without its registration config`); },
			refresh: () => registry.refresh(),
		},
	});
}

function resolveChildModel(registry: ModelRegistryInstance, reference: string): { model: import("@duckmind/dm-ai").Model<any>; thinkingLevel?: ThinkingLevel } {
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(reference);
	const slash = baseModel.indexOf("/");
	const model = slash > 0 ? registry.find(baseModel.slice(0, slash), baseModel.slice(slash + 1)) : registry.getAvailable().find((item) => item.id === baseModel);
	if (!model) throw new Error(`Model ${reference} not found in child registry`);
	return { model, ...(thinkingSuffix ? { thinkingLevel: thinkingSuffix.slice(1) as ThinkingLevel } : {}) };
}

/** Registers the parent's providers this child did not claim itself and returns their ids. */
function inheritParentProviders(modelRuntime: ModelRuntimeInstance, parentProviders: ParentProviderRegistry, claimedProviderIds: ReadonlySet<string>, onError: ((error: ChildSessionExtensionError) => void) | undefined): Set<string> {
	let providerIds: readonly string[];
	const legacy = "getRegisteredProviderIds" in parentProviders ? parentProviders : undefined;
	// Copy parent extension registrations into the fresh child registry.
	const configs = legacy ? undefined : (parentProviders as unknown as { registeredProviders?: Map<string, ProviderConfig> }).registeredProviders;
	try {
		if (!legacy && !(configs instanceof Map)) throw new Error("parent model registry does not expose provider registrations");
		providerIds = legacy ? legacy.getRegisteredProviderIds() : [...configs!.keys()];
	} catch (error) {
		onError?.({ extensionPath: "<parent-providers>", event: "inherit_provider", error });
		throw new Error(`Failed to enumerate parent providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const inherited = new Set<string>();
	for (const providerId of new Set(providerIds)) {
		if (claimedProviderIds.has(providerId)) continue;
		try {
			const native = legacy?.getRegisteredNativeProvider(providerId);
			const config = native ? undefined : legacy ? legacy.getRegisteredProviderConfig(providerId) : configs?.get(providerId);
			if (native) modelRuntime.registerNativeProvider(native);
			else if (config) modelRuntime.registerProvider(providerId, config);
			else throw new Error(`Parent provider '${providerId}' has no registered native provider or config.`);
			inherited.add(providerId);
		} catch (error) {
			onError?.({ extensionPath: `<parent-provider:${providerId}>`, event: "inherit_provider", error });
			throw new Error(`Failed to inherit parent provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
	return inherited;
}

const CHILD_PROMPT_RUNTIME_EXTENSION_PATH = "<inline:dm-subagents:prompt-runtime>";
const CHILD_PROMPT_BOUNDARY_EXTENSION_PATH = "<inline:dm-subagents:prompt-boundary>";
/** Same class as UNICODE_SPACES in dm-coding-agent dist/utils/paths.js, which resolvePath(..., { normalizeUnicodeSpaces: true }) replaces with a space. */
const PI_UNICODE_SPACES = new RegExp("[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]", "g");

function childExtensionFileIdentity(extensionPath: string): string | undefined {
	if (!path.isAbsolute(extensionPath)) return undefined;
	try {
		const stat = fs.statSync(extensionPath, { bigint: true });
		return stat.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
	} catch { return undefined; }
}

function createRequiredChildExtensionIdentity(requiredPaths: ReadonlySet<string>): (extensionPath: string) => string | undefined {
	const aliases = new Map([...requiredPaths].map((extensionPath) => [extensionPath, childExtensionFileIdentity(extensionPath) ?? extensionPath]));
	const identities = new Set(aliases.values());
	return (extensionPath) => {
		const known = aliases.get(extensionPath);
		if (known !== undefined) return known;
		const identity = childExtensionFileIdentity(extensionPath);
		if (identity === undefined || !identities.has(identity)) return undefined;
		// Retain the alias even if the extension removes its file before reporting a failure.
		aliases.set(extensionPath, identity);
		return identity;
	};
}

/** The prompt runtime filters parent-only context before ambient extensions inspect
 *  the child prompt, and the boundary hook appends the child boundary after every
 *  extension has added its prompt sections. Every other extension keeps its order. */
function orderChildPromptHooks<T extends { extensions: Array<{ path: string }> }>(result: T, hooks: readonly ChildHookExtension[] = []): T {
	const isHook = (path: string, name: string) => path === `<inline:${name}>` ||
		(/^<inline:(\d+)>$/.exec(path)?.[1] !== undefined && hooks[Number(/^<inline:(\d+)>$/.exec(path)![1]) - 1]?.name === name);
	const runtime = result.extensions.filter(({ path }) => isHook(path, "dm-subagents:prompt-runtime"));
	const boundary = result.extensions.filter(({ path }) => isHook(path, "dm-subagents:prompt-boundary"));
	const others = result.extensions.filter(({ path }) => !isHook(path, "dm-subagents:prompt-runtime") && !isHook(path, "dm-subagents:prompt-boundary"));
	return { ...result, extensions: [...runtime, ...others, ...boundary] };
}

/** Ambient bash overrides keep their original backend and priority. */
function prioritizeChildCommandRuntime<T extends { extensions: Array<{ path: string; tools?: Map<string, unknown> }> }>(result: T, hooks: readonly ChildHookExtension[] = [], enabled = true): T {
	if (!enabled) return result;
	const commandPath = `<inline:${hooks.length + 1}>`;
	const index = result.extensions.findIndex(({ path }) => path === "<inline:dm-subagents:commands>" || path === commandPath);
	if (index < 0) return result;
	if (result.extensions.some((extension, otherIndex) => otherIndex !== index && extension.tools?.has("bash"))) {
		const extensions = result.extensions.filter((_, otherIndex) => otherIndex !== index);
		if (!extensions.some((extension) => extension.tools?.has(CHILD_COMMAND_TOOL))) {
			const commands = result.extensions[index]!;
			const registered = commands.tools!.get(CHILD_COMMAND_TOOL) as { definition: ToolDefinition };
			const reason = "Native command controls are unavailable with the active custom bash backend. Use that backend's own command controls.";
			extensions.push({ ...commands, tools: new Map([[CHILD_COMMAND_TOOL, { ...registered, definition: {
				...registered.definition, description: reason,
				execute: async () => { throw new Error(reason); },
			} }]]) });
		}
		return { ...result, extensions };
	}
	if (index === 0) return result;
	const extensions = [...result.extensions];
	const [commands] = extensions.splice(index, 1);
	extensions.unshift(commands!);
	return { ...result, extensions };
}

/** One launch at a time from env application through `session_start`, so parallel launches never observe each other's `processEnv` while their extensions load and start. */
let loading: Promise<unknown> = Promise.resolve();

/**
 * dm caches extension factories per process and clears that cache only when a
 * loader reloads a second time, so every child in one process would share each
 * extension's module state. Marking the child's loader as already loaded makes
 * its first `reload()` clear the cache, so the child gets its own instances the
 * way a separate process had them. The flag is a private field of dm's loader.
 */
function resetExtensionCacheOnReload(loader: object): boolean {
	if (!("loaded" in loader)) return false;
	(loader as { loaded: boolean }).loaded = true;
	return true;
}

function applyProcessEnv(values: Record<string, string | undefined> | undefined): () => void {
	if (!values) return () => {};
	const previous = Object.keys(values).map((name) => [name, process.env[name]] as const);
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/**
 * DM's built-in MCP extension registers server tools with the configured exposure, `codemode` by
 * default, which the child's `tools` allowlist cannot declare. Registering the selected names as
 * `direct` makes them model-declared and callable; `hidden` stays hidden. A name counts only when
 * the tool's raw identity, its `<server>/<tool>` label, matches the granting selector: DM can give
 * the sanitized name of `srv/a.b` to `srv/a_b`. The selector's server part may be the configured
 * name or its `-`→`_` form, which DM's namespace uses: DM refuses two servers whose names differ
 * only in `-` and `_`, so both forms name the same server. Every other tool the extension registers becomes
 * `hidden`, so neither codemode nor `ctx.executeTool()` can call it, independent of the `tools`
 * allowlist. The `builtin` entry loads
 * through the explicit `builtin:mcp` path even with `noExtensions`, and `replaceable` lets an
 * ambient MCP extension that registers `/mcp` replace it, as in the parent.
 */
function selectedBuiltinMcpExtension(dm: PiCodingAgentModule, selections: ReadonlyArray<{ name: string; selector: string }>, readinessTool: () => ToolDefinition | undefined): ChildHookExtension & { builtin: true; replaceable: true; waitForTools(signal: AbortSignal, loadError: () => string | undefined): Promise<void> } {
	// DM 0.99 export; the pinned SDK types predate it.
	const createMcpExtension = (dm as { createMcpExtension?: () => (api: ExtensionAPI) => void | Promise<void> }).createMcpExtension;
	if (typeof createMcpExtension !== "function") throw new Error(`Selected built-in MCP tools (${selections.map(({ name }) => name).join(", ")}) need a DM version with built-in MCP.`);
	const selectors = new Map(selections.map(({ name, selector }) => [name, selector]));
	const split = (value: string) => {
		const slash = value.indexOf("/");
		return { server: (slash === -1 ? value : value.slice(0, slash)).replace(/-/g, "_"), tool: slash === -1 ? undefined : value.slice(slash + 1) };
	};
	const granted = (tool: { name: string; label?: string; exposure?: string }) => {
		const selector = selectors.get(tool.name);
		if (selector === undefined || tool.exposure === "hidden" || tool.label === undefined) return false;
		const want = split(selector);
		const have = split(tool.label);
		return have.tool !== undefined && have.server === want.server && (want.tool === undefined || want.tool === have.tool);
	};
	const mcp = createMcpExtension();
	type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;
	let waitForTools: ((signal: AbortSignal) => Promise<void>) | undefined;
	let checkingStartup = false;
	const factory = async (api: ExtensionAPI) => {
		const toolCallHandlers: ToolCallHandler[] = [];
		await mcp(new Proxy(api, {
			get(target, prop) {
				// The allowlist can omit codemode. Only MCP's startup hook sees its
				// host-owned metadata; the session's tool set and permissions do not change.
				if (prop === "getAllTools") return () => checkingStartup && readinessTool() ? [readinessTool()!] : target.getAllTools();
				if (prop === "registerTool") {
					return (tool: Parameters<ExtensionAPI["registerTool"]>[0] & { exposure?: string }) =>
						target.registerTool({ ...tool, exposure: granted(tool) ? "direct" : "hidden" } as typeof tool);
				}
				if (prop === "on") {
					return (event: string, handler: ToolCallHandler) => {
						if (event === "tool_call") toolCallHandlers.push(handler);
						return target.on(event as "tool_call", handler);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}));
		api.on("session_start", (_event, ctx) => {
			waitForTools = async (signal) => {
				if (toolCallHandlers.length === 0) throw new Error(`Selected built-in MCP tools (${selections.map(({ name }) => name).join(", ")}) need DM 0.99.2 or later; earlier built-in MCP cannot report when its servers have connected.`);
				// Run only MCP's readiness hook, not a tool or script. DM 1.0 recognizes its
				// own codemode schema; newer hosts use that tool's reachesTools metadata.
				const event: ToolCallEvent = { type: "tool_call", toolCallId: "dm-subagents:mcp-startup", toolName: "codemode", input: { code: selections.map(({ name }) => `tools.${name}`).join(";\n") } };
				const context = new Proxy(ctx, { get: (target, prop, receiver) => prop === "signal" ? signal : Reflect.get(target, prop, receiver) });
				checkingStartup = true;
				try {
					for (const handler of toolCallHandlers) {
						if (signal.aborted) return;
						const result = await handler(event, context);
						if (result?.block) throw new Error(result.reason ?? "MCP startup readiness was blocked.");
					}
				} finally { checkingStartup = false; }
			};
		});
	};
	return { name: "mcp", factory, builtin: true, replaceable: true, async waitForTools(signal, loadError) {
		if (!waitForTools) {
			const error = loadError();
			throw new Error(`DM's built-in MCP readiness hook did not start in the child session${error ? `: ${error}` : "."}`);
		}
		await waitForTools(signal);
	} };
}

/** Verify the declaration and callable exposure after DM finishes the selected connection attempts. */
function missingBuiltinMcpTools(session: { getAllTools(): Array<{ name: string }>; getActiveToolNames(): string[] }, names: readonly string[]): string[] {
	const active = new Set(session.getActiveToolNames());
	const direct = new Set(session.getAllTools().filter((tool) => (tool as { exposure?: string }).exposure === "direct").map(({ name }) => name));
	return names.filter((name) => !active.has(name) || !direct.has(name));
}

function flushQueuedProviderRegistrations(loader: InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>, modelRuntime: ModelRuntimeInstance, onError: ((error: ChildSessionExtensionError) => void) | undefined, isRequiredSource: (extensionPath: string) => boolean): { claimedProviderIds: Set<string>; registered: boolean } {
	const claimedProviderIds = new Set<string>();
	if (!("getExtensions" in loader) || typeof loader.getExtensions !== "function") return { claimedProviderIds, registered: false };
	const { runtime: loadedRuntime } = loader.getExtensions();
	const runtime = loadedRuntime as typeof loadedRuntime & { pendingNativeProviderRegistrations?: Array<{ provider: { id: string }; extensionPath: string }> };
	let registered = false;
	for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations ?? []) {
		claimedProviderIds.add(name);
		try {
			modelRuntime.registerProvider(name, config);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
			if (isRequiredSource(extensionPath)) throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Array.isArray(runtime.pendingProviderRegistrations)) runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations ?? []) {
		claimedProviderIds.add(provider.id);
		try {
			modelRuntime.registerNativeProvider(provider);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_provider", error });
			if (isRequiredSource(extensionPath)) throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Array.isArray(runtime.pendingNativeProviderRegistrations)) runtime.pendingNativeProviderRegistrations = [];
	// DM core flushes pendingVirtualModelRegistrations when a session binds extensions
	// (agent-session-services), but this factory resolves the requested model before that
	// binding, so an extension-registered virtual model never resolves for the child. The
	// structural cast keeps compiling against SDK versions that predate virtual models;
	// there the queue is absent and the loop is a no-op.
	const virtualModelRuntime = modelRuntime as ModelRuntimeInstance & { registerVirtualModel?: (definition: unknown) => void };
	const virtualModelQueue = runtime as { pendingVirtualModelRegistrations?: Array<{ definition: unknown; extensionPath: string }> };
	const pendingVirtualModelRegistrations = virtualModelQueue.pendingVirtualModelRegistrations ?? [];
	for (const { definition, extensionPath } of pendingVirtualModelRegistrations) {
		if (typeof virtualModelRuntime.registerVirtualModel !== "function") break;
		try {
			virtualModelRuntime.registerVirtualModel(definition);
			registered = true;
		} catch (error) {
			onError?.({ extensionPath, event: "register_virtual_model", error });
			if (isRequiredSource(extensionPath)) throw new Error(`Required child extension virtual model registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (Array.isArray(virtualModelQueue.pendingVirtualModelRegistrations)) virtualModelQueue.pendingVirtualModelRegistrations = [];
	return { claimedProviderIds, registered };
}

/**
 * Load the host-owned dm-coding-agent module by absolute package entry so a
 * child cannot resolve an extension-owned copy. SDK and CLI root precedence is
 * shared through resolveHostPiPackageRoot. Once any root is selected, its manifest,
 * package identity, entry, and import must all succeed; the bare specifier is used
 * only when no root resolves.
 */
export async function loadHostPiCodingAgent(): Promise<PiCodingAgentModule> {
	const overrideRoot = process.env[DM_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim() || undefined;
	const root = resolveHostPiPackageRoot();
	if (root) {
		const entry = fs.realpathSync(resolveHostPackageEntry(root, root === overrideRoot ? overrideRoot : undefined));
		return import(pathToFileURL(entry).href);
	}
	return import(DM_CODING_AGENT_PACKAGE);
}

function resolveHostPackageEntry(root: string, overrideRoot: string | undefined): string {
	const packageJson = path.join(root, "package.json");
	const source = fs.readFileSync(packageJson, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`invalid host SDK manifest at ${packageJson}: malformed JSON`, { cause: error });
	}
	if (!isUnknownRecord(parsed)) throw new Error(`invalid host SDK manifest at ${packageJson}: expected a JSON object`);
	const pkg = parsed;
	if (pkg.name !== DM_CODING_AGENT_PACKAGE) {
		const source = overrideRoot !== undefined ? ` (${DM_CODING_AGENT_PACKAGE_ROOT_ENV} override)` : "";
		throw new Error(`refusing to load the host SDK from ${root}${source}: package.json name is "${String(pkg.name ?? "(none)")}", expected "${DM_CODING_AGENT_PACKAGE}"`);
	}
	const entry = resolvePackageSubpath(root, ".");
	if (!entry) throw new Error(`host SDK manifest at ${packageJson} has no resolvable root export`);
	return entry;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Default factory: detached/background sessions retain the existing shared
 * runtime; each parent-bound foreground launch gets an isolated runtime.
 */
export function createDefaultChildSessionFactory(options: DefaultChildSessionFactoryOptions = {}): ChildSessionFactory {
	const loadPiCodingAgent = options.loadPiCodingAgent ?? loadHostPiCodingAgent;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
	let runtime: Promise<{ runtime: ModelRuntimeInstance; registry?: ModelRegistryInstance }> | undefined;
	const live = new Set<ChildSession>();
	/** Extension shutdowns still running for disposed children; `dispose()` waits for them. */
	const shutdowns = new Set<Promise<void>>();
	/** Launches still waiting for their MCP tools; `dispose()` ends the wait and waits for their shutdown. */
	const mcpWaits = new Map<AbortController, Promise<void>>();
	let disposals = 0;
	const sharedRuntime = async (dm: PiCodingAgentModule, agentDir: string) => {
		runtime ??= childRuntime(dm, agentDir).catch((error: unknown) => {
			runtime = undefined;
			throw error;
		});
		return runtime;
	};
	return {
		async create(launch) {
			const disposalsAtStart = disposals;
			const dm = await loadPiCodingAgent();
			const builtinMcpTools = launch.builtinMcpTools ?? [];
			let readinessTool: ToolDefinition | undefined;
			const builtinMcp = builtinMcpTools.length ? selectedBuiltinMcpExtension(dm, builtinMcpTools, () => readinessTool) : undefined;
			const agentDir = getAgentDir();
			const detachedUltra = !launch.parentProviderRegistry && launch.model?.startsWith("openai-codex/")
				&& (process.env.auth_file || process.env.AUTHS_DIR);
			const { runtime: modelRuntime, registry: modelRegistry } = launch.parentProviderRegistry || detachedUltra
				? await childRuntime(dm, agentDir, launch.parentProviderRegistry, launch.model)
				: await sharedRuntime(dm, agentDir);
			const commands = launch.runtime.runId && launch.runtime.agent && launch.runtime.childIndex !== undefined
				&& launch.tools?.includes("bash") && launch.tools.includes(CHILD_COMMAND_TOOL)
				&& !launch.excludeTools?.includes("bash") && !launch.excludeTools?.includes(CHILD_COMMAND_TOOL)
				&& typeof dm.createBashTool === "function"
				? createChildCommandRuntime(supervisorChannelDir(launch.runtime.runId, launch.runtime.agent, launch.runtime.childIndex)) : undefined;
			const settingsManager = dm.SettingsManager.create(launch.cwd, agentDir, { projectTrusted: launch.projectTrusted });
			// Foreground children share DM's global theme with the parent, so reinitializing it
			// would overwrite the parent's active light/dark appearance. Detached runners have
			// no initialized theme and must initialize one for headless extension renderers.
			const themeKey = Symbol.for("@duckmind/dm-coding-agent:theme");
			const themeInitialized = Boolean((globalThis as Record<symbol, unknown>)[themeKey]);
			if (!themeInitialized && typeof dm.initTheme === "function") dm.initTheme(settingsManager.getTheme());
			// SDK sessions do not install DM's CLI built-ins. Use the host's own
			// codemode factory only when this child can select it; older DM hosts
			// without that factory retain the strict missing-tool diagnostic.
			const createCodemodeExtension = (dm as PiCodingAgentModule & { createCodemodeExtension?: () => ChildHookExtension["factory"] }).createCodemodeExtension;
			const codemodeAllowed = !launch.runtime.capabilityCeiling?.denyExtensions &&
				(launch.tools === undefined || launch.tools.includes("codemode")) && !launch.excludeTools?.includes("codemode");
			const codemode = typeof createCodemodeExtension === "function" && (codemodeAllowed || builtinMcp)
				? [{ name: "codemode", replaceable: true, factory: (api: ExtensionAPI) => createCodemodeExtension()(new Proxy(api, {
					get(target, prop) {
						if (prop === "registerTool") return (tool: ToolDefinition) => {
							if (tool.name === "codemode") readinessTool = tool;
							target.registerTool(codemodeAllowed ? tool : { ...tool, exposure: "hidden" } as ToolDefinition);
						};
						const value = Reflect.get(target, prop, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				})) }]
				: [];
			const requiredPaths = new Set((launch.requiredExtensions ?? []).map(({ path }) => path));
			const requiredExtensionIdentity = createRequiredChildExtensionIdentity(requiredPaths);
			const resolvedExtensionPaths = new Map<string, string>();
			// DM reports failures by source path, without resolvedPath. A source DM never loaded is classified by the
			// file it names, after DM's Unicode-space normalization. A required extension that failed under an
			// unmatched spelling is still rejected by the missing-identity check after loading.
			const isRequiredSource = (extensionPath: string) => requiredPaths.size > 0 && requiredExtensionIdentity(
				resolvedExtensionPaths.get(extensionPath) ?? extensionPath.replace(PI_UNICODE_SPACES, " "),
			) !== undefined;
			const loader = new dm.DefaultResourceLoader({
				cwd: launch.cwd,
				agentDir,
				settingsManager,
				noExtensions: !launch.ambientExtensions,
				noSkills: launch.noSkills,
				// DM merges skills from extensions' resources_discover without checking noSkills.
				skillsOverride: launch.noSkills ? (base) => ({ ...base, skills: [] }) : undefined,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: launch.noContextFiles,
				additionalExtensionPaths: builtinMcp ? [...launch.extensionPaths, "builtin:mcp"] : launch.extensionPaths,
				extensionFactories: [...launch.hooks, ...(commands ? [{ name: "dm-subagents:commands", factory: (api: ExtensionAPI) => {
					api.registerTool(commands.wrap(dm.createBashTool(launch.cwd, { commandPrefix: settingsManager.getShellCommandPrefix(), shellPath: settingsManager.getShellPath() }) as unknown as ToolDefinition));
					api.registerTool(commands.tool());
				} }] : []), ...codemode, ...(builtinMcp ? [builtinMcp] : [])].map(({ factory }) => factory),
				extensionsOverride: (result) => orderChildPromptHooks(prioritizeChildCommandRuntime(result, launch.hooks, Boolean(commands)), launch.hooks),
				...(launch.systemPrompt !== undefined ? { systemPrompt: launch.systemPrompt } : {}),
				// An empty list stops DM from filling the slot with the operator's APPEND_SYSTEM.md (#2960).
				appendSystemPrompt: launch.appendSystemPrompt !== undefined ? [launch.appendSystemPrompt] : [],
			});
			// dm's own hosts emit `session_shutdown` before disposing a session so the
			// extensions loaded into it (ambient extensions included) release their
			// watchers, servers, and timers. Do the same, then dispose.
			const shutdownSession = async (session: Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"]): Promise<void> => {
				try {
					await commands?.shutdown();
					const runner = session.extensionRunner;
					if (runner.hasHandlers("session_shutdown")) {
						let bound: ReturnType<typeof setTimeout> | undefined;
						await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise<void>((resolve) => { bound = setTimeout(resolve, shutdownTimeoutMs); })])
							.finally(() => clearTimeout(bound));
					}
				} catch (error) {
					launch.onExtensionError?.({ extensionPath: "<session>", event: "session_shutdown", error });
				} finally {
					session.dispose();
				}
			};
			let inheritedProviders = new Set<string>();
			const openSession = async () => {
				if (!resetExtensionCacheOnReload(loader) && (launch.ambientExtensions || launch.extensionPaths.length)) launch.onExtensionError?.({ extensionPath: "<loader>", event: "load", error: new Error("dm's extension cache reset is unavailable; extensions loaded into this child share module state with other sessions in this process.") });
				await loader.reload();
				if (requiredPaths.size > 0) for (const extension of loader.getExtensions().extensions) resolvedExtensionPaths.set(extension.path, extension.resolvedPath);
				const loadErrors = requiredPaths.size > 0
					? loader.getExtensions().errors.filter(({ path }) => isRequiredSource(path)) : [];
				if (loadErrors.length > 0) throw new Error(`Required child extension failed to load: ${loadErrors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
				const queued = flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError, isRequiredSource);
				if (requiredPaths.size > 0) {
					const loadedIdentities = new Set(loader.getExtensions().extensions.map(({ resolvedPath }) => requiredExtensionIdentity(resolvedPath)));
					const missing = [...requiredPaths].filter((extensionPath) => !loadedIdentities.has(requiredExtensionIdentity(extensionPath)));
					if (missing.length) throw new Error(`Required child extension failed to load: ${missing.join(", ")}`);
				}
				if (launch.parentProviderRegistry) inheritedProviders = inheritParentProviders(modelRuntime, launch.parentProviderRegistry, queued.claimedProviderIds, launch.onExtensionError);
				if (queued.registered || inheritedProviders.size > 0) {
					try {
						await modelRuntime.refresh({ allowNetwork: false });
					} catch (error) {
						launch.onExtensionError?.({ extensionPath: "<provider-refresh>", event: "refresh_providers", error });
						throw new Error(`Failed to refresh child providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
					}
				}
				const newSessionOptions = launch.parentSessionFile ? { parentSession: launch.parentSessionFile } : undefined;
				const newSessionFile = launch.storage.kind === "file" && !fs.existsSync(launch.storage.sessionFile);
				const sessionManager = launch.storage.kind === "file"
					? dm.SessionManager.open(launch.storage.sessionFile, undefined, launch.cwd)
					: launch.storage.kind === "dir"
						? dm.SessionManager.create(launch.cwd, launch.storage.sessionDir, newSessionOptions)
						: launch.storage.kind === "memory"
							? dm.SessionManager.inMemory(launch.cwd, newSessionOptions)
							: dm.SessionManager.create(launch.cwd, undefined, newSessionOptions);
				// SessionManager.open takes no parent for a file it is about to create, so set it on the
				// header DM writes with the first assistant message. Forked and resumed files keep theirs.
				const header = newSessionFile && launch.parentSessionFile ? sessionManager.getHeader() : null;
				if (header) header.parentSession = launch.parentSessionFile;
				const resolvedModel = launch.model
					? modelRegistry
						? resolveChildModel(modelRegistry, launch.model)
						: (dm as LegacyModule).resolveCliModel?.({ cliModel: launch.model, modelRuntime })
					: undefined;
				if (launch.model && !resolvedModel) throw new Error("child model resolver is unavailable");
				if (resolvedModel && "error" in resolvedModel && resolvedModel.error) throw new Error(resolvedModel.error);
				const { session } = await dm.createAgentSession({
					cwd: launch.cwd,
					agentDir,
					...(modelRegistry ? { modelRegistry, authStorage: modelRegistry.authStorage } : {}),
					...(resolvedModel?.model ? { model: resolvedModel.model } : {}),
					...(resolvedModel?.thinkingLevel ? { thinkingLevel: resolvedModel.thinkingLevel } : {}),
					...(launch.tools ? { tools: launch.tools } : {}),
					...(launch.excludeTools?.length ? { excludeTools: launch.excludeTools } : {}),
					resourceLoader: loader,
					sessionManager,
					settingsManager,
					sessionStartEvent: { type: "session_start", reason: "startup" },
				});
				pinChildCacheRetention(session.agent as unknown as Parameters<typeof pinChildCacheRetention>[0]);
				// DM reports handler failures through onError instead of throwing, so required startup failures must be collected here.
				const requiredStartupErrors: string[] = [];
				let binding = true;
				try {
					await session.bindExtensions({
						mode: "print",
						onError: (error) => {
							if (binding && isRequiredSource(error.extensionPath)) requiredStartupErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`);
							launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error });
						},
					});
				} catch (error) {
					session.dispose();
					throw error;
				} finally {
					binding = false;
				}
				if (requiredStartupErrors.length > 0) {
					// Binding finished, so the other extensions' session_start handlers ran and may hold resources.
					await shutdownSession(session);
					throw new Error(`Required child extension failed during startup: ${requiredStartupErrors.join("; ")}`);
				}
				return session;
			};
			const open = async () => {
				const restoreEnv = applyProcessEnv(launch.processEnv);
				try {
					return await openSession();
				} finally {
					if (launch.restoreProcessEnv) restoreEnv();
				}
			};
			const opened = loading.catch(() => {}).then(open);
			loading = opened;
			const session = await opened;
			let pending: Promise<void> | undefined;
			const shutdown = () => shutdownSession(session);
			// Outside the launch lock: MCP servers connect after `session_start` without reading the per-launch env.
			if (builtinMcp) {
				const cancel = new AbortController();
				const signal = launch.signal ? AbortSignal.any([cancel.signal, launch.signal]) : cancel.signal;
				if (disposals !== disposalsAtStart) cancel.abort();
				const ready = (async () => {
					try {
						await builtinMcp.waitForTools(signal, () => loader.getExtensions().errors.find(({ path }) => path === "builtin:mcp")?.error);
						if (disposals !== disposalsAtStart) throw new Error("The child session factory was disposed while the child waited for its MCP tools.");
						if (signal.aborted) throw new Error("The child launch was cancelled while waiting for its MCP tools.");
						const missing = missingBuiltinMcpTools(session, builtinMcpTools.map(({ name }) => name));
						if (missing.length) throw new Error(`Selected built-in MCP tools did not register in the child session: ${missing.join(", ")}. The MCP server may have failed to connect, or the name belongs to a different tool than the selector names; check it with /mcp.`);
					} catch (error) {
						await shutdown();
						throw error;
					}
				})();
				mcpWaits.set(cancel, ready);
				try { await ready; } finally { mcpWaits.delete(cancel); }
			}
			const child: ChildSession = {
				subscribe: (listener) => session.subscribe((event) => listener(event as unknown as ChildSessionEvent)),
				prompt: (text) => session.prompt(text),
				...(commands ? { finishCommands: () => commands.finish() } : {}),
				steer: async (text) => { await session.steer(text); },
				followUp: async (text) => { await session.followUp(text); },
				abort: () => session.abort(),
				hasQueuedMessages: () => session.agent?.hasQueuedMessages?.() === true,
				dispose: () => {
					if (!pending) {
						live.delete(child);
						const shutdownDone = shutdown();
						pending = shutdownDone;
						shutdowns.add(shutdownDone);
						void shutdownDone.finally(() => shutdowns.delete(shutdownDone));
					}
					return pending;
				},
				get messages() { return session.messages; },
				get sessionFile() { return session.sessionFile; },
				get sessionId() { return session.sessionId; },
				get modelId() { return session.model ? `${session.model.provider}/${session.model.id}` : undefined; },
				get inheritedProvider() { return session.model && inheritedProviders.has(session.model.provider) ? session.model.provider : undefined; },
				get virtualModelId() { return session.model?.api === "dm-virtual" ? `${session.model.provider}/${session.model.id}` : undefined; },
				get contextWindow() { return session.model?.contextWindow; },
			};
			live.add(child);
			return child;
		},
		async dispose() {
			disposals += 1;
			for (const cancel of mcpWaits.keys()) cancel.abort();
			const children = [...live].filter((child) => !child.detached);
			for (const child of children) child.shutDown = true;
			await Promise.allSettled(children.map((child) => child.abort()));
			for (const child of children) {
				try { void child.dispose(); } catch { /* best effort */ }
			}
			await Promise.allSettled([...shutdowns, ...mcpWaits.values()]);
			if (live.size === 0) runtime = undefined;
		},
	};
}

let activeFactory: ChildSessionFactory | undefined;
let activeFactoryModule: string | undefined;

/** The process-wide factory foreground runs use unless a run passes its own. */
export function childSessionFactory(): ChildSessionFactory {
	activeFactory ??= createLazyPlacementFactory(createDefaultChildSessionFactory());
	return activeFactory;
}

function createLazyPlacementFactory(local: ChildSessionFactory): ChildSessionFactory {
	let placed: ChildSessionFactory | undefined;
	const factory = async () => placed ??= (await import("./herdr-placed-run.ts")).createPlacementAwareChildSessionFactory(local);
	return {
		async create(launch) { return launch.machine ? (await factory()).create(launch) : local.create(launch); },
		async dispose() { if (placed) await placed.dispose(); else await local.dispose(); },
	};
}

/** Default factory including pane-native placement; detached runners use the same boundary. */
export function createPlacementChildSessionFactory(options: DefaultChildSessionFactoryOptions = {}): ChildSessionFactory {
	return createLazyPlacementFactory(createDefaultChildSessionFactory(options));
}

/**
 * Replace the process-wide factory. Tests install a scripted factory; passing
 * undefined restores the default on next use.
 */
export function setChildSessionFactory(factory: ChildSessionFactory | undefined): void {
	activeFactory = factory;
}

/**
 * Module path the detached background runner imports its child session factory
 * from. Tests point it at a scripted factory; production launches leave it
 * unset and the runner creates real sessions from the installed dm package.
 */
export function childSessionFactoryModule(): string | undefined {
	return activeFactoryModule;
}

export function setChildSessionFactoryModule(modulePath: string | undefined): void {
	activeFactoryModule = modulePath;
}

/** Abort and dispose every live in-process child and release the shared runtime. */
export async function disposeChildSessions(): Promise<void> {
	const factory = activeFactory;
	if (!factory) return;
	await factory.dispose();
}
