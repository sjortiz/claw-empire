import { useEffect, useState } from "react";
import { getTaskVerifyCommit, getWorktrees } from "../../api";
import { useI18n } from "../../i18n";
import type { Agent, Department, Task } from "../../types";
import AgentAvatar from "../AgentAvatar";
import { clipReport, RELATED_WORK_MAX_TASKS } from "./delegated-scope";
import { COLUMNS, taskStatusLabel } from "./constants";

interface BranchInfo {
  branchName: string | null;
  commitsAhead: number | null;
  compareRef: string | null;
}

interface RelatedWorkPanelProps {
  relatedTasks: Task[];
  agents: Agent[];
  departments: Department[];
}

export default function RelatedWorkPanel({ relatedTasks, agents, departments }: RelatedWorkPanelProps) {
  const { t, language: locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Record<string, BranchInfo> | null>(null);

  const visibleTasks = relatedTasks.slice(0, RELATED_WORK_MAX_TASKS);
  const hiddenCount = relatedTasks.length - visibleTasks.length;
  const doneCount = relatedTasks.filter((task) => task.status === "done").length;
  const inFlightCount = relatedTasks.filter(
    (task) => task.status === "in_progress" || task.status === "collaborating" || task.status === "review",
  ).length;
  const visibleKey = visibleTasks.map((task) => task.id).join(",");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const ids = visibleKey.split(",").filter(Boolean);
    // Branch and commit data is read only on demand: one worktree listing plus one local check per visible task.
    getWorktrees()
      .then(async ({ worktrees }) => {
        const byTask = new Map(worktrees.map((entry) => [entry.taskId, entry.branchName]));
        const entries = await Promise.all(
          ids.map(async (id): Promise<[string, BranchInfo]> => {
            const branchName = byTask.get(id) ?? null;
            if (!branchName) return [id, { branchName: null, commitsAhead: null, compareRef: null }];
            try {
              const verify = await getTaskVerifyCommit(id);
              return [
                id,
                {
                  branchName: verify.branchName ?? branchName,
                  commitsAhead: verify.ok ? (verify.commitCount ?? null) : null,
                  compareRef: verify.compareRef ?? null,
                },
              ];
            } catch {
              return [id, { branchName, commitsAhead: null, compareRef: null }];
            }
          }),
        );
        if (!cancelled) setBranches(Object.fromEntries(entries));
      })
      .catch(() => {
        if (!cancelled) setBranches({});
      });
    return () => {
      cancelled = true;
    };
  }, [open, visibleKey]);

  if (relatedTasks.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-slate-700 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px]"
      >
        <span className="font-semibold text-slate-300">
          🧭 {t({ ko: "관련 작업", en: "Related work", ja: "関連作業", zh: "相关工作" })} · {relatedTasks.length}
        </span>
        <span className="flex-1 truncate text-slate-500">
          {t({
            ko: `완료 ${doneCount} · 진행 ${inFlightCount}`,
            en: `${doneCount} done · ${inFlightCount} in flight`,
            ja: `完了 ${doneCount} · 進行 ${inFlightCount}`,
            zh: `完成 ${doneCount} · 进行 ${inFlightCount}`,
          })}
        </span>
        <span className="text-slate-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <ul
          aria-label={t({ ko: "관련 작업", en: "Related work", ja: "関連作業", zh: "相关工作" })}
          className="space-y-1.5 border-t border-slate-700/70 px-2.5 py-2"
        >
          {visibleTasks.map((task) => {
            const agent = task.assigned_agent ?? agents.find((item) => item.id === task.assigned_agent_id);
            const agentName =
              (agent ? (locale === "ko" ? agent.name_ko : agent.name) : null) ||
              (locale === "ko" ? task.agent_name_ko || task.agent_name : task.agent_name || task.agent_name_ko) ||
              t({ ko: "미배정", en: "Unassigned", ja: "未割り当て", zh: "未分配" });
            const department = departments.find((item) => item.id === task.department_id);
            const statusDot = COLUMNS.find((column) => column.status === task.status)?.dotColor ?? "bg-slate-400";
            const branch = branches?.[task.id];
            const report = clipReport(task.result);
            return (
              <li key={task.id} className="text-xs">
                <div className="flex items-center gap-1.5">
                  {agent && <AgentAvatar agent={agent} agents={agents} size={16} />}
                  <span className="truncate text-slate-200">{agentName}</span>
                  {department && (
                    <span
                      className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
                      style={{ backgroundColor: department.color + "30", color: department.color }}
                    >
                      {department.icon} {locale === "ko" ? department.name_ko : department.name}
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-slate-400">
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
                    {taskStatusLabel(task.status, t)}
                  </span>
                </div>
                <p className="mt-0.5 truncate pl-[22px] text-[11px] text-slate-400" title={task.title}>
                  {task.title}
                </p>
                <p className="truncate pl-[22px] font-mono text-[10px] text-slate-500">
                  {!branches
                    ? t({ ko: "브랜치 확인 중…", en: "Checking branch…", ja: "ブランチ確認中…", zh: "正在检查分支…" })
                    : branch?.branchName
                      ? `⎇ ${branch.branchName}${
                          branch.commitsAhead !== null
                            ? ` · ${t({
                                ko: `커밋 +${branch.commitsAhead}`,
                                en: `+${branch.commitsAhead} commit(s)`,
                                ja: `コミット +${branch.commitsAhead}`,
                                zh: `提交 +${branch.commitsAhead}`,
                              })}`
                            : ""
                        }${branch.compareRef ? ` (vs ${branch.compareRef})` : ""}`
                      : t({
                          ko: "활성 브랜치 없음",
                          en: "No active branch",
                          ja: "アクティブなブランチなし",
                          zh: "无活动分支",
                        })}
                </p>
                {report && (
                  <p className="line-clamp-2 pl-[22px] text-[11px] italic text-slate-500" title={task.result ?? ""}>
                    {report}
                  </p>
                )}
              </li>
            );
          })}
          {hiddenCount > 0 && (
            <li className="text-[11px] text-slate-500">
              {t({
                ko: `+${hiddenCount}개 더`,
                en: `+${hiddenCount} more`,
                ja: `他${hiddenCount}件`,
                zh: `还有 ${hiddenCount} 项`,
              })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
