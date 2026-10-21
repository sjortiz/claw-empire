import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { I18nProvider } from "../../i18n";
import DiffModal from "./DiffModal";
import { ApiRequestError } from "../../api/core";

const apiMocks = vi.hoisted(() => ({
  getTaskDiff: vi.fn(),
  getTaskVerifyCommit: vi.fn(),
  mergeTask: vi.fn(),
  discardTask: vi.fn(),
}));

vi.mock("../../api", () => ({
  getTaskDiff: apiMocks.getTaskDiff,
  getTaskVerifyCommit: apiMocks.getTaskVerifyCommit,
  mergeTask: apiMocks.mergeTask,
  discardTask: apiMocks.discardTask,
}));

describe("DiffModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getTaskDiff.mockResolvedValue({
      ok: true,
      hasWorktree: true,
      branchName: "climpire/test",
      targetBranch: "dev",
      projectPath: "/project",
      stat: "1 file changed",
      diff: "diff --git a/a b/a",
    });
    apiMocks.getTaskVerifyCommit.mockResolvedValue({
      ok: true,
      hasWorktree: true,
      verdict: "ok",
      commitCount: 1,
      compareRef: "main",
      files: ["src/verify.ts"],
      uncommittedFiles: [],
      hasUncommittedChanges: false,
      hasRealCode: true,
    });
    apiMocks.mergeTask.mockResolvedValue({ ok: true, message: "merged" });
    apiMocks.discardTask.mockResolvedValue({ ok: true, message: "discarded" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders final branch verification status from verify-commit", async () => {
    render(
      <I18nProvider language="en">
        <DiffModal taskId="task-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Final Branch Verification")).toBeInTheDocument();
    });

    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("1 commit")).toBeInTheDocument();
    expect(screen.getByText("src/verify.ts")).toBeInTheDocument();
    expect(apiMocks.getTaskVerifyCommit).toHaveBeenCalledWith("task-1");
  });

  it("requires confirmation that merging changes the current local checkout", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(
      <I18nProvider language="en">
        <DiffModal taskId="kept-task" onClose={vi.fn()} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Merge now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Merge climpire/test into dev?"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("local checkout at /project"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Nothing will be pushed"));
    expect(screen.getByText("climpire/test → dev")).toBeInTheDocument();
    expect(apiMocks.mergeTask).not.toHaveBeenCalled();
  });

  it("shows merge progress and removes kept-branch actions after a successful local merge", async () => {
    let finishMerge!: (value: { ok: boolean; message: string }) => void;
    apiMocks.mergeTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishMerge = resolve;
        }),
    );
    const onWorktreeRemoved = vi.fn();
    render(
      <I18nProvider language="en">
        <DiffModal taskId="kept-task" onClose={vi.fn()} onWorktreeRemoved={onWorktreeRemoved} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Merge now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Merging..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    await act(async () => finishMerge({ ok: true, message: "Merged locally" }));
    expect(screen.getByRole("status")).toHaveTextContent("Merge completed: Merged locally");
    expect(onWorktreeRemoved).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(apiMocks.mergeTask).toHaveBeenCalledWith("kept-task", "dev");
  });

  it("keeps a failed branch available for retry", async () => {
    apiMocks.mergeTask.mockResolvedValueOnce({ ok: false, message: "Merge conflict" });
    render(
      <I18nProvider language="en">
        <DiffModal taskId="kept-task" onClose={vi.fn()} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Merge now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Merge failed: Merge conflict"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Merge completed: merged"));
    expect(apiMocks.mergeTask).toHaveBeenCalledTimes(2);
  });

  it("reports a merge request error and permits retry", async () => {
    apiMocks.mergeTask.mockRejectedValueOnce(new Error("Request failed"));
    render(
      <I18nProvider language="en">
        <DiffModal taskId="kept-task" onClose={vi.fn()} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Merge now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Error: Request failed"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Merge completed: merged"));
  });

  it.each([
    ["en", "Merge now", "Review the target and confirm again", "Merge climpire/test into other-session?"],
    ["ko", "지금 병합", "대상을 확인한 후 다시 승인하세요", "climpire/test을(를) other-session에 병합하시겠습니까?"],
    ["ja", "今すぐマージ", "対象を確認して再度承認してください", "climpire/test を other-session にマージしますか？"],
    ["zh", "立即合并", "请确认目标后重新确认", "要将 climpire/test 合并到 other-session 吗？"],
  ] as const)(
    "refreshes a changed target and requires confirmation again in %s",
    async (language, label, warning, confirmation) => {
      apiMocks.mergeTask.mockRejectedValueOnce(
        new ApiRequestError("target_changed", {
          status: 409,
          code: "target_changed",
          details: { targetBranch: "other-session" },
          url: "/api/tasks/kept-task/merge",
        }),
      );
      apiMocks.getTaskDiff
        .mockResolvedValueOnce({
          ok: true,
          hasWorktree: true,
          branchName: "climpire/test",
          targetBranch: "dev",
          projectPath: "/project",
        })
        .mockResolvedValueOnce({
          ok: true,
          hasWorktree: true,
          branchName: "climpire/test",
          targetBranch: "other-session",
          projectPath: "/project",
        });
      render(
        <I18nProvider language={language}>
          <DiffModal taskId="kept-task" onClose={vi.fn()} />
        </I18nProvider>,
      );
      const button = screen.getByRole("button", { name: label });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(warning));
      expect(screen.getByText("climpire/test → other-session")).toBeInTheDocument();
      expect(apiMocks.mergeTask).toHaveBeenCalledExactlyOnceWith("kept-task", "dev");
      expect(window.confirm).toHaveBeenCalledTimes(1);
      fireEvent.click(button);
      await waitFor(() => expect(apiMocks.mergeTask).toHaveBeenLastCalledWith("kept-task", "other-session"));
      expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(confirmation));
    },
  );

  it("blocks merging a detached checkout", async () => {
    apiMocks.getTaskDiff.mockResolvedValue({
      ok: true,
      hasWorktree: true,
      branchName: "climpire/test",
      targetBranch: null,
      projectPath: "/project",
    });
    render(
      <I18nProvider language="en">
        <DiffModal taskId="kept-task" onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Project checkout is detached");
    const button = screen.getByRole("button", { name: "Merge now" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(apiMocks.mergeTask).not.toHaveBeenCalled();
  });

  it("disables merging when a changed target cannot be refreshed", async () => {
    apiMocks.mergeTask.mockRejectedValueOnce(
      new ApiRequestError("target_changed", {
        status: 409,
        code: "target_changed",
        url: "/api/tasks/kept-task/merge",
      }),
    );
    apiMocks.getTaskDiff
      .mockResolvedValueOnce({
        ok: true,
        hasWorktree: true,
        branchName: "climpire/test",
        targetBranch: "dev",
        projectPath: "/project",
      })
      .mockRejectedValueOnce(new Error("Checkout unavailable"));
    render(
      <I18nProvider language="en">
        <DiffModal taskId="kept-task" onClose={vi.fn()} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Merge now" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText("Error: Checkout unavailable")).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(apiMocks.mergeTask).toHaveBeenCalledOnce();
  });

  it("warns that pending changes will be committed and included, listing untracked paths", async () => {
    apiMocks.getTaskDiff.mockResolvedValue({
      ok: true,
      hasWorktree: true,
      branchName: "climpire/dirty",
      targetBranch: "dev",
      projectPath: "/project",
      diff: "diff --git a/a b/a",
      hasUncommittedChanges: true,
      uncommittedFiles: ["src/pending.ts", "src/new-file.ts"],
    });
    render(
      <I18nProvider language="en">
        <DiffModal taskId="dirty-task" onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Uncommitted worktree changes will be committed and included in this merge",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("src/new-file.ts");
    expect(screen.getByRole("alert")).toHaveTextContent("may omit the contents of untracked files");
    expect(apiMocks.mergeTask).not.toHaveBeenCalled();
  });
});
