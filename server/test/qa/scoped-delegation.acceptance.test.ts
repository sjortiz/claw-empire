import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinationLocalizers, createCoordinationDb } from "../agent-coordination-fixture.ts";
import { createSubtaskDelegationBatch } from "../../modules/routes/collab/subtask-delegation-batch.ts";
import type { AgentRow } from "../../modules/routes/collab/direct-chat.ts";
import type { SubtaskRow } from "../../modules/routes/collab/subtask-summary.ts";

const departments = ["dev", "design", "qa"];

describe("QA acceptance: persisted department delegation", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    vi.useFakeTimers();
    db = createCoordinationDb();
    db.exec(`
      ALTER TABLE projects ADD COLUMN assignment_mode TEXT DEFAULT 'auto';
      ALTER TABLE subtasks ADD COLUMN target_department_id TEXT;
      ALTER TABLE subtasks ADD COLUMN delegated_task_id TEXT;
      UPDATE tasks SET status='in_progress' WHERE id='parent';
      INSERT INTO departments(id,name,name_ko,icon,color) VALUES
        ('design','Design','디자인','',''), ('qa','QA','품질','','');
      INSERT INTO agents(id,name,department_id,role,cli_provider) VALUES
        ('design-agent','Designer','design','senior','codex'),
        ('qa-agent','Tester','qa','senior','codex');
    `);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    db.close();
  });

  it.each(["ko", "en", "ja", "zh"] as const)(
    "saves only the assigned checklist and preserves the full parent separately in %s",
    async (lang) => {
      const parentDescription = `${"Shared coordination goal. ".repeat(50)}FULL DIRECTIVE REFERENCE TAIL`;
      db.prepare("UPDATE tasks SET description=? WHERE id='parent'").run(parentDescription);
      const parent = {
        id: "parent",
        title: "Coordinate departments",
        description: parentDescription,
        project_id: "project",
        project_path: null,
        department_id: "dev",
        workflow_pack_key: "development",
      };
      const agents = new Map(
        departments.map((dept) => [
          dept,
          db
            .prepare("SELECT * FROM agents WHERE id=?")
            .get(dept === "dev" ? "alpha" : `${dept}-agent`) as unknown as AgentRow,
        ]),
      );
      const spawn = vi.fn(() => ({ on: vi.fn() }));
      const finalize = vi.fn();
      const batch = createSubtaskDelegationBatch({
        db,
        ...coordinationLocalizers,
        resolveLang: () => lang,
        getDeptName: (id) => id,
        getAgentDisplayName: (agent) => agent.name,
        findTeamLeader: (id) => agents.get(id ?? "") ?? null,
        findBestSubordinate: () => null,
        nowMs: () => 100,
        broadcast: vi.fn(),
        notifyCeo: vi.fn(),
        sendAgentMessage: vi.fn(),
        appendTaskLog: vi.fn(),
        recordTaskCreationAudit: vi.fn(),
        resolveProjectPath: () => "/missing/qa-delegation-fixture",
        createWorktree: () => "/missing/qa-delegation-fixture/worktree",
        logsDir: "/missing/qa-delegation-fixture/logs",
        ensureTaskExecutionSession: (taskId, agentId, provider) => ({
          sessionId: `session-${taskId}`,
          agentId,
          provider,
        }),
        ensureClaudeMd: vi.fn(),
        getProviderModelConfig: () => ({}),
        spawnCliAgent: spawn,
        getNextHttpAgentPid: () => -1,
        launchApiProviderAgent: vi.fn(),
        launchHttpAgent: vi.fn(),
        startProgressTimer: vi.fn(),
        subtaskDelegationCallbacks: new Map(),
        delegatedTaskToSubtask: new Map(),
        maybeNotifyAllSubtasksComplete: vi.fn(),
        finalizeDelegatedSubtasks: finalize,
        buildSubtaskDelegationPrompt: (_parent, items) => items.map((item) => item.description).join("\n"),
      });

      for (const [index, dept] of departments.entries()) {
        db.prepare(
          "INSERT INTO subtasks(id,task_id,title,description,status,target_department_id) VALUES (?,'parent',?,?,'pending',?)",
        ).run(`${dept}-item`, `${dept} responsibility`, `${dept.toUpperCase()} EXCLUSIVE RESPONSIBILITY`, dept);
        const item = db.prepare("SELECT * FROM subtasks WHERE id=?").get(`${dept}-item`) as unknown as SubtaskRow;
        batch.delegateSubtaskBatch([item], index, departments.length, parent);
        await vi.advanceTimersByTimeAsync(3000);
      }

      const children = db
        .prepare(
          "SELECT id,department_id,description FROM tasks WHERE source_task_id='parent' AND id NOT IN ('source','target')",
        )
        .all() as Array<{ id: string; department_id: string; description: string }>;
      expect(children).toHaveLength(3);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(finalize).not.toHaveBeenCalled();
      for (const child of children) {
        expect(child.description).toContain(`${child.department_id.toUpperCase()} EXCLUSIVE RESPONSIBILITY`);
        expect(child.description).toContain(`[${child.department_id}-item]`);
        expect(child.description).toContain("GET /api/tasks/parent");
        expect(child.description).not.toContain("FULL DIRECTIVE REFERENCE TAIL");
        for (const other of departments.filter((dept) => dept !== child.department_id)) {
          expect(child.description).not.toContain(`${other.toUpperCase()} EXCLUSIVE RESPONSIBILITY`);
          expect(child.description).not.toContain(`[${other}-item]`);
        }
        expect(
          db.prepare("SELECT delegated_task_id,status FROM subtasks WHERE id=?").get(`${child.department_id}-item`),
        ).toEqual({
          delegated_task_id: child.id,
          status: "in_progress",
        });
      }
      expect(db.prepare("SELECT description FROM tasks WHERE id='parent'").get()).toEqual({
        description: parentDescription,
      });
    },
  );
});
