import { execFileSync } from "node:child_process";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { CliUsageEntry } from "../shared/types.ts";
import { discoverTaskWorktree, discoverTaskWorktrees } from "../../workflow/core/worktree/lifecycle.ts";
import { autoCommitWorktreePendingChanges } from "../../workflow/core/worktree/shared.ts";

function readGitLines(cwd: string, args: string[], timeout = 8000): string[] {
  const output = execFileSync("git", args, { cwd, stdio: "pipe", timeout }).toString().trim();
  return output
    ? output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function tryReadGitLines(cwd: string, args: string[], timeout = 8000): string[] {
  try {
    return readGitLines(cwd, args, timeout);
  } catch {
    return [];
  }
}

function refExists(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], { cwd, stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function resolveCompareRef(projectPath: string, worktreePath: string): string | null {
  const preferredCandidates: string[] = [];

  try {
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    if (currentBranch && currentBranch !== "HEAD") {
      preferredCandidates.push(`origin/${currentBranch}`, currentBranch);
    }
  } catch {
    // ignore and fall back to generic candidates
  }

  preferredCandidates.push("origin/main", "main", "origin/master", "master");

  for (const candidate of preferredCandidates) {
    if (refExists(worktreePath, candidate)) return candidate;
  }
  return null;
}

function isCodeLikePath(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|scss|py|md|yml|yaml|sh|ps1|sql)$/i.test(filePath);
}

function isIgnoredWorktreeArtifact(filePath: string): boolean {
  return filePath === ".claude/skills" || filePath.startsWith(".claude/skills/");
}

function readUncommittedFiles(worktreePath: string): string[] {
  const entries = execFileSync("git", ["status", "--porcelain", "-z"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 8000,
  })
    .toString()
    .split("\0");
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!entry) continue;
    const filePath = entry.slice(3);
    if (filePath && !isIgnoredWorktreeArtifact(filePath)) files.push(filePath);
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  return files;
}

type VerifyCommitState = {
  ok: true;
  hasWorktree: boolean;
  worktreePath: string | null;
  branchName?: string;
  compareRef: string | null;
  hasCommit: boolean;
  commitCount: number;
  commits: string[];
  files: string[];
  uncommittedFiles: string[];
  hasUncommittedChanges: boolean;
  hasRealCode: boolean;
  verdict: "no_worktree" | "no_commit" | "dirty_without_commit" | "commit_but_no_code" | "ok";
};

function inspectWorktreeVerification(wtInfo?: {
  worktreePath: string;
  branchName: string;
  projectPath: string;
}): VerifyCommitState {
  const worktreePath = wtInfo?.worktreePath ?? null;
  if (!wtInfo || !worktreePath) {
    return {
      ok: true,
      hasWorktree: false,
      worktreePath: null,
      compareRef: null,
      hasCommit: false,
      commitCount: 0,
      commits: [],
      files: [],
      uncommittedFiles: [],
      hasUncommittedChanges: false,
      hasRealCode: false,
      verdict: "no_worktree",
    };
  }

  const compareRef = resolveCompareRef(wtInfo.projectPath, worktreePath);
  const commits = compareRef ? readGitLines(worktreePath, ["log", `${compareRef}..HEAD`, "--oneline"]) : [];
  const changedFiles = (
    compareRef ? tryReadGitLines(worktreePath, ["diff", `${compareRef}..HEAD`, "--name-only"]) : []
  ).filter((filePath) => !isIgnoredWorktreeArtifact(filePath));
  const uncommittedFiles = readUncommittedFiles(worktreePath);
  const hasRealCode = changedFiles.some(isCodeLikePath);
  const hasUncommittedChanges = uncommittedFiles.length > 0;

  const verdict =
    commits.length === 0
      ? hasUncommittedChanges
        ? "dirty_without_commit"
        : "no_commit"
      : hasRealCode
        ? "ok"
        : "commit_but_no_code";

  return {
    ok: true,
    hasWorktree: true,
    worktreePath,
    branchName: wtInfo.branchName,
    compareRef,
    hasCommit: commits.length > 0,
    commitCount: commits.length,
    commits,
    files: changedFiles,
    uncommittedFiles,
    hasUncommittedChanges,
    hasRealCode,
    verdict,
  };
}

