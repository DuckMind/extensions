import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { getAgentDir } from "@duckmind/dm-coding-agent";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_OUTPUT_FORMAT = "png";
const REQUEST_TIMEOUT_MS = 900_000;
const TEST_DELAY_ENV = "DM_IMAGE_TEST_DELAY_MS";
const LEGACY_FALLBACK_ENV = "DM_IMAGE_ALLOW_LEGACY_FALLBACK";
const IMAGE2_MODEL = "@preset/image2";
const DEFAULT_IMAGE_MODEL = IMAGE2_MODEL;
const LEGACY_CODEX_MODEL = "gpt-5.5";
const IMAGE2_ALIASES = new Set([
	"image2",
	IMAGE2_MODEL,
	"duckmind/image2",
	"duckmind/@preset/image2",
	"openrouter/image2",
	"openrouter/@preset/image2",
]);
const LEGACY_CODEX_ALIASES = new Set([
	LEGACY_CODEX_MODEL,
	`openai-codex/${LEGACY_CODEX_MODEL}`,
	`codex/${LEGACY_CODEX_MODEL}`,
]);

const ASPECT_RATIOS = {
	"1:1": { width: 1024, height: 1024 },
	"4:5": { width: 1024, height: 1280 },
	"16:9": { width: 1600, height: 900 },
};

const VENDOR_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..", "vendor", "imagen");
const IMAGEN_SCRIPT = join(VENDOR_DIR, "imagen.py");

function slugify(value) {
	const text = String(value ?? "").trim().toLowerCase();
	const slug = text
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "image";
}

export function normalizeAspectRatio(value) {
	return typeof value === "string" && value in ASPECT_RATIOS ? value : DEFAULT_ASPECT_RATIO;
}

export function resolveOutputFormat(value) {
	return value === "svg" ? "svg" : DEFAULT_OUTPUT_FORMAT;
}

export function resolveImageGenerationModel(value) {
	const raw = String(value ?? "").trim();
	if (LEGACY_CODEX_ALIASES.has(raw)) return LEGACY_CODEX_MODEL;
	return IMAGE2_ALIASES.has(raw) ? IMAGE2_MODEL : DEFAULT_IMAGE_MODEL;
}

function isOpenRouterImageModel(value) {
	return resolveImageGenerationModel(value) === IMAGE2_MODEL;
}

export function isLegacyFallbackEnabled(value = process.env[LEGACY_FALLBACK_ENV]) {
	return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

export function createAbortError(message = "Request was aborted") {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

export function isAbortError(error) {
	if (!error) return false;
	if (error instanceof Error && error.name === "AbortError") return true;
	const message = error instanceof Error ? error.message : String(error);
	return message === "Request was aborted" || message === "This operation was aborted";
}

function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) {
		throw signal.reason;
	}
	throw createAbortError();
}

function createRequestAbortScope(signal, timeoutMs = REQUEST_TIMEOUT_MS) {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(createAbortError(`Image request timed out after ${Math.round(timeoutMs / 1000)}s`)),
		timeoutMs,
	);
	const onAbort = () => {
		controller.abort(signal?.reason instanceof Error ? signal.reason : createAbortError());
	};
	if (signal?.aborted) {
		onAbort();
	} else if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

