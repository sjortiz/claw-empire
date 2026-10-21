import { effectiveMeetingVerdict, parseMeetingVerdict } from "../../../shared/meeting-verdict";
import { useI18n } from "../../i18n";

export default function MeetingVerdictSummary({ content }: { content: string }) {
  const { t } = useI18n();
  const verdict = parseMeetingVerdict(content);
  if (!verdict) return null;

  const needsRevision = effectiveMeetingVerdict(verdict) === "revise";

  return (
    <div className="mt-2 space-y-1 text-xs" aria-label={t({ ko: "판정", en: "Verdict", ja: "判定", zh: "结论" })}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 font-medium ${
            needsRevision ? "bg-amber-900/40 text-amber-200" : "bg-emerald-900/40 text-emerald-200"
          }`}
        >
          {needsRevision
            ? t({ ko: "수정 요청", en: "Revise", ja: "修正依頼", zh: "需要修改" })
            : t({ ko: "승인", en: "Approve", ja: "承認", zh: "批准" })}
        </span>
        <span style={{ color: "var(--th-text-secondary)" }}>
          {t({ ko: "차단 항목", en: "Blocking items", ja: "ブロッキング項目", zh: "阻塞项" })}:{" "}
          {verdict.blocking_items.length}
        </span>
      </div>
      {verdict.blocking_items.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4" style={{ color: "var(--th-text-primary)" }}>
          {verdict.blocking_items.map((item, index) => (
            <li key={index} className="whitespace-pre-wrap break-words">
              {item}
            </li>
          ))}
        </ul>
      )}
      {verdict.non_blocking_notes.length > 0 && (
        <div style={{ color: "var(--th-text-secondary)" }}>
          <span>{t({ ko: "참고 사항", en: "Non-blocking notes", ja: "非ブロッキングの注記", zh: "非阻塞备注" })}</span>
          <ul className="list-disc space-y-0.5 pl-4">
            {verdict.non_blocking_notes.map((note, index) => (
              <li key={index} className="whitespace-pre-wrap break-words">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
