import { API_REASONING_LEVELS, supportsApiReasoningEffort } from "../../lib/api-reasoning-effort";

type Props = {
  provider: string;
  apiType?: string;
  value: string;
  globalEffort?: string;
  onChange: (value: string) => void;
  t: (messages: { ko: string; en: string; ja: string; zh: string }) => string;
};

export default function AgentReasoningControl({ provider, apiType, value, globalEffort, onChange, t }: Props) {
  const isApi = provider === "api";
  const supported = !isApi || supportsApiReasoningEffort(apiType ?? "");
  const levels: readonly string[] = isApi
    ? API_REASONING_LEVELS.filter((level) => level !== "none")
    : ["low", "medium", "high", "xhigh", "max"];
  const descriptions: Record<string, string> = {
    minimal: t({ ko: "최소 깊이", en: "Minimal depth", ja: "最小の深さ", zh: "最小深度" }),
    low: t({ ko: "빠름, 낮은 깊이", en: "Faster, lower depth", ja: "高速・浅い推論", zh: "更快，较浅推理" }),
    medium: t({ ko: "균형", en: "Balanced", ja: "バランス", zh: "均衡" }),
    high: t({ ko: "높은 깊이", en: "Higher depth", ja: "高い深度", zh: "更高深度" }),
    xhigh: t({ ko: "매우 높은 깊이", en: "Very high depth", ja: "非常に高い深度", zh: "很高深度" }),
    max: t({
      ko: "최대 깊이, 가장 느림",
      en: "Maximum depth, slowest",
      ja: "最大深度・最も遅い",
      zh: "最大深度，最慢",
    }),
  };
  const inheritLabel = isApi
    ? t({
        ko: "기본값(모델 결정)",
        en: "Default (model decides)",
        ja: "デフォルト（モデルが決定）",
        zh: "默认（由模型决定）",
      })
    : globalEffort === undefined
      ? t({
          ko: "기본값(설정창 추론)",
          en: "Default (Settings reasoning)",
          ja: "デフォルト（設定推論）",
          zh: "默认（设置中的推理）",
        })
      : globalEffort
        ? t({
            ko: `기본값(설정: ${globalEffort})`,
            en: `Default (Settings: ${globalEffort})`,
            ja: `デフォルト（設定: ${globalEffort}）`,
            zh: `默认（设置：${globalEffort}）`,
          })
        : t({
            ko: "기본값(CLI 기본값)",
            en: "Default (CLI default)",
            ja: "デフォルト（CLI 既定）",
            zh: "默认（CLI 默认）",
          });
  const unknown = value && !levels.includes(value) && !(isApi && value === "none");
  return (
    <div className="min-w-0 space-y-1">
      <label className="block text-[10px] text-slate-400">
        {t({
          ko: "에이전트 추론 레벨",
          en: "Agent reasoning effort",
          ja: "エージェント推論レベル",
          zh: "代理推理级别",
        })}
        <select
          value={value}
          disabled={!supported}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 block max-w-full bg-slate-700 text-slate-200 text-xs rounded px-1.5 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
        >
          <option value="">{inheritLabel}</option>
          <optgroup label={t({ ko: "레벨", en: "Levels", ja: "レベル", zh: "级别" })}>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level} — {descriptions[level]}
              </option>
            ))}
          </optgroup>
          {isApi && (
            <optgroup label={t({ ko: "끄기", en: "Off", ja: "オフ", zh: "关闭" })}>
              <option value="none">
                {t({
                  ko: "끄기 — 사고 없음 (none)",
                  en: "Off — no thinking (none)",
                  ja: "オフ — 思考なし (none)",
                  zh: "关闭 — 不思考 (none)",
                })}
              </option>
            </optgroup>
          )}
          {unknown && (
            <option value={value}>
              {value} ({t({ ko: "사용자 지정", en: "custom", ja: "カスタム", zh: "自定义" })})
            </option>
          )}
        </select>
      </label>
      {!supported ? (
        <p className="text-[10px] text-slate-400">
          {t({
            ko: "이 프로바이더의 추론 설정은 아직 지원되지 않습니다. 저장된 값은 유지되며 전송되지 않습니다.",
            en: "Reasoning effort is not supported for this provider yet. The saved value is kept and is not sent.",
            ja: "このプロバイダーの推論設定は未対応です。保存値は保持され、送信されません。",
            zh: "暂不支持此提供方的推理设置。保存的值将保留，但不会发送。",
          })}
        </p>
      ) : isApi && value === "none" ? (
        <p className="text-[10px] text-slate-400">
          {t({
            ko: "이 에이전트의 사고가 비활성화됩니다.",
            en: "Thinking is disabled for this agent.",
            ja: "このエージェントの思考は無効です。",
            zh: "此代理的思考已禁用。",
          })}
        </p>
      ) : value ? (
        <p className="text-[10px] text-slate-400">
          {t({ ko: "에이전트 재정의", en: "Agent override", ja: "エージェントの上書き", zh: "代理覆盖值" })}: {value}
        </p>
      ) : null}
      {isApi && supported && (
        <p className="text-[10px] text-slate-400">
          {t({
            ko: "reasoning_effort로 전송됩니다. 지원하지 않는 모델은 요청을 거부할 수 있습니다.",
            en: "Sent as reasoning_effort. Models that do not support it may reject the request.",
            ja: "reasoning_effort として送信します。未対応モデルはリクエストを拒否する場合があります。",
            zh: "作为 reasoning_effort 发送。不支持的模型可能拒绝请求。",
          })}
        </p>
      )}
    </div>
  );
}
