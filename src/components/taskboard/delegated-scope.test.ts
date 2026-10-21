import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import { buildRelatedTaskIndex, clipReport, parseDelegatedScope } from "./delegated-scope";

const checklist = "1. Ship the scope card [st-1] - Separate scope from parent context\n2. Related work list [st-2]";

// Mirrors buildDelegatedDescription in server/modules/routes/collab/subtask-delegation-batch-messages.ts.
const scopedDescriptions: Array<[string, string]> = [
  [
    "ko",
    `[서브태스크 위임 from 기획팀]\n[담당 범위: 디자인팀]\n아래 담당 체크리스트만 수행하세요.\n\n[순차 체크리스트]\n${checklist}\n\n[상위 업무 배경 — 참고 전용]\n전체 지시 요약\n전체 지시: GET /api/tasks/parent-1`,
  ],
  [
    "en",
    `[Subtasks delegated from Planning]\n[Department scope: Design]\nExecute only the owned checklist below.\n\n[Sequential checklist]\n${checklist}\n\n[Parent context — reference only]\nFull directive summary\nFull directive: GET /api/tasks/parent-1`,
  ],
  [
    "ja",
    `[サブタスク委任元 企画]\n[担当範囲: デザイン]\n以下の担当チェックリストのみ実行してください。\n\n[順次チェックリスト]\n${checklist}\n\n[親タスクの背景 — 参照専用]\n完全な指示の要約\n完全な指示: GET /api/tasks/parent-1`,
  ],
  [
    "zh",
    `[SubTask 委派来源 企划]\n[负责范围：设计]\n仅执行以下负责清单。\n\n[顺序清单]\n${checklist}\n\n[父任务背景 — 仅供参考]\n完整指示摘要\n完整指示：GET /api/tasks/parent-1`,
  ],
];

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: null,
    department_id: null,
    assigned_agent_id: null,
    status: "planned",
    priority: 1,
    task_type: "general",
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
    created_at: 0,
    updated_at: 0,
    source_task_id: null,
    ...overrides,
  };
}

describe("parseDelegatedScope", () => {
  it.each(scopedDescriptions)("separates the owned checklist from parent context (%s)", (_lang, description) => {
    const scope = parseDelegatedScope(description);

    expect(scope).not.toBeNull();
    expect(scope!.sourceDept).toBeTruthy();
    expect(scope!.scopeDept).toBeTruthy();
    expect(scope!.items).toEqual([
      { index: 1, title: "Ship the scope card", subtaskId: "st-1", detail: "Separate scope from parent context" },
      { index: 2, title: "Related work list", subtaskId: "st-2", detail: null },
    ]);
    expect(scope!.parentContext).toContain("GET /api/tasks/parent-1");
    expect(scope!.parentContext).not.toContain("Ship the scope card");
    expect(scope!.instruction).not.toContain("[");
  });

  it("treats the legacy header summary as parent context", () => {
    const scope = parseDelegatedScope(
      `[Subtasks delegated from Planning] Whole directive text\n\n[Sequential checklist]\n${checklist}`,
    );

    expect(scope?.sourceDept).toBe("Planning");
    expect(scope?.scopeDept).toBeNull();
    expect(scope?.parentContext).toBe("Whole directive text");
    expect(scope?.items).toHaveLength(2);
  });

  it("leaves ordinary descriptions alone", () => {
    expect(parseDelegatedScope(null)).toBeNull();
    expect(parseDelegatedScope("Fix the login button")).toBeNull();
    expect(parseDelegatedScope("[Sequential checklist]\nno numbered items")).toBeNull();
  });
});

describe("buildRelatedTaskIndex", () => {
  it("groups a parent with its delegated children and orders in-flight work first", () => {
    const tasks = [
      task("parent", { status: "collaborating", updated_at: 1 }),
      task("design", { source_task_id: "parent", status: "done", updated_at: 5 }),
      task("dev", { source_task_id: "parent", status: "in_progress", updated_at: 2 }),
      task("qa-child", { source_task_id: "dev", status: "planned", updated_at: 9 }),
      task("solo", { status: "in_progress" }),
    ];

    const index = buildRelatedTaskIndex(tasks);

    expect(index.get("design")?.map((item) => item.id)).toEqual(["dev", "parent", "qa-child"]);
    expect(index.get("parent")?.map((item) => item.id)).toEqual(["dev", "qa-child", "design"]);
    expect(index.has("solo")).toBe(false);
  });

  it("groups siblings whose parent is not loaded", () => {
    const index = buildRelatedTaskIndex([
      task("a", { source_task_id: "missing" }),
      task("b", { source_task_id: "missing" }),
    ]);

    expect(index.get("a")?.map((item) => item.id)).toEqual(["b"]);
  });
});

describe("clipReport", () => {
  it("collapses whitespace and bounds length", () => {
    expect(clipReport(null)).toBeNull();
    expect(clipReport("  a\n\nb  ")).toBe("a b");
    expect(clipReport("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
