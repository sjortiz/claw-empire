import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { installSecurityMiddleware } from "../../security/auth.ts";
import { buildAgentMessageToken } from "../../security/agent-messages.ts";
import { registerAgentMessageRoutes } from "../../modules/routes/core/tasks/agent-messages.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinationLocalizers, createCoordinationDb } from "../agent-coordination-fixture.ts";
import type { AgentRow } from "../../modules/routes/collab/direct-chat.ts";
import { createCrossDeptCooperationTools } from "../../modules/routes/collab/coordination/cross-dept-cooperation.ts";
import { createExecutionStartTaskTools } from "../../modules/workflow/orchestration/execution-start-task.ts";
import { continueTaskForAgentNotes } from "../../modules/workflow/core/agent-coordination.ts";
import { hasUnreadAgentNotes } from "../../modules/workflow/core/agent-message-inbox.ts";
import type { WorktreeInfo } from "../../modules/workflow/core/worktree/lifecycle.ts";

// Acceptance regression for the resolved HIGH AC-QA-001.
// Exercise a real authenticated POST between the initial and continuation launch.
describe("QA acceptance: cooperation late-note delivery (AC-QA-001)", () => {
  let db: DatabaseSync;
  let directory: string;
  beforeEach(() => {
    vi.useFakeTimers();
    db = createCoordinationDb();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "qa-note-launch-gap-"));
    db.exec("ALTER TABLE projects ADD COLUMN assignment_mode TEXT DEFAULT 'auto'");
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("delivers an authenticated late note in the same dirty worktree before review without a CEO pause", async () => {
    const taskWorktrees = new Map<string, WorktreeInfo>();
    const agent = db.prepare("SELECT * FROM agents WHERE id='beta'").get() as unknown as AgentRow;
    const session = { sessionId: "collaboration-session", agentId: "beta" };
    const worktreePath = path.join(directory, "isolated");
    fs.mkdirSync(worktreePath);
    const createInitialWorktree = vi.fn((projectPath: string, taskId: string) => {
      taskWorktrees.set(taskId, { projectPath, worktreePath, branchName: `climpire/${taskId.slice(0, 8)}` });
      return worktreePath;
    });
    const launch = vi.fn((..._args: any[]) => ({ on: vi.fn() }));
    const appendTaskLog = vi.fn();
    const shared = {
      db,
      ...coordinationLocalizers,
      taskWorktrees,
      nowMs: () => 100,
      appendTaskLog,
      broadcast: vi.fn(),
      resolveLang: () => "en",
      getDeptName: () => "Development",
      notifyCeo: vi.fn(),
      resolveProjectPath: () => directory,
      ensureTaskExecutionSession: () => session,
      logsDir: directory,
    };
    const cooperation = createCrossDeptCooperationTools({
      ...shared,
      createWorktree: createInitialWorktree,
      recordTaskCreationAudit: vi.fn(),
      delegatedTaskToSubtask: new Map(),
      crossDeptNextCallbacks: new Map(),
      findTeamLeader: () => agent,
      findBestSubordinate: () => agent,
      getAgentDisplayName: () => "Beta",
      sendAgentMessage: vi.fn(),
      startTaskExecutionForAgent: vi.fn(),
      linkCrossDeptTaskToParentSubtask: () => null,
      detectProjectPath: () => directory,
      getDeptRoleConstraint: () => "",
      getRecentConversationContext: () => "",
      buildAvailableSkillsPromptBlock: () => "",
      buildTaskExecutionPrompt: (parts: string[]) => parts.filter(Boolean).join("\n"),
      hasExplicitWarningFixRequest: () => false,
      getProviderModelConfig: () => ({}),
      spawnCliAgent: launch,
      launchApiProviderAgent: vi.fn(),
      launchHttpAgent: vi.fn(),
      getNextHttpAgentPid: () => -1,
      handleSubtaskDelegationComplete: vi.fn(),
      handleTaskRunComplete: vi.fn(),
      startProgressTimer: vi.fn(),
    });
    cooperation.startCrossDeptCooperation(["dev"], 0, {
      teamLeader: agent,
      taskTitle: "Cooperation",
      ceoMessage: "Coordinate assigned scope.",
      leaderDeptId: "dev",
      leaderDeptName: "Development",
      leaderName: "Beta",
      lang: "en",
      taskId: "parent",
      projectId: "project",
    });
    vi.runAllTimers();
    expect(launch).toHaveBeenCalledTimes(1);
    const taskId = launch.mock.calls[0][0];
    expect(taskWorktrees.get(taskId)?.worktreePath).toBe(worktreePath);
    expect(launch.mock.calls[0][3]).toBe(worktreePath);
    const dirtyFile = path.join(worktreePath, "unfinished.txt");
    fs.writeFileSync(dirtyFile, "retain original work");
    vi.useRealTimers();
    const app = express();
    installSecurityMiddleware(app);
    registerAgentMessageRoutes({
      app,
      db,
      nowMs: () => 100,
      taskExecutionSessions: new Map([
        ["source", { sessionId: "source-session", agentId: "alpha" }],
        [taskId, session],
      ]),
      broadcast: shared.broadcast,
      appendTaskLog,
    });
    const posted = await request(app)
      .post("/api/agent-messages")
      .set("Authorization", `Bearer ${buildAgentMessageToken("source", "source-session")}`)
      .send({
        task_id: "source",
        session_id: "source-session",
        to_task_id: taskId,
        content: "Handle this note before review.",
      });
    expect(posted.status).toBe(200);
    expect(hasUnreadAgentNotes(db, taskId)).toBe(true);
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "in_progress" });
    expect(shared.broadcast).toHaveBeenCalledWith(
      "new_message",
      expect.objectContaining({
        sender_id: "alpha",
        receiver_id: "beta",
        task_id: taskId,
      }),
    );

    const createWorktree = vi.fn();
    const continuationSpawn = vi.fn((..._args: any[]) => ({ on: vi.fn() }));
    const starter = createExecutionStartTaskTools({
      ...shared,
      createWorktree,
      spawnCliAgent: continuationSpawn,
      notifyTaskStatus: vi.fn(),
      getDeptRoleConstraint: () => "",
      getRecentConversationContext: () => "",
      getTaskContinuationContext: () => "",
      getRecentChanges: () => "",
      ensureClaudeMd: vi.fn(),
      buildAvailableSkillsPromptBlock: () => "",
      buildTaskExecutionPrompt: (parts: string[]) => parts.filter(Boolean).join("\n"),
      hasExplicitWarningFixRequest: () => false,
      getNextHttpAgentPid: () => -1,
      launchApiProviderAgent: vi.fn(),
      launchHttpAgent: vi.fn(),
      getProviderModelConfig: () => ({}),
      handleTaskRunComplete: vi.fn(),
      startProgressTimer: vi.fn(),
    });
    // Same callback/options as run-complete-handler.ts. Exercise the real
    // starter instead of mocking successful note delivery at this boundary.
    expect(
      continueTaskForAgentNotes({
        db,
        taskId,
        exitCode: 0,
        session,
        stopped: false,
        log: vi.fn(),
        start: (recipient, departmentId) =>
          starter.startTaskExecutionForAgent(taskId, recipient, departmentId, "Development", { reuseWorktree: true }),
      }),
    ).toBe(true);
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "in_progress" });
    expect(hasUnreadAgentNotes(db, taskId)).toBe(false);
    expect(continuationSpawn).toHaveBeenCalledTimes(1);
    expect(continuationSpawn.mock.calls[0][2]).toContain("Handle this note before review.");
    expect(continuationSpawn.mock.calls[0][3]).toBe(worktreePath);
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("retain original work");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(createInitialWorktree).toHaveBeenCalledTimes(1);
    expect(appendTaskLog).not.toHaveBeenCalledWith(taskId, "error", expect.anything());
  });
});
