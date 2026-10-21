import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { formatMeetingVerdict } from "../../../../src/lib/meeting-verdict.ts";
import { createPlannedApprovalTools } from "./planned-approval.ts";

let db: DatabaseSync;
afterEach(() => db?.close());

it("drafts department plans concurrently and lets the assigned planner consolidate all results", async () => {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES
      ('planning', 'Planning', '기획', 'P', '#111'), ('dev', 'Development', '개발', 'D', '#111'), ('design', 'Design', '디자인', 'D', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
      ('senior', 'Senior', 'planning', 'senior', 'codex', 'idle'),
      ('dev', 'Dev lead', 'dev', 'team_leader', 'codex', 'idle'),
      ('design', 'Design lead', 'design', 'team_leader', 'codex', 'idle');
    INSERT INTO tasks (id, title, department_id, assigned_agent_id, status) VALUES ('root', 'Root', 'planning', 'senior', 'planned');
  `);
  const leaders = db.prepare("SELECT * FROM agents WHERE department_id != 'planning' ORDER BY id").all();
  const releases = new Map<string, (result: { text: string }) => void>();
  const planGraph = {
    plan_items: [
      { key: "api", title: "API 구현", description: "검증 근거 ".repeat(500), department_id: "dev", depends_on: [] },
    ],
  };
  const verdict = formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] });
  const runAgentOneShot = vi.fn((agent: { id: string }, _prompt?: string, _options?: { rawOutput?: boolean }) => {
    if (agent.id === "senior")
      return Promise.resolve({ text: "```json\n" + JSON.stringify(planGraph, null, 2) + "\n```\n" + verdict });
    return new Promise<{ text: string }>((resolve) => releases.set(agent.id, resolve));
  });
  const prompts: Array<{ agent: string; context: any }> = [];
  const onApproved = vi.fn();
  const finishMeetingMinutes = vi.fn();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tools = createPlannedApprovalTools({
    db,
    classifyMeetingReviewDecision: () => "approved",
    reviewInFlight: new Set(),
    reviewRoundState: new Map(),
    getTaskReviewLeaders: () => leaders,
    resolveProjectPath: () => "/workspace/project",
    resolveLang: () => "ko",
    beginMeetingMinutes: () => "meeting",
    isTaskWorkflowInterrupted: () => false,
    getTaskStatusById: () => "planned",
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    getAgentDisplayName: (agent: { name: string }) => agent.name,
    getDeptName: (id: string) => id,
    getRoleLabel: (role: string) => role,
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    notifyCeo: vi.fn(),
    l: (ko: string[], en: string[]) => ({ ko, en }),
    pickL: (pool: { en: string[] }) => pool.en[0],
    buildMeetingPrompt: (agent: { id: string }, context: any) => {
      prompts.push({ agent: agent.id, context: { ...context, transcript: [...context.transcript] } });
      return context.turnObjective;
    },
    runAgentOneShot,
    chooseSafeReply: (run: { text: string }) =>
      run.text.includes('"plan_items"') ? "요약 완료" : run.text.slice(0, 420),
    sleepMs: async () => {},
    randomDelay: () => 0,
    collectPlannedActionItems: (transcript: any[]) => transcript.map((entry) => entry.content),
    appendTaskProjectMemo: vi.fn(),
    appendTaskLog: vi.fn(),
  });
  tools.startPlannedApprovalMeeting("root", "Root", "planning", (items) => {
    onApproved(items);
    finish();
  });
  expect(runAgentOneShot.mock.calls.map(([agent]) => agent.id)).toEqual(["design", "dev"]);
  const developmentDraft = "Development task with evidence ".repeat(50) + "\nitem: late_api; depends_on: late_schema";
  releases.get("dev")!({ text: developmentDraft + "\n\n" + verdict });
  await Promise.resolve();
  expect(runAgentOneShot).toHaveBeenCalledTimes(2);
  releases.get("design")!({ text: "Design task with evidence\n\n" + verdict });
  await done;
  expect(runAgentOneShot.mock.calls.map(([agent]) => agent.id)).toEqual(["design", "dev", "senior"]);
  expect(prompts[2].context.transcript.map((entry: any) => entry.content)).toEqual([
    "Design task with evidence\n\n" + verdict,
    developmentDraft + "\n\n" + verdict,
  ]);
  expect(prompts[2].context.transcript[1].content).toContain("depends_on: late_schema");
  expect(runAgentOneShot.mock.calls[0][2]?.rawOutput).toBe(true);
  expect(runAgentOneShot.mock.calls[1][2]?.rawOutput).toBe(true);
  expect(prompts[2].context.lang).toBe("ko");
  expect(runAgentOneShot.mock.calls[2][2]?.rawOutput).toBe(true);
  expect(JSON.parse(onApproved.mock.calls[0][0][0])).toEqual(planGraph);

  runAgentOneShot.mockImplementation((agent: { id: string }) =>
    Promise.resolve(
      agent.id === "senior"
        ? { text: JSON.stringify(planGraph), error: "Provider failed with partial output" }
        : { text: "Department plan\n\n" + verdict },
    ),
  );
  tools.startPlannedApprovalMeeting("root", "Root", "planning", onApproved);
  await vi.waitFor(() => expect(finishMeetingMinutes).toHaveBeenCalledWith("meeting", "failed"));
  expect(onApproved).toHaveBeenCalledTimes(1);
});
