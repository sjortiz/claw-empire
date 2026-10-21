import type { ProjectReviewAutomation, ReviewAutomationOverride } from "../../types";
import type { I18nTextMap, ProjectI18nTranslate } from "./types";

interface ProjectReviewAutomationSelectorProps {
  t: ProjectI18nTranslate;
  value: ProjectReviewAutomation;
  onChange: (value: ProjectReviewAutomation) => void;
  disabled: boolean;
}

const FIELDS: Array<{ key: keyof ProjectReviewAutomation; label: I18nTextMap }> = [
  {
    key: "review_auto_start",
    label: {
      ko: "리뷰 회의 자동 시작",
      en: "Start review meetings automatically",
      ja: "レビュー会議を自動開始",
      zh: "自动启动评审会议",
    },
  },
  {
    key: "review_auto_apply",
    label: {
      ko: "리뷰 항목 모두 자동 반영",
      en: "Apply all review items automatically",
      ja: "レビュー項目をすべて自動反映",
      zh: "自动应用全部评审项",
    },
  },
];

export default function ProjectReviewAutomationSelector({
  t,
  value,
  onChange,
  disabled,
}: ProjectReviewAutomationSelectorProps) {
  return (
    <div className="space-y-2">
      {FIELDS.map((field) => (
        <label key={field.key} className="block text-xs text-slate-400">
          {t(field.label)}
          <select
            value={value[field.key] ?? "inherit"}
            onChange={(e) =>
              onChange({
                ...value,
                [field.key]: e.target.value === "inherit" ? null : (e.target.value as ReviewAutomationOverride),
              })
            }
            disabled={disabled}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          >
            <option value="inherit">
              {t({ ko: "전역 설정 사용", en: "Use global setting", ja: "全体設定を使用", zh: "使用全局设置" })}
            </option>
            <option value="on">{t({ ko: "켜기", en: "On", ja: "オン", zh: "开启" })}</option>
            <option value="off">{t({ ko: "끄기", en: "Off", ja: "オフ", zh: "关闭" })}</option>
          </select>
        </label>
      ))}
      <span className="block text-xs leading-relaxed text-slate-400">
        {t({
          ko: "켜면 모든 작업이 Review에 도달했을 때 CEO 승인 없이 팀장 회의를 시작하고, 의사결정 인박스에는 확인용 알림만 남깁니다. 항목 자동 반영은 라운드의 모든 리뷰 의견을 보완 작업으로 적용합니다.",
          en: "When on, the team-lead review meeting starts without CEO approval once every task reaches Review; the Decision Inbox keeps an informational notice. Auto-apply turns every review item of a round into revision work.",
          ja: "オンにすると、全タスクがReviewに達した時点でCEO承認なしにチームリーダー会議を開始し、Decision Inboxには確認用の通知のみ残します。項目の自動反映はラウンドの全レビュー意見を補完作業として適用します。",
          zh: "开启后，所有任务进入 Review 时无需 CEO 批准即启动组长评审会议，Decision Inbox 仅保留一条通知。自动应用会将本轮全部评审意见转为整改工作。",
        })}
      </span>
    </div>
  );
}
