import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceImportPattern = /from\s+["'](@duckmind\/[^"']+)["']|import\s+["'](@duckmind\/[^"']+)["']/g;
const oldPiScopePattern = /@mariozechner\/dm-/;
const piPackageJsonSubpathPattern = /@duckmind\/dm-[^"']+\/package\.json/;
const cjsPiPackageResolutionPattern = /require(?:\.resolve)?\(\s*["']@duckmind\/dm-/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const hostPeerPackages = [
	"@duckmind/dm-agent-core",
	"@duckmind/dm-ai",
	"@duckmind/dm-coding-agent",
	"@duckmind/dm-tui",
	"typebox",
] as const;
const expectedHostPeerRanges = {
	"@duckmind/dm-agent-core": ">=0.80.2",
	"@duckmind/dm-ai": ">=0.80.2",
	"@duckmind/dm-coding-agent": ">=0.80.2",
	"@duckmind/dm-tui": ">=0.80.2",
	typebox: "*",
} satisfies Record<(typeof hostPeerPackages)[number], string>;
const expectedHostDevVersions = {
	"@duckmind/dm-agent-core": "file:../../dm-mono/packages/agent",
	"@duckmind/dm-ai": "file:../../dm-mono/packages/ai",
	"@duckmind/dm-coding-agent": "file:../../dm-mono/packages/coding-agent",
	"@duckmind/dm-tui": "file:../../dm-mono/packages/tui",
	typebox: "1.3.27",
} satisfies Record<(typeof hostPeerPackages)[number], string>;

test("the root entrypoint exposes the runtime error flag to TypeScript consumers", () => {
	const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dm-subagents-types-"));
	try {
		fs.writeFileSync(path.join(consumerRoot, "consumer.ts"), `
import "dm-subagents";
import type { AgentToolResult } from "@duckmind/dm-agent-core";
import { registerWorkflowResource, type RegisterWorkflowResourceInput, type WorkflowResourceDefinition, type WorkflowResourceRegistration } from "dm-subagents/workflow-resources";

const definition: WorkflowResourceDefinition = {
	name: "consumer.check", version: 1,
	resolve: (args) => typeof args.task === "string"
		? { script: "return 1;", hostCommands: [{ key: "check", command: "node --version" }] }
		: { error: "task required" },
};
const input: RegisterWorkflowResourceInput = { sessionId: "consumer", definition };
const registration: WorkflowResourceRegistration = registerWorkflowResource(input);
registration.dispose();

const result: AgentToolResult<undefined> = {
	content: [],
	details: undefined,
	isError: true,
};

void result.isError;
`, "utf-8");
		fs.writeFileSync(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2023",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				noEmit: true,
				types: ["node"],
				typeRoots: [path.join(projectRoot, "node_modules", "@types")],
				skipLibCheck: true,
				allowImportingTsExtensions: true,
				baseUrl: consumerRoot,
				paths: {
					"dm-subagents": [path.join(projectRoot, "index.ts")],
					"dm-subagents/workflow-resources": [path.join(projectRoot, "src/api/workflow-resources.ts")],
				"@duckmind/dm-agent-core": [path.join(projectRoot, "node_modules", "@duckmind", "dm-agent-core", "dist", "index.d.ts")],
				},
			},
			files: [path.join(consumerRoot, "consumer.ts")],
		}, null, 2), "utf-8");

		execFileSync(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "--project", path.join(consumerRoot, "tsconfig.json")], {
			cwd: consumerRoot,
			stdio: "pipe",
		});
	} finally {
		fs.rmSync(consumerRoot, { recursive: true, force: true });
	}
});

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSourceFiles(entryPath).forEach((file) => files.push(file));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
			files.push(entryPath);
		}
	}
	return files;
}

