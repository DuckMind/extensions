/**
 * Re-export from shared path-utils.
 * Kept as a local module for LSP imports that use relative paths.
 */
export {
	isUnderDir,
	kernelPathIdentityAsync,
	normalizeEphemeralMapKey,
	normalizeMapKey,
	pathsEqual,
	realpathOrResolveAsync,
	uriToDiskPath,
	uriToPath,
} from "../path-utils.js";
