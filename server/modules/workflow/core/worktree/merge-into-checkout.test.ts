import { execFileSync } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createWorktreeMergeTools } from "./merge.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("merge into checkout", () => {
  it("merges into the current checkout without switching branches, pushing, or requesting GitHub credentials", () => {
    const commands: string[][] = [];
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const command = args as string[];
      commands.push(command);
      if (command[0] === "rev-parse") return Buffer.from("dev\n");
      if (command[0] === "diff") return Buffer.from(" src/policy.ts | 1 +\n");
      return Buffer.from("");
    });
    const get = vi.fn(() => ({ title: "Merge policy", description: null }));
    const prepare = vi.fn(() => ({ get }));
    const cleanupWorktree = vi.fn();
    const tools = createWorktreeMergeTools({
      db: { prepare },
      taskWorktrees: new Map([
        [
          "task-1",
          {
            projectPath: "/project",
            worktreePath: "/isolated",
            branchName: "climpire/task-1",
          },
        ],
      ]),
      appendTaskLog: vi.fn(),
      cleanupWorktree,
      resolveLang: () => "en",
      l: (_ko: string[], en: string[]) => en[0],
      pickL: (value: string) => value,
    });

    expect(tools.mergeIntoCheckout("/project", "task-1", "climpire/task-1")).toEqual({
      success: true,
      message: "Merge completed: climpire/task-1 -> dev",
    });
    expect(commands).toEqual([
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["diff", "dev...climpire/task-1", "--stat"],
      ["merge", "climpire/task-1", "--no-ff", "-m", "Merge climpire task task-1 (branch climpire/task-1)"],
    ]);
    expect(prepare).toHaveBeenCalledExactlyOnceWith("SELECT title, description FROM tasks WHERE id = ?");
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });
});
