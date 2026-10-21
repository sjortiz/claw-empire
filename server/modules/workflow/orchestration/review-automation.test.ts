import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { resolveReviewPolicy } from "../core/review-policy.ts";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";
import { startReadyProjectReviewMeetings } from "./review-automation.ts";
import {
  applyAllReviewItemsAutomatically,
  buildAutomaticReviewInfoItems,
} from "../../routes/ops/messages/decision-inbox/review-automation.ts";
import type { DecisionInboxRouteItem } from "../../routes/ops/messages/decision-inbox/types.ts";

describe("review automation", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    db.exec(`INSERT INTO projects (id, name, project_path, core_goal) VALUES ('p', 'Review project', '/project', 'Review');
      INSERT INTO tasks (id, title, status, project_id, created_at, updated_at) VALUES ('a', 'First review', 'review', 'p', 1, 1), ('b', 'Second review', 'review', 'p', 2, 2)`);
  });
  afterEach(() => db.close());
  function global(key: string, value: boolean) {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, JSON.stringify(value));
  }
  function harness() {
    const inFlight = new Set<string>();
    const appendTaskLog = vi.fn((taskId, kind, message) => {
      db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, 100)").run(
        taskId,
        kind,
        message,
      );
    });
    const start = vi.fn((taskId: string) => {
      inFlight.add(taskId);
      db.prepare(
        "INSERT INTO meeting_minutes (id, task_id, title, meeting_type, round, status, started_at, created_at) VALUES (?, ?, 'Review', 'review', 1, 'in_progress', 100, 100)",
      ).run(`meeting-${taskId}`, taskId);
    });
    const { finishReview } = createReviewFinalizeTools({
      db,
      nowMs: () => 100000,
      appendTaskLog,
      resolveLang: () => "en",
      getPreferredLanguage: () => "en",
      getProjectReviewGateSnapshot: () => ({ activeReview: 2, activeTotal: 2, ready: true }),
      projectReviewGateNotifiedAt: new Map(),
      notifyCeo: vi.fn(),
      l: (ko: string[], en: string[], ja: string[], zh: string[]) => ({ ko, en, ja, zh }),
      pickL: (pool: { en: string[] }) => pool.en[0],
      taskWorktrees: new Map(),
      reviewInFlight: inFlight,
      startReviewConsensusMeeting: start,
    });
    return { finishReview, start, appendTaskLog };
  }
  it("default off preserves the CEO wait and creates no meeting", () => {
    const h = harness();
    h.finishReview("a", "First review");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.appendTaskLog).toHaveBeenCalledWith(
      "a",
      "system",
      expect.stringContaining("waiting for project-level decision"),
    );
    expect(startReadyProjectReviewMeetings(db, h.finishReview)).toBe(0);
  });
  it("starts all ready roots without representative or CEO picks and derives durable info from persisted logs", () => {
    global("reviewMeetingAutoStart", true);
    const h = harness();
    h.finishReview("a", "First review");
    expect(h.start.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    startReadyProjectReviewMeetings(db, h.finishReview);
    h.finishReview("a", "First review");
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(
      h.appendTaskLog.mock.calls.filter(
        ([, , message]) => message === "Review meeting started automatically (setting)",
      ),
    ).toHaveLength(2);
    const infos = buildAutomaticReviewInfoItems(db, "en");
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ informational: true, options: [], kind: "project_review_ready" });
    db.exec("UPDATE tasks SET status='done'");
    expect(buildAutomaticReviewInfoItems(db, "ja")).toHaveLength(2);
  });
  it.each(["reviewMeetingAutoStart", "reviewItemsAutoApply"] as const)(
    "project override wins both directions for %s",
    (key) => {
      const column = key === "reviewMeetingAutoStart" ? "review_meeting_auto_start" : "review_items_auto_apply";
      global(key, true);
      db.exec(`UPDATE projects SET ${column}=0`);
      expect(resolveReviewPolicy(db, "p", key)).toBe(false);
      global(key, false);
      db.exec(`UPDATE projects SET ${column}=1`);
      expect(resolveReviewPolicy(db, "p", key)).toBe(true);
      db.exec(`UPDATE projects SET ${column}=NULL`);
      expect(resolveReviewPolicy(db, "p", key)).toBe(false);
    },
  );
  it("honors explicit project overrides when starting meetings", () => {
    global("reviewMeetingAutoStart", true);
    db.exec("UPDATE projects SET review_meeting_auto_start=0");
    const h = harness();
    h.finishReview("a", "First review");
    expect(h.start).not.toHaveBeenCalled();
    global("reviewMeetingAutoStart", false);
    db.exec("UPDATE projects SET review_meeting_auto_start=1");
    startReadyProjectReviewMeetings(db, h.finishReview);
    expect(h.start).toHaveBeenCalledTimes(2);
  });
  it("rechecks readiness after the last child completes and when enabled after waiting", () => {
    global("reviewMeetingAutoStart", true);
    const h = harness();
    db.exec(
      "INSERT INTO tasks (id, title, status, project_id, source_task_id) VALUES ('child', 'Child', 'in_progress', 'p', 'a')",
    );
    startReadyProjectReviewMeetings(db, h.finishReview);
    expect(h.start).not.toHaveBeenCalled();
    db.exec("UPDATE tasks SET status='done' WHERE id='child'");
    startReadyProjectReviewMeetings(db, h.finishReview);
    expect(h.start).toHaveBeenCalledTimes(2);
  });
  it("does not bypass unfinished subtasks or pending revision decisions", () => {
    global("reviewMeetingAutoStart", true);
    const h = harness();
    db.exec("INSERT INTO subtasks (id, task_id, title, status) VALUES ('s', 'a', 'Fix', 'pending')");
    h.finishReview("a", "First review");
    expect(h.start.mock.calls.map(([id]) => id)).toEqual(["b"]);
    db.exec("UPDATE meeting_minutes SET status='revision_requested'");
    db.exec("UPDATE subtasks SET status='done'");
    startReadyProjectReviewMeetings(db, h.finishReview);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(buildAutomaticReviewInfoItems(db, "en").map((item) => item.task_id)).toEqual(["b"]);
  });
  it("backs off unchanged holds between background ticks and retries immediately on subtask progress", () => {
    global("reviewMeetingAutoStart", true);
    const h = harness();
    db.exec("INSERT INTO subtasks (id, task_id, title, status) VALUES ('held', 'a', 'Fix', 'pending')");
    const run = (now: number) => startReadyProjectReviewMeetings(db, h.finishReview, undefined, { nowMs: () => now });
    run(0);
    const holds = () =>
      h.appendTaskLog.mock.calls.filter(([id, , message]) => id === "a" && message.startsWith("Review hold:"));
    expect(holds()).toHaveLength(1);
    for (let now = 2500; now < 30000; now += 2500) run(now);
    expect(holds()).toHaveLength(1);
    run(30000);
    expect(holds()).toHaveLength(2);
    run(60000);
    expect(holds()).toHaveLength(2);
    db.exec("UPDATE subtasks SET status='done', completed_at=60001 WHERE id='held'");
    run(60001);
    expect(h.start.mock.calls.map(([id]) => id)).toEqual(["b", "a"]);
  });
  it("only its own auto-apply setting selects every offered revision item", () => {
    db.exec(
      "INSERT INTO meeting_minutes (id, task_id, title, meeting_type, round, status, started_at, created_at) VALUES ('round', 'a', 'Review', 'review', 1, 'revision_requested', 100, 100)",
    );
    const item = {
      id: "round",
      kind: "review_round_pick",
      project_id: "p",
      options: [
        { number: 1, action: "apply_review_pick", label: "First fix" },
        { number: 2, action: "apply_review_pick", label: "Second fix" },
        { number: 3, action: "skip_to_next_round", label: "Skip" },
      ],
    } as DecisionInboxRouteItem;
    const apply = vi.fn(() => ({ status: 200, payload: { ok: true } }));
    const getDecisionInboxItems = vi.fn(() => [item]);
    const input = { db, getDecisionInboxItems, applyDecisionReply: apply };
    global("reviewMeetingAutoStart", true);
    expect(applyAllReviewItemsAutomatically(input)).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(getDecisionInboxItems).not.toHaveBeenCalled();
    global("reviewMeetingAutoStart", false);
    global("reviewItemsAutoApply", true);
    expect(applyAllReviewItemsAutomatically(input)).toBe(1);
    expect(apply).toHaveBeenCalledWith("round", { option_number: 1, selected_option_numbers: [1, 2] });
    db.exec("UPDATE projects SET review_items_auto_apply=0");
    expect(applyAllReviewItemsAutomatically(input)).toBe(0);
  });
});
