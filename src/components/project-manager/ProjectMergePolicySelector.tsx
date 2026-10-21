import type { MergePolicy } from "../../types";
import type { ProjectI18nTranslate } from "./types";

interface ProjectMergePolicySelectorProps {
  t: ProjectI18nTranslate;
  value: MergePolicy | null;
  onChange: (policy: MergePolicy | null) => void;
  disabled: boolean;
}

export default function ProjectMergePolicySelector({ t, value, onChange, disabled }: ProjectMergePolicySelectorProps) {
  return (
    <label className="block text-xs text-slate-400">
      {t({ ko: "병합 정책", en: "Merge policy", ja: "マージ方針", zh: "合并策略" })}
      <select
        value={value ?? "inherit"}
        onChange={(e) => onChange(e.target.value === "inherit" ? null : (e.target.value as MergePolicy))}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
      >
        <option value="inherit">
          {t({ ko: "전역 설정 사용", en: "Use global setting", ja: "全体設定を使用", zh: "使用全局设置" })}
        </option>
        <option value="auto">{t({ ko: "자동 병합", en: "Auto-merge", ja: "自動マージ", zh: "自动合并" })}</option>
        <option value="manual">
          {t({
            ko: "수동 검토를 위해 브랜치 유지",
            en: "Keep branch for manual review",
            ja: "手動レビュー用にブランチを保持",
            zh: "保留分支供手动审查",
          })}
        </option>
      </select>
      <span className="mt-1 block leading-relaxed">
        {t({
          ko: "수동 검토는 승인 시 작업을 완료하고 브랜치를 유지하며 프로젝트 체크아웃을 변경하지 않습니다. 병합은 원격으로 푸시하지 않습니다.",
          en: "Manual review completes approved tasks and keeps their branches without changing the project checkout. Merging does not push to a remote.",
          ja: "手動レビューでは承認したタスクを完了し、プロジェクトのチェックアウトを変更せずブランチを保持します。マージしてもリモートへプッシュしません。",
          zh: "手动审查会完成已批准的任务并保留其分支，不更改项目检出内容。合并不会推送到远程。",
        })}
      </span>
    </label>
  );
}
