import cliproxy from "../index.ts";

const registered: Array<{ name: string; api?: string; modelCount?: number }> =
	[];
const commands: string[] = [];
const fixtureModels = Array.from({ length: 21 }, (_, index) => ({
	id: `test-model-${index + 1}`,
	owned_by: "test",
}));

const dmMock = {
	registerCommand(name: string, _opts: unknown): void {
		commands.push(name);
	},
	registerProvider(
		name: string,
		config: { api?: string; models?: unknown[] },
	): void {
		registered.push({
			name,
			api: config.api,
			modelCount: config.models?.length,
		});
	},
	unregisterProvider(_name: string): void {},
	on() {},
	registerTool() {},
	registerShortcut() {},
	registerFlag() {},
	getFlag() {
		return undefined;
	},
	registerMessageRenderer() {},
	sendMessage() {},
	sendUserMessage() {},
	appendEntry() {},
	setSessionName() {},
	getSessionName() {
		return undefined;
	},
	setLabel() {},
	exec() {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	},
	getActiveTools() {
		return [];
	},
	getAllTools() {
		return [];
	},
	setActiveTools() {},
	getCommands() {
		return [];
	},
	setModel() {
		return Promise.resolve(true);
	},
	getThinkingLevel() {
		return "off";
	},
	setThinkingLevel() {},
	events: { on() {}, off() {}, emit() {} },
};

const startupLogs: unknown[][] = [];
const originalConsole = {
	log: console.log,
	warn: console.warn,
	error: console.error,
};
const originalFetch = globalThis.fetch;

try {
	const requests: string[] = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input);
		requests.push(url);
		if (url === "https://proxy.example/.well-known/pi") {
			return new Response("", { status: 404 });
		}
		if (url === "https://proxy.example/v1/models") {
			return Response.json({ data: fixtureModels });
		}
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch;
	console.log = (...args: unknown[]) => startupLogs.push(args);
	console.warn = (...args: unknown[]) => startupLogs.push(args);
	console.error = (...args: unknown[]) => startupLogs.push(args);
	await cliproxy(dmMock as any);
	process.stdout.write(
		JSON.stringify({
			requests,
			registered,
			commands: commands.sort(),
			startupLogs,
		}) + "\n",
	);
} finally {
	console.log = originalConsole.log;
	console.warn = originalConsole.warn;
	console.error = originalConsole.error;
	globalThis.fetch = originalFetch;
}
