import { useState, useCallback, useEffect } from "react";
import { useI18n, type UiLanguage } from "../../i18n";
import { isApiRequestError } from "../../api/core";
import {
  discardTask,
  getTaskDiff,
  getTaskVerifyCommit,
  integrateTask,
  mergeTask,
  type TaskDiffResult,
  type TaskVerifyCommitResult,
} from "../../api";
import type { TaskStatus } from "../../types";
import { DirectiveBranchChip } from "./DirectiveProgress";
import type { TaskDirectiveContext } from "./directive-progress";

interface DiffModalProps {
  taskId: string;
  onClose: () => void;
  language?: UiLanguage;
  onWorktreeRemoved?: () => void;
  directive?: TaskDirectiveContext;
  ownerName?: string | null;
  /** Tasks that are not done yet are approved by integrating into their directive branch. */
  taskStatus?: TaskStatus;
}

type IntegrationOutcome =
  | { kind: "integrated"; message: string }
  | { kind: "conflict"; message: string; conflicts: string[] }
  | { kind: "failed"; message: string };

function DiffModal({ taskId, onClose, language, onWorktreeRemoved, directive, ownerName, taskStatus }: DiffModalProps) {
  const { t } = useI18n(language);
  const [diffData, setDiffData] = useState<TaskDiffResult | null>(null);
  const [verifyData, setVerifyData] = useState<TaskVerifyCommitResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [worktreeRemoved, setWorktreeRemoved] = useState(false);
  const [outcome, setOutcome] = useState<IntegrationOutcome | null>(null);
  // Before completion the action is directive approval; afterwards it is Merge now.
  const integrateMode = taskStatus !== undefined && taskStatus !== "done";
  const integrationBranch = directive?.branch ?? null;
  // Child and revision tasks integrate inside the root's single CEO approval.
  const approvedWithDirective = !!directive && !directive.isRoot;
  const directiveSummary = directive?.isRoot ? directive.summary : null;
  const openParts = directiveSummary
    ? directiveSummary.parts.length - directiveSummary.counts.integrated - directiveSummary.counts.awaiting_approval
    : 0;
  const waitingOnParts = directiveSummary?.readiness === "not_ready";

  useEffect(() => {
    Promise.allSettled([getTaskDiff(taskId), getTaskVerifyCommit(taskId)]).then(([diffResult, verifyResult]) => {
      if (diffResult.status === "fulfilled") {
        const d = diffResult.value;
        if (!d.ok)
          setError(d.error || t({ ko: "알 수 없는 오류", en: "Unknown error", ja: "不明なエラー", zh: "未知错误" }));
        else setDiffData(d);
      } else {
        setError(diffResult.reason instanceof Error ? diffResult.reason.message : String(diffResult.reason));
      }

      if (verifyResult.status === "fulfilled") {
        const v = verifyResult.value;
        if (!v.ok)
          setVerifyError(v.error || t({ ko: "검증 실패", en: "Verification failed", ja: "検証失敗", zh: "校验失败" }));
        else setVerifyData(v);
      } else {
        setVerifyError(
          verifyResult.reason instanceof Error ? verifyResult.reason.message : String(verifyResult.reason),
        );
      }
      setLoading(false);
    });
  }, [taskId, t]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleMerge = useCallback(async () => {
    if (!diffData?.hasWorktree || !diffData.targetBranch) return;
    const { branchName, targetBranch, projectPath } = diffData;
    if (
      !confirm(
        t({
          ko: `${branchName}을(를) ${targetBranch}에 병합하시겠습니까? ${projectPath}의 로컬 체크아웃이 변경됩니다. 원격으로 푸시하지 않습니다.`,
          en: `Merge ${branchName} into ${targetBranch}? This changes the local checkout at ${projectPath}. Nothing will be pushed to a remote.`,
          ja: `${branchName} を ${targetBranch} にマージしますか？${projectPath} のローカルチェックアウトが変更されます。リモートへはプッシュしません。`,
          zh: `要将 ${branchName} 合并到 ${targetBranch} 吗？这会更改 ${projectPath} 的本地检出，不会推送到远程。`,
        }),
      )
    )
      return;
    setMerging(true);
    setActionResult(null);
    try {
      const result = await mergeTask(taskId, targetBranch);
      setActionResult(
        result.ok
          ? `${t({ ko: "병합 완료", en: "Merge completed", ja: "マージ完了", zh: "合并完成" })}: ${result.message}`
          : `${t({ ko: "병합 실패", en: "Merge failed", ja: "マージ失敗", zh: "合并失败" })}: ${result.message}`,
      );
      if (result.ok) {
        setWorktreeRemoved(true);
        onWorktreeRemoved?.();
      }
    } catch (e: unknown) {
      if (isApiRequestError(e) && e.code === "target_changed") {
        // Refresh the diff as well as the target. A retry always needs a new confirmation.
        setDiffData(null);
        try {
          const refreshed = await getTaskDiff(taskId);
          if (!refreshed.ok) throw new Error(refreshed.error || "Unable to refresh target");
          setDiffData(refreshed);
          const target = refreshed.targetBranch ?? "HEAD";
          setActionResult(
            t({
              ko: `프로젝트 체크아웃이 ${target}(으)로 바뀌었습니다. 대상을 확인한 후 다시 승인하세요.`,
              en: `The project checkout changed to ${target}. Review the target and confirm again.`,
              ja: `プロジェクトのチェックアウトが ${target} に変わりました。対象を確認して再度承認してください。`,
              zh: `项目检出已变更为 ${target}。请确认目标后重新确认。`,
            }),
          );
        } catch (refreshError) {
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
        return;
      }
      setActionResult(
        `${t({ ko: "오류", en: "Error", ja: "エラー", zh: "错误" })}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setMerging(false);
    }
  }, [taskId, onWorktreeRemoved, t, diffData]);

  const handleIntegrate = useCallback(
    async (retry = false) => {
      const target =
        integrationBranch ??
        t({ ko: "디렉티브 브랜치", en: "the directive branch", ja: "ディレクティブブランチ", zh: "指令分支" });
      if (
        !retry &&
        !confirm(
          t({
            ko: `이 디렉티브를 승인하고 ${target}에 통합하시겠습니까?\n\n로컬 통합만 수행합니다. 프로젝트 체크아웃, dev, main은 변경되지 않으며 push나 PR은 없습니다.`,
            en: `Approve this directive and integrate it into ${target}?\n\nLocal integration only: the project checkout, dev and main are not changed, and nothing is pushed or opened as a PR.`,
            ja: `このディレクティブを承認し ${target} に統合しますか？\n\nローカル統合のみです。プロジェクトのチェックアウト、dev、main は変更されず、push や PR も行いません。`,
            zh: `批准此指令并集成到 ${target} 吗？\n\n仅本地集成：项目检出、dev 和 main 不会更改，也不会推送或创建 PR。`,
          }),
        )
      )
        return;
      setMerging(true);
      setOutcome(null);
      try {
        const result = await integrateTask(taskId);
        if (result.ok) {
          setOutcome({ kind: "integrated", message: result.message });
          setWorktreeRemoved(true);
          onWorktreeRemoved?.();
        } else if (result.conflicts?.length)
          setOutcome({ kind: "conflict", message: result.message, conflicts: result.conflicts });
        else setOutcome({ kind: "failed", message: result.message });
      } catch (e: unknown) {
        setOutcome({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      } finally {
        setMerging(false);
      }
    },
    [taskId, integrationBranch, onWorktreeRemoved, t],
  );

  const handleDiscard = useCallback(async () => {
    if (
      !confirm(
        t({
          ko: "이 브랜치의 변경사항을 모두 폐기하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
          en: "Discard all changes in this branch? This action cannot be undone.",
          ja: "このブランチの変更をすべて破棄しますか？この操作は元に戻せません。",
          zh: "要丢弃此分支的所有更改吗？此操作无法撤销。",
        }),
      )
    )
      return;
    setDiscarding(true);
    try {
      const result = await discardTask(taskId);
      setActionResult(
        result.ok
          ? t({
              ko: "브랜치가 폐기되었습니다.",
              en: "Branch was discarded.",
              ja: "ブランチを破棄しました。",
              zh: "分支已丢弃。",
            })
          : `${t({ ko: "폐기 실패", en: "Discard failed", ja: "破棄失敗", zh: "丢弃失败" })}: ${result.message}`,
      );
      if (result.ok) {
        setWorktreeRemoved(true);
        onWorktreeRemoved?.();
      }
    } catch (e: unknown) {
      setActionResult(
        `${t({ ko: "오류", en: "Error", ja: "エラー", zh: "错误" })}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setDiscarding(false);
    }
  }, [taskId, onWorktreeRemoved, t]);

  const verifyToneClass =
    verifyData?.verdict === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : verifyData?.verdict === "dirty_without_commit" || verifyData?.verdict === "commit_but_no_code"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
        : "border-slate-700 bg-slate-800/70 text-slate-300";

  const verifyVerdictLabel = (() => {
    switch (verifyData?.verdict) {
      case "ok":
        return t({ ko: "통과", en: "Passed", ja: "成功", zh: "通过" });
      case "dirty_without_commit":
        return t({ ko: "미커밋 변경", en: "Uncommitted changes", ja: "未コミット変更", zh: "未提交变更" });
      case "commit_but_no_code":
        return t({ ko: "코드 외 변경", en: "No code changes", ja: "コード変更なし", zh: "无代码变更" });
      case "no_commit":
        return t({ ko: "커밋 없음", en: "No commit", ja: "コミットなし", zh: "无提交" });
      case "no_worktree":
        return t({ ko: "워크트리 없음", en: "No worktree", ja: "ワークツリーなし", zh: "无工作树" });
      default:
        return t({ ko: "확인 불가", en: "Unknown", ja: "不明", zh: "未知" });
    }
  })();

  const commitLabel =
    verifyData && typeof verifyData.commitCount === "number"
      ? t({
          ko: `${verifyData.commitCount}개 커밋`,
          en: `${verifyData.commitCount} commit${verifyData.commitCount === 1 ? "" : "s"}`,
          ja: `${verifyData.commitCount}件のコミット`,
          zh: `${verifyData.commitCount} 个提交`,
        })
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-3">
          <div className="min-w-0">
            <span className="text-lg font-bold text-white">
              {t({ ko: "Git 변경사항", en: "Git Diff", ja: "Git 差分", zh: "Git 差异" })}
            </span>
            {diffData?.branchName && (
              <p className="mt-1 break-all font-mono text-xs text-slate-300">
                {diffData.branchName} →{" "}
                {integrateMode ? (integrationBranch ?? "HEAD") : (diffData.targetBranch ?? "HEAD")}
              </p>
            )}
            {integrateMode && integrationBranch && (
              <div className="mt-1">
                <DirectiveBranchChip branch={integrationBranch} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {integrateMode ? (
              !approvedWithDirective && (
                <button
                  onClick={() => void handleIntegrate()}
                  disabled={
                    merging || discarding || loading || worktreeRemoved || !diffData?.hasWorktree || waitingOnParts
                  }
                  aria-describedby={waitingOnParts ? "directive-approval-hold" : undefined}
                  className="rounded-lg bg-green-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-600 disabled:opacity-40"
                >
                  {merging
                    ? "..."
                    : t({ ko: "디렉티브 승인", en: "Approve directive", ja: "ディレクティブを承認", zh: "批准指令" })}
                </button>
              )
            ) : (
              <button
                onClick={handleMerge}
                disabled={
                  merging ||
                  discarding ||
                  loading ||
                  worktreeRemoved ||
                  !diffData?.hasWorktree ||
                  !diffData.targetBranch
                }
                className="rounded-lg bg-green-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-600 disabled:opacity-40"
              >
                {merging
                  ? t({ ko: "병합 중...", en: "Merging...", ja: "マージ中...", zh: "正在合并..." })
                  : t({ ko: "지금 병합", en: "Merge now", ja: "今すぐマージ", zh: "立即合并" })}
              </button>
            )}
            <button
              onClick={handleDiscard}
              disabled={
                merging ||
                discarding ||
                loading ||
                worktreeRemoved ||
                !diffData?.hasWorktree ||
                diffData.mergeSource === "directive"
              }
              className="rounded-lg bg-red-800 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-40"
            >
              {discarding
                ? t({ ko: "폐기 중...", en: "Discarding...", ja: "破棄中...", zh: "正在丢弃..." })
                : t({ ko: "폐기", en: "Discard", ja: "破棄", zh: "丢弃" })}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              title={t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "关闭" })}
            >
              X
            </button>
          </div>
        </div>

        {integrateMode && approvedWithDirective && (
          <p className="border-b border-slate-700 bg-slate-800 px-5 py-2 text-xs text-sky-300">
            {t({
              ko: "이 작업은 별도로 승인하지 않습니다. 루트 디렉티브의 단일 CEO 승인에서 함께 통합됩니다.",
              en: "This part is not approved on its own. It integrates with the root directive's single CEO approval.",
              ja: "この作業は単独では承認しません。ルートディレクティブの一括 CEO 承認で統合されます。",
              zh: "此部分不单独审批，将随根指令的一次性 CEO 审批一并集成。",
            })}
          </p>
        )}
        {integrateMode && waitingOnParts && (
          <p
            id="directive-approval-hold"
            className="border-b border-slate-700 bg-slate-800 px-5 py-2 text-xs text-amber-300"
          >
            {t({
              ko: `승인 보류: 아직 ${openParts}개 작업이 통합 준비되지 않았습니다.`,
              en: `Approval on hold: ${openParts} part(s) are not ready to integrate yet.`,
              ja: `承認保留: まだ ${openParts} 件が統合準備できていません。`,
              zh: `审批暂缓：仍有 ${openParts} 项尚未准备好集成。`,
            })}
          </p>
        )}

        {/* Integration outcome */}
        {outcome?.kind === "integrated" && (
          <div
            role="status"
            className="border-b border-emerald-500/30 bg-emerald-500/10 px-5 py-2 text-sm text-emerald-200"
          >
            <p className="font-medium">
              ✅{" "}
              {t({
                ko: `${integrationBranch ?? "디렉티브 브랜치"}에 통합되었습니다. 검토를 위해 브랜치가 유지됩니다.`,
                en: `Integrated into ${integrationBranch ?? "the directive branch"}. The branch is kept for your review.`,
                ja: `${integrationBranch ?? "ディレクティブブランチ"} に統合しました。レビュー用にブランチを保持します。`,
                zh: `已集成到 ${integrationBranch ?? "指令分支"}。分支已保留供您审核。`,
              })}
            </p>
            <p className="text-xs text-emerald-300/80">
              {t({
                ko: "프로젝트 체크아웃, dev, main은 변경되지 않았고 push되지 않았습니다. 게시는 별도의 CEO 작업입니다.",
                en: "Project checkout, dev and main are unchanged and nothing was pushed. Publishing is a separate CEO action.",
                ja: "プロジェクトのチェックアウト、dev、main は未変更で push もしていません。公開は別の CEO 操作です。",
                zh: "项目检出、dev 和 main 均未更改，也未推送。发布是单独的 CEO 操作。",
              })}
            </p>
          </div>
        )}
        {outcome && outcome.kind !== "integrated" && (
          <div role="alert" className="border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-sm text-red-200">
            <p className="font-medium">
              ⚠️{" "}
              {outcome.kind === "conflict"
                ? t({
                    ko: "통합 충돌: 디렉티브 브랜치는 변경되지 않았습니다.",
                    en: "Integration conflict: the directive branch was not changed.",
                    ja: "統合コンフリクト: ディレクティブブランチは変更されていません。",
                    zh: "集成冲突：指令分支未被更改。",
                  })
                : t({
                    ko: "통합 실패: 디렉티브 브랜치는 변경되지 않았습니다.",
                    en: "Integration failed: the directive branch was not changed.",
                    ja: "統合失敗: ディレクティブブランチは変更されていません。",
                    zh: "集成失败：指令分支未被更改。",
                  })}
            </p>
            {outcome.kind === "conflict" && (
              <>
                <ul className="mt-1 list-inside list-disc font-mono text-xs text-red-200/90">
                  {outcome.conflicts.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-red-200/80">
                  {t({
                    ko: `${ownerName ?? "담당자"}가 기존 워크트리에서 충돌을 해결한 뒤 다시 시도하세요.`,
                    en: `${ownerName ?? "The owner"} resolves these in the retained worktree; then retry.`,
                    ja: `${ownerName ?? "担当者"} が既存のワークツリーで解消した後、再試行してください。`,
                    zh: `由 ${ownerName ?? "负责人"} 在保留的工作树中解决后再重试。`,
                  })}
                </p>
              </>
            )}
            {outcome.kind === "failed" && <p className="text-xs text-red-200/80">{outcome.message}</p>}
            <button
              type="button"
              onClick={() => void handleIntegrate(true)}
              disabled={merging}
              className="mt-1.5 rounded bg-red-800 px-2 py-1 text-xs font-medium text-white transition hover:bg-red-700 disabled:opacity-40"
            >
              ↻ {t({ ko: "통합 다시 시도", en: "Retry integration", ja: "統合を再試行", zh: "重试集成" })}
            </button>
          </div>
        )}

        {/* Action result */}
        {actionResult && (
          <div role="status" className="border-b border-slate-700 bg-slate-800 px-5 py-2 text-sm text-amber-300">
            {actionResult}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              {t({
                ko: "변경사항 불러오는 중...",
                en: "Loading diff...",
                ja: "差分を読み込み中...",
                zh: "正在加载差异...",
              })}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-12 text-red-400">
              {t({ ko: "오류", en: "Error", ja: "エラー", zh: "错误" })}: {error}
            </div>
          ) : !diffData?.hasWorktree ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              {t({
                ko: "이 작업의 워크트리를 찾을 수 없습니다. (Git 프로젝트 아님 또는 이미 병합됨)",
                en: "No worktree found for this task (non-git project or already merged)",
                ja: "このタスクのワークツリーが見つかりません（Git プロジェクトではない、または既にマージ済み）",
                zh: "找不到该任务的 worktree（非 Git 项目或已合并）",
              })}
            </div>
          ) : (
            <div className="space-y-4">
              {!diffData.targetBranch && (
                <div role="alert" className="rounded-lg border border-amber-500/40 p-3 text-xs text-amber-200">
                  {t({
                    ko: "프로젝트 체크아웃이 분리된 HEAD 상태입니다. 병합하기 전에 브랜치를 체크아웃하세요.",
                    en: "Project checkout is detached; check out a branch before merging.",
                    ja: "プロジェクトのチェックアウトは detached HEAD 状態です。マージ前にブランチをチェックアウトしてください。",
                    zh: "项目检出处于分离 HEAD 状态；请先检出一个分支再合并。",
                  })}
                </div>
              )}
              {diffData.hasUncommittedChanges && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200"
                >
                  <p>
                    {t({
                      ko: "이 워크트리의 미커밋 변경사항은 병합 시 커밋되어 함께 포함됩니다. 병합 전에 브랜치에서 변경사항을 검토하세요. 추적되지 않은 파일의 내용은 아래 차이에 표시되지 않을 수 있습니다.",
                      en: "Uncommitted worktree changes will be committed and included in this merge. Review them in the branch before merging. The diff below may omit the contents of untracked files.",
                      ja: "ワークツリーの未コミット変更はコミットされ、このマージに含まれます。マージ前にブランチで変更を確認してください。未追跡ファイルの内容は以下の差分に表示されない場合があります。",
                      zh: "工作树中未提交的更改将被提交并包含在此次合并中。请在合并前检查分支中的更改。下方差异可能不包含未跟踪文件的内容。",
                    })}
                  </p>
                  {diffData.uncommittedFiles && diffData.uncommittedFiles.length > 0 && (
                    <ul className="mt-2 space-y-1 break-all font-mono">
                      {diffData.uncommittedFiles.map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {verifyData && (
                <div className={`rounded-lg border p-3 ${verifyToneClass}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">
                      {t({
                        ko: "최종 브랜치 검증",
                        en: "Final Branch Verification",
                        ja: "最終ブランチ検証",
                        zh: "最终分支校验",
                      })}
                    </h3>
                    <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs font-medium">
                      {verifyVerdictLabel}
                    </span>
                    {commitLabel && <span className="text-xs opacity-80">{commitLabel}</span>}
                    {verifyData.compareRef && <span className="text-xs opacity-80">base: {verifyData.compareRef}</span>}
                  </div>
                  {verifyData.files && verifyData.files.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {verifyData.files.slice(0, 6).map((filePath) => (
                        <span key={filePath} className="rounded bg-black/20 px-2 py-0.5 text-[11px]">
                          {filePath}
                        </span>
                      ))}
                    </div>
                  )}
                  {verifyData.uncommittedFiles && verifyData.uncommittedFiles.length > 0 && (
                    <p className="mt-2 text-xs">
                      {t({
                        ko: `미커밋 변경 ${verifyData.uncommittedFiles.length}건`,
                        en: `${verifyData.uncommittedFiles.length} uncommitted file(s)`,
                        ja: `未コミット変更 ${verifyData.uncommittedFiles.length}件`,
                        zh: `${verifyData.uncommittedFiles.length} 个未提交文件`,
                      })}
                    </p>
                  )}
                </div>
              )}
              {verifyError && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                  {t({
                    ko: "브랜치 검증 정보를 불러오지 못했습니다",
                    en: "Branch verification could not be loaded",
                    ja: "ブランチ検証情報を取得できませんでした",
                    zh: "无法加载分支校验信息",
                  })}
                  : {verifyError}
                </div>
              )}
              {/* Stat summary */}
              {diffData.stat && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold text-slate-300">
                    {t({ ko: "요약", en: "Summary", ja: "概要", zh: "摘要" })}
                  </h3>
                  <pre className="rounded-lg bg-slate-800 p-3 text-xs text-slate-300 overflow-x-auto">
                    {diffData.stat}
                  </pre>
                </div>
              )}
              {/* Full diff */}
              {diffData.diff && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold text-slate-300">
                    {t({ ko: "Diff", en: "Diff", ja: "差分", zh: "差异" })}
                  </h3>
                  <pre className="max-h-[50vh] overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed">
                    {diffData.diff.split("\n").map((line, i) => {
                      let cls = "text-slate-400";
                      if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-400";
                      else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-400";
                      else if (line.startsWith("@@")) cls = "text-cyan-400";
                      else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "text-slate-500 font-bold";
                      return (
                        <span key={i} className={cls}>
                          {line}
                          {"\n"}
                        </span>
                      );
                    })}
                  </pre>
                </div>
              )}
              {!diffData.stat && !diffData.diff && (
                <div className="text-center text-slate-500 py-8">
                  {t({
                    ko: "변경사항이 없습니다",
                    en: "No changes detected",
                    ja: "変更はありません",
                    zh: "未检测到更改",
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DiffModal;
