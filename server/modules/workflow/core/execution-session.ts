export interface TaskExecutionSessionState {
  sessionId: string;
  taskId: string;
  agentId: string;
  provider: string;
  openedAt: number;
  lastTouchedAt: number;
  nativeSessionId?: string;
}

const SESSION_STATE_PREFIX = "Execution session state: ";

export function executionSessionStateLog(session: TaskExecutionSessionState, closed = false): string {
  return SESSION_STATE_PREFIX + JSON.stringify({ ...session, closed });
}

export function loadTaskExecutionSession(db: any, taskId: string): TaskExecutionSessionState | undefined {
  const row = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(taskId, `${SESSION_STATE_PREFIX}%`) as { message: string } | undefined;
  if (!row) return undefined;
  try {
    const state = JSON.parse(row.message.slice(SESSION_STATE_PREFIX.length));
    if (
      state.closed ||
      state.taskId !== taskId ||
      typeof state.sessionId !== "string" ||
      typeof state.agentId !== "string" ||
      typeof state.provider !== "string" ||
      !Number.isFinite(state.openedAt) ||
      !Number.isFinite(state.lastTouchedAt)
    ) {
      return undefined;
    }
    if (state.nativeSessionId !== undefined && !isNativeSessionId(state.nativeSessionId)) return undefined;
    return state;
  } catch {
    return undefined;
  }
}

export function isNativeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value);
}

// Parse complete JSON lines only: provider events are frequently split across stdout chunks.
export function createProviderSessionCapture(provider: string, onSession: (nativeSessionId: string) => void) {
  let pending = "";
  function parseLine(line: string): void {
    try {
      const event = JSON.parse(line);
      const nativeSessionId =
        provider === "claude" && event.type === "system" && event.subtype === "init"
          ? event.session_id
          : provider === "codex" && event.type === "thread.started"
            ? event.thread_id
            : provider === "gemini" && event.type === "init"
              ? event.session_id
              : provider === "opencode"
                ? event.sessionID
                : undefined;
      if (isNativeSessionId(nativeSessionId)) onSession(nativeSessionId);
    } catch {
      // Human-readable output and incomplete/malformed events do not identify sessions.
    }
  }
  return {
    write(text: string): void {
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        parseLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      // Bound memory if a provider emits a very long non-JSON line.
      if (pending.length > 1024 * 1024) pending = "";
    },
    end(): void {
      if (pending) parseLine(pending);
      pending = "";
    },
  };
}
