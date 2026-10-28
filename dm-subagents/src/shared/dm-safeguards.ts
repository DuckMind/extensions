// DM-specific checks retained across the upstream SDK child-session migration.
const READ_ONLY = new Set(["read", "grep", "find", "ls", "web_search", "fetch_content",
  "get_search_content", "intercom", "contact_supervisor", "structured_output"]);
const IMPLEMENTATION = /\b(?:implement|modify|edit|refactor|ship|land)\b|\b(?:fix|patch)\s+(?:(?:the|a|an|this|that)\s+)?(?:it|bug|defect|issues?|problems?|failures?|regressions?|tests?|errors?|code|source|implementation|files?|module|config|parser|build|workflow)\b|\b(?:create|update|add|remove|replace|delete|write)\s+(?:(?:the|a|an)\s+)?(?:code|files?|tests?|source|module|config|implementation|changes?)\b/i;
const NO_EDIT = /\b(?:do not|don't|must not|without)\s+(?:edit|modify|write|touch|change)(?:(?!\b(?:but|and|then)\b)[^.;,:!?\n])*/gi;
function requiresMutation(task: string): boolean {
  const scoped = task.replace(NO_EDIT, " ");
  return !/\b(?:review only|read.only|analy[sz]e only)\b/i.test(scoped) && IMPLEMENTATION.test(scoped);
}
const PROVIDER_FAILURE = /\b(?:provider.*unavailable|model.*unavailable|overloaded|service unavailable|connection (?:error|reset|closed|aborted|refused)|fetch failed|network error|socket hang up|50[0234]|internal server error|cold.?start|empty response|no output)\b/i;
const TOOL_FAILURE = /^[\w.:@/-]+ failed (?:\(exit \d+\):|with exit code \d+)/i;
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
type RetryEvidence = {
  exitCode: number; error?: string; finalOutput?: string; messages: readonly unknown[];
  toolCount: number; durationMs: number; usage: Usage; observedMutationAttempt?: boolean;
  completionDiagnostic?: boolean;
  stopped?: boolean; timedOut?: boolean; interrupted?: boolean;
};

export function implementationToolsError(agent: string, task: string, tools?: readonly string[],
  mcpDirectTools?: readonly string[]): string | undefined {
  if (!requiresMutation(task) || tools === undefined || tools.some(tool => !READ_ONLY.has(tool))
    || mcpDirectTools?.length) return undefined;
  return `Agent '${agent}' was given an implementation task, but its tool allowlist has no mutation-capable tools.`;
}

export function implementationMutationError(input: {
  agent: string; task: string; tools?: readonly string[]; mcpDirectTools?: readonly string[];
  attempted: boolean; unavailable?: string;
}): string | undefined {
  if (!requiresMutation(input.task) || input.attempted || input.unavailable
    || input.tools !== undefined && input.tools.every(tool => READ_ONLY.has(tool)) && !input.mcpDirectTools?.length) return undefined;
  return `Agent '${input.agent}' completed an implementation task without attempting a mutation. Review its result before accepting it.`;
}

export function dmRetryDelay(run: RetryEvidence, attempt: number): number | undefined {
  if (attempt >= 3 || run.exitCode === 0 || run.stopped || run.timedOut || run.interrupted
    || run.completionDiagnostic || run.observedMutationAttempt || run.toolCount !== 0 || run.finalOutput?.trim()
    || Object.values(run.usage).some(value => value !== 0)) return undefined;
  const error = run.error?.trim();
  // No transcript at all: a short SDK startup failure. Provider errors may
  // contribute one assistant error record, but must never include tool work.
  if (!error && run.messages.length === 0 && run.durationMs <= 2000) return [250, 750, 1500][attempt];
  // SAFETY: transcript entries may have any shape; optional access to a missing errorMessage rejects the retry.
  if (error && !TOOL_FAILURE.test(error) && PROVIDER_FAILURE.test(error)
    && (run.messages.length === 0 || run.messages.length === 1 &&
      (run.messages[0] as { errorMessage?: string })?.errorMessage?.trim() === error)) {
    return [250, 750, 1500][attempt];
  }
  return undefined;
}
