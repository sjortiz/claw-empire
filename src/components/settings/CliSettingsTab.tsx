import { CLI_INFO } from "./constants";
import type { CliSettingsTabProps } from "./types";

const CLAUDE_REASONING_LEVELS = [
  {
    effort: "low",
    description: { ko: "빠른 응답, 낮은 깊이", en: "Faster, lower depth", ja: "高速、浅い推論", zh: "更快、较浅推理" },
  },
  { effort: "medium", description: { ko: "균형", en: "Balanced", ja: "バランス", zh: "均衡" } },
  { effort: "high", description: { ko: "높은 깊이", en: "Higher depth", ja: "深い推論", zh: "更深入推理" } },
  {
    effort: "xhigh",
    description: { ko: "매우 높은 깊이", en: "Very high depth", ja: "非常に深い推論", zh: "极深入推理" },
  },
  {
    effort: "max",
    description: {
      ko: "최대 깊이, 가장 느림",
      en: "Maximum depth, slowest",
      ja: "最大の深さ、最も低速",
      zh: "最大深度、最慢",
    },
  },
];

export default function CliSettingsTab({
  t,
  cliStatus,
  cliModels,
  cliModelsLoading,
  form,
  setForm,
  persistSettings,
  onRefresh,
}: CliSettingsTabProps) {
  return (
    <section
      className="rounded-xl p-5 sm:p-6 space-y-5"
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({ ko: "CLI 도구 상태", en: "CLI Tool Status", ja: "CLI ツール状態", zh: "CLI 工具状态" })}
        </h3>
        <button onClick={onRefresh} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          🔄 {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "刷新" })}
        </button>
      </div>

      {cliStatus ? (
        <div className="space-y-2">
          {Object.entries(cliStatus)
            .filter(([provider]) => !["copilot", "antigravity"].includes(provider))
            .map(([provider, status]) => {
              const info = CLI_INFO[provider];
              const isReady = status.installed && status.authenticated;
              const hasSubModel = provider === "claude" || provider === "codex";
              const modelList = cliModels?.[provider] ?? [];
              const currentModel = form.providerModelConfig?.[provider]?.model || "";
              const currentSubModel = form.providerModelConfig?.[provider]?.subModel || "";
              const currentReasoningLevel = form.providerModelConfig?.[provider]?.reasoningLevel || "";

              const selectedModel = modelList.find((m) => m.slug === currentModel);
              const reasoningLevels = selectedModel?.reasoningLevels;
              const defaultReasoning = selectedModel?.defaultReasoningLevel || "";

              return (
                <div key={provider} className="bg-slate-700/30 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{info?.icon ?? "?"}</span>
                    <div className="flex-1">
                      <div className="text-sm text-white">{info?.label ?? provider}</div>
                      <div className="text-xs text-slate-500">
                        {status.version ??
                          (status.installed
                            ? t({
                                ko: "버전 확인 불가",
                                en: "Version unknown",
                                ja: "バージョン不明",
                                zh: "版本未知",
                              })
                            : t({ ko: "미설치", en: "Not installed", ja: "未インストール", zh: "未安装" }))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          status.installed ? "bg-green-500/20 text-green-400" : "bg-slate-600/50 text-slate-400"
                        }`}
                      >
                        {status.installed
                          ? t({ ko: "설치됨", en: "Installed", ja: "インストール済み", zh: "已安装" })
                          : t({ ko: "미설치", en: "Not installed", ja: "未インストール", zh: "未安装" })}
                      </span>
                      {status.installed && (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            status.authenticated ? "bg-blue-500/20 text-blue-400" : "bg-yellow-500/20 text-yellow-400"
                          }`}
                        >
                          {status.authenticated
                            ? t({ ko: "인증됨", en: "Authenticated", ja: "認証済み", zh: "已认证" })
                            : t({ ko: "미인증", en: "Not Authenticated", ja: "未認証", zh: "未认证" })}
                        </span>
                      )}
                    </div>
                  </div>

                  {isReady && (
                    <div className="space-y-1.5 pl-0 sm:pl-8">
                      <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                        <span className="w-auto shrink-0 text-xs text-slate-400 sm:w-20">
                          {hasSubModel
                            ? t({ ko: "메인 모델:", en: "Main model:", ja: "メインモデル:", zh: "主模型:" })
                            : t({ ko: "모델:", en: "Model:", ja: "モデル:", zh: "模型:" })}
                        </span>
                        {cliModelsLoading ? (
                          <span className="text-xs text-slate-500 animate-pulse">
                            {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "加载中..." })}
                          </span>
                        ) : modelList.length > 0 ? (
                          <select
                            value={currentModel}
                            onChange={(e) => {
                              const newSlug = e.target.value;
                              const newModel = modelList.find((m) => m.slug === newSlug);
                              const prev = form.providerModelConfig?.[provider] || {};
                              const newConfig = {
                                ...form.providerModelConfig,
                                [provider]: {
                                  ...prev,
                                  model: newSlug,
                                  ...(provider === "codex"
                                    ? { reasoningLevel: newModel?.defaultReasoningLevel || undefined }
                                    : {}),
                                },
                              };
                              const newForm = { ...form, providerModelConfig: newConfig };
                              setForm(newForm);
                              persistSettings(newForm);
                            }}
                            className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none sm:flex-1"
                          >
                            <option value="">{t({ ko: "기본값", en: "Default", ja: "デフォルト", zh: "默认" })}</option>
                            {modelList.map((m) => (
                              <option key={m.slug} value={m.slug}>
                                {m.displayName || m.slug}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-slate-500">
                            {t({ ko: "모델 목록 없음", en: "No models", ja: "モデル一覧なし", zh: "无模型列表" })}
                          </span>
                        )}
                      </div>

                      {(provider === "claude" ||
                        (provider === "codex" && reasoningLevels && reasoningLevels.length > 0)) && (
                        <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                          <span className="w-auto shrink-0 text-xs text-slate-400 sm:w-20">
                            {t({ ko: "추론 레벨:", en: "Reasoning:", ja: "推論レベル:", zh: "推理级别:" })}
                          </span>
                          <select
                            aria-label={
                              provider === "claude"
                                ? t({
                                    ko: "Claude 추론 레벨",
                                    en: "Claude reasoning effort",
                                    ja: "Claude 推論レベル",
                                    zh: "Claude 推理级别",
                                  })
                                : undefined
                            }
                            value={
                              provider === "claude" ? currentReasoningLevel : currentReasoningLevel || defaultReasoning
                            }
                            onChange={(e) => {
                              const prev = form.providerModelConfig?.[provider] || { model: "" };
                              const newConfig = {
                                ...form.providerModelConfig,
                                [provider]: { ...prev, reasoningLevel: e.target.value },
                              };
                              const newForm = { ...form, providerModelConfig: newConfig };
                              setForm(newForm);
                              persistSettings(newForm);
                            }}
                            className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none sm:flex-1"
                          >
                            {provider === "claude" ? (
                              <>
                                <option value="">
                                  {t({
                                    ko: "CLI 기본값 (--effort 생략)",
                                    en: "CLI default (no --effort)",
                                    ja: "CLI デフォルト (--effort なし)",
                                    zh: "CLI 默认（不传 --effort）",
                                  })}
                                </option>
                                {currentReasoningLevel &&
                                  !CLAUDE_REASONING_LEVELS.some((rl) => rl.effort === currentReasoningLevel) && (
                                    <option value={currentReasoningLevel}>
                                      {currentReasoningLevel} (
                                      {t({ ko: "사용자 지정", en: "custom", ja: "カスタム", zh: "自定义" })})
                                    </option>
                                  )}
                                {CLAUDE_REASONING_LEVELS.map((rl) => (
                                  <option key={rl.effort} value={rl.effort}>
                                    {rl.effort} ({t(rl.description)})
                                  </option>
                                ))}
                              </>
                            ) : (
                              reasoningLevels?.map((rl) => (
                                <option key={rl.effort} value={rl.effort}>
                                  {rl.effort} ({rl.description})
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                      )}

                      {hasSubModel && (
                        <>
                          <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                            <span className="w-auto shrink-0 text-xs text-slate-400 sm:w-20">
                              {t({
                                ko: "알바생 모델:",
                                en: "Sub-agent model:",
                                ja: "サブモデル:",
                                zh: "子代理模型:",
                              })}
                            </span>
                            {cliModelsLoading ? (
                              <span className="text-xs text-slate-500 animate-pulse">
                                {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "加载中..." })}
                              </span>
                            ) : modelList.length > 0 ? (
                              <select
                                value={currentSubModel}
                                onChange={(e) => {
                                  const newSlug = e.target.value;
                                  const newSubModel = modelList.find((m) => m.slug === newSlug);
                                  const prev = form.providerModelConfig?.[provider] || { model: "" };
                                  const newConfig = {
                                    ...form.providerModelConfig,
                                    [provider]: {
                                      ...prev,
                                      subModel: newSlug,
                                      ...(provider === "codex"
                                        ? { subModelReasoningLevel: newSubModel?.defaultReasoningLevel || undefined }
                                        : {}),
                                    },
                                  };
                                  const newForm = { ...form, providerModelConfig: newConfig };
                                  setForm(newForm);
                                  persistSettings(newForm);
                                }}
                                className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none sm:flex-1"
                              >
                                <option value="">
                                  {t({ ko: "기본값", en: "Default", ja: "デフォルト", zh: "默认" })}
                                </option>
                                {modelList.map((m) => (
                                  <option key={m.slug} value={m.slug}>
                                    {m.displayName || m.slug}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-xs text-slate-500">
                                {t({ ko: "모델 목록 없음", en: "No models", ja: "モデル一覧なし", zh: "无模型列表" })}
                              </span>
                            )}
                          </div>

                          {(() => {
                            const subSelected = modelList.find((m) => m.slug === currentSubModel);
                            const subLevels = subSelected?.reasoningLevels;
                            const subDefault = subSelected?.defaultReasoningLevel || "";
                            const currentSubRL = form.providerModelConfig?.[provider]?.subModelReasoningLevel || "";
                            if (provider !== "codex" || !subLevels || subLevels.length === 0) return null;
                            return (
                              <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                                <span className="w-auto shrink-0 text-xs text-slate-400 sm:w-20">
                                  {t({ ko: "알바 추론:", en: "Sub reasoning:", ja: "サブ推論:", zh: "子推理:" })}
                                </span>
                                <select
                                  value={currentSubRL || subDefault}
                                  onChange={(e) => {
                                    const prev = form.providerModelConfig?.[provider] || { model: "" };
                                    const newConfig = {
                                      ...form.providerModelConfig,
                                      [provider]: { ...prev, subModelReasoningLevel: e.target.value },
                                    };
                                    const newForm = { ...form, providerModelConfig: newConfig };
                                    setForm(newForm);
                                    persistSettings(newForm);
                                  }}
                                  className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none sm:flex-1"
                                >
                                  {subLevels.map((rl) => (
                                    <option key={rl.effort} value={rl.effort}>
                                      {rl.effort} ({rl.description})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })()}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      ) : (
        <div className="text-center py-4 text-slate-500 text-sm">
          {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "加载中..." })}
        </div>
      )}

      <p className="text-xs text-slate-500">
        {t({
          ko: "각 에이전트의 CLI 도구는 오피스에서 에이전트 클릭 후 변경할 수 있습니다. Copilot/Antigravity 모델은 OAuth 탭에서 설정합니다.",
          en: "Each agent's CLI tool can be changed in Office by clicking an agent. Configure Copilot/Antigravity models in OAuth tab.",
          ja: "各エージェントの CLI ツールは Office でエージェントをクリックして変更できます。Copilot/Antigravity のモデルは OAuth タブで設定してください。",
          zh: "每个代理的 CLI 工具可在 Office 中点击代理后修改。Copilot/Antigravity 模型请在 OAuth 页签配置。",
        })}
      </p>
    </section>
  );
}
