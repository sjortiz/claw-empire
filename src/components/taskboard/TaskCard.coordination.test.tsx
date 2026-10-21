import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Agent, Department, Task } from "../../types";
import TaskCard from "./TaskCard";

const apiMocks = vi.hoisted(() => ({
  getWorktrees: vi.fn(),
  getTaskVerifyCommit: vi.fn(),
}));

vi.mock("../../api", () => ({
  getWorktrees: apiMocks.getWorktrees,
  getTaskVerifyCommit: apiMocks.getTaskVerifyCommit,
}));

const design: Department = {
  id: "design",
  name: "Design",
  name_ko: "디자인팀",
  icon: "🎨",
  color: "#ec4899",
  description: null,
  prompt: null,
  sort_order: 1,
  created_at: 0,
};
const dev: Department = { ...design, id: "dev", name: "Development", name_ko: "개발팀", icon: "💻" };

const aria: Agent = {
  id: "aria",
  name: "Aria",
  name_ko: "아리아",
  department_id: "dev",
  role: "team_leader",
  cli_provider: "codex",
  avatar_emoji: "",
  personality: null,
  status: "working",
  current_task_id: null,
  stats_tasks_done: 0,
  stats_xp: 0,
  created_at: 0,
};

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: null,
    department_id: null,
    assigned_agent_id: null,
    status: "planned",
    priority: 1,
    task_type: "general",
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const delegated = task("design-task", {
  title: "[Batched Subtask Collaboration x2] Design scope",
  department_id: "design",
  source_task_id: "parent",
  description:
    "[Subtasks delegated from Planning]\n[Department scope: Design]\nExecute only the owned checklist below.\n\n" +
    "[Sequential checklist]\n1. Scope card [st-1] - Separate scope from parent\n2. Sibling list [st-2]\n3. Note styling [st-3]\n\n" +
    "[Parent context — reference only]\nWhole CEO directive kept for reference.",
});

const sibling = task("dev-task", {
  title: "Development scope",
  department_id: "dev",
  assigned_agent_id: "aria",
  source_task_id: "parent",
  status: "in_progress",
  result: "Scoped delegation landed; related-work prompt in progress.",
});

function renderCard(card: Task, relatedTasks?: Task[], language = "en") {
  return render(
    <I18nProvider language={language}>
      <TaskCard
        task={card}
        agents={[aria]}
        departments={[design, dev]}
        taskSubtasks={[]}
        relatedTasks={relatedTasks}
        onUpdateTask={() => {}}
        onDeleteTask={() => {}}
        onAssignTask={() => {}}
        onRunTask={() => {}}
        onStopTask={() => {}}
      />
    </I18nProvider>,
  );
}

describe("TaskCard coordination UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getWorktrees.mockResolvedValue({
      ok: true,
      worktrees: [{ taskId: "dev-task", branchName: "climpire/dev-task", worktreePath: "/wt", projectPath: "/p" }],
    });
    apiMocks.getTaskVerifyCommit.mockResolvedValue({
      ok: true,
      branchName: "climpire/dev-task",
      commitCount: 3,
      compareRef: "dev",
    });
  });

  it("shows the assigned scope first and keeps parent context collapsed", () => {
    renderCard(delegated);

    expect(screen.getByRole("region", { name: "Assigned scope" })).toBeInTheDocument();
    expect(screen.getByText("🎯 Assigned scope · Design")).toBeInTheDocument();
    expect(screen.getByText("Scope card")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
    expect(screen.queryByText("Whole CEO directive kept for reference.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Parent context · reference only/ }));
    expect(screen.getByText("Whole CEO directive kept for reference.")).toBeInTheDocument();
  });

  it.each([
    ["ko", "상위 업무 배경 · 참고 전용", "관련 작업"],
    ["ja", "親タスクの背景 · 参照専用", "関連作業"],
    ["zh", "父任务背景 · 仅供参考", "相关工作"],
  ])("localizes scope and related-work labels (%s)", (language, parentLabel, relatedLabel) => {
    renderCard(delegated, [sibling], language);

    expect(screen.getByText(parentLabel)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(relatedLabel))).toBeInTheDocument();
  });

  it("lists sibling owner, department, status, branch, commits ahead and latest report on demand", async () => {
    renderCard(delegated, [sibling]);

    expect(screen.getByText("0 done · 1 in flight")).toBeInTheDocument();
    expect(apiMocks.getWorktrees).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Related work · 1/ }));

    const list = within(screen.getByRole("list", { name: "Related work" }));
    expect(list.getByText("Aria")).toBeInTheDocument();
    expect(list.getByText("💻 Development")).toBeInTheDocument();
    expect(list.getByText("In Progress")).toBeInTheDocument();
    expect(list.getByText("Scoped delegation landed; related-work prompt in progress.")).toBeInTheDocument();
    await waitFor(() => expect(list.getByText("⎇ climpire/dev-task · +3 commit(s) (vs dev)")).toBeInTheDocument());
    expect(apiMocks.getTaskVerifyCommit).toHaveBeenCalledWith("dev-task");
  });

  it("keeps single-agent tasks unchanged", () => {
    renderCard(task("solo", { description: "Fix the login button" }));

    expect(screen.getByText("Fix the login button")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Assigned scope" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Related work/)).not.toBeInTheDocument();
  });
});