export function sleepWithSignal(ms, signal) {
	if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
	throwIfAborted(signal);
	return new Promise((resolvePromise, rejectPromise) => {
		const timeoutId = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(createAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function getTestDelayMs() {
	const raw = String(process.env[TEST_DELAY_ENV] ?? "").trim();
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return Math.min(parsed, 300_000);
}

function getAgentPath(fileName) {
	return join(getAgentDir(), fileName);
}

function parseJsonFile(filePath) {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}

function isPlaceholderAccountEmail(value) {
	const email = String(value ?? "").trim().toLowerCase();
	return !email || email === "select";
}

export function isManagedCodexAccountUsable(account, nowMs = Date.now()) {
	const expiresAt =
		typeof account?.expiresAt === "number"
			? account.expiresAt
			: typeof account?.expires_at === "number"
				? account.expires_at
				: undefined;
	const tokenStillFresh = typeof expiresAt !== "number" || expiresAt > nowMs;
	return !!(
		account
		&& account.accessToken
		&& account.accountId
		&& (!account.needsReauth || tokenStillFresh)
	);
}

function selectActiveManagedAccount(storage) {
	if (!storage || typeof storage !== "object") return undefined;
	const accounts = Array.isArray(storage.accounts) ? storage.accounts : [];
	const activeEmail = typeof storage.activeEmail === "string" ? storage.activeEmail : undefined;
	for (const account of accounts) {
		if (activeEmail && account?.email === activeEmail && isManagedCodexAccountUsable(account)) {
			return account;
		}
	}
	return accounts.find((account) => isManagedCodexAccountUsable(account));
}

function selectFallbackAuth(auth) {
	if (!auth || typeof auth !== "object") return undefined;
	const key = Object.keys(auth)
		.filter((candidate) => candidate === "openai-codex" || /^openai-codex-account-\d+$/.test(candidate))
		.sort((left, right) => {
			if (left === "openai-codex") return -1;
			if (right === "openai-codex") return 1;
			return left.localeCompare(right, undefined, { numeric: true });
		})
		.find((candidate) => {
			const value = auth[candidate];
			return value && typeof value === "object" && !Array.isArray(value);
		});
	const entry = key ? auth[key] : undefined;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const accessToken = typeof entry.access === "string" ? entry.access : undefined;
	const accountId =
		typeof entry.accountId === "string"
			? entry.accountId
			: typeof entry.account_id === "string"
				? entry.account_id
				: undefined;
	if (!accessToken || !accountId) return undefined;
	return {
		accessToken,
		accountId,
		email: typeof entry.email === "string" ? entry.email : undefined,
	};
}

export function extractAccountIdFromAccessToken(token) {
	try {
		const parts = String(token ?? "").split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}

function getHeaderValue(headers, key) {
	if (!headers || typeof headers !== "object") return undefined;
	const lower = key.toLowerCase();
	for (const [headerKey, headerValue] of Object.entries(headers)) {
		if (String(headerKey).toLowerCase() !== lower) continue;
		if (typeof headerValue === "string" && headerValue.trim()) {
			return headerValue.trim();
		}
	}
	return undefined;
}

function listLiveCodexModels(runtimeAuthContext) {
	const registry = runtimeAuthContext?.modelRegistry;
	const models = [];
	const seen = new Set();
	const push = (model) => {
		if (!model || typeof model !== "object") return;
		if (model.provider !== "openai-codex") return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		models.push(model);
	};
	push(runtimeAuthContext?.model);
	if (registry && typeof registry.find === "function") {
	push(registry.find("openai-codex", LEGACY_CODEX_MODEL));
	}
	if (registry && typeof registry.getAvailable === "function") {
		for (const model of registry.getAvailable()) {
			push(model);
		}
	}
	return models;
}

export async function resolveLiveSessionCodexCredentials(runtimeAuthContext) {
	const registry = runtimeAuthContext?.modelRegistry;
	if (!registry || typeof registry.getApiKeyAndHeaders !== "function") {
		return undefined;
	}
	for (const model of listLiveCodexModels(runtimeAuthContext)) {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) continue;
		const accountId =
			extractAccountIdFromAccessToken(auth.apiKey)
			|| getHeaderValue(auth.headers, "ChatGPT-Account-Id")
			|| getHeaderValue(auth.headers, "chatgpt-account-id");
		if (!accountId) continue;
		return {
			accessToken: auth.apiKey,
			accountId,
			email: undefined,
			source: `model-registry:${model.provider}/${model.id}`,
		};
	}
	return undefined;
}

export function loadActiveCodexCredentials() {
	const auth = parseJsonFile(getAgentPath("auth.json"));
	const fallback = selectFallbackAuth(auth);
	if (fallback) {
		return {
			...fallback,
			source: "auth.json",
		};
	}
	throw new Error(
		"Missing active Codex credentials. Ensure ~/.dm/agent/auth.json contains an openai-codex or openai-codex-account-N account.",
	);
}

function buildNativeImageInstructions() {
	return [
		"You are a focused image-generation assistant.",
		"Finish by calling image_generation for the final answer.",
		"Do not stop at plain text when the user asked for an image.",
		"Follow the requested visual direction, aspect ratio, and subject details closely.",
	].join(" ");
}

function buildImageInstructions() {
	return [
		"You are a vector illustrator.",
		"Return exactly one standalone SVG image and no prose.",
		"Do not wrap the SVG in markdown fences.",
		"Do not return a data URI unless absolutely necessary.",
		"Do not mention limitations, policies, or explanations in the answer.",
	].join(" ");
}

export function buildVectorPrompt(prompt, aspectRatio) {
	const size = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS[DEFAULT_ASPECT_RATIO];
	return [
		`Create one polished self-contained SVG illustration for this brief: ${prompt}`,
		`Use a ${aspectRatio} aspect ratio with a ${size.width}x${size.height} canvas and a matching viewBox.`,
		"Return only raw <svg>...</svg> markup.",
		"Use simple shapes, gradients, paths, and fills; avoid external fonts, scripts, or remote URLs.",
		"If the request is a portrait, make it respectful, stylized, and presentation-ready.",
	].join("\n");
}

function buildImagenPrompt(prompt, aspectRatio) {
	const size = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS[DEFAULT_ASPECT_RATIO];
	return [
		prompt,
		`Output in exactly ${size.width}px x ${size.height}px (${aspectRatio}).`,
		"Prefer production-ready composition, grounded local detail when relevant, and the strongest final image_generation call.",
	].join("\n");
}

function buildNativeImagePrompt(prompt, aspectRatio) {
	const size = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS[DEFAULT_ASPECT_RATIO];
	return [
		prompt,
		`Target aspect ratio: ${aspectRatio}.`,
		`Compose for roughly ${size.width}x${size.height} output.`,
		"Generate the final answer by calling the image_generation tool.",
		"If the prompt is a portrait or public person, keep it respectful and presentation-ready.",
	].join("\n");
}

export function extractSvgMarkup(text) {
	const raw = String(text ?? "").trim();
	if (!raw) {
		throw new Error("Codex returned an empty image response.");
	}
	const markdownDataUri = raw.match(/!\[[^\]]*]\((data:image\/svg\+xml[^)]+)\)/i);
	if (markdownDataUri?.[1]) {
		const uri = markdownDataUri[1];
		const commaIndex = uri.indexOf(",");
		if (commaIndex !== -1) {
			return decodeURIComponent(uri.slice(commaIndex + 1)).trim();
		}
	}
	const plainDataUri = raw.match(/data:image\/svg\+xml[^,]*,(.+)$/is);
	if (plainDataUri?.[1]) {
		return decodeURIComponent(plainDataUri[1]).trim();
	}
	const fenced = raw.match(/```(?:svg)?\s*([\s\S]*?)```/i);
	const fencedCandidate = fenced?.[1]?.trim();
	if (fencedCandidate?.startsWith("<svg")) {
		return fencedCandidate;
	}
	const inline = raw.match(/<svg[\s\S]*<\/svg>/i);
	if (inline?.[0]) {
		return inline[0].trim();
	}
	throw new Error(`Expected SVG markup from Codex, received: ${raw.slice(0, 240)}`);
}

async function streamCodexResponse(requestBody, credentials, signal) {
	const requestScope = createRequestAbortScope(signal, REQUEST_TIMEOUT_MS);
	let response;
	try {
		response = await fetch(CODEX_RESPONSES_URL, {
			method: "POST",
			signal: requestScope.signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.accessToken}`,
				Accept: "text/event-stream",
				"Cache-Control": "no-cache",
				originator: "Codex Desktop",
				"User-Agent": "Codex Desktop/26.212.1823 (darwin; arm64)",
				"ChatGPT-Account-Id": credentials.accountId,
			},
			body: JSON.stringify(requestBody),
		});
	} catch (error) {
		requestScope.cleanup();
		if (isAbortError(error) || requestScope.signal.aborted) {
			throw createAbortError();
		}
		throw error;
	}

	if (!response.ok) {
		requestScope.cleanup();
		const body = await response.text().catch(() => "");
		throw new Error(`Codex image request failed: HTTP ${response.status} ${body.slice(0, 240)}`);
	}
	if (!response.body) {
		requestScope.cleanup();
		throw new Error("Codex image request returned no response body.");
	}

	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let buffer = "";
	let currentEvent = null;
	let dataLines = [];
	let assistantText = "";
	let responseId;
	const outputItems = [];

	const flushEvent = () => {
		if (!currentEvent || dataLines.length === 0) {
			currentEvent = null;
			dataLines = [];
			return false;
		}
		const payload = JSON.parse(dataLines.join("\n"));
		if (currentEvent === "response.output_text.delta" && typeof payload.delta === "string") {
			assistantText += payload.delta;
		}
		if (currentEvent === "response.output_item.done" && payload.item && typeof payload.item === "object") {
			outputItems.push(payload.item);
		}
		if (currentEvent === "response.completed" || currentEvent === "response.done") {
			responseId = payload.response?.id ?? responseId;
			currentEvent = null;
			dataLines = [];
			return true;
		}
		if (currentEvent === "response.failed" || currentEvent === "response.incomplete") {
			const message =
				payload.response?.error?.message
				|| payload.response?.incomplete_details?.reason
				|| "Codex image request did not complete.";
			throw new Error(String(message));
		}
		currentEvent = null;
		dataLines = [];
		return false;
	};

	try {
		while (true) {
			throwIfAborted(requestScope.signal);
			const { value, done } = await reader.read();
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
			while (true) {
				const lineEnd = buffer.indexOf("\n");
				if (lineEnd === -1) break;
				let line = buffer.slice(0, lineEnd);
				buffer = buffer.slice(lineEnd + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) {
					if (flushEvent()) {
						return { assistantText: assistantText.trim(), outputItems, responseId };
					}
					continue;
				}
				if (line.startsWith("event: ")) {
					currentEvent = line.slice(7).trim();
				} else if (line.startsWith("data: ")) {
					dataLines.push(line.slice(6));
				}
			}
			if (done) break;
		}
		if (dataLines.length > 0) {
			flushEvent();
		}
		return { assistantText: assistantText.trim(), outputItems, responseId };
	} catch (error) {
		await reader.cancel().catch(() => {});
		if (isAbortError(error) || requestScope.signal.aborted) {
			throw createAbortError();
		}
		throw error;
	} finally {
		requestScope.cleanup();
		reader.releaseLock();
	}
}

function resolveOutputRoot(cwd, save, saveDir) {
	switch (save) {
		case "global":
			return resolve(join(getAgentDir(), "generated-images"));
		case "custom":
			if (!saveDir || !String(saveDir).trim()) {
				throw new Error("save=custom requires saveDir.");
			}
			return resolve(String(saveDir).trim());
		case "project":
		default:
			return resolve(cwd, ".dm", "generated-images");
	}
}

function buildImagenSessionRoot(cwd, save, saveDir, runId) {
	const suffix = runId || `run-${randomUUID().slice(0, 8)}`;
	// Keep imagen.py sessions ephemeral and isolated. In this environment the
	// bundled lane has been materially more reliable when its shared-session
	// state lives under /tmp rather than the project tree; DM copies the final
	// artifact back into the requested save root after success.
	return resolve("/tmp", "dm-imagen-runs", suffix);
}

function writeTextFile(filePath, content) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
}

function writeBinaryFile(filePath, content) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
}

function renderSvgToPng(svgPath, pngPath) {
	const sips = spawnSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
		encoding: "utf-8",
	});
	if (sips.status === 0 && existsSync(pngPath)) {
		return;
	}
	const detail = (sips.stderr || sips.stdout || `exit ${sips.status ?? "unknown"}`).trim();
	throw new Error(`Failed to convert SVG to PNG via sips: ${detail}`);
}

export function decodeGeneratedImageData(imageData, outputFormat = "png") {
	const raw = String(imageData ?? "").trim();
	if (!raw) {
		throw new Error("image_generation.result is empty");
	}
	let encoded = raw;
	let mimeType = "";
	if (raw.startsWith("data:")) {
		const commaIndex = raw.indexOf(",");
		if (commaIndex === -1) {
			throw new Error("image_generation.result data URL is malformed");
		}
		const header = raw.slice(5, commaIndex);
		mimeType = String(header.split(";", 1)[0] ?? "").trim();
		encoded = raw.slice(commaIndex + 1);
	}
	const bytes = Buffer.from(encoded, "base64");
	if (!bytes.length) {
		throw new Error("image_generation.result decoded to empty bytes");
	}
	let extension = String(outputFormat || "png").trim().toLowerCase().replace(/^\./, "") || "png";
	if (mimeType === "image/jpeg") extension = "jpg";
	else if (mimeType === "image/webp") extension = "webp";
	else if (mimeType === "image/gif") extension = "gif";
	else if (mimeType === "image/png") extension = "png";
	return {
		bytes,
		mimeType: mimeType || (extension === "jpg" ? "image/jpeg" : `image/${extension}`),
		extension,
	};
}

function stripConfigQuotes(value) {
	return String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function readOpenRouterKeyFile(filePath) {
	if (!filePath || !existsSync(filePath)) return undefined;
	try {
		for (const raw of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
			let line = raw.trim();
			if (!line || line.startsWith("#") || !line.includes("=")) continue;
			if (line.startsWith("export ")) line = line.slice("export ".length).trim();
			const [key, ...rest] = line.split("=");
			const name = key.trim();
			const value = stripConfigQuotes(rest.join("="));
			if ((name === "OPENROUTER_API_KEY" || name === "OPENROUTER_KEY") && value) {
				return { apiKey: value, source: `config:${filePath}` };
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function walkConfigCandidates(startDir) {
	const candidates = [];
	let current = resolve(startDir || process.cwd());
	while (true) {
		candidates.push(join(current, "config", "openrouter.cnf"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return candidates;
}

function resolveOpenRouterKey(cwd) {
	const envKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
	if (envKey) return { apiKey: envKey, source: "env:OPENROUTER_API_KEY" };
	const candidates = [
		...walkConfigCandidates(cwd),
		...walkConfigCandidates(process.cwd()),
		join(homedir(), ".dm", "openrouter.cnf"),
		join(homedir(), ".config", "dm", "openrouter.cnf"),
	];
	const seen = new Set();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		const config = readOpenRouterKeyFile(candidate);
		if (config) return config;
	}
	return undefined;
}

async function resolveRuntimeDuckMindKey(runtimeAuthContext) {
	const registry = runtimeAuthContext?.modelRegistry;
	if (!registry || typeof registry !== "object") return undefined;
	if (typeof registry.getApiKeyForProvider === "function") {
		for (const provider of ["openrouter", "duckmind"]) {
			const apiKey = await registry.getApiKeyForProvider(provider);
			if (typeof apiKey === "string" && apiKey.trim()) {
				return { apiKey: apiKey.trim(), source: `model-registry:${provider}` };
			}
		}
	}
	if (typeof registry.getApiKeyAndHeaders !== "function") return undefined;
	const candidates = [];
	const seen = new Set();
	const push = (model) => {
		if (!model || typeof model !== "object") return;
		const provider = String(model.provider ?? "").toLowerCase();
		if (provider !== "openrouter" && provider !== "duckmind") return;
		const id = String(model.id ?? model.modelId ?? "");
		const key = `${provider}/${id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};
	push(runtimeAuthContext?.model);
	if (typeof registry.find === "function") {
		push(registry.find("openrouter", IMAGE2_MODEL));
		push(registry.find("openrouter", "@preset/free"));
	}
	if (typeof registry.getAvailable === "function") {
		for (const model of registry.getAvailable()) push(model);
	}
	for (const model of candidates) {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (auth?.ok && typeof auth.apiKey === "string" && auth.apiKey.trim()) {
			return { apiKey: auth.apiKey.trim(), source: `model-registry:${model.provider}/${model.id ?? model.modelId ?? ""}` };
		}
	}
	return undefined;
}

async function resolveDuckMindImage2Key(cwd, runtimeAuthContext) {
	return (await resolveRuntimeDuckMindKey(runtimeAuthContext)) ?? resolveOpenRouterKey(cwd);
}

function openRouterResponseText(message) {
	const content = message?.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			return typeof item.text === "string" ? item.text : "";
		})
		.join("")
		.trim();
}

function firstOpenRouterImageData(response) {
	for (const choice of Array.isArray(response?.choices) ? response.choices : []) {
		const message = choice?.message;
		for (const item of Array.isArray(message?.images) ? message.images : []) {
			const imageUrl = item?.image_url;
			const value = typeof imageUrl === "string" ? imageUrl : imageUrl?.url ?? item?.url;
			if (typeof value === "string" && value.trim()) return value.trim();
		}
		for (const item of Array.isArray(message?.content) ? message.content : []) {
			const imageUrl = item?.image_url;
			const value = typeof imageUrl === "string" ? imageUrl : imageUrl?.url ?? item?.url;
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return "";
}

async function generateViaOpenRouterImage({ prompt, aspectRatio, outputFormat, model, outputRoot, baseName, cwd, signal, runtimeAuthContext }) {
	if (outputFormat !== "png") {
		throw new Error("DuckMind image2 currently supports PNG output only.");
	}
	if (typeof fetch !== "function") {
		throw new Error("DuckMind image2 requires a runtime with global fetch support.");
	}
	const key = await resolveDuckMindImage2Key(cwd, runtimeAuthContext);
	if (!key?.apiKey) {
		throw new Error("Missing DuckMind API key for image2. Set OPENROUTER_API_KEY, paste a DuckMind API key via /login, or provide a local DuckMind image service config.");
	}
	const body = {
		model,
		modalities: ["image", "text"],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: buildNativeImagePrompt(prompt, aspectRatio) }],
			},
		],
	};
	const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});
	const responseText = await response.text();
	let payload;
	try {
		payload = responseText ? JSON.parse(responseText) : {};
	} catch {
		payload = {};
	}
	if (!response.ok) {
		const detail = payload?.error?.message || payload?.message || responseText.slice(0, 400) || response.statusText;
		throw new Error(`DuckMind image_generation failed (${response.status}): ${detail}`);
	}
	const imageData = firstOpenRouterImageData(payload);
	if (!imageData) {
		throw new Error("DuckMind image_generation returned no image data.");
	}
	const decoded = decodeGeneratedImageData(imageData, outputFormat);
	const imagePath = join(outputRoot, `${baseName}.${decoded.extension}`);
	writeBinaryFile(imagePath, decoded.bytes);
	const message = payload?.choices?.[0]?.message;
	return {
		status: "ok",
		imagePath,
		svgPath: "",
		imageBase64: decoded.bytes.toString("base64"),
		mimeType: decoded.mimeType,
		prompt,
		aspectRatio,
		model,
		source: key.source,
		responseId: typeof payload?.id === "string" ? payload.id : "",
		revisedPrompt: "",
		backendMode: "openrouter-image-generation",
		requestedBackend: "openrouter:image2",
		authSource: key.source,
		assistantText: openRouterResponseText(message),
		openRouterModel: typeof payload?.model === "string" ? payload.model : "",
	};
}

