import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../../../bootstrap/schema/task-schema-migrations.ts";
import { REVIEW_AUTO_APPLY_LOG } from "../../../../workflow/core/review-automation.ts";
import {
  buildReviewAutoApplyReplyPayload,
  createReviewAutoStartNoticeItems,
  handleReviewAutoStartNoticeReply,
  isReviewAutoApplyConfigured,
  runReviewAutoApplyAutopilot,
} from "./review-automation.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

function createDb(options: { global?: boolean; project?: "on" | "off" | null; pack?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.prepare(
    "INSERT INTO projects (id, name, project_path, core_goal, review_auto_apply) VALUES ('project-1', 'Empire', '/project', 'Goal', ?)",
  ).run(options.project ?? null);
  db.prepare(
    "INSERT INTO tasks (id, title, status, project_id, workflow_pack_key) VALUES ('task-1', 'Backend', 'review', 'project-1', ?)",
  ).run(options.pack ?? "development");
  if (options.global !== undefined) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('reviewAutoApply', ?)").run(String(options.global));
  }
  return db;
}

function roundPick(): DecisionInboxRouteItem {
  return {
    id: "review-round-pick:task-1:meeting-1",
    kind: "review_round_pick",
    created_at: 1,
    summary: "Recommended picks: 2",
    project_id: "project-1",
    project_name: "Empire",
    project_path: "/project",
    task_id: "task-1",
    task_title: "Backend",
    meeting_id: "meeting-1",
    review_round: 1,
    options: [
      { number: 1, action: "apply_review_pick", label: "Add tests" },
      { number: 2, action: "apply_review_pick", label: "Fix docs" },
      { number: 3, action: "apply_review_pick", label: "Rename flag" },
      { number: 4, action: "skip_to_next_round", label: "Skip" },
    ],
  };
}

function runAutopilot(db: DatabaseSync) {
  let pending = [roundPick()];
  const applyDecisionReply = vi.fn(() => {
    pending = [];
    return { status: 200, payload: { ok: true } };
  });
  const appendTaskLog = vi.fn();
  const applied = runReviewAutoApplyAutopilot({
    db,
    getReviewRoundItems: () => pending,
    applyDecisionReply,
    appendTaskLog,
  });
  return { applied, applyDecisionReply, appendTaskLog };
}

describe("review auto-apply", () => {
  it("selects every review item, ignoring planner recommendations and the skip option", () => {
    expect(buildReviewAutoApplyReplyPayload(roundPick())).toEqual({
      option_number: 1,
      selected_option_numbers: [1, 2, 3],
    });
    expect(
      buildReviewAutoApplyReplyPayload({
        ...roundPick(),
        options: [{ number: 1, action: "skip_to_next_round", label: "Skip" }],
      }),
    ).toBeNull();
    expect(buildReviewAutoApplyReplyPayload({ ...roundPick(), kind: "project_review_ready" })).toBeNull();
  });

  it.each([
    { global: true, project: null, applies: true },
    { global: false, project: "on" as const, applies: true },
    { global: true, project: "off" as const, applies: false },
    { global: undefined, project: null, applies: false },
  ])("applies all items only when its own setting resolves on: %j", ({ global, project, applies }) => {
    const db = createDb({ global, project });
    try {
      expect(isReviewAutoApplyConfigured(db)).toBe(global === true || project === "on");
      const h = runAutopilot(db);
      expect(h.applied).toBe(applies ? 1 : 0);
      if (applies) {
        expect(h.applyDecisionReply).toHaveBeenCalledExactlyOnceWith("review-round-pick:task-1:meeting-1", {
          option_number: 1,
          selected_option_numbers: [1, 2, 3],
        });
        expect(h.appendTaskLog).toHaveBeenCalledExactlyOnceWith("task-1", "system", REVIEW_AUTO_APPLY_LOG);
      } else {
        expect(h.applyDecisionReply).not.toHaveBeenCalled();
        expect(h.appendTaskLog).not.toHaveBeenCalled();
      }
    } finally {
      db.close();
    }
  });

  it("is not enabled by the review auto-start setting", () => {
    const db = createDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES ('reviewAutoStart', 'true')").run();
      expect(runAutopilot(db).applyDecisionReply).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("leaves video pre-production picks with the CEO, like YOLO mode", () => {
    const db = createDb({ global: true, pack: "video_preprod" });
    try {
      expect(runAutopilot(db).applyDecisionReply).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

describe("review auto-start notices", () => {
  it("lists unacknowledged notices as informational items until the CEO acknowledges them", () => {
    const db = createDb();
    try {
      db.prepare(
        "INSERT INTO review_auto_start_notices (id, project_id, task_ids_json, created_at) VALUES ('n1', 'project-1', ?, 5)",
      ).run(JSON.stringify(["task-1"]));
      const { buildReviewAutoStartNoticeItems } = createReviewAutoStartNoticeItems({
        db,
        getPreferredLanguage: () => "en",
        l: (_ko, en) => en[0],
        pickL: (value: string) => value,
      });
      const [item] = buildReviewAutoStartNoticeItems();
      expect(item).toMatchObject({
        id: "review-auto-started:n1",
        kind: "review_auto_started",
        project_id: "project-1",
        task_id: "task-1",
        options: [{ number: 1, action: "acknowledge_review_auto_start", label: "Acknowledge" }],
      });
      expect(item.summary).toContain("started automatically by setting");
      expect(item.summary).toContain("- Backend");

      const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
      const handled = handleReviewAutoStartNoticeReply({
        res: res as any,
        currentItem: item,
        selectedOption: item.options[0],
        deps: { db, nowMs: () => 9 },
      });
      expect(handled).toBe(true);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, resolved: true }));
      expect(buildReviewAutoStartNoticeItems()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
