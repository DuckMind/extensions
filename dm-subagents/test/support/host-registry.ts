import * as path from "node:path";
import { AuthStorage, ModelRegistry, type ExtensionAPI } from "@duckmind/dm-coding-agent";
import type { FauxProviderHandle } from "@duckmind/dm-ai";

export function testModelRegistry(agentDir: string) {
	const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
	return ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
}

export function registerTestProvider(api: ExtensionAPI, faux: FauxProviderHandle): void {
	const model = faux.getModel("local");
	api.registerProvider(model.provider, {
		api: faux.api, baseUrl: model.baseUrl, apiKey: "test",
		models: [model], streamSimple: faux.provider.streamSimple,
	} as never);
}
