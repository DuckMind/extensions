import type { BeforeProviderRequestEvent, ExtensionAPI } from "@duckmind/dm-coding-agent";

export function rewriteFastModeProviderRequest(event: BeforeProviderRequestEvent): unknown {
	if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return event.payload;
	return { ...event.payload, service_tier: "priority" };
}

export default function registerSubagentFastModeExtension(dm: ExtensionAPI): void {
	dm.on("before_provider_request", rewriteFastModeProviderRequest);
}
