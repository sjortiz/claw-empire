import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktreeLifecycleTools } from "../../workflow/core/worktree/lifecycle.ts";
import { registerWorktreeAndUsageRoutes } from "./worktrees-and-usage.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 15000 }).toString().trim();
}

function initRepo(basePrefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), basePrefix));
  try {
    runGit(dir, ["init", "-b", "main"]);
  } catch {
    runGit(dir, ["init"]);
    runGit(dir, ["checkout", "-B", "main"]);
  }
  runGit(dir, ["config", "user.name", "Claw-Empire Test"]);
  runGit(dir, ["config", "user.email", "claw-empire-test@example.local"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n", "utf8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "seed"]);
  return dir;
}

function createHarness(
  taskWorktrees: Map<string, { worktreePath: string; branchName: string; projectPath: string }>,
  mergeResult = { success: true, message: "merged", conflicts: [] as string[] },
) {
  const appendLogCalls: Array<{ taskId: string | null; kind: string; message: string }> = [];
  const mergeCalls: Array<{ projectPath: string; taskId: string }> = [];
  const cleanupCalls: Array<{ projectPath: string; taskId: string }> = [];
  const getRoutes = new Map<string, RouteHandler>();
  const postRoutes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      getRoutes.set(path, handler);
      return this;
    },
    post(path: string, handler: RouteHandler) {
      postRoutes.set(path, handler);
      return this;
    },
  };

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, project_path TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_path TEXT, project_id TEXT, status TEXT);
  `);
  registerWorktreeAndUsageRoutes({
    app: app as any,
    taskWorktrees,
    mergeWorktree: (projectPath: string, taskId: string) => {
      mergeCalls.push({ projectPath, taskId });
      return mergeResult;
    },
    cleanupWorktree: (projectPath: string, taskId: string) => {
      cleanupCalls.push({ projectPath, taskId });
    },
    appendTaskLog: (taskId: string | null, kind: string, message: string) => {
      appendLogCalls.push({ taskId, kind, message });
    },
    resolveLang: () => "en",
    pickL: (value: string) => value,
    l: (_ko: string[], en: string[]) => en.join(""),
    notifyCeo: () => {},
    db: db as any,
    nowMs: () => Date.now(),
    CLI_TOOLS: [],
    fetchClaudeUsage: async () => ({ windows: [], error: "not_implemented" }),
    fetchCodexUsage: async () => ({ windows: [], error: "not_implemented" }),
    fetchGeminiUsage: async () => ({ windows: [], error: "not_implemented" }),
    broadcast: () => {},
  } as any);

  return { db, getRoutes, postRoutes, appendLogCalls, mergeCalls, cleanupCalls };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree verify-commit route", () => {
  it("worktree가 없으면 no_worktree 판정을 돌려준다", () => {
    const { db, getRoutes } = createHarness(new Map());
    try {
      const handler = getRoutes.get("/api/tasks/:id/verify-commit");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: "task-1" } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        hasWorktree: false,
        hasCommit: false,
        verdict: "no_worktree",
      });
    } finally {
      db.close();
    }
  });

  it("커밋 없이 변경만 있으면 dirty_without_commit 판정을 돌려준다", () => {
    const repo = initRepo("climpire-verify-dirty-");
    tempDirs.push(repo);
    const taskId = "verify-dirty-0000-0000-0000-000000000000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();

    fs.writeFileSync(path.join(String(worktreePath), "src-dirty.ts"), "export const dirty = true;\n", "utf8");

    const { db, getRoutes } = createHarness(taskWorktrees);
    try {
      const handler = getRoutes.get("/api/tasks/:id/verify-commit");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        hasWorktree: true,
        hasCommit: false,
        hasUncommittedChanges: true,
        verdict: "dirty_without_commit",
      });
    } finally {
      db.close();
      tools.cleanupWorktree(repo, taskId);
    }
  });

  it("커밋된 코드 변경이 있으면 ok 판정을 돌려준다", () => {
    const repo = initRepo("climpire-verify-ok-");
    tempDirs.push(repo);
    const taskId = "verify-okay-0000-0000-0000-000000000000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();

    const worktreeDir = String(worktreePath);
    fs.mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, "src", "verify.ts"), "export const verified = true;\n", "utf8");
    runGit(worktreeDir, ["add", "."]);
    runGit(worktreeDir, ["commit", "-m", "feat: add verify file"]);

    const { db, getRoutes } = createHarness(taskWorktrees);
    try {
      const handler = getRoutes.get("/api/tasks/:id/verify-commit");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({
        ok: true,
        hasWorktree: true,
        hasCommit: true,
        verdict: "ok",
      });
      expect(res.payload).toMatchObject({
        files: ["src/verify.ts"],
      });
    } finally {
      db.close();
      tools.cleanupWorktree(repo, taskId);
    }
  });

  it("수동 merge 전에 최종 브랜치 검증 통과 로그를 남긴다", () => {
    const repo = initRepo("climpire-verify-merge-");
    tempDirs.push(repo);
    const taskId = "verify-merge-0000-0000-0000-000000000000";
    const taskWorktrees = new Map<string, { worktreePath: string; branchName: string; projectPath: string }>();
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester");
    expect(worktreePath).toBeTruthy();

    const worktreeDir = String(worktreePath);
    fs.mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, "src", "verify.ts"), "export const verified = true;\n", "utf8");
    runGit(worktreeDir, ["add", "."]);
    runGit(worktreeDir, ["commit", "-m", "feat: ready for merge"]);

    const { db, postRoutes, appendLogCalls } = createHarness(taskWorktrees);
    try {
      const handler = postRoutes.get("/api/tasks/:id/merge");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ params: { id: taskId }, body: { expectedTargetBranch: "main" } }, res);

      expect(res.statusCode).toBe(200);
      expect(appendLogCalls.some((entry) => entry.message.includes("Final branch verification: passed"))).toBe(true);
    } finally {
      db.close();
      tools.cleanupWorktree(repo, taskId);
    }
  });
});

describe("retained worktrees after server restart", () => {
  function createRetainedTask() {
    const repo = initRepo("climpire-retained-route-");
    tempDirs.push(repo);
    const taskId = "retained-0000-0000-0000-000000000000";
    const tools = createWorktreeLifecycleTools({ appendTaskLog: () => {}, taskWorktrees: new Map() });
    const worktreePath = tools.createWorktree(repo, taskId, "Tester")!;
    fs.writeFileSync(path.join(worktreePath, "retained.ts"), "export const retained = true;\n", "utf8");
    runGit(worktreePath, ["add", "."]);
    runGit(worktreePath, ["commit", "-m", "feat: retained task"]);
    return { repo, taskId, worktreePath };
  }

  it.each(["task", "project"])("recovers done task diff, verification and list from the %s path", (pathSource) => {
    const { repo, taskId, worktreePath } = createRetainedTask();
    const taskWorktrees = new Map();
    const { db, getRoutes } = createHarness(taskWorktrees);
    db.prepare("INSERT INTO projects (id, project_path) VALUES (?, ?)").run("project-1", repo);
    db.prepare("INSERT INTO tasks (id, project_path, project_id, status) VALUES (?, ?, ?, 'done')").run(
      taskId,
      pathSource === "task" ? repo : "",
      "project-1",
    );
    const head = runGit(repo, ["rev-parse", "HEAD"]);

    try {
      const diff = createFakeResponse();
      getRoutes.get("/api/tasks/:id/diff")?.({ params: { id: taskId } }, diff);
      expect(diff.payload).toMatchObject({
        ok: true,
        hasWorktree: true,
        branchName: "climpire/retained",
        targetBranch: "main",
        projectPath: repo,
        hasUncommittedChanges: false,
        uncommittedFiles: [],
      });
      expect((diff.payload as { diff: string }).diff).toContain("export const retained = true");

      taskWorktrees.clear();
      const verification = createFakeResponse();
      getRoutes.get("/api/tasks/:id/verify-commit")?.({ params: { id: taskId } }, verification);
      expect(verification.payload).toMatchObject({ hasWorktree: true, verdict: "ok" });

      taskWorktrees.clear();
      const list = createFakeResponse();
      getRoutes.get("/api/worktrees")?.({}, list);
      expect(list.payload).toEqual({
        ok: true,
        worktrees: [
          { taskId, branchName: "climpire/retained", worktreePath: fs.realpathSync(worktreePath), projectPath: repo },
        ],
      });
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(head);
      expect(fs.existsSync(path.join(repo, "retained.ts"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("shows staged and unstaged tracked changes and warns about untracked files before manual merge", () => {
    const { repo, taskId, worktreePath } = createRetainedTask();
    fs.writeFileSync(path.join(worktreePath, "retained.ts"), "export const retained = 'staged';\n", "utf8");
    runGit(worktreePath, ["add", "retained.ts"]);
    fs.appendFileSync(path.join(worktreePath, "README.md"), "pending readme\n", "utf8");
    fs.writeFileSync(path.join(worktreePath, "untracked.ts"), "export const pending = true;\n", "utf8");
    const { db, getRoutes } = createHarness(new Map());
    db.prepare("INSERT INTO tasks (id, project_path, status) VALUES (?, ?, 'done')").run(taskId, repo);

    try {
      const res = createFakeResponse();
      getRoutes.get("/api/tasks/:id/diff")?.({ params: { id: taskId } }, res);

      expect(res.payload).toMatchObject({ ok: true, hasWorktree: true, hasUncommittedChanges: true });
      const payload = res.payload as { diff: string; uncommittedFiles: string[] };
      expect(payload.diff).toContain("# Uncommitted worktree changes (staged and unstaged)");
      expect(payload.diff).toContain("+export const retained = 'staged';");
      expect(payload.diff).toContain("+pending readme");
      expect(payload.uncommittedFiles).toEqual(["README.md", "retained.ts", "untracked.ts"]);
      expect(fs.existsSync(path.join(repo, "retained.ts"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it.each([true, false])("recovers a kept branch for manual merge and cleans up only on success=%s", (success) => {
    const { repo, taskId, worktreePath } = createRetainedTask();
    const taskWorktrees = new Map();
    const { db, postRoutes, mergeCalls, cleanupCalls, appendLogCalls } = createHarness(taskWorktrees, {
      success,
      message: success ? "merged" : "conflict; branch preserved",
      conflicts: success ? [] : ["retained.ts"],
    });
    db.prepare("INSERT INTO tasks (id, project_path, status) VALUES (?, ?, 'done')").run(taskId, repo);

    try {
      const res = createFakeResponse();
      postRoutes.get("/api/tasks/:id/merge")?.({ params: { id: taskId }, body: { expectedTargetBranch: "main" } }, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toMatchObject({ ok: success });
      expect(mergeCalls).toEqual([{ projectPath: repo, taskId }]);
      expect(cleanupCalls).toEqual(success ? [{ projectPath: repo, taskId }] : []);
      expect(
        appendLogCalls.some((entry) =>
          entry.message.includes(success ? "Manual merge completed" : "Manual merge failed"),
        ),
      ).toBe(true);
      if (!success) {
        expect(fs.readFileSync(path.join(worktreePath, "retained.ts"), "utf8")).toContain("retained = true");
        expect(taskWorktrees.get(taskId)?.branchName).toBe("climpire/retained");
      }
    } finally {
      db.close();
    }
  });

  it.each(["changed", "detached", "missing"])("refuses a %s target before any merge or cleanup", (state) => {
    const { repo, taskId, worktreePath } = createRetainedTask();
    fs.writeFileSync(path.join(worktreePath, "pending.ts"), "export const pending = true;\n");
    const h = createHarness(new Map());
    h.db.prepare("INSERT INTO tasks (id, project_path, status) VALUES (?, ?, 'done')").run(taskId, repo);
    try {
      const diff = createFakeResponse();
      h.getRoutes.get("/api/tasks/:id/diff")?.({ params: { id: taskId } }, diff);
      expect(diff.payload).toMatchObject({ targetBranch: "main" });
      if (state === "changed") runGit(repo, ["checkout", "-b", "other-session"]);
      if (state === "detached") runGit(repo, ["checkout", "--detach"]);
      const before = {
        head: runGit(repo, ["rev-parse", "HEAD"]),
        index: runGit(repo, ["write-tree"]),
        pending: runGit(worktreePath, ["status", "--porcelain"]),
      };
      const res = createFakeResponse();
      h.postRoutes.get("/api/tasks/:id/merge")?.(
        { params: { id: taskId }, body: state === "missing" ? {} : { expectedTargetBranch: "main" } },
        res,
      );
      expect(res.statusCode).toBe(state === "missing" ? 400 : 409);
      expect(res.payload).toMatchObject(
        state === "missing"
          ? { error: "expected_target_required" }
          : { code: "target_changed", targetBranch: state === "detached" ? null : "other-session" },
      );
      expect(h.mergeCalls).toEqual([]);
      expect(h.cleanupCalls).toEqual([]);
      expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(before.head);
      expect(runGit(repo, ["write-tree"])).toBe(before.index);
      expect(runGit(worktreePath, ["status", "--porcelain"])).toBe(before.pending);
      const updated = createFakeResponse();
      h.getRoutes.get("/api/tasks/:id/diff")?.({ params: { id: taskId } }, updated);
      expect(updated.payload).toMatchObject({
        ok: true,
        targetBranch: state === "detached" ? null : state === "changed" ? "other-session" : "main",
      });
    } finally {
      h.db.close();
    }
  });
});
