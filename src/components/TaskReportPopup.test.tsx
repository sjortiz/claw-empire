import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import TaskReportPopup from "./TaskReportPopup";

const apiMocks = vi.hoisted(() => ({ getWorktrees: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getWorktrees: apiMocks.getWorktrees,
}));

const baseReport = {
  task: {
    id: "task-1",
    title: "Ship feature",
    description: null,
    department_id: "planning",
    assigned_agent_id: "agent-1",
    status: "done",
    project_path: "/tmp/project",
    created_at: 1000,
    completed_at: 2000,
    agent_name: "Ari",
    agent_name_ko: "아리",
    agent_role: "team_leader",
    dept_name: "Planning",
    dept_name_ko: "기획팀",
  },
  logs: [
    { kind: "system", message: "Final branch verification: passed (ref=main, commits=1, files=1)", created_at: 1500 },
  ],
  subtasks: [],
  meeting_minutes: [],
  planning_summary: {
    title: "Planning Lead Consolidated Summary",
    content: "Summary body",
    source_task_id: "task-1",
    source_agent_name: "Ari",
    source_department_name: "Planning",
    generated_at: 1600,
    documents: [],
  },
  team_reports: [],
  project: {
    root_task_id: "task-1",
    project_name: "Project",
    project_path: "/tmp/project",
    core_goal: "Goal",
  },
};

describe("TaskReportPopup", () => {
  beforeEach(() => {
    apiMocks.getWorktrees.mockResolvedValue({ ok: true, worktrees: [] });
  });

  it("shows final branch verification logs in the report popup", async () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup
          report={baseReport as any}
          agents={[{ id: "agent-1", name: "Ari", name_ko: "아리", avatar_emoji: "A" } as any]}
          departments={[{ id: "planning", name: "Planning", name_ko: "기획팀", color: "#00aa88", icon: "P" } as any]}
          uiLanguage="en"
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Final Branch Verification")).toBeInTheDocument();
    expect(screen.getByText(/Final branch verification: passed/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Checking task branch...")).not.toBeInTheDocument());
  });

  it("keeps a sprite avatar when the assigned agent is missing from the active agent list", async () => {
    render(
      <I18nProvider language="en">
        <TaskReportPopup report={baseReport as any} agents={[]} departments={[]} uiLanguage="en" onClose={() => {}} />
      </I18nProvider>,
    );

    expect(screen.getByAltText("Ari")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Checking task branch...")).not.toBeInTheDocument());
  });

  it("offers branch review from a completed task detail", async () => {
    apiMocks.getWorktrees.mockResolvedValue({
      ok: true,
      worktrees: [
        {
          taskId: "task-1",
          branchName: "climpire/task-1",
          projectPath: "/tmp/project",
          worktreePath: "/tmp/project/.worktrees/task-1",
        },
      ],
    });
    render(
      <I18nProvider language="en">
        <TaskReportPopup report={baseReport as any} agents={[]} departments={[]} uiLanguage="en" onClose={() => {}} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("button", { name: "Review and merge" })).toBeEnabled();
    expect(screen.getByText("climpire/task-1")).toBeInTheDocument();
  });
});
