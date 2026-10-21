import type { MeetingVerdict } from "../lib/meeting-verdict";
import { meetingVerdictNeedsRevision } from "../lib/meeting-verdict";
import { useI18n } from "../i18n";

export function MeetingVerdictBadge({ verdict }: { verdict: MeetingVerdict | null }) {
  const { t } = useI18n();
  const missing = !verdict || verdict.verdict === "no_verdict";
  const revise = verdict && meetingVerdictNeedsRevision(verdict);
  const title = missing
    ? t({ ko: "명시적 판정 없음", en: "No recorded verdict", ja: "明示的な判定なし", zh: "没有明确判定" })
    : verdict.verdict === "revise" && !revise
      ? t({
          ko: "차단 항목 없는 REVISE · 승인 처리",
          en: "REVISE without blocking items; counted as approval",
          ja: "阻害項目のないREVISE・承認扱い",
          zh: "REVISE没有阻塞项 · 按批准处理",
        })
      : undefined;
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium ${missing ? "bg-slate-500/15 text-slate-400" : revise ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"}`}
      title={title}
    >
      {missing ? "NO VERDICT" : revise ? "REVISE" : "APPROVE"}
      {revise &&
        ` · ${verdict.blocking_items.length} ${t({ ko: "차단 항목", en: "blocking", ja: "阻害項目", zh: "阻塞项" })}`}
    </span>
  );
}

export default function MeetingVerdictView({
  verdict,
  showBadge = true,
}: {
  verdict: MeetingVerdict | null;
  showBadge?: boolean;
}) {
  const { t } = useI18n();
  const missing = !verdict || verdict.verdict === "no_verdict";
  const notes = verdict?.non_blocking_notes ?? [];
  return (
    <div className="space-y-1 text-xs">
      {showBadge && <MeetingVerdictBadge verdict={verdict} />}
      {verdict?.verdict === "no_verdict" && (
        <p style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "이 팀장의 APPROVE 또는 REVISE 확인을 기다리는 중",
            en: "Waiting for this leader to confirm APPROVE or REVISE",
            ja: "このリーダーのAPPROVEまたはREVISEの確認待ち",
            zh: "等待此负责人确认APPROVE或REVISE",
          })}
        </p>
      )}
      {verdict && meetingVerdictNeedsRevision(verdict) && (
        <ul className="list-disc pl-4 text-amber-300">
          {verdict.blocking_items.map((item, index) => (
            <li key={index}>
              {t({ ko: "차단 항목", en: "Blocking", ja: "阻害項目", zh: "阻塞项" })}: {item}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <details open={notes.length <= 3} style={{ color: "var(--th-text-muted)" }}>
          <summary className="cursor-pointer">
            {t({ ko: "참고 사항", en: "Notes", ja: "参考情報", zh: "备注" })} ({notes.length})
          </summary>
          <ul className="list-disc pl-4">
            {notes.map((note, index) => (
              <li key={index}>
                {t({ ko: "참고 사항", en: "Note", ja: "参考情報", zh: "备注" })}: {note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
