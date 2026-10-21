import {
  DEFAULT_HEADROOM,
  normalizeHeadroomSettings,
  type HeadroomReason,
  type HeadroomSettings,
  type HeadroomStatus,
} from "../../src/lib/headroom.ts";

type SettingsDb = { prepare(sql: string): { get(...args: any[]): unknown } };

function loadSettings(db: SettingsDb): { settings: HeadroomSettings; invalid: boolean } {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get("headroom") as
      | { value: string }
      | undefined;
    return { settings: normalizeHeadroomSettings(row ? JSON.parse(row.value) : DEFAULT_HEADROOM), invalid: false };
  } catch {
    return { settings: normalizeHeadroomSettings(DEFAULT_HEADROOM), invalid: true };
  }
}

export function readHeadroomSettings(db: SettingsDb): HeadroomSettings {
  return loadSettings(db).settings;
}

const inFlight = new Map<string, Promise<HeadroomStatus>>();
function hasClaudeBackend(env: NodeJS.ProcessEnv): boolean {
  return ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((key) =>
    ["1", "true"].includes((env[key] ?? "").trim().toLowerCase()),
  );
}
function status(reason: HeadroomReason | null, checkedAt: number | null = null): HeadroomStatus {
  return {
    state: reason === "disabled" ? "disabled" : reason ? "unavailable" : "healthy",
    reason,
    checkedAt,
    version: null,
    tokensSaved: null,
    capabilities: { claude: !hasClaudeBackend(process.env), codex: false, api: true },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("invalid_response");
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_response");
    return body;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function probe(proxyUrl: string): Promise<HeadroomStatus> {
  const checkedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${proxyUrl}/health`, { redirect: "error", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return status("http_error", checkedAt);
    }
    const body = await readJson(response);
    if (
      body.service !== "headroom-proxy" ||
      typeof body.ready !== "boolean" ||
      !["healthy", "unhealthy"].includes(String(body.status)) ||
      typeof body.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(body.version)
    )
      return status("invalid_response", checkedAt);
    if (!body.ready || body.status !== "healthy") return status("not_ready", checkedAt);
    return { ...status(null, checkedAt), version: body.version };
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    return status(
      controller.signal.aborted
        ? "health_timeout"
        : code === "ECONNREFUSED"
          ? "connection_refused"
          : error instanceof SyntaxError || (error as Error)?.message === "invalid_response"
            ? "invalid_response"
            : "http_error",
      checkedAt,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function currentHealth(proxyUrl: string): Promise<HeadroomStatus> {
  const pending = inFlight.get(proxyUrl);
  if (pending) return pending;
  const promise = probe(proxyUrl).finally(() => inFlight.delete(proxyUrl));
  inFlight.set(proxyUrl, promise);
  return promise;
}

async function waitForHealth(proxyUrl: string, signal?: AbortSignal): Promise<HeadroomStatus> {
  signal?.throwIfAborted();
  if (!signal) return currentHealth(proxyUrl);
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      currentHealth(proxyUrl),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function getHeadroomStatus(db: SettingsDb): Promise<HeadroomStatus> {
  const { settings, invalid } = loadSettings(db);
  if (invalid) return status("invalid_settings");
  if (!settings.enabled) return status("disabled");
  const health = await currentHealth(settings.proxyUrl);
  if (health.state !== "healthy") return health;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${settings.proxyUrl}/stats`, { redirect: "error", signal: controller.signal });
    if (response.ok) {
      const body = await readJson(response);
      const saved = (body.tokens as Record<string, unknown> | undefined)?.proxy_compression_saved;
      if (typeof saved === "number" && Number.isSafeInteger(saved) && saved >= 0)
        return { ...health, tokensSaved: saved };
    } else await response.body?.cancel();
  } catch {
    // Savings are optional; a failed dashboard endpoint never changes readiness.
  } finally {
    clearTimeout(timeout);
  }
  return health;
}

const VERIFIED_API_UPSTREAMS = new Set([
  "https://api.openai.com/v1/chat/completions",
  "https://api.anthropic.com/v1/messages",
]);

export async function prepareHeadroomRoute(
  db: SettingsDb,
  provider: string,
  options: { upstreamUrl?: string; signal?: AbortSignal } = {},
): Promise<{ proxyUrl: string | null; reason: HeadroomReason | null }> {
  const { settings, invalid } = loadSettings(db);
  let reason: HeadroomReason | null = invalid ? "invalid_settings" : !settings.enabled ? "disabled" : null;
  if (!reason && !["claude", "codex", "api"].includes(provider)) reason = "unsupported_provider";
  if (!reason && !settings.providers[provider as keyof HeadroomSettings["providers"]]) reason = "provider_disabled";
  if (!reason && provider === "codex") reason = "codex_unverified";
  if (!reason && provider === "api" && !VERIFIED_API_UPSTREAMS.has(options.upstreamUrl ?? ""))
    reason = "upstream_unverified";
  if (reason) return { proxyUrl: null, reason };
  const health = await waitForHealth(settings.proxyUrl, options.signal);
  options.signal?.throwIfAborted();
  return { proxyUrl: health.state === "healthy" ? settings.proxyUrl : null, reason: health.reason };
}

export async function prepareHeadroomCli(
  db: SettingsDb,
  provider: string,
  inherited: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; args: string[]; warning: string | null }> {
  const env = { ...inherited };
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_BASE_URL;
  if (env.ANTHROPIC_CUSTOM_HEADERS) {
    const headers = env.ANTHROPIC_CUSTOM_HEADERS.split(/\r?\n/).filter((line) => !/^\s*x-headroom-/i.test(line));
    if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  // Codex is never routed, and its own config decides its endpoint: forcing the OpenAI
  // API base URL breaks ChatGPT sign-in (401, missing api.responses.write).
  const args: string[] = [];
  const route =
    provider === "claude" && hasClaudeBackend(env)
      ? { proxyUrl: null, reason: "unsupported_provider" as const }
      : await prepareHeadroomRoute(db, provider);
  if (route.proxyUrl && provider === "claude") {
    env.ANTHROPIC_BASE_URL = route.proxyUrl;
    env.ANTHROPIC_CUSTOM_HEADERS = [env.ANTHROPIC_CUSTOM_HEADERS, "X-Headroom-Base-Url: https://api.anthropic.com"]
      .filter(Boolean)
      .join("\n");
  }
  return {
    env,
    args,
    warning:
      route.reason &&
      route.reason !== "disabled" &&
      route.reason !== "provider_disabled" &&
      route.reason !== "unsupported_provider"
        ? `Headroom: ${route.reason}; using direct connection.`
        : null,
  };
}
