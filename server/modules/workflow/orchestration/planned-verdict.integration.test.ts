import { createReplyCoreTools } from "../core/reply-core-tools.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import {
  formatMeetingVerdict,
  parseMeetingVerdict,
  parseStoredMeetingVerdict,
  type MeetingVerdict,
} from "../../../../src/lib/meeting-verdict.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";
import { createMeetingMinutesTools } from "./meetings/minutes.ts";
import { createSubtaskSeedingTools } from "../agents/subtask-seeding.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
const approve: MeetingVerdict = { verdict: "approve", blocking_items: [], non_blocking_notes: ["Monitor risk later"] };

async function runPlanning(draft: string, summary: string, retry = "invalid verdict", solo = false) {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', '기획', 'P', '#111'), ('dev', 'Development', '개발', 'D', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES ('planner', 'Planner', 'planning', 'team_leader', 'codex', 'idle'), ('dev', 'Dev', 'dev', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, department_id, assigned_agent_id, status) VALUES ('task', 'Plan', 'planning', 'planner', 'planned');`);
  if (solo) db.exec("DELETE FROM agents WHERE id = 'dev'");
  const appendTaskLog = vi.fn();
  const deps = {
    db,
    nowMs: () => Date.now(),
    getDeptName: (id: string) => id,
    getRoleLabel: (role: string) => role,
    getAgentDisplayName: (agent: any) => agent.name,
    pickL: (pool: any) => pool.en[0],
    l: (ko: string[], en: string[]) => ({ ko, en }),
    summarizeForMeetingBubble: (text: string) => text,
    appendTaskLog,
    broadcast: vi.fn(),
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 4,
  };
  const minutes = createMeetingMinutesTools(deps);
  const runAgentOneShot = vi.fn(async (_agent: any, prompt: string) => ({
    text: prompt === "draft" ? draft : prompt === "consolidation" ? summary : retry,
  }));
  const { seedApprovedPlanSubtasks } = createSubtaskSeedingTools({
    ...deps,
    analyzeSubtaskDepartment: (text) => (text.startsWith("dev ") ? "dev" : null),
    rerouteSubtasksByPlanningLeader: async () => {},
    findTeamLeader: (department) => db.prepare("SELECT * FROM agents WHERE department_id = ?").get(department),
    getPreferredLanguage: () => "en",
    resolveLang: () => "en",
    notifyCeo: vi.fn(),
  });
  const onApproved = vi.fn((items: string[] = []) => seedApprovedPlanSubtasks("task", "planning", items));
  const classifyMeetingReviewDecision = vi.fn(
    createReplyCoreTools({
      detectLang: () => "en",
      getPreferredLanguage: () => "en",
      pickL: (pool) => pool.en[0],
      prettyStreamJson: (text) => text,
    }).classifyMeetingReviewDecision,
  );
  const buildMeetingPrompt = vi.fn((_agent: any, context: any) => context.planningPhase);
  createPlannedApprovalTools({
    ...deps,
    ...minutes,
    classifyMeetingReviewDecision,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => db.prepare("SELECT * FROM agents ORDER BY id").all(),
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "en",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => "planned",
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    notifyCeo: vi.fn(),
    buildMeetingPrompt,
    runAgentOneShot,
    chooseSafeReply: (run: any) => run.text,
    sleepMs: async () => {},
    randomDelay: () => 0,
  }).startPlannedApprovalMeeting("task", "Plan", "planning", onApproved);
  await vi.waitFor(() =>
    expect(db.prepare("SELECT status FROM meeting_minutes WHERE task_id = 'task'").get()).not.toEqual({
      status: "in_progress",
    }),
  );
  return {
    onApproved,
    appendTaskLog,
    runAgentOneShot,
    buildMeetingPrompt,
    classifyMeetingReviewDecision,
    seededPlanItems: db.prepare("SELECT title, description FROM subtasks WHERE title LIKE '[Plan Item] %'").all(),
    status: (db.prepare("SELECT status FROM meeting_minutes WHERE task_id = 'task'").get() as any).status,
    description: (db.prepare("SELECT description FROM tasks WHERE id = 'task'").get() as any).description as string,
  };
}

