import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { createOAuthTools } from "./providers/oauth-tools.ts";
import { createProcessTools } from "./providers/process-tools.ts";
import { createCredentialTools } from "./providers/credential-tools.ts";
import { createUsageCliTools } from "./providers/usage-cli-tools.ts";
import { createHttpAgentTools } from "./providers/http-agent-tools.ts";
import { createApiProviderTools } from "./providers/api-provider-tools.ts";

export function initializeWorkflowAgentProviders(ctx: RuntimeContext): any {
  const __ctx: RuntimeContext = ctx;

  const db = __ctx.db;
  const nowMs = __ctx.nowMs;
  const logsDir = __ctx.logsDir;
  const activeProcesses = __ctx.activeProcesses;
  const broadcast = __ctx.broadcast;
  const normalizeStreamChunk = __ctx.normalizeStreamChunk;
  const createSubtaskFromCli = __ctx.createSubtaskFromCli;
  const completeSubtaskFromCli = __ctx.completeSubtaskFromCli;
  const handleTaskRunComplete = (...args: any[]) => __ctx.handleTaskRunComplete(...args);
  const ensureOAuthActiveAccount = __ctx.ensureOAuthActiveAccount;
  const getActiveOAuthAccountIds = __ctx.getActiveOAuthAccountIds;
  const setActiveOAuthAccount = __ctx.setActiveOAuthAccount;

  const processTools = createProcessTools({
    db,
    nowMs,
  });
  const { killPidTree, isPidAlive, interruptPidTree, appendTaskLog } = processTools;

  const oauthTools = createOAuthTools({
    db,
    nowMs,
    ensureOAuthActiveAccount,
    getActiveOAuthAccountIds,
  });
  const {
    ANTIGRAVITY_ENDPOINTS,
    normalizeOAuthProvider,
    getOAuthAccountDisplayName,
    getNextOAuthLabel,
    getOAuthAutoSwapEnabled,
    rotateOAuthAccounts,
    prioritizeOAuthAccount,
    markOAuthAccountFailure,
    markOAuthAccountSuccess,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    loadCodeAssistProject,
  } = oauthTools;

  const credentialTools = createCredentialTools();
  const {
    jsonHasKey,
    fileExistsNonEmpty,
    readClaudeToken,
    readCodexTokens,
    readGeminiCredsFromKeychain,
    freshGeminiToken,
    getGeminiProjectId,
  } = credentialTools;

  const usageCliTools = createUsageCliTools({
    jsonHasKey,
    fileExistsNonEmpty,
    readClaudeToken,
    readCodexTokens,
    readGeminiCredsFromKeychain,
    freshGeminiToken,
    getGeminiProjectId,
  });
  const {
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    cachedCliStatus,
    CLI_STATUS_TTL,
    execWithTimeout,
    detectAllCli,
  } = usageCliTools;

  let httpAgentCounter = Date.now() % 1_000_000;
  const cachedModels: { data: Record<string, string[]>; loadedAt: number } | null = null;
  const MODELS_CACHE_TTL = 60_000;
  function getNextHttpAgentPid(): number {
    httpAgentCounter += 1;
    return -httpAgentCounter;
  }

  const httpAgentTools = createHttpAgentTools({
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    handleTaskRunComplete,
    setActiveOAuthAccount,
    getProviderModelConfig,
    getOAuthAutoSwapEnabled,
    getPreferredOAuthAccounts,
    prioritizeOAuthAccount,
    rotateOAuthAccounts,
    getOAuthAccountDisplayName,
    exchangeCopilotToken,
    refreshGoogleToken,
    loadCodeAssistProject,
    markOAuthAccountFailure,
    markOAuthAccountSuccess,
    ANTIGRAVITY_ENDPOINTS,
  });
  const {
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
    executeCopilotAgent,
    executeAntigravityAgent,
    launchHttpAgent,
  } = httpAgentTools;

  const apiProviderTools = createApiProviderTools({
    appendTaskLog,
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    handleTaskRunComplete,
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
  });
  const { executeApiProviderAgent, launchApiProviderAgent } = apiProviderTools;

  return {
    httpAgentCounter,
    getNextHttpAgentPid,
    cachedModels,
    MODELS_CACHE_TTL,
    normalizeOAuthProvider,
    getNextOAuthLabel,
    getOAuthAccounts,
    getPreferredOAuthAccounts,
    getDecryptedOAuthToken,
    getProviderModelConfig,
    refreshGoogleToken,
    exchangeCopilotToken,
    executeCopilotAgent,
    executeAntigravityAgent,
    executeApiProviderAgent,
    launchHttpAgent,
    launchApiProviderAgent,
    killPidTree,
    isPidAlive,
    interruptPidTree,
    appendTaskLog,
    cachedCliStatus,
    CLI_STATUS_TTL,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    CLI_TOOLS,
    execWithTimeout,
    detectAllCli,
  };
}
