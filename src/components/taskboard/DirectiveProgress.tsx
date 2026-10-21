import { useState } from "react";
import type { Agent, Department, Task } from "../../types";
import { localeName, useI18n } from "../../i18n";
import type { DirectivePart, DirectivePartState, DirectiveSummary } from "./directive-progress";

type TFunction = ReturnType<typeof useI18n>["t"];

const STATE_STYLE: Record<DirectivePartState, { icon: string; bar: string; text: string }> = {
  integrated: { icon: "✅", bar: "bg-emerald-500", text: "text-emerald-300" },
  awaiting_approval: { icon: "🔀", bar: "bg-sky-500", text: "text-sky-300" },
  working: { icon: "🔨", bar: "bg-amber-400", text: "text-amber-300" },
  waiting: { icon: "⛓", bar: "bg-slate-500", text: "text-slate-300" },
  queued: { icon: "⏳", bar: "bg-slate-600", text: "text-slate-400" },
  conflict: { icon: "⚠️", bar: "bg-red-500", text: "text-red-300" },
  blocked: { icon: "🚫", bar: "bg-rose-700", text: "text-rose-300" },
};

// Bar segments run from finished to unfinished so progress reads left-to-right.
const BAR_ORDER: DirectivePartState[] = [
  "integrated",
  "awaiting_approval",
  "working",
  "waiting",
  "queued",
  "blocked",
  "conflict",
];

export function directivePartStateLabel(state: DirectivePartState, t: TFunction): string {
  switch (state) {
    case "integrated":
      return t({ ko: "통합됨", en: "Integrated", ja: "統合済み", zh: "已集成" });
    case "awaiting_approval":
      return t({ ko: "승인 대기", en: "Awaiting approval", ja: "承認待ち", zh: "待审批" });
    case "working":
      return t({ ko: "진행 중", en: "Working", ja: "作業中", zh: "进行中" });
    case "waiting":
      return t({ ko: "선행 작업 대기", en: "Waiting on dependency", ja: "依存待ち", zh: "等待前置任务" });
    case "queued":
      return t({ ko: "시작 가능", en: "Ready to start", ja: "開始可能", zh: "可开始" });
    case "conflict":
      return t({ ko: "통합 충돌", en: "Integration conflict", ja: "統合コンフリクト", zh: "集成冲突" });
    case "blocked":
      return t({ ko: "차단됨", en: "Blocked", ja: "ブロック中", zh: "已阻塞" });
  }
}

function phaseLabel(task: Task, summary: DirectiveSummary, t: TFunction): string {
  if (summary.readiness === "integrated" || task.status === "done") {
    return t({
      ko: "모든 작업이 디렉티브 브랜치에 통합됨",
      en: "All work integrated into the directive branch",
      ja: "すべての作業がディレクティブブランチに統合済み",
      zh: "所有工作已集成到指令分支",
    });
  }
  if (task.status === "review") {
    return t({
      ko: "CEO 단일 승인 대기",
      en: "Awaiting one consolidated CEO approval",
      ja: "CEO の一括承認待ち",
      zh: "等待 CEO 一次性审批",
    });
  }
  if (task.status === "planned" || task.status === "collaborating") {
    return t({
      ko: "부서별 계획을 병렬로 작성 중",
      en: "Departments planning in parallel",
      ja: "部署ごとに並行して計画中",
      zh: "各部门并行规划中",
    });
  }
  return t({
    ko: "공유 브랜치 위에서 병렬 진행 중",
    en: "Building in parallel on the shared branch",
    ja: "共有ブランチ上で並行作業中",
    zh: "在共享分支上并行推进",
  });
}

function departmentLabel(departmentId: string | null, departments: Department[], locale: string, t: TFunction) {
  const department = departments.find((item) => item.id === departmentId);
  if (!department) return { icon: "🏢", name: t({ ko: "기타", en: "Other", ja: "その他", zh: "其他" }), color: "" };
  return { icon: department.icon, name: localeName(locale, department), color: department.color };
}

function ownerName(part: DirectivePart, agents: Agent[], locale: string): string | null {
  const ownerId = part.childTask?.assigned_agent_id ?? part.subtask.assigned_agent_id;
  const owner = ownerId ? agents.find((agent) => agent.id === ownerId) : null;
  return owner ? localeName(locale, owner) : null;
}

interface DirectiveBranchChipProps {
  branch: string;
}

export function DirectiveBranchChip({ branch }: DirectiveBranchChipProps) {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-indigo-900/60 px-2 py-0.5 font-mono text-[10px] text-indigo-200"
      title={t({
        ko: "이 디렉티브의 모든 작업과 수정본이 공유하는 통합 브랜치",
        en: "Integration branch shared by all of this directive's work and revisions",
        ja: "このディレクティブの全作業と修正が共有する統合ブランチ",
        zh: "该指令所有工作与修订共享的集成分支",
      })}
    >
      ⑂ {branch}
    </span>
  );
}

