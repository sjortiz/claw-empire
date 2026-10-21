import { REVIEW_AUTOMATION_SETTINGS } from "../settings/review-automation";
import type { ProjectI18nTranslate } from "./types";

interface ProjectReviewAutomationSelectorsProps {
  t: ProjectI18nTranslate;
  reviewMeetingAutoStart: boolean | null;
  reviewItemsAutoApply: boolean | null;
  onChange: (key: "reviewMeetingAutoStart" | "reviewItemsAutoApply", value: boolean | null) => void;
  disabled: boolean;
}

export default function ProjectReviewAutomationSelectors({
  t,
  reviewMeetingAutoStart,
  reviewItemsAutoApply,
  onChange,
  disabled,
}: ProjectReviewAutomationSelectorsProps) {
  const values = { reviewMeetingAutoStart, reviewItemsAutoApply };
  return (
    <>
      {REVIEW_AUTOMATION_SETTINGS.map(({ key, label, help }) => (
        <div key={key}>
          <label htmlFor={`project-${key}`} className="block text-xs text-slate-400">
            {t(label)}
          </label>
          <select
            id={`project-${key}`}
            aria-describedby={`project-${key}-help`}
            value={values[key] === null ? "inherit" : String(values[key])}
            onChange={(e) => onChange(key, e.target.value === "inherit" ? null : e.target.value === "true")}
            disabled={disabled}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
          >
            <option value="inherit">
              {t({ ko: "전역 설정 사용", en: "Use global setting", ja: "全体設定を使用", zh: "使用全局设置" })}
            </option>
            <option value="true">{t({ ko: "켜기", en: "On", ja: "有効", zh: "开启" })}</option>
            <option value="false">{t({ ko: "끄기", en: "Off", ja: "無効", zh: "关闭" })}</option>
          </select>
          <p id={`project-${key}-help`} className="mt-1 text-xs leading-relaxed text-slate-400">
            {t(help)}
          </p>
        </div>
      ))}
    </>
  );
}
