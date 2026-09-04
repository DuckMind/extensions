import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { getAgentDir } from "@duckmind/dm-coding-agent";

import { generateVectorImage, isAbortError, normalizeAspectRatio, resolveOutputFormat } from "./src/image-lib.mjs";

const SAVE_MODES = ["project", "global", "custom"];

const imageGenerationSchema = Type.Object(
	{
		prompt: Type.String({
			description:
				"Detailed art direction for the image. Include subject, pose, mood, style, background, and any research findings you want preserved.",
		}),
		aspectRatio: Type.Optional(
			Type.String({
				description: "Target aspect ratio. Supported: 1:1, 4:5, 16:9. Default: 1:1.",
			}),
		),
			model: Type.Optional(
				Type.String({
					description: "Optional model override. Defaults to DuckMind image2/@preset/image2. Use gpt-5.5/openai-codex/gpt-5.5 only for the legacy Codex lane.",
				}),
			),
		outputFormat: Type.Optional(
			Type.String({
				description: "Artifact format. Supported: png, svg. Default: png.",
			}),
		),
		save: Type.Optional(
			Type.String({
				description: "Artifact destination: project, global, or custom. Default: project.",
			}),
		),
		saveDir: Type.Optional(
			Type.String({
				description: "Custom artifact directory when save=custom.",
			}),
		),
	},
	{ additionalProperties: false },
);

function renderImageGenerationText(result) {
	const lines = [`Saved image: ${result.imagePath}`];
	if (result.svgPath && result.svgPath !== result.imagePath) {
		lines.push(`SVG source: ${result.svgPath}`);
	}
	lines.push(`Model: ${result.model}`);
	lines.push(`Aspect: ${result.aspectRatio}`);
	if (result.backendMode) {
		lines.push(`Backend: ${result.backendMode}`);
	}
	if (result.source) {
		lines.push(`Auth source: ${result.source}`);
	}
	return lines.join("\n");
}

export default function registerDmImage(pi) {
	pi.on("session_start", async (_event, ctx) => {
		const agentDir = getAgentDir();
		const openRouterAuthStatus =
			typeof ctx.modelRegistry?.getProviderAuthStatus === "function"
				? ctx.modelRegistry.getProviderAuthStatus("openrouter")
				: undefined;
		const hasOpenRouterKey =
			process.env.OPENROUTER_API_KEY
			|| process.env.OPENROUTER_KEY
			|| existsSync(join(process.cwd(), "config", "openrouter.cnf"))
			|| openRouterAuthStatus?.configured;
		if (!hasOpenRouterKey && !existsSync(join(agentDir, "auth.json"))) {
				ctx.ui.notify(
					"dm-image2: no DuckMind API key or Codex auth.json account found. image2 can use OPENROUTER_API_KEY, /login, or local config; the legacy Codex lane needs ~/.dm/agent/auth.json.",
					"warning",
				);
		}
	});

		pi.registerTool({
			name: "image_generation",
			label: "Image Generation",
				description:
					"Generate a polished PNG image artifact using DuckMind image2 by default, or the bundled imagen.py lane from M only when model=gpt-5.5/openai-codex/gpt-5.5. " +
					"Use this after research for logos, diagrams, posters, portraits, and other image tasks instead of asking the model to dump raw image data inline.",
			promptSnippet:
				"Dedicated image-generation lane. Use it for logos, portraits, diagrams, product shots, posters, UI mockups, character sheets, and artifacts you want saved to disk.",
			promptGuidelines: [
				"Prefer image_generation over raw SVG or markdown image data in the final answer.",
				"Use the bundled image-generation skill's pattern families: product hero, ad storyboard, editorial portrait, poster, character sheet, UI mockup, and comparison exploration.",
				"Do research first when the image must reflect real people, products, or public facts.",
				"Do not call third-party image APIs; route generation through this tool.",
				"Answer with the saved artifact path after the tool succeeds.",
			],
			parameters: imageGenerationSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					const result = await generateVectorImage(
						{
							prompt: params.prompt,
							aspectRatio: normalizeAspectRatio(params.aspectRatio),
							model: params.model,
							outputFormat: resolveOutputFormat(params.outputFormat),
							save: typeof params.save === "string" && SAVE_MODES.includes(params.save) ? params.save : "project",
							saveDir: typeof params.saveDir === "string" ? params.saveDir : undefined,
						},
						ctx.cwd,
						signal,
						{ modelRegistry: ctx.modelRegistry, model: ctx.model },
					);
					const content = [{ type: "text", text: renderImageGenerationText(result) }];
					if (result.imageBase64 && result.mimeType === "image/png") {
						content.push({
							type: "image",
							data: result.imageBase64,
							mimeType: result.mimeType,
						});
				}
					return {
						content,
						details: result,
					};
				} catch (error) {
					if (signal?.aborted || isAbortError(error)) {
						throw error;
					}
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `image_generation failed: ${message}` }],
						details: {
							status: "error",
							message,
						},
					isError: true,
				};
			}
		},
	});
}