describe("planned meeting verdicts", () => {
  it("shares verdict handling, preserves executable drafts without plan_items, and excludes notes from fallback work", async () => {
    const result = await runPlanning(
      `Implement API\nMonitor risk later\n${formatMeetingVerdict(approve)}`,
      `Approve. #47 blocks downstream work with risk.\n${formatMeetingVerdict(approve)}`,
    );
    const items = result.onApproved.mock.calls[0][0];
    expect(items).toEqual(["dev Dev: Implement API"]);
    expect(result.seededPlanItems).toEqual([
      { title: "[Plan Item] Implement API", description: expect.stringContaining("dev Dev: Implement API") },
    ]);
    expect(result.classifyMeetingReviewDecision).toHaveBeenCalledTimes(2);
    expect(result.classifyMeetingReviewDecision.mock.results.map((call) => call.value)).toEqual([
      "approved",
      "approved",
    ]);
    expect(result.runAgentOneShot).toHaveBeenCalledTimes(2);
    expect(result.description).toContain("nonblocking notes (informational only; no work items)");
    expect(result.description).toContain("Monitor risk later");
    expect(result.appendTaskLog).toHaveBeenCalledWith(
      "task",
      "system",
      expect.stringContaining("supplement-signals=no"),
    );
    const drafts = result.buildMeetingPrompt.mock.calls[1][1].transcript;
    expect(drafts[0].content).not.toContain("Monitor risk later");
    const stored = db.prepare("SELECT content FROM meeting_minute_entries ORDER BY seq").all() as Array<{
      content: string;
    }>;
    expect(stored.map((entry) => parseMeetingVerdict(entry.content))).toEqual([approve, approve]);
  });
  it("records informational notes without seeding plan items from notes-only drafts", async () => {
    const result = await runPlanning(
      `Monitor risk later\n${formatMeetingVerdict(approve)}`,
      `Monitor risk later\n${formatMeetingVerdict(approve)}`,
    );
    expect(result.onApproved).toHaveBeenCalledExactlyOnceWith([]);
    expect(result.seededPlanItems).toEqual([]);
    expect(result.description).toContain("Monitor risk later");
    expect(result.description).not.toContain("unresolved improvement items");
  });
  it("seeds draft work once when consolidation repeats it without plan_items", async () => {
    const text = `Implement API\n${formatMeetingVerdict(approve)}`;
    const result = await runPlanning(text, text);
    expect(result.onApproved).toHaveBeenCalledExactlyOnceWith(["dev Dev: Implement API"]);
    expect(result.seededPlanItems).toHaveLength(1);
    expect(result.seededPlanItems[0]).toEqual({
      title: "[Plan Item] Implement API",
      description: expect.stringContaining("dev Dev: Implement API"),
    });
  });
  it("classifies the resolved verdict after a verdict-only retry and preserves the original draft work", async () => {
    const result = await runPlanning("Implement API", formatMeetingVerdict(approve), formatMeetingVerdict(approve));
    expect(result.onApproved).toHaveBeenCalledExactlyOnceWith(["dev Dev: Implement API"]);
    expect(result.classifyMeetingReviewDecision).toHaveBeenCalledTimes(2);
    expect(result.classifyMeetingReviewDecision.mock.results.map((call) => call.value)).toEqual([
      "approved",
      "approved",
    ]);
    expect(result.seededPlanItems).toHaveLength(1);
  });
  it("preserves a solo planning leader's draft instead of replacing it with the consolidation verdict", async () => {
    const result = await runPlanning(
      `Implement API\n${formatMeetingVerdict(approve)}`,
      `Summary only\n${formatMeetingVerdict(approve)}`,
      "invalid",
      true,
    );
    expect(result.onApproved).toHaveBeenCalledExactlyOnceWith(["planning Planner: Implement API"]);
    const rows = db.prepare("SELECT speaker_agent_id, content FROM meeting_minute_entries ORDER BY seq").all() as {
      speaker_agent_id: string;
      content: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.speaker_agent_id === "planner")).toBe(true);
    expect(rows[0].content).toContain("Implement API");
    expect(rows[1].content).toContain("Summary only");
  });
  it("records supplement signals only for revise with blocking items", async () => {
    const revise: MeetingVerdict = { ...approve, verdict: "revise", blocking_items: ["Specify API owner"] };
    const result = await runPlanning(`Implement API\n${formatMeetingVerdict(revise)}`, formatMeetingVerdict(approve));
    expect(result.appendTaskLog).toHaveBeenCalledWith(
      "task",
      "system",
      expect.stringContaining("supplement-signals=yes"),
    );
    expect(JSON.stringify(result.onApproved.mock.calls[0][0])).toContain("Specify API owner");
    expect(JSON.stringify(result.onApproved.mock.calls[0][0])).not.toContain("Monitor risk later");
  });
  it("treats revise without blocking items as approval", async () => {
    const result = await runPlanning(
      `Implement API\n${formatMeetingVerdict({ ...approve, verdict: "revise" })}`,
      formatMeetingVerdict(approve),
    );
    expect(result.appendTaskLog).toHaveBeenCalledWith(
      "task",
      "system",
      expect.stringContaining("supplement-signals=no"),
    );
  });
  it("does not infer approval from prose after retry exhaustion", async () => {
    const result = await runPlanning("Implement API. Approved with no risk", formatMeetingVerdict(approve));
    expect(result.status).toBe("failed");
    expect(result.onApproved).not.toHaveBeenCalled();
    expect(result.runAgentOneShot).toHaveBeenCalledTimes(3);
  });
  it("retries missing verdicts once per reviewer and persists no-verdict outcomes", async () => {
    const result = await runPlanning("Implement API with risk", "Consolidated plan");
    expect(result.runAgentOneShot).toHaveBeenCalledTimes(4);
    expect(
      result.appendTaskLog.mock.calls.filter((call) =>
        String(call[2]).includes("clarification required after one retry"),
      ),
    ).toHaveLength(2);
    expect(result.status).toBe("failed");
    expect(result.onApproved).not.toHaveBeenCalled();
    const rows = db.prepare("SELECT content FROM meeting_minute_entries ORDER BY seq").all() as { content: string }[];
    expect(rows.map((row) => parseStoredMeetingVerdict(row.content)?.verdict)).toEqual(["no_verdict", "no_verdict"]);
    expect(result.description ?? "").not.toContain("unresolved improvement items");
  });
});
