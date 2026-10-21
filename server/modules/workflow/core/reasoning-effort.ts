const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function normalizeClaudeEffort(value: string | null | undefined): string | undefined {
  return value && CLAUDE_EFFORT_LEVELS.has(value) ? value : undefined;
}

/** Agent overrides win; unset values preserve the provider's existing defaults. */
export function resolveCliReasoningLevel(
  provider: string,
  agentLevel: string | null | undefined,
  defaultLevel: string | null | undefined,
): string | undefined {
  if (provider === "claude") {
    return normalizeClaudeEffort(agentLevel) || normalizeClaudeEffort(defaultLevel);
  }
  if (provider === "codex") return agentLevel || defaultLevel || undefined;
  return defaultLevel || undefined;
}
