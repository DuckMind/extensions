import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
	buildVectorPrompt,
	createAbortError,
	decodeGeneratedImageData,
	extractAccountIdFromAccessToken,
	extractSvgMarkup,
	isManagedCodexAccountUsable,
	isLegacyFallbackEnabled,
	isAbortError,
	generateVectorImage,
	normalizeAspectRatio,
	resolveCustomFallbackCredentials,
	resolveImageGenerationModel,
	resolveOutputFormat,
	sleepWithSignal,
} from "../src/image-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("extractSvgMarkup accepts raw svg", () => {
	const svg = "<svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg>";
	assert.equal(extractSvgMarkup(svg), svg);
});

test("extractSvgMarkup unwraps fenced svg", () => {
	const actual = extractSvgMarkup("```svg\n<svg viewBox='0 0 10 10'></svg>\n```");
	assert.equal(actual, "<svg viewBox='0 0 10 10'></svg>");
});

test("extractSvgMarkup decodes markdown svg data uri", () => {
	const actual = extractSvgMarkup("![duck](data:image/svg+xml;utf8,%3Csvg%20viewBox%3D'0%200%2010%2010'%3E%3C/svg%3E)");
	assert.equal(actual, "<svg viewBox='0 0 10 10'></svg>");
});

test("buildVectorPrompt bakes in aspect ratio instructions", () => {
	const prompt = buildVectorPrompt("DuckMind duck logo", "4:5");
	assert.match(prompt, /4:5/);
	assert.match(prompt, /1024x1280/);
	assert.match(prompt, /DuckMind duck logo/);
});

test("normalizers clamp unsupported values", () => {
	assert.equal(normalizeAspectRatio("wide"), "1:1");
	assert.equal(normalizeAspectRatio("16:9"), "16:9");
	assert.equal(resolveOutputFormat("jpeg"), "png");
	assert.equal(resolveOutputFormat("svg"), "svg");
});

test("image generation defaults non-ultra requests to the OpenRouter image2 preset", () => {
	assert.equal(resolveImageGenerationModel(), "@preset/image2");
	assert.equal(resolveImageGenerationModel("legacy-model"), "@preset/image2");
	assert.equal(resolveImageGenerationModel("free"), "@preset/image2");
	assert.equal(resolveImageGenerationModel("image2"), "@preset/image2");
	assert.equal(resolveImageGenerationModel("duckmind/image2"), "@preset/image2");
	assert.equal(resolveImageGenerationModel("ultra"), "@preset/image2");
	assert.equal(resolveImageGenerationModel("duckmind/ultra"), "@preset/image2");
	assert.equal(resolveImageGenerationModel("openai-codex/gpt-5.5"), "gpt-5.5");
});

test("default image backend writes OpenRouter image data using the runtime DuckMind API key", async () => {
	const previousKey = process.env.OPENROUTER_API_KEY;
	const previousAltKey = process.env.OPENROUTER_KEY;
	const previousFetch = globalThis.fetch;
	const dir = mkdtempSync(resolve(tmpdir(), "dm-image2-openrouter-"));
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_KEY;
	globalThis.fetch = async (_url, init) => {
		assert.equal(init.headers.Authorization, "Bearer registry-key");
		const body = JSON.parse(String(init.body));
		assert.equal(body.model, "@preset/image2");
		assert.deepEqual(body.modalities, ["image", "text"]);
		return {
			ok: true,
			status: 200,
			async text() {
				return JSON.stringify({
					id: "or-test",
					model: "openai/gpt-5.4-image-2",
					choices: [
						{
							message: {
								content: "done",
								images: [
									{
										image_url: {
											url: "data:image/png;base64," + Buffer.from("png-bytes").toString("base64"),
										},
									},
								],
							},
						},
					],
				});
			},
		};
	};
	try {
				const result = await generateVectorImage(
					{ prompt: "pixel duck", outputFormat: "png", save: "custom", saveDir: dir },
					dir,
					undefined,
					{
						model: { provider: "duckmind", id: "free" },
						modelRegistry: {
							async getApiKeyForProvider(provider) {
								return provider === "openrouter" ? "registry-key" : undefined;
							},
						},
					},
				);
		assert.equal(result.model, "@preset/image2");
		assert.equal(result.backendMode, "openrouter-image-generation");
		assert.equal(result.openRouterModel, "openai/gpt-5.4-image-2");
		assert.equal(result.source, "model-registry:openrouter");
		assert.equal(readFileSync(result.imagePath, "utf-8"), "png-bytes");
	} finally {
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		if (previousAltKey === undefined) delete process.env.OPENROUTER_KEY;
		else process.env.OPENROUTER_KEY = previousAltKey;
		globalThis.fetch = previousFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy fallback gate stays opt-in", () => {
	assert.equal(isLegacyFallbackEnabled(), false);
	assert.equal(isLegacyFallbackEnabled("1"), true);
	assert.equal(isLegacyFallbackEnabled("true"), true);
	assert.equal(isLegacyFallbackEnabled("no"), false);
});

test("extractAccountIdFromAccessToken reads the ChatGPT account claim", () => {
	const payload = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct-123",
		},
	};
	const token = [
		Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"sig",
	].join(".");
	assert.equal(extractAccountIdFromAccessToken(token), "acct-123");
});

