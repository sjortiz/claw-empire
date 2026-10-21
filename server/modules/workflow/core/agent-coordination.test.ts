import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createCoordinationDb, coordinationLocalizers } from "../../../test/agent-coordination-fixture.ts";
import { buildAgentCoordinationContext, continueTaskForAgentNotes } from "./agent-coordination.ts";
import {
  buildAgentInboxBlock,
  hasUnreadAgentNotes,
  loadAgentNotes,
  AGENT_INBOX_MAX_CHARS,
} from "./agent-message-inbox.ts";
import { createExecutionStartTaskTools } from "../orchestration/execution-start-task.ts";

describe("agent coordination prompts and continuation", () => {
  let db: DatabaseSync;
  const paths: string[] = [];
  const session = () => ({ sessionId: "target-session", agentId: "beta", coordinationContinuations: 0 });
  beforeEach(() => {
    db = createCoordinationDb();
  });
  afterEach(() => {
    db.close();
    for (const p of paths.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  });
  function addNote(content = "Ready helper on sibling branch.") {
    const messageId = `message-${Math.random()}`;
    db.prepare(
      "INSERT INTO messages(id,sender_type,sender_id,receiver_type,receiver_id,content,task_id) VALUES (?,'agent','alpha','agent','beta',?,'target')",
    ).run(messageId, content);
    return Number(
      db
        .prepare("INSERT INTO task_agent_notes(message_id,source_task_id,target_task_id) VALUES (?,'source','target')")
        .run(messageId).lastInsertRowid,
    );
  }
  it("keeps solo task prompts unchanged", () => {
    db.exec("DELETE FROM tasks WHERE id IN ('source','target','parent')");
    expect(buildAgentCoordinationContext(db, "unrelated", session(), "en", coordinationLocalizers, 1)).toBe("");
  });
  it.each(["ko", "en", "ja", "zh"] as const)(
    "provides local protocol, scoped identity and unread notes in %s",
    (lang) => {
      const noteId = addNote();
      const context = buildAgentCoordinationContext(db, "target", session(), lang, coordinationLocalizers, 22);
      expect(context).toContain("/api/agent-messages");
      expect(context).toContain("reference_task_id=PARENT_TASK_ID");
      expect(context).toContain('"task_id":"target"');
      expect(context).toContain('"to_task_id":"TARGET_TASK_ID"');
      expect(context).toContain(`note ${noteId}`);
      expect(context).toContain("Ready helper");
      expect(context).not.toContain("Full parent directive reference.");
      expect(hasUnreadAgentNotes(db, "target")).toBe(false);
    },
  );
  it("bounds inbox text without marking omitted notes as delivered", () => {
    for (let i = 0; i < 12; i++) addNote("n".repeat(2000));
    const notes = loadAgentNotes(db, "target");
    const bounded = buildAgentInboxBlock(notes);
    expect(bounded.text.length).toBeLessThanOrEqual(AGENT_INBOX_MAX_CHARS);
    const context = buildAgentCoordinationContext(db, "target", session(), "en", coordinationLocalizers, 33);
    expect(context.length).toBeLessThan(20000);
    expect(hasUnreadAgentNotes(db, "target")).toBe(true);
    expect(loadAgentNotes(db, "target", 0, true)[0].id).toBeGreaterThan(bounded.through);
  });
  it("continues unread successful work without pausing and caps automatic runs", () => {
    addNote();
    const current = session();
    const start = vi.fn();
    const log = vi.fn();
    const run = () =>
      continueTaskForAgentNotes({ db, taskId: "target", exitCode: 0, session: current, stopped: false, start, log });
    expect(run()).toBe(true);
    expect(run()).toBe(true);
    expect(run()).toBe(true);
    expect(run()).toBe(false);
    expect(start).toHaveBeenCalledTimes(3);
    expect(current.coordinationContinuations).toBe(3);
    expect(hasUnreadAgentNotes(db, "target")).toBe(true);
  });
  it("never restarts stopped, failed, reassigned or finished tasks", () => {
    addNote();
    const start = vi.fn();
    const args = { db, taskId: "target", exitCode: 0, session: session(), stopped: false, start, log: vi.fn() };
    expect(continueTaskForAgentNotes({ ...args, stopped: true })).toBe(false);
    expect(continueTaskForAgentNotes({ ...args, exitCode: 1 })).toBe(false);
    expect(continueTaskForAgentNotes({ ...args, session: undefined })).toBe(false);
    db.exec("UPDATE tasks SET assigned_agent_id='alpha' WHERE id='target'");
    expect(continueTaskForAgentNotes(args)).toBe(false);
    db.exec("UPDATE tasks SET assigned_agent_id='beta', status='done' WHERE id='target'");
    expect(continueTaskForAgentNotes(args)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  function createStarter(worktreePath: string | null) {
    const spawn = vi.fn(async () => ({ on: vi.fn() }) as unknown as ChildProcess);
    const createWorktree = vi.fn();
    const tools = createExecutionStartTaskTools({
      db,
      nowMs: () => 100,
      logsDir: paths[0],
      appendTaskLog: vi.fn(),
      broadcast: vi.fn(),
      ensureTaskExecutionSession: () => session(),
      resolveLang: () => "en",
      notifyTaskStatus: vi.fn(),
      resolveProjectPath: () => paths[0],
      createWorktree,
      taskWorktrees: new Map(
        worktreePath ? [["target", { worktreePath, branchName: "climpire/target-1", projectPath: paths[0] }]] : [],
      ),
      getDeptRoleConstraint: () => "",
      getRecentConversationContext: () => "",
      getTaskContinuationContext: () => "Continue existing work.",
      getRecentChanges: () => "",
      ensureClaudeMd: vi.fn(),
      ...coordinationLocalizers,
      buildAvailableSkillsPromptBlock: () => "",
      buildTaskExecutionPrompt: (parts: string[]) => parts.filter(Boolean).join("\n"),
      hasExplicitWarningFixRequest: () => false,
      getNextHttpAgentPid: () => -1,
      launchApiProviderAgent: vi.fn(),
      launchHttpAgent: vi.fn(),
      getProviderModelConfig: () => ({}),
      spawnCliAgent: spawn,
      handleTaskRunComplete: vi.fn(),
      notifyCeo: vi.fn(),
      startProgressTimer: vi.fn(),
    });
    return { ...tools, spawn, createWorktree };
  }
  it("reuses the same dirty worktree and includes peer notes on the continuation prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-note-worktree-"));
    paths.push(dir);
    const dirtyFile = path.join(dir, "unfinished.txt");
    fs.writeFileSync(dirtyFile, "preserve unfinished work");
    addNote();
    const starter = createStarter(dir);
    const agent = db.prepare("SELECT * FROM agents WHERE id='beta'").get();
    starter.startTaskExecutionForAgent("target", agent, "dev", "Development", { reuseWorktree: true });
    expect(starter.createWorktree).not.toHaveBeenCalled();
    expect(starter.spawn).toHaveBeenCalledWith(
      "target",
      "codex",
      expect.stringContaining("Ready helper on sibling branch."),
      dir,
      expect.any(String),
      undefined,
      undefined,
      expect.objectContaining({ executionSession: expect.objectContaining({ sessionId: "target-session" }) }),
    );
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("preserve unfinished work");
  });
  it("blocks a missing continuation worktree without recreating it or consuming notes", () => {
    paths.push(fs.mkdtempSync(path.join(os.tmpdir(), "agent-note-missing-")));
    addNote();
    const starter = createStarter(null);
    starter.startTaskExecutionForAgent(
      "target",
      db.prepare("SELECT * FROM agents WHERE id='beta'").get(),
      "dev",
      "Development",
      { reuseWorktree: true },
    );
    expect(starter.createWorktree).not.toHaveBeenCalled();
    expect(starter.spawn).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id='target'").get()).toMatchObject({ status: "pending" });
    expect(hasUnreadAgentNotes(db, "target")).toBe(true);
  });
});