interface DirectiveProgressProps {
  task: Task;
  summary: DirectiveSummary;
  agents: Agent[];
  departments: Department[];
  onRetryPart?: (taskId: string) => void;
}

export default function DirectiveProgress({ task, summary, agents, departments, onRetryPart }: DirectiveProgressProps) {
  const { t, language: locale } = useI18n();
  const [showParts, setShowParts] = useState(false);
  const total = summary.parts.length;
  const openCount = total - summary.counts.integrated - summary.counts.awaiting_approval;

  const readinessText =
    summary.readiness === "integrated"
      ? t({
          ko: `${total}개 작업 모두 통합됨. 게시/병합은 별도의 CEO 작업입니다.`,
          en: `All ${total} parts integrated. Publishing or merging stays a separate CEO action.`,
          ja: `全 ${total} 件を統合済み。公開/マージは別の CEO 操作です。`,
          zh: `全部 ${total} 项已集成。发布或合并仍是单独的 CEO 操作。`,
        })
      : summary.readiness === "ready_for_approval"
        ? t({
            ko: `준비 완료: 한 번의 CEO 승인으로 ${summary.counts.awaiting_approval}개 작업을 통합합니다.`,
            en: `Ready: one CEO approval integrates the remaining ${summary.counts.awaiting_approval} part(s).`,
            ja: `準備完了: CEO の一括承認で残り ${summary.counts.awaiting_approval} 件を統合します。`,
            zh: `已就绪：一次 CEO 审批即可集成剩余 ${summary.counts.awaiting_approval} 项。`,
          })
        : t({
            ko: `아직 준비되지 않음: ${total}개 중 ${openCount}개 작업이 진행 중입니다.`,
            en: `Not ready: ${openCount} of ${total} parts are still open.`,
            ja: `未完了: ${total} 件中 ${openCount} 件が進行中です。`,
            zh: `尚未就绪：${total} 项中仍有 ${openCount} 项未完成。`,
          });
  const readinessTone =
    summary.readiness === "integrated"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : summary.readiness === "ready_for_approval"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-200"
        : "border-slate-600 bg-slate-900/40 text-slate-300";

  return (
    <section
      className="mb-3 space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-2"
      aria-label={t({ ko: "디렉티브 진행 현황", en: "Directive progress", ja: "ディレクティブ進捗", zh: "指令进度" })}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <DirectiveBranchChip branch={summary.branch} />
        <span className="text-[10px] text-slate-400">
          {t({
            ko: `하위 작업 ${summary.childTaskCount}개 · 수정 ${summary.revisionIntegrated}/${summary.revisionTotal} 통합`,
            en: `${summary.childTaskCount} child task(s) · revisions ${summary.revisionIntegrated}/${summary.revisionTotal} integrated`,
            ja: `子タスク ${summary.childTaskCount} 件 · 修正 ${summary.revisionIntegrated}/${summary.revisionTotal} 統合済み`,
            zh: `子任务 ${summary.childTaskCount} 个 · 修订 ${summary.revisionIntegrated}/${summary.revisionTotal} 已集成`,
          })}
        </span>
      </div>

      <p className="text-[11px] font-medium text-slate-300">{phaseLabel(task, summary, t)}</p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={summary.counts.integrated}
        aria-valuetext={t({
          ko: `${total}개 중 ${summary.counts.integrated}개 통합됨`,
          en: `${summary.counts.integrated} of ${total} parts integrated`,
          ja: `${total} 件中 ${summary.counts.integrated} 件統合済み`,
          zh: `${total} 项中已集成 ${summary.counts.integrated} 项`,
        })}
        className="flex h-1.5 overflow-hidden rounded-full bg-slate-700"
      >
        {BAR_ORDER.map((state) =>
          summary.counts[state] > 0 ? (
            <div
              key={state}
              className={`h-full ${STATE_STYLE[state].bar}`}
              style={{ width: `${(summary.counts[state] / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>

      <ul className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
        {BAR_ORDER.filter((state) => summary.counts[state] > 0).map((state) => (
          <li key={state} className={STATE_STYLE[state].text}>
            {STATE_STYLE[state].icon} {directivePartStateLabel(state, t)} {summary.counts[state]}
          </li>
        ))}
      </ul>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {t({
            ko: `부서별 병렬 진행 (${summary.parallelLaneCount}개 부서 진행 중)`,
            en: `Departments in parallel (${summary.parallelLaneCount} working)`,
            ja: `部署別の並行状況（${summary.parallelLaneCount} 部署が作業中）`,
            zh: `各部门并行状态（${summary.parallelLaneCount} 个部门进行中）`,
          })}
        </p>
        <ul className="space-y-1">
          {summary.lanes.map((lane) => {
            const dept = departmentLabel(lane.departmentId, departments, locale, t);
            const conflicts = lane.parts.filter((part) => part.state === "conflict");
            const waiting = lane.parts.filter((part) => part.state === "waiting");
            return (
              <li key={lane.departmentId ?? "none"} className="text-xs">
                <div className="flex items-center gap-1.5">
                  <span
                    className="min-w-0 flex-1 truncate text-slate-300"
                    style={dept.color ? { color: dept.color } : {}}
                  >
                    {dept.icon} {dept.name}
                  </span>
                  <span className={`shrink-0 text-[10px] ${STATE_STYLE[lane.state].text}`}>
                    {STATE_STYLE[lane.state].icon} {directivePartStateLabel(lane.state, t)}
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-500">
                    {lane.integrated}/{lane.parts.length}
                  </span>
                </div>
                {waiting.length > 0 && (
                  <p className="truncate pl-4 text-[10px] text-slate-500">
                    {t({ ko: "대기 대상", en: "Waiting on", ja: "待機対象", zh: "等待" })}:{" "}
                    {[...new Set(waiting.flatMap((part) => part.waitingOn.map((dep) => dep.title)))].join(", ")}
                  </p>
                )}
                {conflicts.map((part) => {
                  const owner = ownerName(part, agents, locale);
                  const retryTaskId = part.childTask?.id;
                  const canRetry =
                    !!onRetryPart &&
                    !!retryTaskId &&
                    (part.childTask?.status === "planned" || part.childTask?.status === "pending");
                  return (
                    <div
                      key={part.subtask.id}
                      role="alert"
                      className="mt-1 rounded border border-red-500/40 bg-red-500/10 px-1.5 py-1 text-[10px] text-red-200"
                    >
                      <p className="font-medium">
                        {t({
                          ko: `${owner ?? "담당자"}에게 수정 반환됨 · 디렉티브 브랜치는 변경되지 않음`,
                          en: `Returned to ${owner ?? "its owner"} for revision · directive branch unchanged`,
                          ja: `${owner ?? "担当者"} に修正を差し戻し · ディレクティブブランチは未変更`,
                          zh: `已退回 ${owner ?? "负责人"} 修订 · 指令分支未更改`,
                        })}
                      </p>
                      {part.conflictFiles.length > 0 && (
                        <p className="truncate font-mono" title={part.conflictFiles.join(", ")}>
                          {part.conflictFiles.join(", ")}
                        </p>
                      )}
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => onRetryPart(retryTaskId)}
                          className="mt-1 rounded bg-red-800 px-1.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-red-700"
                        >
                          ↻{" "}
                          {t({
                            ko: "담당자 수정 재시작",
                            en: "Restart owner revision",
                            ja: "担当者の修正を再開",
                            zh: "重新开始负责人修订",
                          })}
                        </button>
                      )}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      </div>

      <p role="status" className={`rounded border px-1.5 py-1 text-[11px] ${readinessTone}`}>
        {readinessText}
      </p>

      <button
        type="button"
        onClick={() => setShowParts((v) => !v)}
        aria-expanded={showParts}
        className="text-[10px] text-slate-400 transition hover:text-slate-200"
      >
        {showParts ? "▲" : "▼"}{" "}
        {t({
          ko: `작업 ${total}개 보기`,
          en: `Show ${total} part(s)`,
          ja: `${total} 件を表示`,
          zh: `查看 ${total} 项`,
        })}
      </button>
      {showParts && (
        <ul className="space-y-1 pl-1">
          {summary.parts.map((part) => (
            <li key={part.subtask.id} className="flex items-center gap-1.5 text-xs">
              <span aria-hidden="true">{STATE_STYLE[part.state].icon}</span>
              <span
                className={`min-w-0 flex-1 truncate ${part.state === "integrated" ? "text-slate-500" : "text-slate-300"}`}
                title={part.subtask.title}
              >
                {part.subtask.title}
              </span>
              {part.isRevision && (
                <span className="shrink-0 rounded bg-violet-900/60 px-1 text-[10px] text-violet-200">
                  {t({ ko: "수정", en: "Revision", ja: "修正", zh: "修订" })}
                </span>
              )}
              <span className={`shrink-0 text-[10px] ${STATE_STYLE[part.state].text}`}>
                {directivePartStateLabel(part.state, t)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
