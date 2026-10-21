import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionReviewTools } from "./session-review-tools.ts";
import {
  createProviderSessionCapture,
  executionSessionStateLog,
  loadTaskExecutionSession,
} from "../core/execution-session.ts";

describe("durable execution sessions", () => {
  let db: DatabaseSync;
  let nextId: number;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE task_logs (task_id TEXT, kind TEXT, message TEXT, created_at INTEGER)");
    nextId = 0;
  });
  afterEach(() => db.close());
  function appendTaskLog(taskId: string, kind: string, message: string) {
    db.prepare("INSERT INTO task_logs VALUES (?, ?, ?, ?)").run(taskId, kind, message, 100);
  }
  function fixture() {
    return createSessionReviewTools({
      db,
      taskExecutionSessions: new Map(),
      nowMs: () => 100,
      randomUUID: () => `execution-${++nextId}`,
      appendTaskLog,
    });
  }

  it.each([
    ["claude", { type: "system", subtype: "init", session_id: "claude-native-123" }, "claude-native-123"],
    ["codex", { type: "thread.started", thread_id: "codex-native-123" }, "codex-native-123"],
    ["gemini", { type: "init", session_id: "gemini-native-123" }, "gemini-native-123"],
    ["opencode", { type: "step_start", sessionID: "ses_native123", part: { sessionID: "child" } }, "ses_native123"],
  ])("reconstructs %s native and task session IDs after a restart", (provider, event, nativeSessionId) => {
    const session = fixture().ensureTaskExecutionSession("task", "agent", provider);
    const capture = createProviderSessionCapture(provider, (id) => {
      session.nativeSessionId = id;
      appendTaskLog("task", "system", executionSessionStateLog(session));
    });
    const line = JSON.stringify(event) + "\n";
    capture.write(line.slice(0, 12));
    expect(loadTaskExecutionSession(db, "task")?.nativeSessionId).toBeUndefined();
    capture.write(line.slice(12));

    const recovered = fixture().ensureTaskExecutionSession("task", "agent", provider);
    expect(recovered.sessionId).toBe(session.sessionId);
    expect(recovered.nativeSessionId).toBe(nativeSessionId);
    expect(nextId).toBe(1);
  });

  it("rotates the task session and discards native ID when the agent or provider changes", () => {
    const session = fixture().ensureTaskExecutionSession("task", "agent", "claude");
    session.nativeSessionId = "native-123";
    appendTaskLog("task", "system", executionSessionStateLog(session));
    const reassigned = fixture().ensureTaskExecutionSession("task", "other-agent", "claude");
    expect(reassigned.sessionId).not.toBe(session.sessionId);
    expect(reassigned.nativeSessionId).toBeUndefined();
    const changed = fixture().ensureTaskExecutionSession("task", "other-agent", "codex");
    expect(changed.sessionId).not.toBe(reassigned.sessionId);
    expect(changed.nativeSessionId).toBeUndefined();
  });

  it("closing a session after restart prevents its later reconstruction", () => {
    const session = fixture().ensureTaskExecutionSession("task", "agent", "claude");
    fixture().endTaskExecutionSession("task", "done");
    expect(loadTaskExecutionSession(db, "task")).toBeUndefined();
    expect(fixture().ensureTaskExecutionSession("task", "agent", "claude").sessionId).not.toBe(session.sessionId);
  });

  it("uses row ordering when the snapshot timestamps are equal", () => {
    const tools = fixture();
    const session = tools.ensureTaskExecutionSession("task", "agent", "codex");
    appendTaskLog("task", "system", executionSessionStateLog({ ...session, nativeSessionId: "latest" }));
    expect(loadTaskExecutionSession(db, "task")?.nativeSessionId).toBe("latest");
  });

  it("flushes a final event without a newline and ignores subagent IDs and malformed output", () => {
    const captured: string[] = [];
    const capture = createProviderSessionCapture("codex", (id) => captured.push(id));
    capture.write('noise\n{malformed}\n{"type":"item.completed","thread_id":"subagent"}\n');
    capture.write('{"type":"thread.started","thread_id":"--last"}\n');
    capture.write('{"type":"thread.started","thread_id":"main-session"}');
    capture.end();
    expect(captured).toEqual(["main-session"]);
  });
});
