import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadroomStatus, prepareHeadroomCli, prepareHeadroomRoute, readHeadroomSettings } from "./headroom.ts";

const ready = { service: "headroom-proxy", status: "healthy", ready: true, version: "0.37.0" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let db: DatabaseSync;
function configure(value: unknown = { enabled: true }) {
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('headroom', ?)").run(JSON.stringify(value));
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Headroom routing policy", () => {
  it("defaults off, strips inherited routing for all children and preserves auth", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const provider of ["claude", "codex", "gemini", "opencode"]) {
      const original = {
        ANTHROPIC_BASE_URL: "http://old",
        OPENAI_BASE_URL: "http://old/v1",
        ANTHROPIC_API_KEY: "secret",
        ANTHROPIC_CUSTOM_HEADERS: "x-headroom-base-url: http://evil\r\nX-Other: retained\nX-HeAdRoOm-Test: ignored",
      };
      const result = await prepareHeadroomCli(db, provider, original);
      expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(result.env.OPENAI_BASE_URL).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY).toBe("secret");
      expect(result.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Other: retained");
      expect(original.OPENAI_BASE_URL).toBe("http://old/v1");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await getHeadroomStatus(db)).state).toBe("disabled");
  });
  it("fails closed on malformed stored settings", async () => {
    configure({ enabled: "true", proxyUrl: "http://proxy" });
    expect(readHeadroomSettings(db).enabled).toBe(false);
    expect(await prepareHeadroomRoute(db, "claude")).toEqual({ proxyUrl: null, reason: "invalid_settings" });
  });
  it("routes Claude with one official upstream header and unchanged credentials", async () => {
    configure();
    const fetch = vi.fn().mockResolvedValue(json(ready));
    vi.stubGlobal("fetch", fetch);
    const result = await prepareHeadroomCli(db, "claude", {
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_CUSTOM_HEADERS: "X-Other: value\nx-headroom-base-url: http://evil",
    });
    expect(result.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_CUSTOM_HEADERS: "X-Other: value\nX-Headroom-Base-Url: https://api.anthropic.com",
    });
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    expect(fetch.mock.calls[0][1].headers).toBeUndefined();
  });
  it("keeps Codex and custom API upstreams direct without probing", async () => {
    configure({ enabled: true, providers: { codex: true } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await prepareHeadroomRoute(db, "codex")).toMatchObject({ proxyUrl: null, reason: "codex_unverified" });
    for (const upstreamUrl of [
      "http://127.0.0.1:11434/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions?x=1",
      "https://other/v1/messages",
    ]) {
      expect(await prepareHeadroomRoute(db, "api", { upstreamUrl })).toMatchObject({
        proxyUrl: null,
        reason: "upstream_unverified",
      });
    }
    expect((await prepareHeadroomCli(db, "codex", {})).args).toEqual([
      "-c",
      'openai_base_url="https://api.openai.com/v1"',
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes only exact official API endpoint URLs", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(json(ready))),
    );
    for (const upstreamUrl of ["https://api.openai.com/v1/chat/completions", "https://api.anthropic.com/v1/messages"]) {
      expect(await prepareHeadroomRoute(db, "api", { upstreamUrl })).toEqual({
        proxyUrl: "http://127.0.0.1:8787",
        reason: null,
      });
    }
  });
  it("respects provider opt-outs without contacting the proxy", async () => {
    configure({ enabled: true, providers: { claude: false, api: false } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await prepareHeadroomRoute(db, "claude")).toEqual({ proxyUrl: null, reason: "provider_disabled" });
    expect(
      await prepareHeadroomRoute(db, "api", { upstreamUrl: "https://api.openai.com/v1/chat/completions" }),
    ).toEqual({ proxyUrl: null, reason: "provider_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the Codex opt-out quiet and does not warn for excluded CLI families", async () => {
    configure();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await prepareHeadroomRoute(db, "codex")).toEqual({ proxyUrl: null, reason: "provider_disabled" });
    for (const provider of ["codex", "gemini", "opencode"])
      expect((await prepareHeadroomCli(db, provider, {})).warning).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"])(
    "keeps %s direct and reports Claude capability unavailable",
    async (selector) => {
      configure();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const env = { [selector]: "1", ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_CUSTOM_HEADERS: "X-Other: keep" };
      const result = await prepareHeadroomCli(db, "claude", env);
      expect(result.env).toEqual(env);
      expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(result.warning).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      vi.stubEnv(selector, "1");
      fetch.mockResolvedValue(json(ready));
      // stats uses the same ready body, so no savings are exposed.
      expect(await getHeadroomStatus(db)).toMatchObject({ capabilities: { claude: false } });
    },
  );
  it("cancels one waiting caller without cancelling another caller's shared probe", async () => {
    configure();
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const controller = new AbortController();
    const cancelled = prepareHeadroomRoute(db, "claude", { signal: controller.signal });
    const retained = prepareHeadroomRoute(db, "claude");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    resolve(json(ready));
    expect(await retained).toMatchObject({ proxyUrl: "http://127.0.0.1:8787", reason: null });
  });
  it("deduplicates concurrent health checks without keeping a stale healthy result", async () => {
    configure();
    let resolve!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(json({ ...ready, ready: false, status: "unhealthy" }));
    vi.stubGlobal("fetch", fetch);
    const first = prepareHeadroomRoute(db, "claude");
    const second = prepareHeadroomRoute(db, "claude");
    resolve(json(ready));
    expect((await first).proxyUrl).not.toBeNull();
    expect((await second).proxyUrl).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await prepareHeadroomRoute(db, "claude")).toEqual({ proxyUrl: null, reason: "not_ready" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ status: "healthy" }, 200, "invalid_response"],
    [{ ...ready, ready: false }, 200, "not_ready"],
    [ready, 503, "http_error"],
  ])("rejects invalid or unhealthy health responses", async (body, code, reason) => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, code as number)));
    expect(await prepareHeadroomRoute(db, "claude")).toMatchObject({ proxyUrl: null, reason });
  });
  it("bounds body reads and sanitizes connection errors", async () => {
    configure();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...ready, payload: "x".repeat(66000) }))
      .mockRejectedValueOnce(new Error("credential or URL must not leak", { cause: { code: "ECONNREFUSED" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await prepareHeadroomRoute(db, "claude")).toMatchObject({ reason: "invalid_response" });
    expect(await prepareHeadroomRoute(db, "claude")).toMatchObject({ reason: "connection_refused" });
  });
  it("times out the health preflight and falls back directly", async () => {
    configure();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) =>
              options.signal.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        ),
    );
    try {
      const route = prepareHeadroomRoute(db, "claude");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await route).toEqual({ proxyUrl: null, reason: "health_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("returns only sanitized measured savings and retains healthy state if stats fails", async () => {
    configure();
    const fetch = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          json(url.endsWith("/health") ? ready : { tokens: { proxy_compression_saved: 42 }, secret: "must not leak" }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await getHeadroomStatus(db)).toEqual({
      state: "healthy",
      reason: null,
      version: "0.37.0",
      checkedAt: expect.any(Number),
      tokensSaved: 42,
      capabilities: { claude: true, codex: false, api: true },
    });
    fetch.mockImplementation((url: string) =>
      url.endsWith("/health") ? Promise.resolve(json(ready)) : Promise.reject(new Error("private response")),
    );
    expect(await getHeadroomStatus(db)).toMatchObject({ state: "healthy", tokensSaved: null });
  });
  it.each([-1, "100", 1.5, Number.MAX_SAFE_INTEGER + 1])("ignores invalid stats counter %s", async (saved) => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(json(url.endsWith("/health") ? ready : { tokens: { proxy_compression_saved: saved } })),
        ),
    );
    expect(await getHeadroomStatus(db)).toMatchObject({ state: "healthy", tokensSaved: null });
  });
});
