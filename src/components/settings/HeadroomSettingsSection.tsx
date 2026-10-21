import { useEffect, useState } from "react";
import { getHeadroomStatus } from "../../api/headroom";
import { DEFAULT_HEADROOM, type HeadroomSettings, type HeadroomStatus } from "../../lib/headroom";
import { ToggleSettingCard } from "./ToggleSettingCard";
import { HEADROOM_COPY } from "./headroom-copy";
import { validateProxyUrl } from "./headroom-settings";
import type { Locale, TFunction } from "./types";

interface Props {
  t: TFunction;
  value: HeadroomSettings;
  savedValue: HeadroomSettings;
  locale: Locale;
  onChange: (value: HeadroomSettings) => void;
}

export default function HeadroomSettingsSection({ t, value, savedValue, locale, onChange }: Props) {
  const copy = (key: keyof typeof HEADROOM_COPY) => t(HEADROOM_COPY[key]);
  const [status, setStatus] = useState<HeadroomStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [touched, setTouched] = useState(false);
  const [normalizedNotice, setNormalizedNotice] = useState<string | null>(null);
  const savedKey = JSON.stringify(savedValue);
  const unsaved = JSON.stringify(value) !== savedKey;
  const validation = validateProxyUrl(value.proxyUrl);
  const error = touched ? validation.error : null;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const saved = JSON.parse(savedKey) as HeadroomSettings;
    setStatus(null);
    setFailed(false);
    setLoading(false);
    if (!saved.enabled) return;

    async function check() {
      if (disposed || document.visibilityState !== "visible" || controller) return;
      const current = new AbortController();
      controller = current;
      setLoading(true);
      try {
        const next = await getHeadroomStatus(current.signal);
        if (!disposed && !current.signal.aborted) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (!disposed && !current.signal.aborted) {
          setStatus(null);
          setFailed(true);
        }
      } finally {
        if (!disposed && !current.signal.aborted) {
          controller = undefined;
          setLoading(false);
          timer = setTimeout(() => void check(), 15_000);
        }
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
      setLoading(false);
      if (document.visibilityState === "visible") void check();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [savedKey, refresh]);

  const state = !savedValue.enabled ? "disabled" : failed ? "error" : (status?.state ?? "checking");
  const statusText =
    state === "disabled"
      ? copy("Status: off")
      : state === "error"
        ? copy("Status: error")
        : state === "healthy"
          ? copy("Status: healthy").replace("{version}", status?.version ?? "?")
          : state === "unavailable"
            ? copy("Status: unavailable")
            : copy("Status: checking");
  const statusColor =
    state === "healthy"
      ? "text-green-400"
      : state === "unavailable"
        ? "text-amber-400"
        : state === "error"
          ? "text-red-400"
          : "text-slate-400";
  const reasonKeys = {
    health_timeout: "Reason: timeout",
    connection_refused: "Reason: refused",
    http_error: "Reason: http",
    invalid_response: "Reason: invalid",
    not_ready: "Reason: not ready",
    invalid_settings: "Reason: settings",
  } as const;
  const reason =
    status?.reason && status.reason in reasonKeys ? copy(reasonKeys[status.reason as keyof typeof reasonKeys]) : null;
  function nextRoute(provider: keyof HeadroomSettings["providers"]) {
    if (!savedValue.enabled) return copy("Status: off");
    const direct = copy("Next: direct");
    if (provider === "codex" && status?.capabilities.codex !== true) return copy("Codex unverified");
    if (!savedValue.providers[provider]) return `${direct} ${copy("· provider off")}`;
    if (!status || failed) return copy("Next: checking");
    if (!status.capabilities[provider]) return `${direct} ${copy("· not verified")}`;
    if (status.state === "disabled") return copy("Status: off");
    if (status.state !== "healthy") return `${direct} ${copy("· proxy unavailable")}`;
    return copy("Next: Headroom");
  }
  function blurUrl() {
    setTouched(true);
    if (!validation.error) {
      if (validation.normalized !== value.proxyUrl) {
        setNormalizedNotice(validation.normalized);
        onChange({ ...value, proxyUrl: validation.normalized });
      }
    }
  }

  return (
    <section
      className="rounded-xl p-5 sm:p-6 space-y-5"
      aria-labelledby="headroom-heading"
      style={{
        background: "var(--th-card-bg)",
        border: "1px solid var(--th-card-border)",
        color: "var(--th-text-secondary)",
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3
          id="headroom-heading"
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: "var(--th-text-primary)" }}
        >
          {copy("Section title")}
        </h3>
        <span className={`text-xs ${statusColor}`}>{statusText}</span>
      </div>
      <p className="text-xs leading-relaxed">{copy("Section intro")}</p>
      <div>
        <ToggleSettingCard
          label={copy("Master switch")}
          checked={value.enabled}
          onToggle={() => onChange({ ...value, enabled: !value.enabled })}
          describedBy="headroom-off-help"
        />
        <p id="headroom-off-help" className="mt-2 text-xs leading-relaxed">
          {copy("Master help")}
        </p>
      </div>
      <div>
        <label htmlFor="headroom-proxy-url" className="block text-xs mb-1">
          {copy("URL label")}
        </label>
        <input
          id="headroom-proxy-url"
          type="url"
          value={value.proxyUrl}
          aria-invalid={Boolean(error)}
          aria-describedby={`headroom-url-help${error ? " headroom-url-error" : ""}`}
          onBlur={blurUrl}
          onChange={(event) => {
            setNormalizedNotice(null);
            onChange({ ...value, proxyUrl: event.target.value });
          }}
          className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${error ? "border-red-500" : ""}`}
          style={{
            background: "var(--th-input-bg)",
            borderColor: error ? undefined : "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
        <p id="headroom-url-help" className="mt-2 text-xs">
          {copy("URL help")}
        </p>
        {error && (
          <p id="headroom-url-error" className="mt-2 text-xs text-red-400" role="alert">
            {copy(error)}
          </p>
        )}
        {normalizedNotice && <p className="mt-2 text-xs">{copy("Normalized").replace("{url}", normalizedNotice)}</p>}
        {value.proxyUrl !== DEFAULT_HEADROOM.proxyUrl && (
          <button
            type="button"
            className="mt-2 text-xs underline"
            onClick={() => {
              onChange({ ...value, proxyUrl: DEFAULT_HEADROOM.proxyUrl });
              setTouched(false);
              setNormalizedNotice(null);
            }}
          >
            {copy("Reset")}
          </button>
        )}
      </div>
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider">{copy("Group heading")}</h4>
        {!value.enabled && (
          <p id="headroom-provider-hint" className="text-xs">
            {copy("Off hint")}
          </p>
        )}
        {(
          [
            ["claude", "Claude Code", "Claude coverage"],
            ["codex", "Codex", "Codex coverage"],
            ["api", copy("API providers"), "API coverage"],
          ] as const
        ).map(([provider, label, coverage]) => (
          <div key={provider} className="space-y-1">
            <ToggleSettingCard
              label={label}
              checked={value.providers[provider]}
              disabled={!value.enabled || (provider === "codex" && status?.capabilities.codex !== true)}
              describedBy={`headroom-${provider}-coverage${value.enabled || provider === "codex" ? ` headroom-${provider}-route` : ""}${!value.enabled ? " headroom-provider-hint" : ""}`}
              onToggle={() =>
                onChange({ ...value, providers: { ...value.providers, [provider]: !value.providers[provider] } })
              }
            />
            <p id={`headroom-${provider}-coverage`} className="text-xs leading-relaxed px-3">
              {copy(coverage)}
            </p>
            {(value.enabled || provider === "codex") && (
              <p id={`headroom-${provider}-route`} className="text-xs px-3">
                {provider === "codex" ? copy("Codex unverified") : nextRoute(provider)}
              </p>
            )}
          </div>
        ))}
        <p className="text-xs leading-relaxed">{copy("Always direct")}</p>
      </div>
      <div className="rounded-lg border p-3 space-y-2 text-xs" style={{ borderColor: "var(--th-card-border)" }}>
        {unsaved && <p className="text-amber-400">{copy("Unsaved")}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p aria-live="polite" className={statusColor}>
            {statusText}
          </p>
          <button
            type="button"
            className="rounded border px-3 py-1.5 disabled:opacity-50"
            disabled={!savedValue.enabled || loading}
            onClick={() => setRefresh((previous) => previous + 1)}
          >
            {copy("Check now")}
          </button>
        </div>
        {state === "error" && <p>{copy("Status error help")}</p>}
        {state === "unavailable" && reason && <p>{reason}</p>}
        {savedValue.enabled && status?.checkedAt != null && (
          <p>{copy("Checked at").replace("{time}", new Date(status.checkedAt).toLocaleTimeString(locale))}</p>
        )}
        {state === "healthy" && (
          <div>
            {typeof status?.tokensSaved === "number" &&
            Number.isFinite(status.tokensSaved) &&
            status.tokensSaved >= 0 ? (
              <p>
                {copy("Savings label")}:{" "}
                <span className="font-mono">{new Intl.NumberFormat(locale).format(status.tokensSaved)}</span>
              </p>
            ) : (
              <p>{copy("Savings missing")}</p>
            )}
            <p className="mt-1">{copy("Savings scope")}</p>
          </div>
        )}
      </div>
      <p className="text-xs leading-relaxed">{copy("Applies next run")}</p>
    </section>
  );
}
