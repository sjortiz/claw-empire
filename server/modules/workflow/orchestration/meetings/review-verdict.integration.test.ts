import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../../bootstrap/schema/task-schema-migrations.ts";
import { createReplyCoreTools } from "../../core/reply-core-tools.ts";
import {
  formatMeetingVerdict,
  parseStoredMeetingVerdict,
  type MeetingVerdict,
} from "../../../../../src/lib/meeting-verdict.ts";
import { createMeetingMinutesTools } from "./minutes.ts";
import { createReviewConsensusTools } from "./review-consensus.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
const approval: MeetingVerdict = {
  verdict: "approve",
  blocking_items: [],
  non_blocking_notes: ["risk in downstream work remains informational"],
};

async function runReview(finalVerdict: MeetingVerdict | null, feedbackVerdict = finalVerdict, round = 1) {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('dev', 'Development', '개발', 'D', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES ('dev', 'Dev lead', 'dev', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, department_id, status) VALUES ('task', 'Review', 'dev', 'review');`);
  if (round > 1)
    db.prepare(
      "INSERT INTO meeting_minutes (id, task_id, meeting_type, round, title, status, started_at, created_at) VALUES ('previous', 'task', 'review', ?, 'Review', 'completed', 0, 0)",
    ).run(round - 1);
  const leaders = db.prepare("SELECT * FROM agents").all();
  const core = createReplyCoreTools({
    detectLang: () => "en",
    getPreferredLanguage: () => "en",
    pickL: (pool) => pool.en[0],
    prettyStreamJson: (text) => text,
  });
  const decisions = new Map();
  const appendTaskLog = vi.fn();
  const memoDeps = {
    db,
    nowMs: () => Date.now(),
    getDeptName: () => "Development",
    getRoleLabel: () => "Leader",
    getAgentDisplayName: (agent: any) => agent.name,
    pickL: (pool: any) => pool.en[0],
    l: (ko: string[], en: string[]) => ({ ko, en }),
    summarizeForMeetingBubble: core.summarizeForMeetingBubble,
    appendTaskLog,
    broadcast: vi.fn(),
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 4,
  };
  const minutes = createMeetingMinutesTools(memoDeps);
  const runAgentOneShot = vi.fn(async (_agent: any, prompt: string) => {
    const verdict = prompt === "feedback" ? feedbackVerdict : finalVerdict;
    return {
      text: `#47 blocks downstream work. Approved with risk documented.${verdict ? "\n" + formatMeetingVerdict(verdict) : ""}`,
    };
  });
  const onApproved = vi.fn();
  const tools = createReviewConsensusTools({
    ...memoDeps,
    ...core,
    ...minutes,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => leaders,
    getTaskStatusById: () => "review",
    getReviewRoundMode: (value: number) => (value === 3 ? "final_decision" : "parallel_remediation"),
    scheduleNextReviewRound: vi.fn(),
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "en",
    runAgentOneShot,
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: (id: string, _seat: number, _phase: string, _task: string, content: string) =>
      decisions.set(id, core.classifyMeetingReviewDecision(content)),
    callLeadersToCeoOffice: vi.fn(),
    dismissLeadersFromCeoOffice: vi.fn(),
    meetingReviewDecisionByAgent: decisions,
    clearTaskWorkflowState: vi.fn(),
    isTaskWorkflowInterrupted: () => false,
    randomDelay: () => 0,
    sleepMs: async () => {},
    buildMeetingPrompt: (_agent: any, context: any) =>
      context.turnObjective.includes("only reviewer")
        ? "feedback"
        : context.turnObjective.includes("final approval decision for") ||
            context.turnObjective.includes("final approval decision and")
          ? "approval"
          : "other",
    REVIEW_MAX_ROUNDS: 3,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND: 10,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT: 4,
    REVIEW_MAX_REMEDIATION_REQUESTS: 2,
    REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND: 2,
    REVIEW_MAX_REVISION_SIGNALS_PER_ROUND: 6,
  });
  tools.startReviewConsensusMeeting("task", "Review", "dev", onApproved);
  await vi.waitFor(() =>
    expect(
      db.prepare("SELECT status FROM meeting_minutes WHERE task_id = 'task' ORDER BY round DESC LIMIT 1").get(),
    ).not.toEqual({ status: "in_progress" }),
  );
  return {
    tools,
    onApproved,
    appendTaskLog,
    runAgentOneShot,
    description: (db.prepare("SELECT description FROM tasks WHERE id = 'task'").get() as any).description as string,
    status: (
      db.prepare("SELECT status FROM meeting_minutes WHERE task_id = 'task' ORDER BY round DESC LIMIT 1").get() as any
    ).status,
  };
}