test("managed Codex account accepts fresh token even with stale reauth flag", () => {
	const now = 1_000;
	assert.equal(
		isManagedCodexAccountUsable(
			{
				accessToken: "token",
				accountId: "acct-123",
				needsReauth: true,
				expiresAt: now + 60_000,
			},
			now,
		),
		true,
	);
	assert.equal(
		isManagedCodexAccountUsable(
			{
				accessToken: "token",
				accountId: "acct-123",
				needsReauth: true,
				expiresAt: now - 1,
			},
			now,
		),
		false,
	);
});

test("explicit auth_file is accepted as image fallback credential source", () => {
	const previousAuthFile = process.env.auth_file;
	const previousMAuthFile = process.env.M_AUTH_FILE;
	const dir = mkdtempSync(resolve(tmpdir(), "dm-image2-auth-"));
	try {
		const authPath = resolve(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				tokens: {
					access_token: "token",
					account_id: "acct-123",
				},
			}),
		);
		process.env.auth_file = authPath;
		delete process.env.M_AUTH_FILE;
		const actual = resolveCustomFallbackCredentials();
		assert.equal(actual.source, "env:auth_file");
		assert.equal(actual.accountId, "acct-123");
		assert.equal(actual.accessToken, "token");
	} finally {
		if (previousAuthFile === undefined) delete process.env.auth_file;
		else process.env.auth_file = previousAuthFile;
		if (previousMAuthFile === undefined) delete process.env.M_AUTH_FILE;
		else process.env.M_AUTH_FILE = previousMAuthFile;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("decodeGeneratedImageData accepts data URLs", () => {
	const payload = "data:image/png;base64," + Buffer.from("png-bytes").toString("base64");
	const actual = decodeGeneratedImageData(payload, "png");
	assert.equal(actual.mimeType, "image/png");
	assert.equal(actual.extension, "png");
	assert.equal(actual.bytes.toString("utf-8"), "png-bytes");
});

test("abort helpers classify and reject aborts", async () => {
	const controller = new AbortController();
	const pending = sleepWithSignal(10_000, controller.signal);
	controller.abort(createAbortError());
	await assert.rejects(pending, (error) => {
		assert.equal(isAbortError(error), true);
		return true;
	});
});

test("bundled skill teaches pattern workflows without external API coupling", () => {
	const skill = readFileSync(resolve(__dirname, "../skills/image-generation/SKILL.md"), "utf8");
	assert.match(skill, /Reusable prompt pattern library/);
	assert.match(skill, /Product hero/);
	assert.match(skill, /Ad creative/);
	assert.match(skill, /Editorial portrait/);
	assert.match(skill, /UI .* mockup/);
	assert.match(skill, /image_generation/);
	assert.doesNotMatch(skill, /gpt-image-2-gen-skill/);
	assert.doesNotMatch(skill, /evolink\.ai/i);
});
