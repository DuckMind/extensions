import type { ExtensionAPI } from "@duckmind/dm-coding-agent";
import type {} from "./src/types/dm-runtime-compat.d.ts";
import { HERDR_PI_MODE_ENV } from "./src/runs/shared/herdr-dm-protocol.ts";
import { loadedPackageVersion, readInstalledPackageVersion } from "./src/shared/package-version.ts";

const registerExtension = process.env[HERDR_PI_MODE_ENV] === "1"
	? (await import("./src/extension/herdr-dm-bridge.ts")).default
	: process.env.DM_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(dm: ExtensionAPI): void {
	const installedVersion = readInstalledPackageVersion();
	if (installedVersion !== loadedPackageVersion) {
		throw new Error(`dm-subagents ${installedVersion} is installed, but this DM process still has ${loadedPackageVersion} loaded. Restart DM to load the update; /reload cannot replace extension modules that Node has already loaded.`);
	}
	registerExtension?.(dm);
}
