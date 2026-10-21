import { execFileSync } from "node:child_process";
import { ensureDirectiveBranch } from "./directive-branch.ts";
import { integrateTaskBranch } from "./integrate.ts";
import type { WorktreeInfo } from "./lifecycle.ts";
import {
  autoCommitWorktreePendingChanges,
  DIFF_SUMMARY_ERROR,
  DIFF_SUMMARY_NONE,
  hasVisibleDiffSummary,
  readWorktreeStatusShort,
} from "./shared.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type CreateWorktreeMergeToolsDeps = {
  db: DbLike;
  taskWorktrees: Map<string, WorktreeInfo>;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  cleanupWorktree: (projectPath: string, taskId: string) => void;
  resolveLang: (text: string) => string;
  l: (...args: any[]) => any;
  pickL: (...args: any[]) => string;
};

export function createWorktreeMergeTools(deps: CreateWorktreeMergeToolsDeps) {
  const { db, taskWorktrees, appendTaskLog, cleanupWorktree, resolveLang, l, pickL } = deps;

  function mergeWorktree(
    projectPath: string,
    taskId: string,
  ): { success: boolean; message: string; conflicts?: string[] } {
    const info = taskWorktrees.get(taskId);
    if (!info) return { success: false, message: "No worktree found for this task" };
    const taskRow = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as
      | {
          title: string;
          description: string | null;
        }
      | undefined;
    const lang = resolveLang(taskRow?.description ?? taskRow?.title ?? "");

    try {
      const autoCommit = autoCommitWorktreePendingChanges(taskId, info, appendTaskLog);
      if (autoCommit.error) {
        if (autoCommit.errorKind === "restricted_untracked") {
          return {
            success: false,
            message: pickL(
              l(
                [
                  `병합 전 제한된 미추적 파일(${autoCommit.restrictedUntrackedCount}개) 때문에 자동 커밋이 차단되었습니다. 제한 파일을 정리한 뒤 다시 시도하세요.`,
                ],
                [
                  `Pre-merge auto-commit was blocked by restricted untracked files (${autoCommit.restrictedUntrackedCount}). Remove/review restricted files and retry.`,
                ],
                [
                  `マージ前の自動コミットは制限付き未追跡ファイル（${autoCommit.restrictedUntrackedCount}件）によりブロックされました。制限ファイルを整理して再試行してください。`,
                ],
                [
                  `合并前自动提交因受限未跟踪文件（${autoCommit.restrictedUntrackedCount}个）被阻止。请处理受限文件后重试。`,
                ],
              ),
              lang,
            ),
          };
        }
        return {
          success: false,
          message: pickL(
            l(
              [`병합 전 변경사항 자동 커밋에 실패했습니다: ${autoCommit.error}`],
              [`Failed to auto-commit pending changes before merge: ${autoCommit.error}`],
              [`マージ前の未コミット変更の自動コミットに失敗しました: ${autoCommit.error}`],
              [`合并前自动提交未提交更改失败：${autoCommit.error}`],
            ),
            lang,
          ),
        };
      }

      const directive = ensureDirectiveBranch(projectPath, taskId, db);
      const integrationBranch = info.integrationBranch ?? directive.integrationBranch;
      info.integrationBranch = integrationBranch;
      info.rootTaskId = directive.rootTaskId;
      const result = integrateTaskBranch(projectPath, integrationBranch, info.branchName);
      if (!result.success) {
        return {
          success: false,
          conflicts: result.conflicts,
          message: pickL(
            l(
              [`통합 실패 (${integrationBranch}): ${result.conflicts?.join(", ") || result.error}`],
              [`Integration failed (${integrationBranch}): ${result.conflicts?.join(", ") || result.error}`],
              [`統合失敗 (${integrationBranch}): ${result.conflicts?.join(", ") || result.error}`],
              [`集成失败 (${integrationBranch}): ${result.conflicts?.join(", ") || result.error}`],
            ),
            lang,
          ),
        };
      }
      appendTaskLog(
        taskId,
        "system",
        `Integrated ${info.branchName} into ${integrationBranch}; retained for CEO review`,
      );
      return {
        success: true,
        message: pickL(
          l(
            [`통합 완료: ${integrationBranch}. CEO의 브랜치 검토를 기다립니다.`],
            [`Integrated into ${integrationBranch}. Branch retained for CEO review.`],
            [`${integrationBranch} に統合しました。CEO のブランチレビューを待ちます。`],
            [`已集成到 ${integrationBranch}。分支保留供 CEO 审核。`],
          ),
          lang,
        ),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: pickL(
          l([`통합 실패: ${msg}`], [`Integration failed: ${msg}`], [`統合失敗: ${msg}`], [`集成失败: ${msg}`]),
          lang,
        ),
      };
    }
  }

  // Explicit local merge into the project's checked-out branch (auto merge policy
  // or "Merge now"). Never pushes; conflicts abort and leave the checkout as it was.
  function mergeIntoCheckout(
    projectPath: string,
    taskId: string,
    sourceBranch: string,
  ): { success: boolean; message: string; conflicts?: string[] } {
    const taskRow = db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(taskId) as
      | { title: string; description: string | null }
      | undefined;
    const lang = resolveLang(taskRow?.description ?? taskRow?.title ?? "");
    try {
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      const diffCheck = execFileSync("git", ["diff", `${currentBranch}...${sourceBranch}`, "--stat"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      })
        .toString()
        .trim();
      if (!diffCheck) {
        return {
          success: true,
          message: pickL(
            l(
              ["변경사항이 없어 병합이 필요하지 않습니다."],
              ["No changes to merge."],
              ["マージする変更がありません。"],
              ["没有可合并的更改。"],
            ),
            lang,
          ),
        };
      }

      const mergeMsg = `Merge climpire task ${taskId.slice(0, 8)} (branch ${sourceBranch})`;
      execFileSync("git", ["merge", sourceBranch, "--no-ff", "-m", mergeMsg], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 30000,
      });
      return {
        success: true,
        message: pickL(
          l(
            [`병합 완료: ${sourceBranch} → ${currentBranch}`],
            [`Merge completed: ${sourceBranch} -> ${currentBranch}`],
            [`マージ完了: ${sourceBranch} -> ${currentBranch}`],
            [`合并完成: ${sourceBranch} -> ${currentBranch}`],
          ),
          lang,
        ),
      };
    } catch (err: unknown) {
      let conflicts: string[] = [];
      try {
        const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();
        conflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["merge", "--abort"], { cwd: projectPath, stdio: "pipe", timeout: 5000 });
      } catch {
        /* no merge in progress */
      }
      if (conflicts.length > 0) {
        return {
          success: false,
          message: pickL(
            l(
              [`병합 충돌 발생: ${conflicts.length}개 파일에서 충돌이 있습니다. 수동 해결이 필요합니다.`],
              [`Merge conflict: ${conflicts.length} file(s) have conflicts and need manual resolution.`],
              [`マージ競合: ${conflicts.length}件のファイルで競合が発生し、手動解決が必要です。`],
              [`合并冲突：${conflicts.length} 个文件存在冲突，需要手动解决。`],
            ),
            lang,
          ),
          conflicts,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: pickL(
          l([`병합 실패: ${msg}`], [`Merge failed: ${msg}`], [`マージ失敗: ${msg}`], [`合并失败: ${msg}`]),
          lang,
        ),
      };
    }
  }

  function getWorktreeDiffSummary(projectPath: string, taskId: string): string {
    const info = taskWorktrees.get(taskId);
    if (!info) return "";

    try {
      const currentBranch =
        info.integrationBranch ??
        execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: projectPath,
          stdio: "pipe",
          timeout: 5000,
        })
          .toString()
          .trim();

      const stat = execFileSync("git", ["diff", `${currentBranch}...${info.branchName}`, "--stat"], {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      })
        .toString()
        .trim();

      const worktreePending = readWorktreeStatusShort(info.worktreePath);
      if (stat && worktreePending) return `${stat}\n\n[uncommitted worktree changes]\n${worktreePending}`;
      if (stat) return stat;
      if (worktreePending) return `[uncommitted worktree changes]\n${worktreePending}`;
      return DIFF_SUMMARY_NONE;
    } catch {
      return DIFF_SUMMARY_ERROR;
    }
  }

  function rollbackTaskWorktree(taskId: string, reason: string): boolean {
    const info = taskWorktrees.get(taskId);
    if (!info) return false;

    const diffSummary = getWorktreeDiffSummary(info.projectPath, taskId);
    if (hasVisibleDiffSummary(diffSummary)) {
      appendTaskLog(taskId, "system", `Rollback(${reason}) diff summary:\n${diffSummary}`);
    }

    cleanupWorktree(info.projectPath, taskId);
    appendTaskLog(taskId, "system", `Worktree rollback completed (${reason})`);
    return true;
  }

  return {
    mergeWorktree,
    mergeIntoCheckout,
    rollbackTaskWorktree,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
  };
}