export function registerWorktreeAndUsageRoutes(ctx: RuntimeContext): {
  refreshCliUsageData: () => Promise<Record<string, CliUsageEntry>>;
} {
  const {
    app,
    taskWorktrees,
    mergeWorktree,
    mergeIntoCheckout,
    cleanupWorktree,
    appendTaskLog,
    resolveLang,
    pickL,
    l,
    notifyCeo,
    db,
    nowMs,
    CLI_TOOLS,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    broadcast,
  } = ctx;

  function findTaskWorktree(taskId: string) {
    const cached = taskWorktrees.get(taskId);
    if (cached) return cached;
    const task = db
      .prepare(
        "SELECT COALESCE(NULLIF(TRIM(t.project_path), ''), p.project_path) AS project_path FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
      )
      .get(taskId) as { project_path: string | null } | undefined;
    if (!task?.project_path) return undefined;
    const recovered = discoverTaskWorktree(task.project_path, taskId);
    if (recovered) taskWorktrees.set(taskId, recovered);
    return recovered;
  }

  // A completed directive root keeps its integration branch after task worktrees are
  // cleaned up; Merge now can still merge that branch into the checkout.
  function findDirectiveBranch(taskId: string): { projectPath: string; branchName: string } | undefined {
    const task = db
      .prepare(
        "SELECT t.status, t.source_task_id, COALESCE(NULLIF(TRIM(t.project_path), ''), p.project_path) AS project_path FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
      )
      .get(taskId) as { status: string; source_task_id: string | null; project_path: string | null } | undefined;
    if (!task?.project_path || task.status !== "done" || task.source_task_id) return undefined;
    const branchName = `climpire/d-${taskId}`;
    try {
      readGitLines(task.project_path, ["show-ref", "--verify", `refs/heads/${branchName}`]);
    } catch {
      return undefined;
    }
    return { projectPath: task.project_path, branchName };
  }

  app.get("/api/tasks/:id/diff", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = findTaskWorktree(id);
    if (!wtInfo) {
      const directive = findDirectiveBranch(id);
      if (!directive) return res.json({ ok: true, hasWorktree: false, diff: "", stat: "" });
      try {
        const currentBranch = readGitLines(directive.projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])[0];
        const range = `${currentBranch}...${directive.branchName}`;
        const stat = execFileSync("git", ["diff", range, "--stat"], {
          cwd: directive.projectPath,
          stdio: "pipe",
          timeout: 10000,
        })
          .toString()
          .trim();
        const diff = execFileSync("git", ["diff", range], {
          cwd: directive.projectPath,
          stdio: "pipe",
          timeout: 15000,
        }).toString();
        return res.json({
          ok: true,
          hasWorktree: true,
          mergeSource: "directive",
          branchName: directive.branchName,
          targetBranch: currentBranch === "HEAD" ? null : currentBranch,
          projectPath: directive.projectPath,
          hasUncommittedChanges: false,
          uncommittedFiles: [],
          stat,
          diff: diff.length > 50000 ? diff.slice(0, 50000) + "\n... (truncated)" : diff,
        });
      } catch (err: unknown) {
        return res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    try {
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: wtInfo.projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      let stat = execFileSync("git", ["diff", `${currentBranch}...${wtInfo.branchName}`, "--stat"], {
        cwd: wtInfo.projectPath,
        stdio: "pipe",
        timeout: 10000,
      })
        .toString()
        .trim();

      let diff = execFileSync("git", ["diff", `${currentBranch}...${wtInfo.branchName}`], {
        cwd: wtInfo.projectPath,
        stdio: "pipe",
        timeout: 15000,
      }).toString();

      const uncommittedFiles = readUncommittedFiles(wtInfo.worktreePath);
      if (uncommittedFiles.length > 0) {
        const pendingDiff = execFileSync("git", ["diff", "HEAD", "--"], {
          cwd: wtInfo.worktreePath,
          stdio: "pipe",
          timeout: 15000,
        }).toString();
        if (pendingDiff) {
          const pendingStat = readGitLines(wtInfo.worktreePath, ["diff", "HEAD", "--stat"]).join("\n");
          stat += `\n\nUncommitted worktree changes:\n${pendingStat}`;
          diff += `\n\n# Uncommitted worktree changes (staged and unstaged)\n${pendingDiff}`;
        }
      }

      res.json({
        ok: true,
        hasWorktree: true,
        mergeSource: "task",
        branchName: wtInfo.branchName,
        targetBranch: currentBranch === "HEAD" ? null : currentBranch,
        projectPath: wtInfo.projectPath,
        hasUncommittedChanges: uncommittedFiles.length > 0,
        uncommittedFiles,
        stat,
        diff: diff.length > 50000 ? diff.slice(0, 50000) + "\n... (truncated)" : diff,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ ok: false, error: msg });
    }
  });

  app.post("/api/tasks/:id/merge", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = findTaskWorktree(id);
    const expectedTargetBranch = req.body?.expectedTargetBranch;

    // Before completion, a request without a target is directive approval: integrate the
    // task branch into its directive branch. The project checkout is not touched.
    const taskStatus = (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined)
      ?.status;
    if (expectedTargetBranch === undefined && taskStatus !== "done") {
      if (!wtInfo) {
        return res.status(404).json({ error: "no_worktree", message: "No worktree found for this task" });
      }
      const result = mergeWorktree(wtInfo.projectPath, id);
      if (result.success) {
        cleanupWorktree(wtInfo.projectPath, id);
        appendTaskLog(id, "system", `Directive integration completed: ${result.message}`);
      } else {
        appendTaskLog(id, "system", `Directive integration failed: ${result.message}`);
      }
      return res.json({ ok: result.success, message: result.message, conflicts: result.conflicts });
    }

    // Merge now: merge into the project's checkout. The source is a retained task
    // branch, or the integration branch of a completed directive.
    const directive = wtInfo ? undefined : findDirectiveBranch(id);
    const source = wtInfo ?? directive;
    if (!source) {
      return res.status(404).json({ error: "no_worktree", message: "No worktree found for this task" });
    }

    // Explicit merges must name the checkout the user reviewed. Validate before
    // auto-committing pending work or invoking any checkout mutation.
    if (typeof expectedTargetBranch !== "string" || !expectedTargetBranch.trim()) {
      return res.status(400).json({ ok: false, error: "expected_target_required" });
    }
    try {
      const currentBranch = readGitLines(source.projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])[0];
      const targetBranch = currentBranch === "HEAD" ? null : currentBranch;
      if (!targetBranch || targetBranch !== expectedTargetBranch) {
        return res.status(409).json({
          ok: false,
          error: "target_changed",
          code: "target_changed",
          targetBranch: targetBranch ?? null,
        });
      }
    } catch (err: unknown) {
      return res.status(409).json({
        ok: false,
        error: "target_unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const lang = resolveLang();
    if (wtInfo) {
      let verificationState: VerifyCommitState | null = null;
      try {
        verificationState = inspectWorktreeVerification(wtInfo);
      } catch (err: unknown) {
        appendTaskLog(
          id,
          "system",
          `Final branch verification: skipped (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      if (verificationState?.verdict === "ok") {
        appendTaskLog(
          id,
          "system",
          `Final branch verification: passed (ref=${verificationState.compareRef ?? "unknown"}, commits=${verificationState.commitCount}, files=${verificationState.files.length})`,
        );
      } else if (verificationState && verificationState.verdict !== "no_worktree") {
        appendTaskLog(
          id,
          "system",
          `Final branch verification: warning (verdict=${verificationState.verdict}, commits=${verificationState.commitCount}, uncommitted=${verificationState.uncommittedFiles.length})`,
        );
      }

      const autoCommit = autoCommitWorktreePendingChanges(id, wtInfo, appendTaskLog);
      if (autoCommit.error) {
        const message = `Pre-merge auto-commit failed: ${autoCommit.error}`;
        appendTaskLog(id, "system", `Manual merge failed: ${message}`);
        return res.json({ ok: false, message });
      }
    }

    const result = mergeIntoCheckout(source.projectPath, id, source.branchName);
    if (result.success) {
      if (wtInfo) cleanupWorktree(wtInfo.projectPath, id);
      appendTaskLog(id, "system", `Manual merge completed: ${result.message}`);
      notifyCeo(
        pickL(
          l(
            [`수동 병합 완료: ${result.message}`],
            [`Manual merge completed: ${result.message}`],
            [`手動マージ完了: ${result.message}`],
            [`手动合并完成: ${result.message}`],
          ),
          lang,
        ),
        id,
      );
    } else {
      appendTaskLog(id, "system", `Manual merge failed: ${result.message}`);
    }

    res.json({ ok: result.success, message: result.message, conflicts: result.conflicts });
  });

  app.post("/api/tasks/:id/discard", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = findTaskWorktree(id);
    if (!wtInfo) {
      return res.status(404).json({ error: "no_worktree", message: "No worktree found for this task" });
    }

    cleanupWorktree(wtInfo.projectPath, id);
    appendTaskLog(id, "system", "Worktree discarded (changes abandoned)");
    const lang = resolveLang();
    notifyCeo(
      pickL(
        l(
          [`작업 브랜치가 폐기되었습니다: climpire/${id.slice(0, 8)}`],
          [`Task branch discarded: climpire/${id.slice(0, 8)}`],
          [`タスクブランチを破棄しました: climpire/${id.slice(0, 8)}`],
          [`任务分支已丢弃: climpire/${id.slice(0, 8)}`],
        ),
        lang,
      ),
      id,
    );

    res.json({ ok: true, message: "Worktree discarded" });
  });

  app.get("/api/tasks/:id/verify-commit", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = findTaskWorktree(id);

    try {
      return res.json(inspectWorktreeVerification(wtInfo));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.json({ ok: false, error: msg, verdict: "error" });
    }
  });

  app.get("/api/worktrees", (_req, res) => {
    const tasks = db
      .prepare(
        "SELECT t.id, COALESCE(NULLIF(TRIM(t.project_path), ''), p.project_path) AS project_path FROM tasks t LEFT JOIN projects p ON p.id = t.project_id",
      )
      .all() as Array<{ id: string; project_path: string | null }>;
    const tasksByProject = new Map<string, string[]>();
    for (const task of tasks) {
      if (!task.project_path || taskWorktrees.has(task.id)) continue;
      const taskIds = tasksByProject.get(task.project_path) ?? [];
      taskIds.push(task.id);
      tasksByProject.set(task.project_path, taskIds);
    }
    for (const [projectPath, taskIds] of tasksByProject) {
      for (const [taskId, info] of discoverTaskWorktrees(projectPath, taskIds)) {
        taskWorktrees.set(taskId, info);
      }
    }
    const entries: Array<{ taskId: string; branchName: string; worktreePath: string; projectPath: string }> = [];
    for (const [taskId, info] of taskWorktrees) {
      entries.push({ taskId, ...info });
    }
    res.json({ ok: true, worktrees: entries });
  });

  function readCliUsageFromDb(): Record<string, CliUsageEntry> {
    const rows = db.prepare("SELECT provider, data_json FROM cli_usage_cache").all() as Array<{
      provider: string;
      data_json: string;
    }>;
    const usage: Record<string, CliUsageEntry> = {};
    for (const row of rows) {
      try {
        usage[row.provider] = JSON.parse(row.data_json);
      } catch {
        // invalid json row
      }
    }
    return usage;
  }

  async function refreshCliUsageData(): Promise<Record<string, CliUsageEntry>> {
    const providers = ["claude", "codex", "gemini", "copilot", "antigravity"];
    const usage: Record<string, CliUsageEntry> = {};

    const fetchMap: Record<string, () => Promise<CliUsageEntry>> = {
      claude: fetchClaudeUsage,
      codex: fetchCodexUsage,
      gemini: fetchGeminiUsage,
    };

    const fetches = providers.map(async (p) => {
      const tool = CLI_TOOLS.find((t) => t.name === p);
      if (!tool) {
        usage[p] = { windows: [], error: "not_implemented" };
        return;
      }
      if (!tool.checkAuth()) {
        usage[p] = { windows: [], error: "unauthenticated" };
        return;
      }
      const fetcher = fetchMap[p];
      if (fetcher) {
        usage[p] = await fetcher();
      } else {
        usage[p] = { windows: [], error: "not_implemented" };
      }
    });

    await Promise.all(fetches);

    const upsert = db.prepare(
      "INSERT INTO cli_usage_cache (provider, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
    );
    const now = nowMs();
    for (const [p, entry] of Object.entries(usage)) {
      upsert.run(p, JSON.stringify(entry), now);
    }

    return usage;
  }

  app.get("/api/cli-usage", async (_req, res) => {
    let usage = readCliUsageFromDb();
    if (Object.keys(usage).length === 0) {
      usage = await refreshCliUsageData();
    }
    res.json({ ok: true, usage });
  });

  app.post("/api/cli-usage/refresh", async (_req, res) => {
    try {
      const usage = await refreshCliUsageData();
      broadcast("cli_usage_update", usage);
      res.json({ ok: true, usage });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  return { refreshCliUsageData };
}
