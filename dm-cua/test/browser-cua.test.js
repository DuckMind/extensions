import test from "node:test";
import assert from "node:assert/strict";

import {
	ensureBrowserSelectionUsable,
	classifyHumanInteraction,
	parseListOutput,
	renderBrowserActionText,
	resolveBrowserProcessEnv,
	resolveBrowserRuntimeConfig,
	validateBrowserSelector,
} from "../src/browser-cua-lib.mjs";

test("parseListOutput handles blank-title pages", () => {
	const pages = parseListOutput("AABAB3B6                                                          about:blank\n");
	assert.equal(pages.length, 1);
	assert.deepEqual(pages[0], {
		target: "AABAB3B6",
		title: "",
		url: "about:blank",
	});
});

test("parseListOutput keeps title and url columns", () => {
	const pages = parseListOutput("ABCD1234  Example Domain                                   https://example.com\n");
	assert.equal(pages.length, 1);
	assert.deepEqual(pages[0], {
		target: "ABCD1234",
		title: "Example Domain",
		url: "https://example.com",
	});
});

test("renderBrowserActionText summarizes screenshots", () => {
	const text = renderBrowserActionText({
		action: "screenshot",
		tab: "ABCD1234",
		imagePath: "/tmp/browser.png",
		title: "Example Domain",
		url: "https://example.com",
	});
	assert.match(text, /Saved browser screenshot/);
	assert.match(text, /Example Domain/);
	assert.match(text, /https:\/\/example.com/);
});

test("browser click accepts standard CSS selectors", () => {
	assert.equal(validateBrowserSelector("a[href^='https://example.com']"), "a[href^='https://example.com']");
});

test("browser click rejects jQuery-only :contains before browser startup", () => {
	assert.throws(
		() => validateBrowserSelector("button:contains(Palermo)"),
		/:contains\(\.\.\.\) is not a standard CSS selector.*browser_cua\(evaluate\)/,
	);
});

test("resolveBrowserRuntimeConfig retains an isolated profile per project scope", () => {
	const config = resolveBrowserRuntimeConfig({}, "/tmp/dm-cua-project-a");
	const same = resolveBrowserRuntimeConfig({}, "/tmp/dm-cua-project-a");
	const other = resolveBrowserRuntimeConfig({}, "/tmp/dm-cua-project-b");
	assert.equal(config.port, same.port);
	assert.equal(config.profileDir, same.profileDir);
	assert.notEqual(config.profileDir, other.profileDir);
	assert.ok(config.port >= 9322 && config.port < 9722);
	assert.match(config.profileDir, /\.dm\/agent\/cua\/profiles\/chrome-[a-f0-9]{64}$/);
	assert.match(config.pidFile, /chrome\.pid$/);
	assert.match(config.modeFile, /chrome-mode$/);
	assert.match(config.pagesCache, /cdp-pages\.json$/);
	assert.match(config.socketDir, /dm-cua-cdp-[a-f0-9]{12}$/);
});

test("resolveBrowserRuntimeConfig keeps explicit and ephemeral profile choices", () => {
	const explicit = resolveBrowserRuntimeConfig(
		{ DM_CUA_PROFILE_DIR: "/tmp/custom-dm-cua-profile" },
		"/tmp/dm-cua-profile-choice",
	);
	assert.equal(explicit.profileDir, "/tmp/custom-dm-cua-profile");

	const ephemeral = resolveBrowserRuntimeConfig(
		{ DM_CUA_EPHEMERAL: "1" },
		"/tmp/dm-cua-profile-choice",
	);
	assert.match(ephemeral.profileDir, /dm-cua-chrome-profile-[a-f0-9]{12}$/);
});

test("resolveBrowserRuntimeConfig accepts explicit safe overrides", () => {
	const config = resolveBrowserRuntimeConfig(
		{
			DM_CUA_PORT: "9456",
			DM_CUA_PROFILE_DIR: "/tmp/custom-dm-cua-profile",
			DM_CUA_INSTANCE_ID: "session/one",
		},
		99,
	);
	assert.equal(config.port, 9456);
	assert.equal(config.instanceId, "session-one");
	assert.equal(config.profileDir, "/tmp/custom-dm-cua-profile");
	assert.equal(config.browserKind, "chrome");
	assert.equal(config.browserDisplayName, "Chrome");
});

