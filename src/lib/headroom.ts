export interface HeadroomSettings {
  enabled: boolean;
  proxyUrl: string;
  providers: { claude: boolean; codex: boolean; api: boolean };
}

export const DEFAULT_HEADROOM: HeadroomSettings = {
  enabled: false,
  proxyUrl: "http://127.0.0.1:8787",
  providers: { claude: true, codex: false, api: true },
};

export function normalizeHeadroomUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_proxy_url");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("invalid_proxy_url");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error("invalid_proxy_url");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${url.origin}${path}`;
}

// Used by writes on the server and forms in the browser; never coerce boolean strings.
export function normalizeHeadroomSettings(value: unknown): HeadroomSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_headroom");
  const input = value as Record<string, unknown>;
  for (const key of ["enabled"])
    if (key in input && typeof input[key] !== "boolean") throw new Error("invalid_headroom");
  if (
    input.providers !== undefined &&
    (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers))
  )
    throw new Error("invalid_headroom");
  const providers = (input.providers ?? {}) as Record<string, unknown>;
  for (const key of ["claude", "codex", "api"])
    if (key in providers && typeof providers[key] !== "boolean") throw new Error("invalid_headroom");
  return {
    enabled: (input.enabled as boolean | undefined) ?? DEFAULT_HEADROOM.enabled,
    proxyUrl: input.proxyUrl === undefined ? DEFAULT_HEADROOM.proxyUrl : normalizeHeadroomUrl(input.proxyUrl),
    providers: {
      claude: (providers.claude as boolean | undefined) ?? true,
      codex: (providers.codex as boolean | undefined) ?? false,
      api: (providers.api as boolean | undefined) ?? true,
    },
  };
}

export type HeadroomReason =
  | "disabled"
  | "provider_disabled"
  | "unsupported_provider"
  | "codex_unverified"
  | "upstream_unverified"
  | "health_timeout"
  | "connection_refused"
  | "http_error"
  | "invalid_response"
  | "not_ready"
  | "invalid_settings";
export interface HeadroomStatus {
  state: "disabled" | "healthy" | "unavailable";
  reason: HeadroomReason | null;
  checkedAt: number | null;
  version: string | null;
  tokensSaved: number | null;
  capabilities: { claude: boolean; codex: boolean; api: boolean };
}