function nativeImageItems(outputItems) {
	return Array.isArray(outputItems)
		? outputItems.filter((item) => item && typeof item === "object" && item.type === "image_generation_call")
		: [];
}

function loadDmCodexAuthEntry() {
	const active = loadActiveCodexCredentials();
	return {
		tokens: {
			access_token: active.accessToken,
			account_id: active.accountId,
		},
	};
}

function writeImagenAuthFile(sessionRoot) {
	const authFile = join(sessionRoot, "auth.json");
	writeTextFile(authFile, JSON.stringify(loadDmCodexAuthEntry(), null, 2) + "\n");
	return authFile;
}

function listExplicitAuthFileCandidates() {
	const candidates = [];
	const seen = new Set();
	for (const [authSource, rawPath] of [
		["env:auth_file", process.env.auth_file],
		["env:M_AUTH_FILE", process.env.M_AUTH_FILE],
	]) {
		if (typeof rawPath !== "string" || !rawPath.trim()) continue;
		const authFile = resolve(rawPath);
		if (!existsSync(authFile) || seen.has(authFile)) continue;
		seen.add(authFile);
		candidates.push({ kind: "file", authSource, authFile });
	}
	return candidates;
}

function listAuthJsonImagenAuthCandidates() {
	const auth = parseJsonFile(getAgentPath("auth.json"));
	if (!auth || typeof auth !== "object") return [];
	return Object.keys(auth)
		.filter((key) => key === "openai-codex" || /^openai-codex-account-\d+$/.test(key))
		.sort((left, right) => {
			if (left === "openai-codex") return -1;
			if (right === "openai-codex") return 1;
			return left.localeCompare(right, undefined, { numeric: true });
		})
		.map((key) => {
			const account = auth[key];
			const accessToken = typeof account?.access === "string" ? account.access : "";
			const accountId =
				typeof account?.accountId === "string"
					? account.accountId
					: typeof account?.account_id === "string"
						? account.account_id
						: "";
			if (!accessToken || !accountId) return undefined;
			return {
				kind: "managed",
				authSource: `auth.json:${key}`,
				email: typeof account?.email === "string" ? account.email : key,
				authData: {
					tokens: {
						access_token: accessToken,
						account_id: accountId,
					},
				},
			};
		})
		.filter(Boolean);
}