describe("review verdict orchestration", () => {
  it("approves risk/block prose and persists informational notes in memo and report minutes", async () => {
    const result = await runReview(approval);
    expect(result.onApproved).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.description).toContain("nonblocking notes (informational only; no work items)");
    expect(db.prepare("SELECT content FROM meeting_minute_entries WHERE message_type = 'status_update'").get()).toEqual(
      { content: expect.stringContaining('"non_blocking_notes"') },
    );
    expect(db.prepare("SELECT count(*) AS count FROM review_revision_history").get()).toEqual({ count: 0 });
  });
  it("starts remediation from only concrete blockers and excludes approval notes", async () => {
    const result = await runReview({ ...approval, verdict: "revise", blocking_items: ["Repair parser"] });
    expect(result.onApproved).not.toHaveBeenCalled();
    expect(result.status).toBe("revision_requested");
    expect(db.prepare("SELECT raw_note FROM review_revision_history").all()).toEqual([
      { raw_note: "Development Dev lead: Repair parser" },
    ]);
  });
  it("uses the final approval over earlier revise feedback", async () => {
    const result = await runReview(approval, { ...approval, verdict: "revise", blocking_items: ["Earlier issue"] });
    expect(result.onApproved).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
  });
  it("approves revise without blockers", async () => {
    const result = await runReview({ ...approval, verdict: "revise" });
    expect(result.onApproved).toHaveBeenCalledTimes(1);
  });
  it("retries every missing leader verdict once and waits for clarification without remediation", async () => {
    const result = await runReview(null);
    expect(result.runAgentOneShot).toHaveBeenCalledTimes(8); // one retry for opening, feedback, summary, approval
    expect(
      result.appendTaskLog.mock.calls.filter((call) =>
        String(call[2]).includes("clarification required after one retry"),
      ),
    ).toHaveLength(4);
    expect(result.status).toBe("failed");
    expect(result.onApproved).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS count FROM review_revision_history").get()).toEqual({ count: 0 });
    const stored = db.prepare("SELECT content FROM meeting_minute_entries ORDER BY seq").all() as { content: string }[];
    expect(stored).toHaveLength(4);
    expect(stored.map((entry) => parseStoredMeetingVerdict(entry.content)?.verdict)).toEqual(
      Array(4).fill("no_verdict"),
    );
  });
  it("does not force approval for no verdict in the final round or consume a round on clarification", async () => {
    const result = await runReview(null, null, 3);
    expect(result.status).toBe("failed");
    expect(result.onApproved).not.toHaveBeenCalled();
    result.runAgentOneShot.mockImplementation(async () => ({ text: formatMeetingVerdict(approval) }));
    result.tools.startReviewConsensusMeeting("task", "Review", "dev", result.onApproved);
    await vi.waitFor(() => expect(result.onApproved).toHaveBeenCalledTimes(1));
    expect(
      db.prepare("SELECT round, status FROM meeting_minutes WHERE id != 'previous' ORDER BY created_at").all(),
    ).toEqual([
      { round: 3, status: "failed" },
      { round: 3, status: "completed" },
    ]);
    expect(result.appendTaskLog.mock.calls.some((call) => String(call[2]).includes("exceeds max_rounds"))).toBe(false);
  });
  it("preserves forced finalization in the final round", async () => {
    const result = await runReview(
      { ...approval, verdict: "revise", blocking_items: ["Unresolved blocker"] },
      undefined,
      3,
    );
    expect(result.onApproved).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.description).toContain("documented residual risks");
  });
});
