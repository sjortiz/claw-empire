import { describe, expect, it, vi } from "vitest";
import { createMeetingPromptTools } from "./meeting-prompt-tools.ts";
import type { AgentRow } from "./conversation-types.ts";

function createAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-1",
    name: "DORO",
    name_ko: "도로롱",
    role: "junior",
    personality: null,
    status: "idle",
    department_id: "design",
    current_task_id: null,
    avatar_emoji: "🎨",
    cli_provider: "claude",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
    ...overrides,
  };
}

function createTools() {
  return createMeetingPromptTools({
    getDeptName: () => "Design",
    getDeptRoleConstraint: () => "",
    getRoleLabel: () => "Junior",
    getRecentConversationContext: () => "",
    getAgentDisplayName: (agent) => agent.name,
    formatMeetingTranscript: () => "",
    compactTaskDescriptionForMeeting: () => "",
    normalizeMeetingLang: () => "en",
    localeInstruction: () => "Respond in English.",
    resolveLang: () => "en",
  });
}

describe("buildDirectReplyPrompt", () => {
  it("includes character persona block when personality exists", () => {
    const tools = createTools();
    const agent = createAgent({
      personality: "Playful design specialist. Call CEO '대표님' and keep warm expressive tone.",
    });
    const built = tools.buildDirectReplyPrompt(agent, "Can you help me now?", "chat");
    expect(built.prompt).toContain("[Character Persona - Highest Priority]");
    expect(built.prompt).toContain("Playful design specialist");
    expect(built.prompt).toContain("Stay in character consistently");
    expect(built.prompt).toContain("Keep the reply aligned with the Character Persona.");
  });

  it("omits persona block when personality is empty", () => {
    const tools = createTools();
    const agent = createAgent({ personality: null });
    const built = tools.buildDirectReplyPrompt(agent, "Can you help me now?", "chat");
    expect(built.prompt).not.toContain("[Character Persona - Highest Priority]");
    expect(built.prompt).not.toContain("Keep the reply aligned with the Character Persona.");
  });
});

describe("buildMeetingPrompt", () => {
  it.each(["planned", "review"] as const)(
    "requires final verdict lines on every %s turn, including opening and summary",
    (meetingType) => {
      const prompt = createTools().buildMeetingPrompt(createAgent(), {
        meetingType,
        round: 1,
        taskTitle: "Task",
        taskDescription: "Context",
        transcript: [],
        turnObjective: "Open or summarize the meeting",
        lang: "en",
      });
      expect(prompt).toContain("single standalone final line: APPROVE or REVISE");
    },
  );

  it("keeps complete department drafts in consolidation instead of applying speech limits", () => {
    const tools = createTools();
    const draft = "department implementation details\n".repeat(200) + "item: late_api; depends_on: late_schema";
    const prompt = tools.buildMeetingPrompt(createAgent(), {
      meetingType: "planned",
      planningPhase: "consolidation",
      round: 1,
      taskTitle: "Directive",
      taskDescription: "Implement workflow",
      transcript: [
        { speaker_agent_id: "dev", speaker: "Dev", department: "Development", role: "Leader", content: draft },
      ],
      turnObjective: "Consolidate department plans",
      lang: "en",
    });
    expect(prompt).toContain(draft);
    expect(prompt).toContain("JSON plan_items block");
    expect(prompt).not.toContain("1-3 sentences");
    expect(prompt).not.toContain("no JSON");
  });

  it("passes workflow pack key into department name lookup", () => {
    const getDeptName = vi.fn(() => "씬 엔진팀");
    const tools = createMeetingPromptTools({
      getDeptName,
      getDeptRoleConstraint: () => "",
      getRoleLabel: () => "팀장",
      getRecentConversationContext: () => "",
      getAgentDisplayName: (agent) => agent.name_ko,
      formatMeetingTranscript: () => "",
      compactTaskDescriptionForMeeting: () => "",
      normalizeMeetingLang: () => "ko",
      localeInstruction: () => "한국어로 응답하세요.",
      resolveLang: () => "ko",
    });
    const prompt = tools.buildMeetingPrompt(createAgent({ department_id: "dev", role: "team_leader" }), {
      meetingType: "planned",
      round: 1,
      taskTitle: "영상 제작",
      taskDescription: "킥오프",
      workflowPackKey: "video_preprod",
      transcript: [],
      turnObjective: "킥오프",
      lang: "ko",
    });
    expect(getDeptName).toHaveBeenCalledWith("dev", "video_preprod");
    expect(prompt).toContain("Remotion");
  });
});

it.each(["draft", "consolidation"] as const)(
  "adds implementation rules only when required during %s",
  (planningPhase) => {
    const tools = createTools();
    const context = {
      meetingType: "planned" as const,
      planningPhase,
      round: 1,
      taskTitle: "Nexo",
      taskDescription: "Fix #84",
      transcript: [],
      turnObjective: "Plan",
      lang: "en",
    };
    const plain = tools.buildMeetingPrompt(createAgent(), context);
    expect(
      tools.buildMeetingPrompt(createAgent(), { ...context, requiresImplementation: false, implementationUnits: [] }),
    ).toBe(plain);
    const code = tools.buildMeetingPrompt(createAgent(), {
      ...context,
      requiresImplementation: true,
      implementationUnits: [
        { key: "issue-84", reference: "#84", description: "Fix #84", requiresTests: true, separateBranch: true },
      ],
    });
    expect(code).toContain("[Required implementation coverage]");
    expect(code).toContain('department_id: "dev"');
    expect(code).toContain("one separate branch for this issue");
    expect(code).toContain("cannot replace implementation");
  },
);
