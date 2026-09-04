/**
 * DM Lens dependency bridge for bundled DM artifacts.
 *
 * Bundled extensions intentionally have no nested node_modules. The DM
 * extension loader exposes static host modules and resolved native paths through
 * this symbol before evaluating an extension. Source-package development keeps
 * its normal local dependency fallback in each bridge.
 */
const DM_EXTENSION_MODULES = Symbol.for("duckmind.dm.extension-modules");

interface DmExtensionModuleRegistry {
	modules?: Record<string, unknown>;
	paths?: Record<string, string>;
}

function registry(): DmExtensionModuleRegistry | undefined {
	return (globalThis as typeof globalThis & {
		[DM_EXTENSION_MODULES]?: DmExtensionModuleRegistry;
	})[DM_EXTENSION_MODULES];
}

export function getDmHostModule<T>(specifier: string): T | undefined {
	return registry()?.modules?.[specifier] as T | undefined;
}

export function getDmHostModulePath(specifier: string): string | undefined {
	return registry()?.paths?.[specifier];
}
