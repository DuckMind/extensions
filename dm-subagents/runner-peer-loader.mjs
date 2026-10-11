import { pathToFileURL } from "node:url";

let aliases = {};
let nativeRunner = false;
const redirected = new Set([
	"@duckmind/dm-tui",
]);

export function initialize(data) {
	aliases = data?.aliases ?? {};
	nativeRunner = data?.nativeRunner === true;
}

export function resolve(specifier, context, nextResolve) {
	const alias = nativeRunner ? aliases[specifier] : redirected.has(specifier) && aliases[specifier];
	if (alias) {
		const target = pathToFileURL(alias).href;
		return nativeRunner ? { url: target, shortCircuit: true } : nextResolve(target, context);
	}
	return nextResolve(specifier, context);
}
