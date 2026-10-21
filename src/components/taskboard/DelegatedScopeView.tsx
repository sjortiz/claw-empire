import { useState } from "react";
import { useI18n } from "../../i18n";
import type { DelegatedScope } from "./delegated-scope";

const COLLAPSED_ITEM_COUNT = 2;

interface DelegatedScopeViewProps {
  scope: DelegatedScope;
  expanded: boolean;
}

export default function DelegatedScopeView({ scope, expanded }: DelegatedScopeViewProps) {
  const { t } = useI18n();
  const [showParent, setShowParent] = useState(false);
  const visibleItems = expanded ? scope.items : scope.items.slice(0, COLLAPSED_ITEM_COUNT);
  const hiddenCount = scope.items.length - visibleItems.length;

  return (
    <div className="mb-2 space-y-1.5">
      <section
        aria-label={t({ ko: "담당 범위", en: "Assigned scope", ja: "担当範囲", zh: "负责范围" })}
        className="rounded-lg border border-emerald-700/60 bg-emerald-950/30 px-2.5 py-2"
      >
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-emerald-300">
            🎯 {t({ ko: "담당 범위", en: "Assigned scope", ja: "担当範囲", zh: "负责范围" })}
            {scope.scopeDept && ` · ${scope.scopeDept}`}
          </span>
          {scope.sourceDept && (
            <span className="text-slate-500">
              {t({
                ko: `${scope.sourceDept}에서 위임`,
                en: `from ${scope.sourceDept}`,
                ja: `${scope.sourceDept}から委任`,
                zh: `来自 ${scope.sourceDept}`,
              })}
            </span>
          )}
        </div>
        <ol className="space-y-0.5 text-xs text-slate-200">
          {visibleItems.map((item) => (
            <li key={`${item.index}-${item.subtaskId ?? item.title}`} className="flex gap-1.5">
              <span className="shrink-0 text-emerald-400/80">{item.index}.</span>
              <span className="min-w-0">
                <span className={expanded ? "" : "line-clamp-1"}>{item.title}</span>
                {expanded && item.detail && (
                  <span className="mt-0.5 block whitespace-pre-wrap text-[11px] text-slate-400">{item.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
        {hiddenCount > 0 && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {t({
              ko: `+${hiddenCount}개 더`,
              en: `+${hiddenCount} more`,
              ja: `他${hiddenCount}件`,
              zh: `还有 ${hiddenCount} 项`,
            })}
          </p>
        )}
      </section>

      {scope.parentContext && (
        <section className="rounded-lg border border-dashed border-slate-600 bg-slate-900/40 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setShowParent((v) => !v)}
            aria-expanded={showParent}
            className="flex w-full items-center gap-1.5 text-left text-[11px] text-slate-400 hover:text-slate-300"
          >
            <span>📎</span>
            <span className="flex-1">
              {t({
                ko: "상위 업무 배경 · 참고 전용",
                en: "Parent context · reference only",
                ja: "親タスクの背景 · 参照専用",
                zh: "父任务背景 · 仅供参考",
              })}
            </span>
            <span className="text-slate-500">{showParent ? "▲" : "▼"}</span>
          </button>
          {showParent && (
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-500">
              {scope.parentContext}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
