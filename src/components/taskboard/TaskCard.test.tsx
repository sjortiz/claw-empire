import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Task } from "../../types";
import TaskCard from "./TaskCard";

vi.mock("./DiffModal", () => ({ default: () => <div>Review branch changes</div> }));

describe("TaskCard completed branch review", () => {
  it("shows planning failure attention and retries through the task resume action", () => {
    const task: Task = {
      id: "failed-plan",
      title: "Recover planned meeting",
      description: null,
      department_id: null,
      assigned_agent_id: "planner",
      status: "pending",
      planning_attention_reason: "Provider unavailable after one retry",
      priority: 0,
      task_type: "development",
      project_path: null,
      result: null,
      started_at: null,
      completed_at: null,
      created_at: 1,
      updated_at: 2,
    };
    const onResumeTask = vi.fn();
    render(
      <I18nProvider language="en">
        <TaskCard
          task={task}
          agents={[]}
          departments={[]}
          taskSubtasks={[]}
          onUpdateTask={vi.fn()}
          onDeleteTask={vi.fn()}
          onAssignTask={vi.fn()}
          onRunTask={vi.fn()}
          onStopTask={vi.fn()}
          onResumeTask={onResumeTask}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Planning needs attention");
    expect(screen.getByRole("status")).toHaveTextContent("Provider unavailable after one retry");
    fireEvent.click(screen.getByRole("button", { name: "Retry planning meeting" }));
    expect(onResumeTask).toHaveBeenCalledExactlyOnceWith("failed-plan");
  });

  it("lets a done task open branch review without changing its status", () => {
    const task: Task = {
      id: "completed-task",
      title: "Keep task branch",
      description: null,
      department_id: null,
      assigned_agent_id: null,
      status: "done",
      priority: 0,
      task_type: "development",
      project_path: "/projects/tool",
      result: null,
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
    };
    const onUpdateTask = vi.fn();
    render(
      <I18nProvider language="en">
        <TaskCard
          task={task}
          agents={[]}
          departments={[]}
          taskSubtasks={[]}
          onUpdateTask={onUpdateTask}
          onDeleteTask={vi.fn()}
          onAssignTask={vi.fn()}
          onRunTask={vi.fn()}
          onStopTask={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByText("Review branch changes")).toBeInTheDocument();
    expect(onUpdateTask).not.toHaveBeenCalled();
  });
});
