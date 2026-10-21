import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { formatMeetingVerdict } from "../../../../src/lib/meeting-verdict.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";

let db: DatabaseSync;
afterEach(() => db?.close());

function harness() {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', '기획', 'P', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status, current_task_id)
      VALUES ('planner', 'Planner', 'planning', 'team_leader', 'codex', 'idle', 'root');
    INSERT INTO tasks (id, title, department_id, assigned_agent_id, status)
      VALUES ('root', 'Root', 'planning', 'planner', 'planned');`);
  const verdict = formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] });
  const runAgentOneShot = vi.fn(async () => ({ text: `Implement recovery\n${verdict}` }));
  const reviewInFlight = new Set<string>();
  const appendTaskLog = vi.fn();
  const notifyCeo = vi.fn();
  const broadcast = vi.fn();
  const onApproved = vi.fn();
  const finishMeetingMinutes = vi.fn();
  const tools = createPlannedApprovalTools({
    db,
    reviewInFlight,
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => db.prepare("SELECT * FROM agents").all(),
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "en",
    beginMeetingMinutes: () => "meeting",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => (db.prepare("SELECT status FROM tasks WHERE id='root'").get() as any).status,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    getAgentDisplayName: (agent) => agent.name,
    getDeptName: (id) => id,
    getRoleLabel: (role) => role,
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    notifyCeo,
    l: (ko, en) => ({ ko, en }),
    pickL: (pool) => pool.en[0],
    buildMeetingPrompt: (_agent, context) => context.planningPhase,
    runAgentOneShot,
    chooseSafeReply: (run) => run.text,
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems: () => ["Implement recovery"],
    appendTaskProjectMemo: vi.fn(),
    appendTaskLog,
    broadcast,
    classifyMeetingReviewDecision: () => "approved",
  });
  return {
    ...tools,
    runAgentOneShot,
    reviewInFlight,
    appendTaskLog,
    notifyCeo,
    broadcast,
    onApproved,
    finishMeetingMinutes,
  };
}

describe("planned meeting failure recovery", () => {
  it("retries a failed meeting once with its reason, then marks attention and notifies the CEO", async () => {
    const h = harness();
    h.runAgentOneShot.mockRejectedValue(new Error("provider unavailable"));
    h.startPlannedApprovalMeeting("root", "Root", "planning", h.onApproved);
    await vi.waitFor(() => expect(h.reviewInFlight.size).toBe(0));
    expect(h.runAgentOneShot).toHaveBeenCalledTimes(2);
    expect(h.finishMeetingMinutes).toHaveBeenCalledTimes(2);
    expect(h.appendTaskLog).toHaveBeenCalledWith(
      "root",
      "system",
      "Automatic re-queue: planned meeting failed; retrying once: provider unavailable",
    );
    expect(
      db
        .prepare("SELECT status, planning_attention_reason, planning_meeting_failures FROM tasks WHERE id='root'")
        .get(),
    ).toEqual({ status: "pending", planning_attention_reason: "provider unavailable", planning_meeting_failures: 2 });
    expect(h.broadcast).toHaveBeenCalledWith("task_update", expect.objectContaining({ status: "pending" }));
    expect(h.notifyCeo).toHaveBeenCalledWith(
      expect.stringContaining("failed after one retry and needs attention"),
      "root",
    );
    expect(h.notifyCeo).toHaveBeenCalledWith(
      expect.stringContaining("Retry planning meeting on the task card"),
      "root",
    );
    expect(h.onApproved).not.toHaveBeenCalled();
    expect(db.prepare("SELECT current_task_id FROM agents WHERE id='planner'").get()).toEqual({
      current_task_id: null,
    });
  });

  it("continues normally if the single meeting retry succeeds", async () => {
    const h = harness();
    h.runAgentOneShot.mockRejectedValueOnce(new Error("provider unavailable"));
    h.startPlannedApprovalMeeting("root", "Root", "planning", h.onApproved);
    await vi.waitFor(() => expect(h.onApproved).toHaveBeenCalledExactlyOnceWith(["Implement recovery"]));
    expect(h.runAgentOneShot).toHaveBeenCalledTimes(3);
    expect(
      db.prepare("SELECT planning_attention_reason, planning_meeting_failures FROM tasks WHERE id='root'").get(),
    ).toEqual({ planning_attention_reason: null, planning_meeting_failures: 0 });
    expect(h.notifyCeo.mock.calls.some(([message]) => message.includes("needs attention"))).toBe(false);
  });

  it("honors a persisted first failure after the meeting runtime is recreated", async () => {
    const h = harness();
    db.prepare("UPDATE tasks SET planning_meeting_failures = 1 WHERE id='root'").run();
    h.runAgentOneShot.mockRejectedValue(new Error("still unavailable after restart"));
    h.startPlannedApprovalMeeting("root", "Root", "planning", h.onApproved);
    await vi.waitFor(() => expect(h.reviewInFlight.size).toBe(0));
    expect(h.runAgentOneShot).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status, planning_meeting_failures FROM tasks WHERE id='root'").get()).toEqual({
      status: "pending",
      planning_meeting_failures: 2,
    });
  });
});
