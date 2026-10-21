import { useId } from "react";
import type { UiLanguage } from "../i18n";

type Translate = (messages: Record<UiLanguage, string>) => string;

const controls = [
  {
    key: "autoStart",
    label: {
      ko: "검토 회의 자동 시작",
      en: "Start review meetings automatically",
      ja: "レビュー会議を自動で開始",
      zh: "自动开始评审会议",
    },
    help: {
      ko: "진행 중인 모든 작업이 검토 단계에 도달하면 프로젝트 검토 회의를 시작합니다. 의사결정함에 안내가 남습니다.",
      en: "Start the project review meeting when all active tasks reach review. A notice remains in the decision inbox.",
      ja: "進行中のすべてのタスクがレビュー段階に達すると、プロジェクトのレビュー会議を開始します。意思決定受信箱に通知が残ります。",
      zh: "所有进行中的任务进入评审阶段后，开始项目评审会议。决策收件箱中会保留通知。",
    },
  },
  {
    key: "autoApply",
    label: {
      ko: "모든 검토 항목 자동 적용",
      en: "Apply all review items automatically",
      ja: "すべてのレビュー項目を自動で適用",
      zh: "自动应用所有评审项",
    },
    help: {
      ko: "CEO에게 선택을 요청하지 않고 모든 수정 항목을 선택합니다. 회의 자동 시작과 별도로 설정합니다.",
      en: "Choose every revision item automatically instead of asking the CEO. This is independent of meeting auto-start.",
      ja: "CEOに選択を求めず、すべての修正項目を選択します。会議の自動開始とは別に設定します。",
      zh: "自动选择所有修订项，无需 CEO 选择。此设置独立于会议自动开始。",
    },
  },
] as const;

interface GlobalReviewAutomationSettingsProps {
  t: Translate;
  autoStart: boolean;
  autoApply: boolean;
  onAutoStartChange: (value: boolean) => void;
  onAutoApplyChange: (value: boolean) => void;
}

interface ProjectReviewAutomationSettingsProps {
  t: Translate;
  autoStart: boolean | null;
  autoApply: boolean | null;
  onAutoStartChange: (value: boolean | null) => void;
  onAutoApplyChange: (value: boolean | null) => void;
  disabled: boolean;
}

function groupLabel(t: Translate) {
  return t({ ko: "검토 자동화", en: "Review automation", ja: "レビューの自動化", zh: "评审自动化" });
}

export function GlobalReviewAutomationSettings({
  t,
  autoStart,
  autoApply,
  onAutoStartChange,
  onAutoApplyChange,
}: GlobalReviewAutomationSettingsProps) {
  const id = useId();
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-1 text-xs font-medium" style={{ color: "var(--th-text-primary)" }}>
        {groupLabel(t)}
      </legend>
      <p className="text-xs leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
        {t({
          ko: "두 설정 모두 기본값은 꺼짐입니다. 프로젝트별로 각 설정을 재정의할 수 있습니다.",
          en: "Both settings default to off. Projects can override each setting separately.",
          ja: "どちらも既定ではオフです。プロジェクトごとに各設定を上書きできます。",
          zh: "两项设置默认均为关闭。项目可分别覆盖每项设置。",
        })}
      </p>
      {controls.map((control) => {
        const checked = control.key === "autoStart" ? autoStart : autoApply;
        const onChange = control.key === "autoStart" ? onAutoStartChange : onAutoApplyChange;
        const controlId = `${id}-${control.key}`;
        return (
          <div
            key={control.key}
            className="rounded-lg border px-3 py-3 sm:px-4"
            style={{ borderColor: "var(--th-card-border)", background: "var(--th-input-bg)" }}
          >
            <label
              htmlFor={controlId}
              className="flex cursor-pointer items-start gap-3 text-sm"
              style={{ color: "var(--th-text-primary)" }}
            >
              <input
                id={controlId}
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                aria-describedby={`${controlId}-help`}
                className="mt-0.5 h-4 w-4 shrink-0 accent-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              />
              <span className="min-w-0">{t(control.label)}</span>
            </label>
            <p
              id={`${controlId}-help`}
              className="mt-1 pl-7 text-xs leading-relaxed"
              style={{ color: "var(--th-text-secondary)" }}
            >
              {t(control.help)}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}

export function ProjectReviewAutomationSettings({
  t,
  autoStart,
  autoApply,
  onAutoStartChange,
  onAutoApplyChange,
  disabled,
}: ProjectReviewAutomationSettingsProps) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <legend className="mb-1 text-xs font-medium text-slate-300">{groupLabel(t)}</legend>
      <p className="text-xs leading-relaxed text-slate-400">
        {t({
          ko: "전역 설정을 사용하거나 이 프로젝트의 각 설정을 재정의합니다.",
          en: "Use the global setting or override each setting for this project.",
          ja: "全体設定を使用するか、このプロジェクトの各設定を上書きします。",
          zh: "使用全局设置，或为此项目分别覆盖每项设置。",
        })}
      </p>
      {controls.map((control) => {
        const value = control.key === "autoStart" ? autoStart : autoApply;
        const onChange = control.key === "autoStart" ? onAutoStartChange : onAutoApplyChange;
        const controlId = `${id}-${control.key}`;
        return (
          <div key={control.key}>
            <label htmlFor={controlId} className="block text-xs text-slate-400">
              {t(control.label)}
            </label>
            <select
              id={controlId}
              value={value === null ? "inherit" : value ? "on" : "off"}
              onChange={(event) => onChange(event.target.value === "inherit" ? null : event.target.value === "on")}
              aria-describedby={`${controlId}-help`}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="inherit">
                {t({ ko: "전역 설정 사용", en: "Use global setting", ja: "全体設定を使用", zh: "使用全局设置" })}
              </option>
              <option value="on">{t({ ko: "켜짐", en: "On", ja: "オン", zh: "开启" })}</option>
              <option value="off">{t({ ko: "꺼짐", en: "Off", ja: "オフ", zh: "关闭" })}</option>
            </select>
            <p id={`${controlId}-help`} className="mt-1 text-xs leading-relaxed text-slate-400">
              {t(control.help)}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}
