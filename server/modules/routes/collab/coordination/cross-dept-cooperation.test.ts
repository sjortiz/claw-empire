import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../../bootstrap/schema/task-schema-migrations.ts";
import { createCrossDeptCooperationTools } from "./cross-dept-cooperation.ts";

type ProviderCase = {
  provider: "api" | "copilot" | "antigravity" | "claude";
  launchKind: "api" | "http" | "cli";
  effort?: string;
  defaultEffort?: string;
  expectedEffort?: string;
  initiallyBusy?: boolean;
  worktreeFails?: boolean;
};

type SeededAgents = {
  teamLeader: any;
  crossLeader: any;
  execAgent: any;
};

function pickVariant(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}

function seedCollaborationFixture(db: DatabaseSync, provider: ProviderCase["provider"]): SeededAgents {
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color, sort_order)
    VALUES
      ('planning', 'Planning', '기획', 'P', '#111827', 1),
      ('dev', 'Development', '개발', 'D', '#1d4ed8', 2);

    INSERT INTO projects (id, name, project_path, core_goal, default_pack_key, created_at, updated_at)
    VALUES ('project-1', 'Demo', '/workspace/demo', 'Ship it', 'development', 1, 1);

    INSERT INTO agents (
      id, name, name_ko, department_id, workflow_pack_key, role, cli_provider,
      oauth_account_id, api_provider_id, api_model, avatar_emoji, status, created_at
    ) VALUES
      ('planning-leader', 'Planner', '기획팀장', 'planning', 'development', 'team_leader', 'claude', NULL, NULL, NULL, ':P', 'idle', 1),
      ('dev-leader', 'Dev Lead', '개발팀장', 'dev', 'development', 'team_leader', 'claude', NULL, NULL, NULL, ':D', 'idle', 1),
      ('dev-worker', 'Dev Worker', '개발담당', 'dev', 'development', 'senior', '${provider}', 'oauth-1', 'api-provider-1', 'model-1', ':W', 'idle', 1);

    INSERT INTO tasks (
      id, title, description, department_id, assigned_agent_id, project_id,
      status, priority, task_type, workflow_pack_key, project_path, created_at, updated_at
    ) VALUES (
      'task-parent',
      'Parent task',
      'Need development support',
      'planning',
      'planning-leader',
      'project-1',
      'collaborating',
      1,
      'general',
      'development',
      '/workspace/demo',
      1,
      1
    );
  `);

  return {
    teamLeader: db.prepare("SELECT * FROM agents WHERE id = ?").get("planning-leader") as any,
    crossLeader: db.prepare("SELECT * FROM agents WHERE id = ?").get("dev-leader") as any,
    execAgent: db.prepare("SELECT * FROM agents WHERE id = ?").get("dev-worker") as any,
  };
}

describe("createCrossDeptCooperationTools", () => {
  let db: DatabaseSync | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db?.close();
    db = null;
  });

  it("recovers lost graph callbacks through dependency dispatch without creating legacy department tasks", () => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    seedCollaborationFixture(db, "api");
    db.exec(`
      INSERT INTO tasks (id, title, source_task_id, status) VALUES ('graph-child', 'Child', 'task-parent', 'done');
      INSERT INTO task_logs (task_id, kind, message) VALUES ('task-parent', 'system', 'Planned graph seeded 3 subtasks with explicit dependencies');
    `);
    const processSubtaskDelegations = vi.fn();
    const maybeNotifyAllSubtasksComplete = vi.fn();
    const startTaskExecutionForAgent = vi.fn();
    const tools = createCrossDeptCooperationTools({
      db,
      processSubtaskDelegations,
      maybeNotifyAllSubtasksComplete,
      startTaskExecutionForAgent,
    });
    tools.recoverCrossDeptQueueAfterMissingCallback("graph-child");
    expect(processSubtaskDelegations).toHaveBeenCalledWith("task-parent");
    expect(maybeNotifyAllSubtasksComplete).toHaveBeenCalledWith("task-parent");
    expect(startTaskExecutionForAgent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<ProviderCase>([
    { provider: "api", launchKind: "api", initiallyBusy: true },
    { provider: "api", launchKind: "api", worktreeFails: true },
    { provider: "api", launchKind: "api" },
    { provider: "copilot", launchKind: "http" },
    { provider: "antigravity", launchKind: "http" },
    { provider: "api", launchKind: "api", effort: "none" },
    { provider: "claude", launchKind: "cli" },
    { provider: "claude", launchKind: "cli", defaultEffort: "high", expectedEffort: "high" },
    { provider: "claude", launchKind: "cli", effort: "low", defaultEffort: "high", expectedEffort: "low" },
  ])(
    "routes $provider collaboration tasks through the $launchKind launcher",
    ({ provider, launchKind, effort, defaultEffort, expectedEffort, initiallyBusy, worktreeFails }) => {
      db = new DatabaseSync(":memory:");
      applyBaseSchema(db);
      applyTaskSchemaMigrations(db);

      const { teamLeader, crossLeader, execAgent } = seedCollaborationFixture(db, provider);

      db.prepare("UPDATE agents SET cli_reasoning_level = ? WHERE id = ?").run(effort ?? null, execAgent.id);
      const launchApiProviderAgent = vi.fn();
      const launchHttpAgent = vi.fn();
      const spawnCliAgent = vi.fn((..._args: unknown[]) => ({ on: vi.fn() }));
      const handleTaskRunComplete = vi.fn();

      const { startCrossDeptCooperation } = createCrossDeptCooperationTools({
        db,
        createWorktree: vi.fn(() => (worktreeFails ? null : "/isolated/collaboration")),
        ensureClaudeMd: vi.fn(),
        nowMs: () => 1_717_171_717_000,
        appendTaskLog: vi.fn(),
        broadcast: vi.fn(),
        recordTaskCreationAudit: vi.fn(),
        delegatedTaskToSubtask: new Map(),
        crossDeptNextCallbacks: new Map(),
        findTeamLeader: (deptId: string) => (deptId === "dev" ? crossLeader : null),
        findBestSubordinate: (deptId: string) => (deptId === "dev" ? execAgent : null),
        resolveLang: () => "en",
        getDeptName: (deptId: string) => (deptId === "dev" ? "Development" : "Planning"),
        getAgentDisplayName: (agent: { name?: string }) => agent.name ?? "",
        sendAgentMessage: vi.fn(),
        notifyCeo: vi.fn(),
        l: (ko: unknown, en: unknown, ja: unknown, zh: unknown) => ({ ko, en, ja, zh }),
        pickL: (messages: Record<string, unknown>, lang: string) =>
          pickVariant(messages[lang] ?? messages.en ?? messages.ko),
        startTaskExecutionForAgent: vi.fn(),
        linkCrossDeptTaskToParentSubtask: vi.fn(() => null),
        detectProjectPath: vi.fn(() => "/workspace/demo"),
        resolveProjectPath: vi.fn((task: { project_path?: string | null }) => task.project_path ?? "/workspace/demo"),
        logsDir: "/tmp",
        getDeptRoleConstraint: vi.fn(() => ""),
        getRecentConversationContext: vi.fn(() => ""),
        buildAvailableSkillsPromptBlock: vi.fn(() => ""),
        buildTaskExecutionPrompt: vi.fn((parts: unknown[]) =>
          parts
            .map((part) => String(part ?? "").trim())
            .filter(Boolean)
            .join("\n"),
        ),
        hasExplicitWarningFixRequest: vi.fn(() => false),
        ensureTaskExecutionSession: vi.fn((taskId: string, agentId: string, currentProvider: string) => ({
          sessionId: `session-${taskId}`,
          agentId,
          provider: currentProvider,
        })),
        getProviderModelConfig: vi.fn(() => ({ claude: { reasoningLevel: defaultEffort } })),
        spawnCliAgent,
        launchApiProviderAgent,
        launchHttpAgent,
        getNextHttpAgentPid: vi.fn(() => 4242),
        handleSubtaskDelegationComplete: vi.fn(),
        handleTaskRunComplete,
        startProgressTimer: vi.fn(),
      });

      startCrossDeptCooperation(["dev"], 0, {
        teamLeader,
        taskTitle: "Parent task",
        ceoMessage: "Need development support",
        leaderDeptId: "planning",
        leaderDeptName: "Planning",
        leaderName: "Planner",
        lang: "en",
        taskId: "task-parent",
        projectId: "project-1",
      });

      if (initiallyBusy) {
        db.prepare(
          "UPDATE agents SET status = 'working', current_task_id = 'existing-run' WHERE department_id = 'dev'",
        ).run();
        vi.advanceTimersByTime(1500);
        expect(launchApiProviderAgent).not.toHaveBeenCalled();
        expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source_task_id = 'task-parent'").get()).toMatchObject({
          n: 0,
        });
        expect(db.prepare("SELECT current_task_id FROM agents WHERE id = 'dev-worker'").get()).toMatchObject({
          current_task_id: "existing-run",
        });
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = 'dev-worker'").run();
      }

      vi.runAllTimers();

      const crossTask = db
        .prepare("SELECT status, assigned_agent_id, source_task_id FROM tasks WHERE source_task_id = ?")
        .get("task-parent") as
        | {
            status: string;
            assigned_agent_id: string | null;
            source_task_id: string | null;
          }
        | undefined;

      expect(crossTask).toMatchObject({
        status: "in_progress",
        assigned_agent_id: "dev-worker",
        source_task_id: "task-parent",
      });
      if (worktreeFails) {
        expect(spawnCliAgent).not.toHaveBeenCalled();
        expect(launchApiProviderAgent).not.toHaveBeenCalled();
        expect(launchHttpAgent).not.toHaveBeenCalled();
        expect(handleTaskRunComplete).toHaveBeenCalledWith(expect.any(String), 1);
        return;
      }

      if (launchKind === "cli") {
        expect(spawnCliAgent).toHaveBeenCalledTimes(1);
        expect(spawnCliAgent.mock.calls[0][6]).toBe(expectedEffort);
        expect(launchApiProviderAgent).not.toHaveBeenCalled();
        expect(launchHttpAgent).not.toHaveBeenCalled();
      } else if (launchKind === "api") {
        expect(spawnCliAgent).not.toHaveBeenCalled();
        expect(launchApiProviderAgent).toHaveBeenCalledTimes(1);
        expect(launchApiProviderAgent.mock.calls[0][4]).toBe("/isolated/collaboration");
        expect(launchApiProviderAgent.mock.calls[0][9]).toBe(effort ?? null);
        expect(launchHttpAgent).not.toHaveBeenCalled();
      } else {
        expect(spawnCliAgent).not.toHaveBeenCalled();
        expect(launchHttpAgent).toHaveBeenCalledTimes(1);
        expect(launchHttpAgent.mock.calls[0][3]).toBe("/isolated/collaboration");
        expect(launchApiProviderAgent).not.toHaveBeenCalled();
      }
    },
  );

  it.each<ProviderCase>([
    { provider: "api", launchKind: "api" },
    { provider: "copilot", launchKind: "http" },
    { provider: "antigravity", launchKind: "http" },
  ])("waits for approval before finalizing linked subtasks for $provider", ({ provider }) => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);

    const { teamLeader, crossLeader, execAgent } = seedCollaborationFixture(db, provider);

    const handleSubtaskDelegationComplete = vi.fn();
    const handleTaskRunComplete = vi.fn();
    const launchApiProviderAgent = vi.fn((...args: any[]) => {
      const onComplete = args[8] as ((exitCode: number) => void) | undefined;
      onComplete?.(0);
    });
    const launchHttpAgent = vi.fn((...args: any[]) => {
      const onComplete = args[8] as ((exitCode: number) => void) | undefined;
      onComplete?.(0);
    });

    const { startCrossDeptCooperation } = createCrossDeptCooperationTools({
      db,
      createWorktree: vi.fn(() => "/workspace/demo/.climpire-worktrees/test"),
      ensureClaudeMd: vi.fn(),
      nowMs: () => 1_717_171_717_000,
      appendTaskLog: vi.fn(),
      broadcast: vi.fn(),
      recordTaskCreationAudit: vi.fn(),
      delegatedTaskToSubtask: new Map(),
      crossDeptNextCallbacks: new Map(),
      findTeamLeader: (deptId: string) => (deptId === "dev" ? crossLeader : null),
      findBestSubordinate: (deptId: string) => (deptId === "dev" ? execAgent : null),
      resolveLang: () => "en",
      getDeptName: (deptId: string) => (deptId === "dev" ? "Development" : "Planning"),
      getAgentDisplayName: (agent: { name?: string }) => agent.name ?? "",
      sendAgentMessage: vi.fn(),
      notifyCeo: vi.fn(),
      l: (ko: unknown, en: unknown, ja: unknown, zh: unknown) => ({ ko, en, ja, zh }),
      pickL: (messages: Record<string, unknown>, lang: string) =>
        pickVariant(messages[lang] ?? messages.en ?? messages.ko),
      startTaskExecutionForAgent: vi.fn(),
      linkCrossDeptTaskToParentSubtask: vi.fn(() => "subtask-linked"),
      detectProjectPath: vi.fn(() => "/workspace/demo"),
      resolveProjectPath: vi.fn((task: { project_path?: string | null }) => task.project_path ?? "/workspace/demo"),
      logsDir: "/tmp",
      getDeptRoleConstraint: vi.fn(() => ""),
      getRecentConversationContext: vi.fn(() => ""),
      buildAvailableSkillsPromptBlock: vi.fn(() => ""),
      buildTaskExecutionPrompt: vi.fn((parts: unknown[]) =>
        parts
          .map((part) => String(part ?? "").trim())
          .filter(Boolean)
          .join("\n"),
      ),
      hasExplicitWarningFixRequest: vi.fn(() => false),
      ensureTaskExecutionSession: vi.fn((taskId: string, agentId: string, currentProvider: string) => ({
        sessionId: `session-${taskId}`,
        agentId,
        provider: currentProvider,
      })),
      getProviderModelConfig: vi.fn(() => ({})),
      spawnCliAgent: vi.fn(),
      launchApiProviderAgent,
      launchHttpAgent,
      getNextHttpAgentPid: vi.fn(() => 4242),
      handleSubtaskDelegationComplete,
      handleTaskRunComplete,
      startProgressTimer: vi.fn(),
    });

    startCrossDeptCooperation(["dev"], 0, {
      teamLeader,
      taskTitle: "Parent task",
      ceoMessage: "Need development support",
      leaderDeptId: "planning",
      leaderDeptName: "Planning",
      leaderName: "Planner",
      lang: "en",
      taskId: "task-parent",
      projectId: "project-1",
    });

    vi.runAllTimers();

    const crossTask = db.prepare("SELECT id FROM tasks WHERE source_task_id = ?").get("task-parent") as
      | { id: string }
      | undefined;

    expect(crossTask?.id).toBeTruthy();
    expect(handleSubtaskDelegationComplete).not.toHaveBeenCalled();
    expect(handleTaskRunComplete).toHaveBeenCalledWith(crossTask?.id, 0);
  });
});