function resolveImagenAuthFile(sessionRoot) {
	return { authFile: writeImagenAuthFile(sessionRoot), authSource: "dm-auth-shim" };
}

function resolveImagenAuthCandidates(sessionRoot, runtimeAuthContext) {
	const candidates = [];
	const seen = new Set();
	const pushInlineCandidate = (sourceLabel, authData) => {
		const accessToken = authData?.tokens?.access_token;
		const accountId = authData?.tokens?.account_id;
		if (typeof accessToken !== "string" || !accessToken.trim()) return;
		if (typeof accountId !== "string" || !accountId.trim()) return;
		const key = `inline:${sourceLabel}:${accountId}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ kind: "managed", authSource: sourceLabel, email: sourceLabel, authData });
	};
	const pushFileCandidate = (sourceLabel, rawPath) => {
		if (!rawPath) return;
		const path = resolve(rawPath);
		if (!existsSync(path)) return;
		const key = `file:${path}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ kind: "file", authSource: sourceLabel, authFile: path });
	};
	const live = runtimeAuthContext?.liveCodexCredentials;
	if (live?.accessToken && live?.accountId) {
		pushInlineCandidate(live.source || "model-registry", {
			tokens: {
				access_token: live.accessToken,
				account_id: live.accountId,
			},
			});
	}
	for (const candidate of listExplicitAuthFileCandidates()) {
		pushFileCandidate(candidate.authSource, candidate.authFile);
	}
	for (const candidate of listAuthJsonImagenAuthCandidates()) {
		const key = `managed:${candidate.email}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push(candidate);
	}
	if (candidates.length === 0) {
		candidates.push({ kind: "file", authSource: "dm-auth-shim", authFile: writeImagenAuthFile(sessionRoot) });
	}
	return candidates;
}

function loadCodexAuthFileCredentials(filePath) {
	const raw = parseJsonFile(filePath);
	const tokens = raw?.tokens;
	const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
	const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
	if (!accessToken || !accountId) return undefined;
	return {
		accessToken,
		accountId,
		email: undefined,
		source: filePath,
	};
}

function loadCodexAuthFileCredentialsFromData(raw) {
	const tokens = raw?.tokens;
	const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
	const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
	if (!accessToken || !accountId) return undefined;
	return {
		accessToken,
		accountId,
		email: undefined,
		source: "managed-inline",
	};
}

export function resolveCustomFallbackCredentials() {
	for (const candidate of listExplicitAuthFileCandidates()) {
		const creds = loadCodexAuthFileCredentials(candidate.authFile);
		if (creds) return { ...creds, source: candidate.authSource };
	}
	for (const candidate of listAuthJsonImagenAuthCandidates()) {
		const creds = loadCodexAuthFileCredentialsFromData(candidate.authData);
		if (creds) return { ...creds, source: candidate.authSource };
	}
	return loadActiveCodexCredentials();
}

async function resolvePreferredCodexCredentials(runtimeAuthContext) {
	const live = await resolveLiveSessionCodexCredentials(runtimeAuthContext);
	if (live) return live;
	return resolveCustomFallbackCredentials();
}

function collectSavedPaths(stdout) {
	return String(stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => resolve(line));
}

function readImagenJsonSession(sessionFile) {
	if (!existsSync(sessionFile)) return [];
	return readFileSync(sessionFile, "utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function latestGeneratedImageMeta(sessionFile) {
	const rows = readImagenJsonSession(sessionFile);
	let savedPath = "";
	let revisedPrompt = "";
	for (const row of rows) {
		if (row?.type === "image_generation_call" && typeof row.saved_path === "string" && row.saved_path) {
			savedPath = row.saved_path;
			if (typeof row.revised_prompt === "string" && row.revised_prompt) {
				revisedPrompt = row.revised_prompt;
			}
		}
	}
	return { savedPath, revisedPrompt };
}

async function runImagenCliWithCandidate({ prompt, aspectRatio, model, outputFormat, cwd, signal, sessionRoot, candidate, index }) {
	const sessionFile = join(sessionRoot, `session-${index}.jsonl`);
	let authFile = candidate.authFile;
	if (candidate.kind === "managed") {
		authFile = join(sessionRoot, `auth-${index}.json`);
		writeTextFile(authFile, JSON.stringify(candidate.authData, null, 2) + "\n");
	}
	const env = {
		...process.env,
		PYTHONPATH: VENDOR_DIR + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""),
		auth_file: authFile,
		model,
		quiet: "1",
		no_session_lock: "1",
		session: `new:${sessionFile}`,
	};
	const timeoutMs = REQUEST_TIMEOUT_MS;
	return await new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const child = spawn("python3", [IMAGEN_SCRIPT, buildImagenPrompt(prompt, aspectRatio)], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
		}, timeoutMs);
		const onAbort = () => {
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(error);
		});
		child.on("close", (code, sig) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				rejectPromise(createAbortError());
				return;
			}
			if (sig === "SIGTERM") {
				rejectPromise(new Error(`imagen.py timed out after ${Math.round(timeoutMs / 1000)}s`));
				return;
			}
			if (code !== 0) {
				rejectPromise(new Error(stderr.trim() || stdout.trim() || `imagen.py exited ${code}`));
				return;
			}
			resolvePromise({
				stdout,
				stderr,
				sessionFile,
				sessionRoot,
				authSource: candidate.authSource,
			});
		});
	});
}

async function runImagenCli({ prompt, aspectRatio, model, outputFormat, cwd, save, saveDir, signal, runId, runtimeAuthContext }) {
	if (outputFormat !== "png") {
		throw new Error("The bundled imagen.py lane only supports PNG output.");
	}
	if (!existsSync(IMAGEN_SCRIPT)) {
		throw new Error(`Bundled imagen.py is missing: ${IMAGEN_SCRIPT}`);
	}
	const sessionRoot = buildImagenSessionRoot(cwd, save, saveDir, runId);
	mkdirSync(sessionRoot, { recursive: true });
	const candidates = resolveImagenAuthCandidates(sessionRoot, runtimeAuthContext);
	const errors = [];
	for (const [index, candidate] of candidates.entries()) {
		try {
			const run = await runImagenCliWithCandidate({
				prompt,
				aspectRatio,
				model,
				outputFormat,
				cwd,
				signal,
				sessionRoot,
				candidate,
				index,
			});
			const savedPaths = collectSavedPaths(run.stdout);
			if (savedPaths.length > 0) {
				return run;
			}
			errors.push(`${candidate.authSource}: no saved image path`);
		} catch (error) {
			if (isAbortError(error)) throw error;
			errors.push(`${candidate.authSource}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`imagen.py candidates exhausted: ${errors.slice(-5).join(" | ")}`);
}

