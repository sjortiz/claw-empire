import type { CliProvider, MergePolicy } from "../../types";
import type { LocalSettings, SetLocalSettings, TFunction } from "./types";

interface GeneralSettingsTabProps {
  t: TFunction;
  form: LocalSettings;
  setForm: SetLocalSettings;
  saved: boolean;
  onSave: () => void;
}

interface ToggleSettingCardProps {
  label: string;
  checked: boolean;
  onToggle: () => void;
  title?: string;
}

function ToggleSettingCard({ label, checked, onToggle, title }: ToggleSettingCardProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 sm:px-4"
      style={{ borderColor: "var(--th-card-border)", background: "var(--th-input-bg)" }}
    >
      <label className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
        {label}
      </label>
      <button
        type="button"
        aria-pressed={checked}
        aria-label={label}
        onClick={onToggle}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-slate-600"}`}
        title={title}
      >
        <div
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export default function GeneralSettingsTab({ t, form, setForm, saved, onSave }: GeneralSettingsTabProps) {
  return (
    <>
      <section
        className="rounded-xl p-5 sm:p-6 space-y-5"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
      >
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({ ko: "회사 정보", en: "Company", ja: "会社情報", zh: "公司信息" })}
        </h3>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "회사명", en: "Company Name", ja: "会社名", zh: "公司名称" })}
          </label>
          <input
            type="text"
            value={form.companyName}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "CEO 이름", en: "CEO Name", ja: "CEO 名", zh: "CEO 名称" })}
          </label>
          <input
            type="text"
            value={form.ceoName}
            onChange={(e) => setForm({ ...form, ceoName: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ToggleSettingCard
            label={t({ ko: "자동 배정", en: "Auto Assign", ja: "自動割り当て", zh: "自动分配" })}
            checked={form.autoAssign}
            onToggle={() => setForm({ ...form, autoAssign: !form.autoAssign })}
          />

          <ToggleSettingCard
            label={t({ ko: "YOLO 모드", en: "YOLO Mode", ja: "YOLO モード", zh: "YOLO 模式" })}
            checked={form.yoloMode === true}
            onToggle={() => setForm({ ...form, yoloMode: !(form.yoloMode === true) })}
            title={t({
              ko: "켜면 기획팀장이 의사결정 단계를 자동으로 분석하고 다음 단계를 진행합니다.",
              en: "When enabled, the planning lead auto-analyzes decision steps and proceeds automatically.",
              ja: "有効にすると、企画リードが意思決定段階を自動分析して次段階へ進めます。",
              zh: "启用后，规划负责人会自动分析决策步骤并推进到下一阶段。",
            })}
          />

          <ToggleSettingCard
            label={t({
              ko: "자동 업데이트 (전역)",
              en: "Auto Update (Global)",
              ja: "Auto Update（全体）",
              zh: "自动更新（全局）",
            })}
            checked={form.autoUpdateEnabled}
            onToggle={() => setForm({ ...form, autoUpdateEnabled: !form.autoUpdateEnabled })}
            title={t({
              ko: "서버 전체 자동 업데이트 루프를 켜거나 끕니다.",
              en: "Enable or disable auto-update loop for the whole server.",
              ja: "サーバー全体の自動更新ループを有効/無効にします。",
              zh: "启用或禁用整个服务器的自动更新循环。",
            })}
          />

          <ToggleSettingCard
            label={t({ ko: "OAuth 자동 스왑", en: "OAuth Auto Swap", ja: "OAuth 自動スワップ", zh: "OAuth 自动切换" })}
            checked={form.oauthAutoSwap !== false}
            onToggle={() => setForm({ ...form, oauthAutoSwap: !(form.oauthAutoSwap !== false) })}
            title={t({
              ko: "실패/한도 시 다음 OAuth 계정으로 자동 전환",
              en: "Auto-switch to next OAuth account on failures/limits",
              ja: "失敗/上限時に次の OAuth アカウントへ自動切替",
              zh: "失败/额度限制时自动切换到下一个 OAuth 账号",
            })}
          />
        </div>

        <div>
          <label htmlFor="merge-policy" className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "승인 후 병합 정책",
              en: "Merge policy after approval",
              ja: "承認後のマージ方針",
              zh: "批准后的合并策略",
            })}
          </label>
          <select
            id="merge-policy"
            aria-describedby="merge-policy-help"
            value={form.mergePolicy ?? "auto"}
            onChange={(e) => setForm({ ...form, mergePolicy: e.target.value as MergePolicy })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="auto">
              {t({
                ko: "자동 병합 (기본값)",
                en: "Auto-merge (default)",
                ja: "自動マージ（既定）",
                zh: "自动合并（默认）",
              })}
            </option>
            <option value="manual">
              {t({
                ko: "수동 검토를 위해 브랜치 유지",
                en: "Keep branch for manual review",
                ja: "手動レビュー用にブランチを保持",
                zh: "保留分支以供手动审查",
              })}
            </option>
          </select>
          <p
            id="merge-policy-help"
            className="mt-2 text-xs leading-relaxed"
            style={{ color: "var(--th-text-secondary)" }}
          >
            {t({
              ko: "자동 병합은 승인 시 프로젝트의 현재 체크아웃 브랜치에 병합합니다. 수동 검토는 작업을 완료하고 프로젝트 체크아웃을 변경하지 않은 채 브랜치를 유지합니다. 프로젝트별로 재정의할 수 있으며 원격으로 푸시하지 않습니다.",
              en: "Auto-merge merges into the project's current checkout branch on approval. Manual review completes the task and keeps its branch without changing the project checkout. Projects can override this policy. Neither option pushes to a remote.",
              ja: "自動マージは承認時にプロジェクトの現在のチェックアウトブランチへマージします。手動レビューはタスクを完了し、チェックアウトを変更せずブランチを保持します。プロジェクトごとに上書きできます。どちらもリモートへプッシュしません。",
              zh: "自动合并会在批准时合并到项目当前检出的分支。手动审查会完成任务并保留分支，不改变项目检出。项目可覆盖此策略。两种选项都不会推送到远程。",
            })}
          </p>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "기본 CLI 프로바이더",
              en: "Default CLI Provider",
              ja: "デフォルト CLI プロバイダ",
              zh: "默认 CLI 提供方",
            })}
          </label>
          <select
            value={form.defaultProvider}
            onChange={(e) => setForm({ ...form, defaultProvider: e.target.value as CliProvider })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="gemini">Gemini CLI</option>
            <option value="opencode">OpenCode</option>
          </select>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "언어", en: "Language", ja: "言語", zh: "语言" })}
          </label>
          <select
            value={form.language}
            onChange={(e) => setForm({ ...form, language: e.target.value as LocalSettings["language"] })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          >
            <option value="ko">{t({ ko: "한국어", en: "Korean", ja: "韓国語", zh: "韩语" })}</option>
            <option value="en">{t({ ko: "영어", en: "English", ja: "英語", zh: "英语" })}</option>
            <option value="ja">{t({ ko: "일본어", en: "Japanese", ja: "日本語", zh: "日语" })}</option>
            <option value="zh">{t({ ko: "중국어", en: "Chinese", ja: "中国語", zh: "中文" })}</option>
          </select>
        </div>
      </section>

      <div className="flex justify-end gap-3">
        {saved && (
          <span className="text-green-400 text-sm self-center">
            ✅ {t({ ko: "저장 완료", en: "Saved", ja: "保存完了", zh: "已保存" })}
          </span>
        )}
        <button
          onClick={onSave}
          className="px-8 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-blue-600/20 hover:shadow-blue-500/30"
        >
          {t({ ko: "저장", en: "Save", ja: "保存", zh: "保存" })}
        </button>
      </div>
    </>
  );
}