test("published extension APIs use supported package entrypoints", async () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	assert.equal(packageJson.private, undefined, "the bundled package preserves upstream publish metadata");
	assert.deepEqual(packageJson.dm?.extensions, ["./index.ts"]);
	assert.equal(packageJson.files?.includes("index.ts"), true);
	assert.equal(packageJson.files?.includes("*.mjs"), true);
	assert.equal(fs.existsSync(path.join(projectRoot, "async-retention-discovery-worker.mjs")), true);
	const entrySource = fs.readFileSync(path.join(projectRoot, "index.ts"), "utf-8");
	assert.match(entrySource, /import type \{\} from "\.\/src\/types\/dm-runtime-compat\.d\.ts";/);
	assert.equal(entrySource.includes('export { default } from "./src/extension/index.ts";'), false);
	assert.match(entrySource, /process\.env\.DM_SUBAGENT_CHILD === "1"/);
	assert.match(entrySource, /await import\("\.\/src\/extension\/index\.ts"\)/);
	assert.equal(fs.existsSync(path.join(projectRoot, "src", "api", "delegation.ts")), true);
	assert.deepEqual(packageJson.exports, {
		".": "./index.ts",
		"./agents": "./src/api/agents.ts",
		"./inspectors": "./src/api/inspectors.ts",
		"./background-work": "./src/api/background-work.ts",
		"./external-job-provider": "./src/api/external-job-provider.ts",
		"./external-runs": "./src/api/external-runs.ts",
		"./capability-ceiling": "./src/api/capability-ceiling.ts",
		"./workflow-resources": "./src/api/workflow-resources.ts",
		"./required-child-extensions": "./src/api/required-child-extensions.ts",
		"./delegation": "./src/api/delegation.ts",
		"./preflight": "./src/api/preflight.ts",
		"./control-channel": "./src/api/control-channel.ts",
		"./intercom-bridge": "./src/api/intercom-bridge.ts",
		"./child-tool-plan": "./src/api/child-tool-plan.ts",
		"./shared-types": "./src/api/shared-types.ts",
		"./project-panes": "./src/api/project-panes.ts",
	});
	const agents = await import("dm-subagents/agents");
	assert.equal(agents.RUNTIME_AGENT_REGISTER_EVENT, "dm-subagents:runtime-agent-register:v1");
	assert.equal(agents.RUNTIME_AGENT_REGISTER_VERSION, 1);
	assert.equal(typeof agents.registerAgentViaEvents, "function");
	const inspectors = await import("dm-subagents/inspectors");
	assert.equal(inspectors.INSPECTOR_REGISTER_EVENT, "dm-subagents:inspector-register:v1");
	assert.deepEqual(Object.keys(inspectors).sort(), ["INSPECTOR_REGISTER_EVENT", "registerInspector"]);
	const backgroundWork = await import("dm-subagents/background-work");
	assert.equal(backgroundWork.BACKGROUND_WORK_PROTOCOL_VERSION, 1);
	assert.equal(backgroundWork.BACKGROUND_WORK_REGISTRY_KEY, "dm-subagents.background-work.v1");
	const externalJobProvider = await import("dm-subagents/external-job-provider");
	assert.equal(externalJobProvider.EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION, 1);
	assert.equal(externalJobProvider.EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, "dm-subagents.external-job-providers.v1");
	assert.equal(typeof externalJobProvider.registerExternalJobProvider, "function");
	const externalRuns = await import("dm-subagents/external-runs");
	assert.equal(externalRuns.EXTERNAL_RUN_REGISTRY_VERSION, 2);
	assert.equal(typeof externalRuns.registerExternalRun, "function");
	assert.equal(typeof externalRuns.updateExternalRun, "function");
	assert.equal(typeof externalRuns.snapshotExternalRuns, "function");
	assert.equal(typeof externalRuns.unregisterExternalRun, "function");
	const capability = await import("dm-subagents/capability-ceiling");
	const workflowResources = await import("dm-subagents/workflow-resources");
	assert.deepEqual(Object.keys(workflowResources), ["registerWorkflowResource"]);
	assert.equal(typeof workflowResources.registerWorkflowResource, "function");
	assert.equal(capability.SUBAGENT_CAPABILITY_CEILING_VERSION, 1);
	assert.equal(capability.SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY, "dm-subagents.capability-ceiling.v1");
	const delegation = await import("dm-subagents/delegation");
	assert.equal(delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
	const preflight = await import("dm-subagents/preflight");
	assert.equal(preflight.SUBAGENT_LAUNCH_CONTRACT_VERSION, 3);
	assert.equal(typeof preflight.resolveSubagentLaunchContract, "function");
	const controlChannel = await import("dm-subagents/control-channel");
	assert.equal(typeof controlChannel.requestAsyncStop, "function");
	const intercomBridge = await import("dm-subagents/intercom-bridge");
	assert.equal(typeof intercomBridge.resolveIntercomSessionTarget, "function");
	const childToolPlan = await import("dm-subagents/child-tool-plan");
	assert.equal(typeof childToolPlan.resolvePiLaunchToolPlan, "function");
	assert.deepEqual(Object.keys(childToolPlan).sort(), ["resolvePiLaunchToolPlan"]);
	const sharedTypes = await import("dm-subagents/shared-types");
	assert.equal(typeof sharedTypes.wrapForkTask, "function");
	assert.equal(typeof sharedTypes.DEFAULT_FORK_PREAMBLE, "string");
	assert.equal("TEMP_ROOT_DIR" in sharedTypes, false);
	const projectPanes = await import("dm-subagents/project-panes");
	assert.equal(projectPanes.PROJECT_PANES_API_VERSION, 1);
	assert.equal(typeof projectPanes.openProjectPane, "function");
	assert.equal(typeof projectPanes.getProjectPaneStatus, "function");
	assert.equal(typeof projectPanes.closeProjectPane, "function");
});

