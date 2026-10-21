import { useEffect, useState } from "react";
import { getWorktrees, type WorktreeEntry } from "../../api";
import { useI18n, type UiLanguage } from "../../i18n";
import DiffModal from "./DiffModal";

interface TaskBranchReviewProps {
  taskId: string;
  language?: UiLanguage;
}

export default function TaskBranchReview({ taskId, language }: TaskBranchReviewProps) {
  const { t } = useI18n(language);
  const [worktree, setWorktree] = useState<WorktreeEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setWorktree(null);
    setShowDiff(false);
    getWorktrees()
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(true);
          return;
        }
        setWorktree(result.worktrees.find((entry) => entry.taskId === taskId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, retry]);

  if (loading) {
    return (
      <p className="text-xs text-slate-400" role="status">
        {t({
          ko: "작업 브랜치 확인 중...",
          en: "Checking task branch...",
          ja: "タスクブランチを確認中...",
          zh: "正在检查任务分支...",
        })}
      </p>
    );
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <p role="alert" className="text-amber-300">
          {t({
            ko: "작업 브랜치를 확인하지 못했습니다.",
            en: "Could not check the task branch.",
            ja: "タスクブランチを確認できませんでした。",
            zh: "无法检查任务分支。",
          })}
        </p>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="rounded border border-slate-600 px-2 py-1 text-slate-200 hover:bg-slate-700"
        >
          {t({ ko: "다시 시도", en: "Retry", ja: "再試行", zh: "重试" })}
        </button>
      </div>
    );
  }

  return (
    <>
      {worktree && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-200">
              {t({
                ko: "검토를 위해 브랜치 유지됨",
                en: "Branch kept for review",
                ja: "レビュー用にブランチを保持",
                zh: "已保留分支以供审查",
              })}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-slate-300">{worktree.branchName}</p>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{worktree.projectPath}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowDiff(true)}
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20 active:scale-[0.98]"
          >
            {t({ ko: "검토 및 병합", en: "Review and merge", ja: "レビューしてマージ", zh: "审查并合并" })}
          </button>
        </div>
      )}
      {showDiff && (
        <DiffModal
          taskId={taskId}
          language={language}
          onClose={() => setShowDiff(false)}
          onWorktreeRemoved={() => setWorktree(null)}
        />
      )}
    </>
  );
}
