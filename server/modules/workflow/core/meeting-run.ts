import type { OneShotRunResult } from "./conversation-types.ts";

// Reply prose may discuss timeout behavior. Only runner errors describe the
// execution outcome; never infer a failed run from the agent's answer.
export function isTimeoutRun(run: Partial<OneShotRunResult> | null | undefined): boolean {
  return /\btimeout\b|timed out|aborted/i.test(run?.error ?? "");
}
