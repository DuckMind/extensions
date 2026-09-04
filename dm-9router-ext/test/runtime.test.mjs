import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalApiKey = process.env.NINE_ROUTER_API_KEY;
const originalBaseUrl = process.env.NINE_ROUTER_BASE_URL;

function modelsResponse(...ids) {
	return new Response(
		JSON.stringify({
			object: "list",
			data: ids.map((id) => ({ id, object: "model", owned_by: "9router" })),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function failedResponse(body, status = 502) {
	return new Response(body, { status, statusText: "Bad Gateway" });
}

function createDmMock({ appendError, registerErrors = [] } = {}) {
	const commands = new Map();
	const events = new Map();
	const registrations = [];
	const unregistrations = [];
	const appendedEntries = [];
	const sentMessages = [];
	let activeRegistration;
	return {
		dm: {
			registerProvider(name, provider) {
				const error = registerErrors.shift();
				if (error) throw error;
				registrations.push({ name, provider });
				activeRegistration = { name, provider };
			},
			unregisterProvider(name) {
				unregistrations.push(name);
				if (activeRegistration?.name === name) activeRegistration = undefined;
			},
			registerCommand(name, command) {
				commands.set(name, command);
			},
			registerTool() {},
			on(name, handler) {
				events.set(name, handler);
			},
			appendEntry(customType, data) {
				appendedEntries.push({ customType, data });
				if (appendError) {
					appendedEntries.pop();
					throw appendError;
				}
			},
			sendUserMessage(message, options) {
				sentMessages.push({ message, options });
			},
		},
		commands,
		events,
		registrations,
		unregistrations,
		appendedEntries,
			sentMessages,
			get activeRegistration() {
				return activeRegistration;
			},
		};
}

function createContext({
	entries = [],
	branchEntries = entries,
	inputs = [],
	selected,
	notifications = [],
} = {}) {
	return {
		signal: AbortSignal.timeout(5000),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branchEntries,
		},
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			input: async () => inputs.shift(),
			select: async () => selected,
		},
	};
}

async function importExtension(label) {
	const url = new URL(`../src/index.ts?test=${label}-${Date.now()}`, import.meta.url);
	return import(url.href);
}

function restoreEnvironment() {
	globalThis.fetch = originalFetch;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalApiKey === undefined) delete process.env.NINE_ROUTER_API_KEY;
	else process.env.NINE_ROUTER_API_KEY = originalApiKey;
	if (originalBaseUrl === undefined) delete process.env.NINE_ROUTER_BASE_URL;
	else process.env.NINE_ROUTER_BASE_URL = originalBaseUrl;
}

test("sanitizes malformed successful model responses", async () => {
	const sentinel = "PRIVATE-ENDPOINT-BODY-SENTINEL";
	globalThis.fetch = async () =>
		new Response(`{${sentinel}`, { status: 200 });
	try {
		const { fetchModels } = await importExtension("invalid-json");
		await assert.rejects(
			fetchModels({ baseUrl: "http://router.invalid", apiKey: undefined }),
			(error) => {
				assert.equal(error.message, "9router returned invalid model metadata");
				assert.doesNotMatch(error.message, new RegExp(sentinel));
				return true;
			},
		);
	} finally {
		restoreEnvironment();
	}
});

test("does not persist an environment-only API key during session migration", async () => {
	const home = mkdtempSync(join(tmpdir(), "dm-9router-env-key-"));
	const sentinel = "ENV-ONLY-SECRET-SENTINEL";
	process.env.HOME = home;
	process.env.NINE_ROUTER_API_KEY = sentinel;
	delete process.env.NINE_ROUTER_BASE_URL;
	globalThis.fetch = async () => modelsResponse("model-a");
	try {
		const extension = await importExtension("env-key");
		const mock = createDmMock();
		await extension.default(mock.dm);
		await mock.events.get("session_start")(
			{},
			createContext({
				entries: [
					{
						type: "custom",
						customType: "9router-config",
						data: { baseUrl: "http://session-router.test" },
					},
				],
			}),
		);
		const raw = readFileSync(
			join(home, ".dm", "agent", "9router-config.json"),
			"utf8",
		);
		const persisted = JSON.parse(raw);
			assert.equal(persisted.baseUrl, "http://session-router.test");
			assert.equal("apiKey" in persisted, false);
			assert.doesNotMatch(raw, new RegExp(sentinel));
			assert.equal(statSync(join(home, ".dm", "agent", "9router-config.json")).mode & 0o777, 0o600);
			assert.deepEqual(mock.appendedEntries, []);
		} finally {
			restoreEnvironment();
		}
	});

test("restores the newest valid 9router config from the current session branch", async () => {
	const home = mkdtempSync(join(tmpdir(), "dm-9router-branch-config-"));
	process.env.HOME = home;
	delete process.env.NINE_ROUTER_API_KEY;
	delete process.env.NINE_ROUTER_BASE_URL;
	const responses = [
		() => modelsResponse("model-a"),
		() => modelsResponse("model-latest"),
	];
	globalThis.fetch = async () => responses.shift()();
	try {
		const extension = await importExtension("branch-config");
		const mock = createDmMock();
		await extension.default(mock.dm);
		await mock.events.get("session_start")(
			{},
			createContext({
				entries: [
					{
						type: "custom",
						customType: "9router-config",
						data: { baseUrl: "http://off-branch-router.test" },
					},
				],
				branchEntries: [
					{
						type: "custom",
						customType: "9router-config",
						data: { baseUrl: "http://older-router.test" },
					},
					{
						type: "custom",
						customType: "9router-config",
						data: { baseUrl: 42 },
					},
					{
						type: "custom",
						customType: "9router-config",
						data: { baseUrl: "  http://latest-router.test/  " },
					},
				],
			}),
		);

		const persisted = JSON.parse(
			readFileSync(join(home, ".dm", "agent", "9router-config.json"), "utf8"),
		);
		assert.equal(persisted.baseUrl, "http://latest-router.test");
		assert.equal(mock.activeRegistration.provider.baseUrl, "http://latest-router.test/v1");
		assert.deepEqual(
			mock.activeRegistration.provider.models.map((model) => model.id),
			["model-latest"],
		);
		assert.deepEqual(mock.appendedEntries, []);
	} finally {
		restoreEnvironment();
	}
});

test("keeps the initial provider when session migration discovery fails", async () => {
	const home = mkdtempSync(join(tmpdir(), "dm-9router-session-atomic-"));
	process.env.HOME = home;
	delete process.env.NINE_ROUTER_API_KEY;
	delete process.env.NINE_ROUTER_BASE_URL;
	const sentinel = "SESSION-RESTORE-SECRET-SENTINEL";
	const responses = [
		() => modelsResponse("model-a"),
		() => failedResponse(sentinel),
	];
	globalThis.fetch = async () => responses.shift()();
	const notifications = [];
	try {
		const extension = await importExtension("session-atomic");
		const mock = createDmMock();
		await extension.default(mock.dm);
		assert.equal(mock.registrations.length, 1);
		assert.equal(mock.unregistrations.length, 0);

		await mock.events.get("session_start")(
			{},
			createContext({
				entries: [
					{
						type: "custom",
						customType: "9router-config",
						data: { baseUrl: "http://broken-session-router.test" },
					},
				],
				notifications,
			}),
		);
		assert.equal(mock.registrations.length, 1);
		assert.equal(mock.unregistrations.length, 0);
		assert.equal(
			existsSync(join(home, ".dm", "agent", "9router-config.json")),
			false,
		);

		await mock.commands.get("9router-models").handler(
			"",
			createContext({ selected: "model-a", notifications }),
		);
		assert.equal(mock.sentMessages.at(-1).message, "/model 9router/model-a");
		assert.doesNotMatch(
			notifications.map((entry) => entry.message).join("\n"),
			new RegExp(sentinel),
		);
	} finally {
		restoreEnvironment();
	}
});

test("keeps the last-good provider and models after failed reload and config", async () => {
	const home = mkdtempSync(join(tmpdir(), "dm-9router-atomic-"));
	process.env.HOME = home;
	delete process.env.NINE_ROUTER_API_KEY;
	delete process.env.NINE_ROUTER_BASE_URL;
	const responses = [
		() => modelsResponse("model-a"),
		() => failedResponse("RELOAD-SECRET-SENTINEL"),
		() => modelsResponse("model-a"),
		() => failedResponse("CONFIG-SECRET-SENTINEL"),
	];
	globalThis.fetch = async () => responses.shift()();
	const notifications = [];
	try {
		const extension = await importExtension("atomic-refresh");
		const mock = createDmMock();
		await extension.default(mock.dm);
		assert.equal(mock.registrations.length, 1);
		assert.equal(mock.unregistrations.length, 0);

		await mock.commands.get("9router-reload").handler(
			"",
			createContext({ notifications }),
		);
		await mock.commands.get("9router-config").handler(
			"",
			createContext({
				inputs: ["http://new-router.test", ""],
				notifications,
			}),
		);
		assert.equal(mock.registrations.length, 1);
		assert.equal(mock.unregistrations.length, 0);
		assert.equal(
			existsSync(join(home, ".dm", "agent", "9router-config.json")),
			false,
		);

		await mock.commands.get("9router-models").handler(
			"",
			createContext({ selected: "model-a", notifications }),
		);
		assert.equal(mock.sentMessages.at(-1).message, "/model 9router/model-a");
		const displayed = notifications.map((entry) => entry.message).join("\n");
		assert.doesNotMatch(displayed, /RELOAD-SECRET-SENTINEL/);
		assert.doesNotMatch(displayed, /CONFIG-SECRET-SENTINEL/);
	} finally {
		restoreEnvironment();
	}
});

test("rolls back provider and memory when the config file cannot be committed", async () => {
	process.env.HOME = "/dev/null";
	delete process.env.NINE_ROUTER_API_KEY;
	delete process.env.NINE_ROUTER_BASE_URL;
	const responses = [
		() => modelsResponse("model-a"),
		() => modelsResponse("model-a"),
		() => modelsResponse("model-b"),
	];
	globalThis.fetch = async () => responses.shift()();
	const notifications = [];
	try {
		const extension = await importExtension("disk-rollback");
		const mock = createDmMock();
		await extension.default(mock.dm);

		await mock.commands.get("9router-config").handler(
			"",
			createContext({
				inputs: ["http://new-router.test", ""],
				notifications,
			}),
		);

		assert.equal(mock.activeRegistration.provider.baseUrl, "http://localhost:20128/v1");
		assert.deepEqual(
			mock.activeRegistration.provider.models.map((model) => model.id),
			["model-a"],
		);
		assert.deepEqual(mock.appendedEntries, []);
		await mock.commands.get("9router-models").handler(
			"",
			createContext({ selected: "model-a", notifications }),
		);
		assert.equal(mock.sentMessages.at(-1).message, "/model 9router/model-a");
		assert.doesNotMatch(
			notifications.map((entry) => entry.message).join("\n"),
			/new-router|ENOTDIR|\/dev\/null/,
		);
	} finally {
		restoreEnvironment();
	}
});

test("rolls back disk, provider, and memory when session append fails", async () => {
	const home = mkdtempSync(join(tmpdir(), "dm-9router-append-rollback-"));
	process.env.HOME = home;
	delete process.env.NINE_ROUTER_API_KEY;
	delete process.env.NINE_ROUTER_BASE_URL;
	const responses = [
		() => modelsResponse("model-a"),
		() => modelsResponse("model-a"),
		() => modelsResponse("model-b"),
	];
	globalThis.fetch = async () => responses.shift()();
	const notifications = [];
	const sentinel = "SESSION-APPEND-FAILURE-SENTINEL";
	try {
		const extension = await importExtension("append-rollback");
		const mock = createDmMock({ appendError: new Error(sentinel) });
		await extension.default(mock.dm);

		await mock.commands.get("9router-config").handler(
			"",
			createContext({
				inputs: ["http://new-router.test", ""],
				notifications,
			}),
		);

		assert.equal(existsSync(join(home, ".dm", "agent", "9router-config.json")), false);
		assert.equal(mock.activeRegistration.provider.baseUrl, "http://localhost:20128/v1");
		assert.deepEqual(
			mock.activeRegistration.provider.models.map((model) => model.id),
			["model-a"],
		);
		assert.deepEqual(mock.appendedEntries, []);
		await mock.commands.get("9router-models").handler(
			"",
			createContext({ selected: "model-a", notifications }),
		);
		assert.equal(mock.sentMessages.at(-1).message, "/model 9router/model-a");
		const displayed = notifications.map((entry) => entry.message).join("\n");
		assert.doesNotMatch(displayed, new RegExp(sentinel));
		assert.doesNotMatch(displayed, /9router updated/);
	} finally {
		restoreEnvironment();
	}
});

test("restores the last-good provider when reload registration fails", async () => {
	const home = mkdtempSync(join(tmpdir(), "dm-9router-register-rollback-"));
	process.env.HOME = home;
	delete process.env.NINE_ROUTER_API_KEY;
	delete process.env.NINE_ROUTER_BASE_URL;
	globalThis.fetch = async () => modelsResponse("model-a");
	const notifications = [];
	const sentinel = "REGISTER-PROVIDER-FAILURE-SENTINEL";
	try {
		const extension = await importExtension("register-rollback");
		const mock = createDmMock({
			registerErrors: [undefined, new Error(sentinel)],
		});
		await extension.default(mock.dm);

		await mock.commands.get("9router-reload").handler(
			"",
			createContext({ notifications }),
		);

		assert.equal(mock.activeRegistration.provider.baseUrl, "http://localhost:20128/v1");
		assert.deepEqual(
			mock.activeRegistration.provider.models.map((model) => model.id),
			["model-a"],
		);
		assert.doesNotMatch(
			notifications.map((entry) => entry.message).join("\n"),
			new RegExp(sentinel),
		);
	} finally {
		restoreEnvironment();
	}
});
