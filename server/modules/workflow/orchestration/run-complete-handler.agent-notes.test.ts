import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinationLocalizers, createCoordinationDb } from "../../../test/agent-coordination-fixture.ts";
import { createRunCompleteHandler } from "./run-complete-handler.ts";

interface Session {
  sessionId: string;
  agentId: string;
  coordinationContinuations?: number;
  coordinationNoteIds?: number[];
}

const databases: DatabaseSync[] = [];

function createHarness(session: Session = { sessionId: "source-session", agentId: "alpha" }) {
  const db = createCoordinationDb();
  databases.push(db);
  db.exec(`
    ALTER TABLE subtasks ADD COLUMN target_department_id TEXT;
    UPDATE agents SET status = 'working', current_task_id = 'source' WHERE id = 'alpha';
  `);
  const worktree = {
    worktreePath: "/missing/test-repo/.climpire-worktrees/source",
    projectPath: "/missing/test-repo",
    branchName: "climpire/source",
  };
  const deps = {
    ...coordinationLocalizers,
    db,
    activeProcesses: new Map<string, unknown>([["source", {}]]),
    stopProgressTimer: vi.fn(),
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, "pause" | "cancel">(),
    appendTaskLog: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    codexThreadToSubtask: new Map<string, string>(),
    nowMs: () => 1700000000000,
    logsDir: "/missing/coordination-handler-test-logs",
    broadcast: vi.fn(),
    processSubtaskDelegations: vi.fn(),
    taskWorktrees: new Map([["source", worktree]]),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn(() => "Lead"),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    resolveLang: vi.fn(() => "en"),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    crossDeptNextCallbacks: new Map<string, () => void>(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map<string, () => void>(),
    finishReview: vi.fn(),
    reconcileDelegatedSubtasksAfterRun: vi.fn(),
    completeTaskWithoutReview: vi.fn(),
    isReportDesignCheckpointTask: vi.fn(() => false),
    extractReportDesignParentTaskId: vi.fn(() => null),
    resumeReportAfterDesignCheckpoint: vi.fn(),
    isPresentationReportTask: vi.fn(() => false),
    readReportFlowValue: vi.fn(() => null),
    startReportDesignCheckpoint: vi.fn(() => false),
    upsertReportFlowValue: vi.fn((description: string | null) => description ?? ""),
    isReportRequestTask: vi.fn(() => false),
    notifyTaskStatus: vi.fn(),
    prettyStreamJson: vi.fn((raw: string) => raw),
    getWorktreeDiffSummary: vi.fn(() => ""),
    hasVisibleDiffSummary: vi.fn(() => false),
    taskExecutionSessions: new Map([["source", session]]),
    startTaskExecutionForAgent: vi.fn(),
    getDeptName: vi.fn(() => "Development"),
  };
  return { db, deps, worktree, session, ...createRunCompleteHandler(deps) };
}

function addNote(
  db: DatabaseSync,
  messageId: string,
  deliveredAt: number | null = null,
  targetTask = "source",
): number {
  db.prepare(
    "INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, task_id) VALUES (?, 'agent', 'beta', 'agent', 'alpha', 'Reuse the completed implementation.', ?)",
  ).run(messageId, targetTask);
  return Number(
    db
      .prepare(
        "INSERT INTO task_agent_notes (message_id, source_task_id, target_task_id, delivered_at) VALUES (?, 'target', ?, ?)",
      )
      .run(messageId, targetTask, deliveredAt).lastInsertRowid,
  );
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("run complete handler - agent notes", () => {
  it("starts a worktree-preserving continuation for late notes before review or delegated completion", () => {
    const { db, deps, session, handleTaskRunComplete } = createHarness();
    const noteId = addNote(db, "late-note");
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, status) VALUES ('own-subtask', 'source', 'Implement API', 'in_progress')",
    ).run();

    handleTaskRunComplete("source", 0);

    expect(deps.startTaskExecutionForAgent).toHaveBeenCalledExactlyOnceWith(
      "source",
      expect.objectContaining({ id: "alpha" }),
      "dev",
      "Development",
      { reuseWorktree: true },
    );
    expect(session.coordinationContinuations).toBe(1);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'source'").get()).toEqual({ status: "in_progress" });
    expect(db.prepare("SELECT status FROM subtasks WHERE id = 'own-subtask'").get()).toEqual({ status: "in_progress" });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'alpha'").get()).toEqual({
      status: "working",
      current_task_id: "source",
    });
    expect(db.prepare("SELECT delivered_at FROM task_agent_notes WHERE id = ?").get(noteId)).toEqual({
      delivered_at: null,
    });
    expect(deps.finishReview).not.toHaveBeenCalled();
    expect(deps.reconcileDelegatedSubtasksAfterRun).not.toHaveBeenCalled();
    expect(deps.processSubtaskDelegations).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
  });

  it("preserves prior successful work and restores only this failed continuation's delivered notes", () => {
    const { db, deps, worktree, session, handleTaskRunComplete } = createHarness({
      sessionId: "source-session",
      agentId: "alpha",
      coordinationContinuations: 1,
    });
    const deliveredId = addNote(db, "delivered-in-failed-continuation", 100);
    const previouslyHandledId = addNote(db, "handled-in-earlier-run", 90);
    const otherTaskId = addNote(db, "other-task-note", 80, "target");
    session.coordinationNoteIds = [deliveredId, otherTaskId];

    handleTaskRunComplete("source", 1);

    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.taskWorktrees.get("source")).toBe(worktree);
    expect(db.prepare("SELECT delivered_at FROM task_agent_notes WHERE id = ?").get(deliveredId)).toEqual({
      delivered_at: null,
    });
    expect(db.prepare("SELECT delivered_at FROM task_agent_notes WHERE id = ?").get(previouslyHandledId)).toEqual({
      delivered_at: 90,
    });
    expect(db.prepare("SELECT delivered_at FROM task_agent_notes WHERE id = ?").get(otherTaskId)).toEqual({
      delivered_at: 80,
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'source'").get()).toEqual({ status: "inbox" });
    expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledExactlyOnceWith("source", 1);
    expect(deps.finishReview).not.toHaveBeenCalled();
  });

  it("keeps the existing cleanup behavior for failures outside note continuations", () => {
    const { db, deps, worktree, handleTaskRunComplete } = createHarness();
    addNote(db, "unread-after-normal-failure");

    handleTaskRunComplete("source", 1);

    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).toHaveBeenCalledExactlyOnceWith(worktree.projectPath, "source");
    expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledExactlyOnceWith("source", 1);
  });

  it("keeps the usual review transition when no note is unread", () => {
    const { db, deps, handleTaskRunComplete } = createHarness();
    addNote(db, "already-delivered-note", 100);

    handleTaskRunComplete("source", 0);

    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'source'").get()).toEqual({ status: "review" });
    // Delegated items are released after directive integration, not on entering review.
    expect(deps.reconcileDelegatedSubtasksAfterRun).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
  });

  it.each([
    ["pause", "pending"],
    ["cancel", "cancelled"],
  ] as const)("does not restart or finalize a task after a %s request", (mode, status) => {
    const { db, deps, handleTaskRunComplete } = createHarness();
    const noteId = addNote(db, `note-before-${mode}`);
    deps.stopRequestedTasks.add("source");
    deps.stopRequestModeByTask.set("source", mode);
    db.prepare("UPDATE tasks SET status = ? WHERE id = 'source'").run(status);

    handleTaskRunComplete("source", 0);

    expect(deps.startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(deps.reconcileDelegatedSubtasksAfterRun).not.toHaveBeenCalled();
    expect(deps.finishReview).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(db.prepare("SELECT delivered_at FROM task_agent_notes WHERE id = ?").get(noteId)).toEqual({
      delivered_at: null,
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'source'").get()).toEqual({ status });
    if (mode === "pause") expect(deps.clearTaskWorkflowState).not.toHaveBeenCalled();
    else expect(deps.clearTaskWorkflowState).toHaveBeenCalledExactlyOnceWith("source");
  });
});
