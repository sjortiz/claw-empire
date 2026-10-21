import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import TaskBranchReview from "./TaskBranchReview";

const apiMocks = vi.hoisted(() => ({ getWorktrees: vi.fn() }));
vi.mock("../../api", () => ({ getWorktrees: apiMocks.getWorktrees }));
vi.mock("./DiffModal", () => ({
  default: ({ taskId, onWorktreeRemoved }: { taskId: string; onWorktreeRemoved: () => void }) => (
    <button onClick={onWorktreeRemoved}>Merge {taskId}</button>
  ),
}));

describe("TaskBranchReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getWorktrees.mockResolvedValue({
      ok: true,
      worktrees: [
        {
          taskId: "done-task",
          branchName: "climpire/kept-task",
          projectPath: "/projects/tool",
          worktreePath: "/projects/tool/.worktrees/kept-task",
        },
      ],
    });
  });

  it("shows the retained branch, opens review, and clears the branch after merging", async () => {
    render(
      <I18nProvider language="en">
        <TaskBranchReview taskId="done-task" />
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking task branch...");
    const reviewButton = await screen.findByRole("button", { name: "Review and merge" });
    expect(screen.getByText("climpire/kept-task")).toBeInTheDocument();
    expect(screen.getByText("/projects/tool")).toBeInTheDocument();
    fireEvent.click(reviewButton);
    fireEvent.click(screen.getByRole("button", { name: "Merge done-task" }));
    expect(screen.queryByText("Branch kept for review")).not.toBeInTheDocument();
  });

  it("hides branch actions when the completed task has no worktree", async () => {
    render(
      <I18nProvider language="en">
        <TaskBranchReview taskId="merged-task" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("allows retry when retained branch discovery fails", async () => {
    apiMocks.getWorktrees.mockRejectedValueOnce(new Error("Offline"));
    render(
      <I18nProvider language="en">
        <TaskBranchReview taskId="done-task" />
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check the task branch.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Review and merge" })).toBeEnabled();
    expect(apiMocks.getWorktrees).toHaveBeenCalledTimes(2);
  });
});
