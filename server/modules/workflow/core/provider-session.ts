import fs from "node:fs";

const PREFIX = "Provider session: ";
const SUPPORTED = new Set(["claude", "codex", "gemini", "opencode", "kimi"]);

export function providerSessionId(provider: string, event: any): string | null {
  let id: unknown;
  if (provider === "codex" && event.type === "thread.started") id = event.thread_id;
  if (provider === "claude" || provider === "gemini" || provider === "kimi") id = event.session_id;
  if (provider === "opencode") id = event.sessionID;
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? id : null;
}

export function readProviderSession(db: any, taskId: string, provider: string, logPath: string): string | null {
  if (!SUPPORTED.has(provider)) return null;
  const row = db
    .prepare?.(
      "SELECT message FROM task_logs WHERE task_id = ? AND message LIKE 'Provider session: %' ORDER BY rowid DESC LIMIT 1",
    )
    .get(taskId);
  if (row) {
    try {
      const stored = JSON.parse(row.message.slice(PREFIX.length));
      if (stored.provider === provider)
        return providerSessionId(provider, {
          type: "thread.started",
          session_id: stored.id,
          thread_id: stored.id,
          sessionID: stored.id,
        });
      return null;
    } catch {
      return null;
    }
  }
  // Runs predating native-session persistence can resume from terminal JSONL.
  // Never guess a provider session using --last.
  try {
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const id = providerSessionId(provider, JSON.parse(lines[i]));
        if (id) return id;
      } catch {
        // Headers, stderr and partial JSON are not session identifiers.
      }
    }
  } catch {
    // No saved provider session: start fresh in the same worktree.
  }
  return null;
}

export function createProviderSessionCapture(provider: string, onSession: (id: string) => void) {
  let pending = "";
  let lastId: string | null = null;
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > 1_000_000) pending = "";
    for (const line of lines) {
      try {
        const id = providerSessionId(provider, JSON.parse(line));
        if (id && id !== lastId) {
          lastId = id;
          onSession(id);
        }
      } catch {
        // Providers may interleave plain text with JSONL.
      }
    }
  };
}
