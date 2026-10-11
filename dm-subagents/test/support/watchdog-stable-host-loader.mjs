const modules = {
	"@duckmind/dm-agent-core": `
		export class Agent {}
	`,
	"@duckmind/dm-coding-agent": `
		export function createReadOnlyTools() { return []; }
		export function convertToLlm(messages) { return messages; }
	`,
	"@duckmind/dm-ai": `
		export const stableHostSurface = true;
	`,
	"@duckmind/dm-ai/compat": `
		export function streamSimple() { throw new Error("not invoked by the linking smoke test"); }
	`,
};

export function resolve(specifier, context, nextResolve) {
	const source = modules[specifier];
	if (source !== undefined) {
		return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
