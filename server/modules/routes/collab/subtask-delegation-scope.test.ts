import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";
import type { L10n } from "./language-policy.ts";
import {
  buildDelegatedChecklist,
  buildDelegatedDescription,
  DELEGATED_CHECKLIST_MAX_CHARS,
  DELEGATED_PARENT_SUMMARY_MAX_CHARS,
} from "./subtask-delegation-batch-messages.ts";
import { createSubtaskDelegationPromptBuilder } from "./subtask-delegation-prompt.ts";
import type { SubtaskRow } from "./subtask-summary.ts";

const localize = {
  l: (ko: string[], en: string[], ja: string[] = en, zh: string[] = en): L10n => ({ ko, en, ja, zh }),
  pickL: (pool: L10n, lang: Lang): string => pool[lang][0],
};

function description(lang: Lang, parentSummary: string, delegatedChecklist: string): string {
  return buildDelegatedDescription({
    ...localize,
    lang,
    sourceDeptName: "Planning",
    targetDeptName: "Development",
    parentTaskId: "parent-task",
    parentSummary,
    delegatedChecklist,
  });
}

function subtask(id: string, targetDepartment: string, description: string): SubtaskRow {
  return {
    id,
    task_id: "parent-task",
    title: `${targetDepartment} owned item`,
    description,
    status: "in_progress",
    created_at: 1,
    target_department_id: targetDepartment,
    delegated_task_id: null,
    blocked_reason: null,
  };
}

function createPromptFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, department_id TEXT, workflow_pack_key TEXT,
      title TEXT, description TEXT, project_path TEXT
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY, task_id TEXT, title TEXT, description TEXT, status TEXT,
      target_department_id TEXT, delegated_task_id TEXT, created_at INTEGER
    );
    CREATE TABLE task_logs (task_id TEXT, kind TEXT, message TEXT, created_at INTEGER);
    INSERT INTO tasks (id, department_id, workflow_pack_key) VALUES ('parent-task', 'planning', 'development');
  `);
  const builder = createSubtaskDelegationPromptBuilder({
    db,
    ...localize,
    resolveLang: () => "en",
    getDeptName: (id) => id,
    getDeptRoleConstraint: () => "Development implements its assigned code changes.",
    getRecentConversationContext: () => "",
    getAgentDisplayName: () => "Developer",
    buildTaskExecutionPrompt: (parts) => parts.filter(Boolean).join("\n"),
    hasExplicitWarningFixRequest: () => false,
  });
  const agent: AgentRow = {
    id: "dev-agent",
    name: "Developer",
    name_ko: "개발자",
    role: "senior",
    personality: null,
    status: "working",
    department_id: "dev",
    current_task_id: "delegated-task",
    avatar_emoji: "",
    cli_provider: "codex",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
  };
  const insert = (row: SubtaskRow) => {
    db.prepare("INSERT INTO subtasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      row.id,
      row.task_id,
      row.title,
      row.description,
      row.status,
      row.target_department_id,
      row.delegated_task_id,
      row.created_at,
    );
  };
  const prompt = (assigned: SubtaskRow[], parentDescription: string) =>
    builder.buildSubtaskDelegationPrompt(
      {
        id: "parent-task",
        title: "Coordinate delivery",
        description: parentDescription,
        project_id: null,
        project_path: null,
      },
      assigned,
      agent,
      "dev",
      "Development",
    );
  return { db, insert, prompt };
}

describe("scoped subtask delegation", () => {
  it.each(["ko", "en", "ja", "zh"] as const)(
    "keeps department scope ahead of background and preserves a parent reference in %s",
    (lang) => {
      const ownChecklist = "1. Implement shared-work API; preserve auth checks.";
      const text = description(lang, "Background title", ownChecklist);

      expect(text).toContain("Development");
      expect(text).toContain("GET /api/tasks/parent-task");
      expect(text.indexOf(ownChecklist)).toBeLessThan(text.indexOf("Background title"));
    },
  );

  it("includes the item's responsibility details instead of retaining only its clipped title", () => {
    const own = subtask("dev-item", "dev", "Implement only the auth endpoint. QA owns regression review.");
    const text = description("en", "Parent goal", buildDelegatedChecklist([own]));

    expect(text).toContain("[dev-item]");
    expect(text).toContain(own.description);
    expect(text).toContain("Execute only the owned checklist below");
    expect(text).toContain("do not duplicate their work");
  });

  it("caps parent context and checklist while keeping full details available by task reference", () => {
    const parent = `${"background ".repeat(500)}TAIL OF FULL DIRECTIVE`;
    const own = subtask("dev-item", "dev", "implementation detail ".repeat(2_000));
    const checklist = buildDelegatedChecklist(Array.from({ length: 100 }, () => own));
    const text = description("en", parent, checklist);

    expect(checklist.length).toBeLessThanOrEqual(DELEGATED_CHECKLIST_MAX_CHARS);
    expect(text).not.toContain("TAIL OF FULL DIRECTIVE");
    expect(text).not.toContain(parent);
    expect(text).toContain("GET /api/tasks/parent-task");
    expect(text.length).toBeLessThan(DELEGATED_CHECKLIST_MAX_CHARS + DELEGATED_PARENT_SUMMARY_MAX_CHARS + 900);
  });

  it("gives an executing department only its own responsibilities and a capped parent reference", () => {
    const fixture = createPromptFixture();
    try {
      const dev = subtask("dev-item", "dev", "Implement coordination endpoint with session auth.");
      const qa = subtask("qa-item", "qa", "QA ONLY SECRET CHECKLIST");
      fixture.insert(dev);
      fixture.insert(qa);
      const text = fixture.prompt([dev, qa], `${"Parent context ".repeat(100)}FULL DIRECTIVE TAIL`);
      const instructions = text.split("[All subtask status]")[0];

      expect(instructions).toContain(dev.description);
      expect(instructions).not.toContain(qa.description);
      expect(instructions).not.toContain("[qa-item]");
      expect(text).toContain("qa owned item (qa - in_progress)");
      expect(text).not.toContain("FULL DIRECTIVE TAIL");
      expect(text).toContain("GET /api/tasks/parent-task");
    } finally {
      fixture.db.close();
    }
  });

  it("bounds completed-work references and does not reinsert old delegated descriptions", () => {
    const fixture = createPromptFixture();
    try {
      const dev = subtask("dev-item", "dev", "Implement coordination endpoint.");
      fixture.insert(dev);
      fixture.db
        .prepare("INSERT INTO tasks (id, description) VALUES (?, ?)")
        .run("previous-task", "LEGACY DIRECTIVE MUST NOT BECOME INSTRUCTIONS");
      fixture.insert({
        ...subtask("done-delegated", "qa", "Previous deliverable"),
        status: "done",
        delegated_task_id: "previous-task",
      });
      for (let index = 0; index < 40; index += 1) {
        fixture.insert({
          ...subtask(`done-${index}`, "qa", "completed artifact ".repeat(1_000)),
          title: `Completed QA ${index} ${"title ".repeat(1_000)}`,
          status: "done",
        });
      }
      const text = fixture.prompt([dev], "Parent context");

      expect(text.length).toBeLessThan(12_000);
      expect(text).not.toContain("LEGACY DIRECTIVE MUST NOT BECOME INSTRUCTIONS");
      expect(text).toContain(dev.description);
    } finally {
      fixture.db.close();
    }
  });
});
