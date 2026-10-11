/** DM 0.80 carries the active tool and prompt snapshot on system messages. */
export function getCurrentSystemPrompt(context: { systemPrompt?: string }): string {
	return context.systemPrompt ?? "";
}

export function getCurrentTools(context: { tools?: any[] }): any[] {
	return context.tools ?? [];
}

export function getSystemMessageText(message: { content?: string }): string {
	return message.content ?? "";
}
