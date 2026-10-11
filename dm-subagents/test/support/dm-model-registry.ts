import * as path from "node:path";
import { AuthStorage, ModelRegistry, type ExtensionAPI } from "@duckmind/dm-coding-agent";

type FauxHandle = {
	api: string;
	provider: { streamSimple: (...args: any[]) => any };
	getModel(id: string): { provider: string };
};

/** Current DM session SDK supplies storage and registry separately. */
export function createDmTestRegistry(agentDir: string, faux?: FauxHandle) {
	const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
	if (faux) authStorage.setRuntimeApiKey(faux.getModel("local").provider, "test");
	const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
	return { authStorage, modelRegistry };
}

export function registerDmTestProvider(api: ExtensionAPI, faux: FauxHandle): void {
	const model = faux.getModel("local");
	api.registerProvider(model.provider, {
		api: faux.api, baseUrl: "http://localhost:0", apiKey: "test",
		models: [model], streamSimple: faux.provider.streamSimple,
	} as never);
}
