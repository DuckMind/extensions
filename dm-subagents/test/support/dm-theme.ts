import { fileURLToPath } from "node:url";
import { loadThemeFromPath, setThemeInstance } from "../../../../dm-mono/packages/coding-agent/dist/modes/interactive/theme/theme.js";

/** Use the checked-in theme while the host's generated dist themes are absent. */
export function initDmTestTheme(): void {
	setThemeInstance(loadThemeFromPath(fileURLToPath(new URL("../../../../theme/duckmind-classic.json", import.meta.url))));
}
