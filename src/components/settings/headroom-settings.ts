import { normalizeHeadroomUrl } from "../../lib/headroom";

export type ProxyUrlError = "Error: empty" | "Error: scheme" | "Error: credentials" | "Error: query";

export function validateProxyUrl(
  value: string,
): { normalized: string; error: null } | { normalized: null; error: ProxyUrlError } {
  if (!value.trim()) return { normalized: null, error: "Error: empty" };
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { normalized: null, error: "Error: scheme" };
  }
  if (!/^https?:$/.test(url.protocol)) return { normalized: null, error: "Error: scheme" };
  if (url.username || url.password) return { normalized: null, error: "Error: credentials" };
  if (url.search || url.hash) return { normalized: null, error: "Error: query" };
  try {
    return { normalized: normalizeHeadroomUrl(value), error: null };
  } catch {
    return { normalized: null, error: "Error: scheme" };
  }
}