function stageImagenArtifact(savedPath, outputRoot, baseName) {
	const resolvedSavedPath = resolve(savedPath);
	if (!existsSync(resolvedSavedPath)) {
		throw new Error(`imagen.py reported a missing artifact: ${resolvedSavedPath}`);
	}
	const extension = resolvedSavedPath.split(".").pop() || "png";
	const imagePath = join(outputRoot, `${baseName}.${extension}`);
	writeBinaryFile(imagePath, readFileSync(resolvedSavedPath));
	return imagePath;
}

async function generateViaCustomFallback({
	prompt,
	aspectRatio,
	outputFormat,
	model,
	outputRoot,
	baseName,
	credentials,
	signal,
	imagenError,
	requestedBackend,
}) {
	let svgPath = "";
	let imagePath = "";
	let imageBase64 = "";
	let mimeType = "image/png";

	try {
		if (outputFormat === "png") {
			const nativeResponse = await streamCodexResponse(
				{
					model,
					instructions: buildNativeImageInstructions(),
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: buildNativeImagePrompt(prompt, aspectRatio) }],
						},
					],
					reasoning: { effort: "medium", summary: "detailed" },
					tools: [{ type: "image_generation", output_format: "png" }],
					tool_choice: "auto",
					parallel_tool_calls: false,
					store: false,
					stream: true,
					include: ["reasoning.encrypted_content"],
				},
				credentials,
				signal,
			);
			const imageItems = nativeImageItems(nativeResponse.outputItems);
			if (imageItems.length > 0) {
				const imageItem = imageItems[0];
				const decoded = decodeGeneratedImageData(imageItem.result, "png");
				imagePath = join(outputRoot, `${baseName}.${decoded.extension}`);
				writeBinaryFile(imagePath, decoded.bytes);
				imageBase64 = readFileSync(imagePath).toString("base64");
				return {
					status: "ok",
					imagePath,
					svgPath: "",
					imageBase64,
					mimeType: decoded.mimeType,
					prompt,
					aspectRatio,
					model,
						source: credentials.source,
						responseId: nativeResponse.responseId,
						revisedPrompt: typeof imageItem.revised_prompt === "string" ? imageItem.revised_prompt : "",
						backendMode: "native-image-generation",
						requestedBackend,
						imagenError,
						assistantText: nativeResponse.assistantText,
					};
			}
		}

		const { assistantText, responseId } = await streamCodexResponse(
			{
				model,
				instructions: buildImageInstructions(),
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: buildVectorPrompt(prompt, aspectRatio) }],
					},
				],
				reasoning: { effort: "medium", summary: "detailed" },
				tool_choice: "auto",
				parallel_tool_calls: false,
				store: false,
				stream: true,
				include: ["reasoning.encrypted_content"],
			},
			credentials,
			signal,
		);

		throwIfAborted(signal);
		const svgMarkup = extractSvgMarkup(assistantText);
		svgPath = join(outputRoot, `${baseName}.svg`);
		writeTextFile(svgPath, svgMarkup);
		imagePath = svgPath;
		mimeType = "image/svg+xml";
		if (outputFormat === "png") {
			const pngPath = join(outputRoot, `${baseName}.png`);
			throwIfAborted(signal);
			renderSvgToPng(svgPath, pngPath);
			throwIfAborted(signal);
			imagePath = pngPath;
			imageBase64 = readFileSync(pngPath).toString("base64");
			mimeType = "image/png";
		}

		return {
			status: "ok",
			imagePath,
			svgPath,
			imageBase64,
			mimeType,
			prompt,
			aspectRatio,
			model,
				source: credentials.source,
				responseId,
				backendMode: "svg-fallback",
				requestedBackend,
				imagenError,
				assistantText,
			};
	} catch (error) {
		if (isAbortError(error)) {
			for (const artifactPath of [imagePath, svgPath]) {
				if (!artifactPath || !existsSync(artifactPath)) continue;
				try {
					unlinkSync(artifactPath);
				} catch {
					// Best-effort cleanup for aborted runs only.
				}
			}
		}
		throw error;
	}
}

