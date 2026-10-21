import { createHmac } from "node:crypto";
import { SESSION_AUTH_TOKEN } from "../config/runtime.ts";
import { safeSecretEquals } from "./auth.ts";

// Deliberately separate from CEO interrupt controls and the server bearer token.
export function buildAgentMessageToken(taskId: string, sessionId: string): string {
  return createHmac("sha256", SESSION_AUTH_TOKEN)
    .update(JSON.stringify(["agent_messages_v1", taskId, sessionId]))
    .digest("hex");
}

export function hasValidAgentMessageToken(taskId: string, sessionId: string, token: string): boolean {
  return safeSecretEquals(token, buildAgentMessageToken(taskId, sessionId));
}