test("direct @earendil-works runtime imports are declared for CI installs", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	const declared = new Set([
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.devDependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
	]);
	const imported = new Set<string>();

	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(sourceImportPattern)) {
			const specifier = match[1] ?? match[2]!;
			imported.add(specifier.split("/").slice(0, 2).join("/"));
		}
	}

	const missing = [...imported].filter((specifier) => !declared.has(specifier)).sort();
	assert.deepEqual(missing, []);
});

test("direct dependency declarations are exact version pins", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const section of ["dependencies", "devDependencies"] as const) {
		for (const [name, version] of Object.entries<string>(packageJson[section] ?? {})) {
			assert.match(version, section === "devDependencies" && name.startsWith("@duckmind/") ? /^file:\.\.\/\.\.\/dm-mono\/packages\// : exactVersionPattern, `${section}.${name} should use a pinned or local version`);
		}
	}
});

test("host-owned packages are optional peers with supported ranges, not production dependencies", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const name of hostPeerPackages) {
		assert.equal(packageJson.peerDependencies?.[name], expectedHostPeerRanges[name], `${name} should use its supported peer range`);
		assert.equal(packageJson.dependencies?.[name], undefined, `${name} should not be a production dependency`);
		assert.deepEqual(packageJson.peerDependenciesMeta?.[name], { optional: true }, `${name} should be an optional peer`);
	}
});
test("host-owned development packages use the supported SDK baseline", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const [name, version] of Object.entries(expectedHostDevVersions)) {
		assert.equal(packageJson.devDependencies?.[name], version, `${name} should use ${version}`);
	}
});

test("old dm package scope is not used by source or tests", () => {
	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(oldPiScopePattern.test(source), false, file);
	}
});

test("DM package resolution stays export-map safe", () => {
	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(piPackageJsonSubpathPattern.test(source), false, `${file} should not resolve unexported package.json subpaths`);
		assert.equal(cjsPiPackageResolutionPattern.test(source), false, `${file} should not use CommonJS resolution for ESM-only DM packages`);
	}
});
