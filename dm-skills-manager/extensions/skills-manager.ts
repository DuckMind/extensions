/**
 * kendex DM Skills Manager.
 *
 * A polished /skills manager view for browsing, previewing, inserting, creating,
 * editing, renaming, deleting, and enabling/disabling DM skills.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@duckmind/dm-coding-agent";
import { INSTALL_SYMBOL } from "./skills-manager/constants.js";
import { createSkillFromAnswers } from "./skills-manager/creation.js";
import { showSkillsManager } from "./skills-manager/dialog.js";
import { recordProjectTrust } from "./skills-manager/paths.js";
import { deleteSkill, loadSkillRegistry } from "./skills-manager/registry.js";
import { settingBoolean, updatePackageConfig } from "./skills-manager/settings.js";
import { patchInteractiveModeStartupSkillsBlock, setStartupHideEnabled } from "./skills-manager/startup.js";
import { setSkillEnabled } from "./skills-manager/toggle.js";
import { EMPTY_REGISTRY, type SkillEntry, type SkillRegistry } from "./skills-manager/types.js";

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 180 ? `${message.slice(0, 179)}…` : message;
}

function insertNativeSkillCommand(ctx: ExtensionContext, skill: SkillEntry): void {
	ctx.ui.pasteToEditor(`/skill:${skill.name}\n`);
}

function dmThinkingLevel(value: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
    if (value === "max") return "xhigh";
    return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
        ? value
        : "off";
}

export default function skillsManager(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	patchInteractiveModeStartupSkillsBlock();
	setStartupHideEnabled(settingBoolean("enabled", true) && settingBoolean("hideStartupSkillsBlock", true));

	let registry: SkillRegistry = EMPTY_REGISTRY;
	const enabledAtLoad = settingBoolean("enabled", true);

	if (!enabledAtLoad) {
		const enableRecovery = async (ctx: ExtensionCommandContext) => {
			updatePackageConfig(ctx.cwd, { enabled: true });
			ctx.ui.notify("Skills Manager enabled. Reloading...", "info");
			await ctx.reload();
		};
		pi.registerCommand("skills", {
			description: "Skills manager recovery command.",
			handler: async (args, ctx) => {
				if (args.trim().toLowerCase() !== "enable") {
					ctx.ui.notify("Skills Manager is disabled. Run /skills:enable, then /reload.", "warning");
					return;
				}
				await enableRecovery(ctx);
			},
		});
		pi.registerCommand("skills:enable", {
			description: "Re-enable the skills manager",
			handler: async (_args, ctx) => enableRecovery(ctx),
		});
		return;
	}

	async function refreshRegistry(cwd: string): Promise<SkillRegistry> {
		registry = await loadSkillRegistry(cwd);
		return registry;
	}

	async function prepareSession(ctx: ExtensionContext): Promise<boolean> {
		recordProjectTrust(ctx);
		setStartupHideEnabled(settingBoolean("enabled", true, ctx.cwd) && settingBoolean("hideStartupSkillsBlock", true, ctx.cwd));
		try {
			await refreshRegistry(ctx.cwd);
		} catch (error) {
			registry = EMPTY_REGISTRY;
			ctx.ui.notify(`Skills Manager failed to load registry: ${errorMessage(error)}`, "error");
		}
		return false;
	}

	pi.registerCommand("skills", {
		description: "DM skills manager view. Native skills remain /skill:name.",
		handler: async (args, ctx) => {
			const rawArgs = args.trim();
			const trimmed = rawArgs.toLowerCase();
			if (trimmed === "enable") {
				updatePackageConfig(ctx.cwd, { enabled: true });
				ctx.ui.notify("Skills Manager already enabled.", "info");
				return;
			}
			if (trimmed === "disable") {
				updatePackageConfig(ctx.cwd, { enabled: false });
				ctx.ui.notify("Skills Manager disabled. Run /reload to unload commands/hooks.", "info");
				return;
			}
			if (rawArgs) {
				ctx.ui.notify("Use /skill:name for native skill invocation, or /skills with no arguments for the manager.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/skills manager requires interactive mode", "warning");
				return;
			}
			try {
				await refreshRegistry(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`Failed to load skills list: ${errorMessage(error)}`, "error");
				return;
			}
			const selection = await showSkillsManager(ctx, registry, {
				onCreate: async (answers, signal) => await createSkillFromAnswers(ctx, answers, { thinkingLevel: dmThinkingLevel(pi.getThinkingLevel()), signal }),
				onDelete: async (skill) => await deleteSkill(ctx, skill),
				onToggle: async (skill, enabled) => await setSkillEnabled(ctx.cwd, skill, enabled),
				onRefresh: async () => await refreshRegistry(ctx.cwd),
			});
			if (selection) insertNativeSkillCommand(ctx, selection);
		},
	});

	pi.on("session_start", async (_event, ctx) => { await prepareSession(ctx); });
}
