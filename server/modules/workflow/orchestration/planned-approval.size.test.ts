import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { formatMeetingVerdict } from "../../../../src/lib/meeting-verdict.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";

let db: DatabaseSync;
afterEach(() => db?.close());

it("completes a meeting with timeout-related prose and a 32-item plan after one merge request", async () => {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES
      ('planning', 'Planning', '기획', 'P', '#111'), ('dev', 'Development', '개발', 'D', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
      ('planner', 'Planner', 'planning', 'senior', 'codex', 'idle'),
      ('dev', 'Dev lead', 'dev', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, department_id, assigned_agent_id, status)
      VALUES ('root', 'Handle timeout recovery', 'planning', 'planner', 'planned');
  `);
  const graph = Array.from({ length: 32 }, (_, i) => ({
    key: `item_${i}`,
    title: `Implement timeout recovery ${i}`,
    department_id: "dev",
    depends_on: [],
  }));
  const merged = [{ ...graph[0], description: "Combined recovery coverage for all 32 cases" }];
  const verdict = formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] });
  const runAgentOneShot = vi
    .fn()
    .mockResolvedValueOnce({ text: `Recover operations that timed out or were aborted.\n\n${verdict}` })
    .mockResolvedValueOnce({ text: `\`\`\`json\n${JSON.stringify({ plan_items: graph })}\n\`\`\`\n${verdict}` })
    .mockResolvedValueOnce({ text: JSON.stringify({ plan_items: merged }) });
  const onApproved = vi.fn();
  const appendTaskLog = vi.fn();
  const finishMeetingMinutes = vi.fn();
  const tools = createPlannedApprovalTools({
    db,
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => db.prepare("SELECT * FROM agents WHERE id = 'dev'").all(),
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "en",
    beginMeetingMinutes: () => "meeting",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => "planned",
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
    notifyCeo: vi.fn(),
    pickL: (pool) => pool.en[0],
    l: (ko, en) => ({ ko, en }),
    buildMeetingPrompt: (_agent, context) => context.turnObjective,
    runAgentOneShot,
    chooseSafeReply: (run) => run.text,
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems: () => [],
    appendTaskProjectMemo: vi.fn(),
    appendTaskLog,
    classifyMeetingReviewDecision: () => "approved",
  });
  tools.startPlannedApprovalMeeting("root", "Handle timeout recovery", "planning", onApproved);
  await vi.waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
  expect(runAgentOneShot.mock.calls.map(([agent]) => agent.id)).toEqual(["dev", "planner", "planner"]);
  expect(runAgentOneShot.mock.calls[2][1]).toContain("at most 30");
  expect(JSON.parse(onApproved.mock.calls[0][0][0])).toEqual({ plan_items: merged });
  expect(finishMeetingMinutes).toHaveBeenCalledWith("meeting", "completed");
  expect(appendTaskLog.mock.calls.some(([, , message]) => message.includes("timed out ("))).toBe(false);
});
