import { existsSync } from "node:fs";
import { Type } from "@sinclair/typebox";

import {
	renderBrowserActionText,
	resolveBrowserHelperPaths,
	runBrowserAction,
} from "./src/browser-cua-lib.mjs";

const browserActionSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("list"),
				Type.Literal("navigate"),
				Type.Literal("snapshot"),
				Type.Literal("screenshot"),
				Type.Literal("click"),
				Type.Literal("click_xy"),
				Type.Literal("type"),
					Type.Literal("evaluate"),
					Type.Literal("handoff"),
					Type.Literal("stop"),
			],
			{
				description:
					"Browser action. Start with list, snapshot, or screenshot before mutating actions on unfamiliar pages. Use handoff to show the retained DM browser window for user-authorized login or verification.",
			},
		),
		tab: Type.Optional(
			Type.String({
				description:
					"Optional target tab prefix from browser_cua(list). If omitted, the first live page in the dedicated profile is used.",
			}),
		),
		url: Type.Optional(Type.String({ description: "URL for action=navigate." })),
		selector: Type.Optional(
			Type.String({
				description:
					"Standard CSS selector for action=click; :contains(...) is not supported. Use evaluate for text matching.",
			}),
		),
		x: Type.Optional(Type.Number({ description: "CSS x coordinate for action=click_xy." })),
		y: Type.Optional(Type.Number({ description: "CSS y coordinate for action=click_xy." })),
		text: Type.Optional(Type.String({ description: "Text for action=type." })),
		expression: Type.Optional(Type.String({ description: "JavaScript expression for action=evaluate." })),
	},
	{ additionalProperties: false },
);

export default function registerDmCua(pi) {
	pi.on("session_start", async (_event, ctx) => {
		const { launchScript, cdpScript } = resolveBrowserHelperPaths();
		if (!existsSync(launchScript) || !existsSync(cdpScript)) {
			ctx.ui.notify(
				"dm-cua: bundled browser helpers are missing. Rebuild DM to restore them.",
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "browser_cua",
		label: "Browser CUA",
		description:
			"Drive a dedicated Chrome browser profile through DM's bundled browser CUA lane. " +
			"If Chrome/Chromium is absent, DM attempts a non-interactive OS package-manager install before launch. " +
				"Inspect first with list, snapshot, or screenshot. Fresh empty profiles auto-bootstrap a blank tab. " +
				"Use handoff when a site needs you to complete a login or verification in the visible browser; DM never solves challenges or enters credentials. " +
				"Use navigate for deterministic URLs, click with a standard CSS selector/click_xy/type for page interaction, evaluate for focused DOM reads or text matching, and stop to close the dedicated browser lane.",
		promptSnippet:
			"First-class browser CUA for Chrome with automatic browser bootstrap. Inspect before acting. Screenshot complex pages before click/scroll loops.",
		parameters: browserActionSchema,
		async execute(_toolCallId, params) {
			try {
				const result = await runBrowserAction(params);
				const content = [{ type: "text", text: renderBrowserActionText(result) }];
				if (result.imageBase64 && result.mimeType) {
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
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `browser_cua failed: ${message}` }],
					details: {
						status: "error",
						action: params?.action ?? null,
						message,
					},
				};
			}
		},
	});
}
