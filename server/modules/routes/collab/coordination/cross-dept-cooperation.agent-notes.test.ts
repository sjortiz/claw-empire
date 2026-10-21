import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinationLocalizers, createCoordinationDb } from "../../../../test/agent-coordination-fixture.ts";
import type { AgentRow } from "../direct-chat.ts";
import { createCrossDeptCooperationTools } from "./cross-dept-cooperation.ts";
import { createExecutionStartTaskTools } from "../../../workflow/orchestration/execution-start-task.ts";
import { continueTaskForAgentNotes } from "../../../workflow/core/agent-coordination.ts";
import { hasUnreadAgentNotes } from "../../../workflow/core/agent-message-inbox.ts";
import type { WorktreeInfo } from "../../../workflow/core/worktree/lifecycle.ts";

// Regression adapted from QA AC-QA-001: initial cooperation and late notes
// must use the same registered isolated worktree, including uncommitted work.
describe("cooperation late-note launch contract (AC-QA-001)", () => {
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

  it.each(
    ["codex", "claude", "gemini", "opencode", "kimi", "api", "copilot", "antigravity"].flatMap((provider) => [
      { provider, failure: false },
      { provider, failure: true },
    ]),
  )("preserves the $provider cooperation launch contract (worktree failure=$failure)", ({ provider, failure }) => {
    const taskWorktrees = new Map<string, WorktreeInfo>();
    db.prepare("UPDATE agents SET cli_provider=? WHERE id='beta'").run(provider);
    const worktreePath = path.join(directory, "isolated");
    fs.mkdirSync(worktreePath);
    const createInitialWorktree = vi.fn((projectPath: string, taskId: string) => {
      if (failure) return null;
      taskWorktrees.set(taskId, { projectPath, worktreePath, branchName: `climpire/${taskId.slice(0, 8)}` });
      return worktreePath;
    });
    const agent = db.prepare("SELECT * FROM agents WHERE id='beta'").get() as unknown as AgentRow;
    const session = { sessionId: "collaboration-session", agentId: "beta" };
    const launch = vi.fn(async (..._args: any[]) => ({ on: vi.fn() }) as unknown as ChildProcess);
    const apiLaunch = vi.fn();
    const httpLaunch = vi.fn();
    const ensureClaudeMd = vi.fn();
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
    const handleTaskRunComplete = vi.fn();
    const handleSubtaskDelegationComplete = vi.fn();
    const linkedSubtaskId = provider === "api" ? "linked-item" : null;
    const crossDeptNextCallbacks = new Map<string, () => void>();
    const cooperation = createCrossDeptCooperationTools({
      ...shared,
      createWorktree: createInitialWorktree,
      ensureClaudeMd,
      recordTaskCreationAudit: vi.fn(),
      delegatedTaskToSubtask: new Map(),
      crossDeptNextCallbacks,
      findTeamLeader: () => agent,
      findBestSubordinate: () => agent,
      getAgentDisplayName: () => "Beta",
      sendAgentMessage: vi.fn(),
      startTaskExecutionForAgent: vi.fn(),
      linkCrossDeptTaskToParentSubtask: () => linkedSubtaskId,
      detectProjectPath: () => directory,
      getDeptRoleConstraint: () => "",
      getRecentConversationContext: () => "",
      buildAvailableSkillsPromptBlock: () => "",
      buildTaskExecutionPrompt: (parts: string[]) => parts.filter(Boolean).join("\n"),
      hasExplicitWarningFixRequest: () => false,
      getProviderModelConfig: () => ({}),
      spawnCliAgent: launch,
      launchApiProviderAgent: apiLaunch,
      launchHttpAgent: httpLaunch,
      getNextHttpAgentPid: () => -1,
      handleSubtaskDelegationComplete,
      handleTaskRunComplete,
      startProgressTimer: vi.fn(),
    });
    cooperation.startCrossDeptCooperation(
      ["dev"],
      0,
      {
        teamLeader: agent,
        taskTitle: "Cooperation",
        ceoMessage: "Coordinate assigned scope.",
        leaderDeptId: "dev",
        leaderDeptName: "Development",
        leaderName: "Beta",
        lang: "en",
        taskId: "parent",
        projectId: "project",
      },
      vi.fn(),
    );
    vi.runAllTimers();
    const providerLaunch =
      provider === "api" ? apiLaunch : ["copilot", "antigravity"].includes(provider) ? httpLaunch : launch;
    if (failure) {
      const taskId = createInitialWorktree.mock.calls[0][1];
      expect(launch).not.toHaveBeenCalled();
      expect(apiLaunch).not.toHaveBeenCalled();
      expect(httpLaunch).not.toHaveBeenCalled();
      expect(taskWorktrees.has(taskId)).toBe(false);
      expect(ensureClaudeMd).not.toHaveBeenCalled();
      expect(appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "error",
        expect.stringContaining("isolated worktree creation failed"),
      );
      // Run completion releases the agent and advances the registered department
      // queue; linked items are reconciled there and complete only after integration.
      expect(crossDeptNextCallbacks.has(taskId)).toBe(true);
      expect(handleTaskRunComplete).toHaveBeenCalledExactlyOnceWith(taskId, 1);
      expect(handleSubtaskDelegationComplete).not.toHaveBeenCalled();
      return;
    }
    expect(providerLaunch).toHaveBeenCalledTimes(1);
    const taskId = providerLaunch.mock.calls[0][0] as string;
    const cwdIndex = provider === "api" ? 4 : 3;
    expect(providerLaunch.mock.calls[0][cwdIndex]).toBe(worktreePath);
    expect(createInitialWorktree).toHaveBeenCalledExactlyOnceWith(directory, taskId, agent.name, undefined);
    expect(taskWorktrees.get(taskId)?.worktreePath).toBe(worktreePath);
    if (provider === "claude") expect(ensureClaudeMd).toHaveBeenCalledExactlyOnceWith(directory, worktreePath);
    const dirtyFile = path.join(worktreePath, "unfinished.ts");
    fs.writeFileSync(dirtyFile, "in-flight implementation");
    db.prepare(
      "INSERT INTO messages(id,sender_type,sender_id,receiver_type,receiver_id,content,task_id) VALUES ('late','agent','alpha','agent','beta','Handle this note before review.',?)",
    ).run(taskId);
    db.prepare("INSERT INTO task_agent_notes(message_id,source_task_id,target_task_id) VALUES ('late','source',?)").run(
      taskId,
    );

    const createWorktree = vi.fn();
    const continuationSpawn = vi.fn(async (..._args: any[]) => ({ on: vi.fn() }) as unknown as ChildProcess);
    const continuationApi = vi.fn();
    const continuationHttp = vi.fn();
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
      launchApiProviderAgent: continuationApi,
      launchHttpAgent: continuationHttp,
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
    const continuationLaunch =
      provider === "api"
        ? continuationApi
        : ["copilot", "antigravity"].includes(provider)
          ? continuationHttp
          : continuationSpawn;
    expect(continuationLaunch).toHaveBeenCalledTimes(1);
    expect(continuationLaunch.mock.calls[0][cwdIndex]).toBe(worktreePath);
    const promptIndex = provider === "api" ? 3 : 2;
    expect(continuationLaunch.mock.calls[0][promptIndex]).toContain("Handle this note before review.");
    expect(hasUnreadAgentNotes(db, taskId)).toBe(false);
    expect(fs.readFileSync(dirtyFile, "utf8")).toBe("in-flight implementation");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(appendTaskLog).not.toHaveBeenCalledWith(taskId, "error", expect.any(String));
  });
});