test("resolveBrowserRuntimeConfig supports opt-in CloakBrowser executable path", () => {
	const config = resolveBrowserRuntimeConfig(
		{
			DM_CUA_BROWSER: "cloakbrowser",
			CLOAKBROWSER_BINARY_PATH: "/opt/cloak/Chromium.app/Contents/MacOS/Chromium",
		},
		"/tmp/dm-cua-project-c",
	);
	assert.equal(config.browserKind, "cloak");
	assert.equal(config.browserDisplayName, "CloakBrowser");
	assert.equal(config.browserExecutablePath, "/opt/cloak/Chromium.app/Contents/MacOS/Chromium");
	assert.match(config.profileDir, /\.dm\/agent\/cua\/profiles\/cloak-[a-f0-9]{64}$/);
});

test("browser process environment stays headless unless visible mode is explicit", () => {
	const config = resolveBrowserRuntimeConfig({}, "/tmp/dm-cua-headless-default");
	const headless = resolveBrowserProcessEnv(config, {});
	assert.equal(Object.hasOwn(headless, "DM_CUA_VISIBLE"), false);
	assert.equal(Object.hasOwn(headless, "GREEDY_SEARCH_VISIBLE"), false);

	const visible = resolveBrowserProcessEnv(config, { DM_CUA_VISIBLE: "1" });
	assert.equal(visible.DM_CUA_VISIBLE, "1");
	assert.equal(visible.GREEDY_SEARCH_VISIBLE, "1");

	const explicitHeadless = resolveBrowserProcessEnv(config, { DM_BROWSER_CUA_VISIBLE: "0" });
	assert.equal(explicitHeadless.DM_CUA_VISIBLE, "0");
	assert.equal(explicitHeadless.GREEDY_SEARCH_VISIBLE, "0");

	const handoff = resolveBrowserProcessEnv(config, {}, { visible: true });
	assert.equal(handoff.DM_CUA_VISIBLE, "1");
	assert.equal(handoff.GREEDY_SEARCH_VISIBLE, "1");
});

test("human interaction detection recognizes verification and login interstitials only", () => {
	assert.deepEqual(classifyHumanInteraction("Just a moment... Cloudflare Turnstile"), {
		needed: true,
		reason: "Just a moment",
	});
	assert.deepEqual(classifyHumanInteraction("Welcome to Example Domain"), {
		needed: false,
		reason: null,
	});
});

test("default Chrome selection discovers or installs a compatible browser", async () => {
	const config = resolveBrowserRuntimeConfig({}, "/tmp/dm-cua-auto-install");
	const result = await ensureBrowserSelectionUsable(config, {
		env: {},
		ensureChrome: async () => ({
			status: "installed",
			path: "/opt/google/chrome",
			method: "test-installer",
			attempts: [{ id: "test-installer", status: "installed", exitCode: 0 }],
		}),
	});

	assert.equal(result.browserExecutablePath, "/opt/google/chrome");
	assert.deepEqual(result.browserInstallation, {
		status: "installed",
		method: "test-installer",
		attempts: [{ id: "test-installer", status: "installed", exitCode: 0 }],
	});
});

test("invalid explicit Chrome path fails closed without running an installer", async () => {
	let installerCalled = false;
	const config = resolveBrowserRuntimeConfig(
		{ DM_CUA_BROWSER_PATH: "/missing/chrome" },
		"/tmp/dm-cua-explicit-path",
	);

	await assert.rejects(
		ensureBrowserSelectionUsable(config, {
			exists: () => false,
			ensureChrome: async () => {
				installerCalled = true;
			},
		}),
		/Chrome executable not found: \/missing\/chrome/,
	);
	assert.equal(installerCalled, false);
});

test("CloakBrowser remains explicit and never triggers automatic installation", async () => {
	let installerCalled = false;
	const config = resolveBrowserRuntimeConfig(
		{ DM_CUA_BROWSER: "cloakbrowser" },
		"/tmp/dm-cua-cloak-guardrail",
	);

	await assert.rejects(
		ensureBrowserSelectionUsable(config, {
			ensureChrome: async () => {
				installerCalled = true;
			},
		}),
		/CloakBrowser selected.*no executable path/i,
	);
	assert.equal(installerCalled, false);
});
