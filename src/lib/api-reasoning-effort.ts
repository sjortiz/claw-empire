export const API_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

const OPENAI_COMPATIBLE_PROVIDER_TYPES = new Set([
  "openai",
  "ollama",
  "openrouter",
  "together",
  "groq",
  "cerebras",
  "custom",
]);

export function supportsApiReasoningEffort(providerType?: string | null): boolean {
  return Boolean(providerType && OPENAI_COMPATIBLE_PROVIDER_TYPES.has(providerType));
}

export function resolveApiReasoningEffort(providerType: string, reasoningLevel?: string | null): string | undefined {
  if (!supportsApiReasoningEffort(providerType)) return undefined;
  return API_REASONING_LEVELS.find((level) => level === reasoningLevel);
}
