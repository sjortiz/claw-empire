import { describe, expect, it } from "vitest";
import type { SubTask, Task } from "../../types";
import { buildDirectiveContexts, parseIntegrationConflict, summarizeDirective } from "./directive-progress";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: null,
    department_id: "planning",
    assigned_agent_id: null,
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
    created_at: 0,
    updated_at: 0,
    status: "in_progress",
    priority: 0,
    task_type: "general",
    ...overrides,
  };
}

function subtask(overrides: Partial<SubTask> & { id: string }): SubTask {
  return {
    task_id: "root",
    title: overrides.id,
    description: null,
    status: "pending",
    assigned_agent_id: null,
    blocked_reason: null,
    cli_tool_use_id: null,
    created_at: 0,
    completed_at: null,
    ...overrides,
  };
}

describe("directive progress", () => {
  const root = task({ id: "root" });
  const design = task({ id: "design-child", source_task_id: "root", department_id: "design", status: "done" });
  const dev = task({ id: "dev-child", source_task_id: "root", department_id: "dev", status: "in_progress" });
  const revision = task({ id: "rev-child", source_task_id: "root", department_id: "dev", status: "review" });
  const tasks = [root, design, dev, revision];
  const subtasks = [
    subtask({ id: "s-design", status: "done", target_department_id: "design", delegated_task_id: "design-child" }),
    subtask({ id: "s-dev", status: "in_progress", target_department_id: "dev", delegated_task_id: "dev-child" }),
    subtask({
      id: "s-rev",
      title: "[Review Revision] Fix approval copy",
      status: "in_progress",
      target_department_id: "dev",
      delegated_task_id: "rev-child",
    }),
    subtask({ id: "s-qa", target_department_id: "qa", depends_on: '["s-dev"]' }),
  ];

  it("shares one directive branch across children and revisions", () => {
    const contexts = buildDirectiveContexts(tasks, { root: subtasks });
    expect(contexts.get("root")).toMatchObject({ branch: "climpire/d-root", isRoot: true });
    expect(contexts.get("rev-child")).toMatchObject({ branch: "climpire/d-root", isRoot: false });
    expect(contexts.get("rev-child")?.part?.state).toBe("awaiting_approval");
  });

  it("reports parallel department lanes, dependencies and revisions", () => {
    const summary = summarizeDirective(root, subtasks, new Map(tasks.map((item) => [item.id, item])), tasks);
    expect(summary.counts).toMatchObject({ integrated: 1, working: 1, awaiting_approval: 1, waiting: 1 });
    expect(summary.parts.find((part) => part.subtask.id === "s-qa")?.waitingOn.map((dep) => dep.id)).toEqual(["s-dev"]);
    expect(summary.lanes.map((lane) => [lane.departmentId, lane.state])).toEqual([
      ["design", "integrated"],
      ["dev", "working"],
      ["qa", "waiting"],
    ]);
    expect(summary).toMatchObject({ revisionTotal: 1, childTaskCount: 3, parallelLaneCount: 1 });
    expect(summary.readiness).toBe("not_ready");
  });

  it("is ready for one approval only when every open part awaits integration", () => {
    const ready = summarizeDirective(
      root,
      [subtasks[0], subtasks[2]],
      new Map(tasks.map((item) => [item.id, item])),
      tasks,
    );
    expect(ready.readiness).toBe("ready_for_approval");
  });

  it("surfaces integration conflicts with files instead of a generic block", () => {
    const reason =
      "Integration of 'x' failed. Integration branch: climpire/d-root. Error: conflict\nsrc/a.ts, src/b.ts";
    expect(parseIntegrationConflict(reason)).toEqual({ isConflict: true, files: ["src/a.ts", "src/b.ts"] });
    expect(parseIntegrationConflict("waiting on API key").isConflict).toBe(false);

    const summary = summarizeDirective(
      root,
      [subtask({ id: "s-c", status: "blocked", blocked_reason: reason, target_department_id: "dev" })],
      new Map(),
      [],
    );
    expect(summary.parts[0]).toMatchObject({ state: "conflict", conflictFiles: ["src/a.ts", "src/b.ts"] });
    expect(summary.lanes[0].state).toBe("conflict");
  });
});