export async function generateVectorImage(params, cwd, signal, runtimeAuthContext = undefined) {
	const prompt = String(params.prompt ?? "").trim();
	if (!prompt) {
		throw new Error("image_generation.prompt is required.");
	}
	throwIfAborted(signal);

	const aspectRatio = normalizeAspectRatio(params.aspectRatio);
	const outputFormat = resolveOutputFormat(params.outputFormat);
	const model = resolveImageGenerationModel(params.model);
	const outputRoot = resolveOutputRoot(cwd, params.save ?? "project", params.saveDir);
	mkdirSync(outputRoot, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const slug = slugify(prompt);
	const baseName = `image-${timestamp}-${slug}-${randomUUID().slice(0, 8)}`;

	if (isOpenRouterImageModel(model)) {
		return await generateViaOpenRouterImage({
			prompt,
			aspectRatio,
			outputFormat,
			model,
			outputRoot,
			baseName,
				cwd,
				signal,
				runtimeAuthContext,
			});
	}

	const liveCodexCredentials = await resolveLiveSessionCodexCredentials(runtimeAuthContext);
	const credentials = liveCodexCredentials ?? resolveCustomFallbackCredentials();

	try {
		const testDelayMs = getTestDelayMs();
		if (testDelayMs > 0) {
			await sleepWithSignal(testDelayMs, signal);
		}

		let imagenError = "";
		const allowLegacyFallback = isLegacyFallbackEnabled();
		if (outputFormat === "png") {
			try {
				const run = await runImagenCli({
				prompt,
				aspectRatio,
				model,
				outputFormat,
					cwd,
					save: params.save ?? "project",
					saveDir: params.saveDir,
					signal,
					runId: baseName,
					runtimeAuthContext: liveCodexCredentials ? { liveCodexCredentials } : runtimeAuthContext,
				});
				const savedPaths = collectSavedPaths(run.stdout);
				if (savedPaths.length > 0) {
					const meta = latestGeneratedImageMeta(run.sessionFile);
					const imagePath = stageImagenArtifact(meta.savedPath || savedPaths[0], outputRoot, baseName);
					const imageBase64 = readFileSync(imagePath).toString("base64");
					return {
						status: "ok",
						imagePath,
						svgPath: "",
						imageBase64,
						mimeType: "image/png",
						prompt,
						aspectRatio,
						model,
						source: credentials.source,
						responseId: "",
					revisedPrompt: meta.revisedPrompt || "",
					backendMode: "imagen-py",
					requestedBackend: "imagen-py",
					authSource: run.authSource,
					assistantText: String(run.stderr ?? "").trim(),
					sessionFile: run.sessionFile,
					imagenSavedPaths: savedPaths,
					};
				}
				imagenError = `imagen.py produced no saved image path. stderr=${run.stderr.trim().slice(0, 400)}`;
				} catch (error) {
					if (isAbortError(error)) {
						throw error;
					}
					imagenError = error instanceof Error ? error.message : String(error);
				}
			if (!allowLegacyFallback) {
				throw new Error(
					`Bundled imagen.py is required for PNG image_generation, but it failed: ${imagenError}. `
					+ `Provide a healthy DM Codex credential source or set ${LEGACY_FALLBACK_ENV}=1 only for emergency legacy fallback debugging.`,
				);
			}
			}

			return await generateViaCustomFallback({
			prompt,
			aspectRatio,
			outputFormat,
			model,
			outputRoot,
				baseName,
				credentials,
				signal,
				imagenError,
				requestedBackend: "legacy-fallback",
			});
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		throw error;
	}
}
