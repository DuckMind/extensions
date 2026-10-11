import assert from "node:assert/strict";
import { AgentSession } from "@duckmind/dm-coding-agent";
import { BACKGROUND_CONTEXT } from "@duckmind/dm-agent-core";
import { createModels, fauxProvider, fauxAssistantMessage } from "@duckmind/dm-ai";

export default function(dm) {
	const state = globalThis.__sdkSmoke;
	assert.equal(AgentSession, state.AgentSession);
	assert.equal(BACKGROUND_CONTEXT, state.BACKGROUND_CONTEXT);
	assert.equal(createModels, state.createModels);
	state.faux = fauxProvider({ provider: "sdk-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
	state.faux.setResponses([fauxAssistantMessage("local response verified")]);
	dm.registerProvider(state.faux.provider);
	dm.on("session_start", () => { state.started++; });
	dm.on("session_shutdown", () => { state.stopped++; });
}
