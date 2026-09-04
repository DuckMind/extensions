declare module "@duckmind/dm-agent-core" {
	interface AgentToolResult<T> {
		/** Runtime error flag emitted and rendered by dm tool execution. */
		isError?: boolean;
	}
}

export {};
