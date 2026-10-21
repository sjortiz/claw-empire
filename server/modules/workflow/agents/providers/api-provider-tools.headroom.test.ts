import type fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiProviderTools } from "./api-provider-tools.ts";
import type { ApiProviderRow } from "./types.ts";

vi.mock("../../../../oauth/helpers.ts", () => ({ decryptSecret: () => "fake-api-secret" }));
afterEach(() => {
  vi.unstubAllGlobals();
});
const json = (body: unknown) => new Response(JSON.stringify(body));
const healthy = () => json({ service: "headroom-proxy", status: "healthy", ready: true, version: "0.37.0" });

function fixture(type: "openai" | "anthropic" | "ollama" | "google" = "openai", enabled = true, available = true) {
  const provider: ApiProviderRow = {
    id: "api",
    name: "Test",
    type,
    base_url:
      type === "anthropic"
        ? "https://api.anthropic.com/v1"
        : type === "ollama"
          ? "http://localhost:11434/v1"
          : type === "google"
            ? "https://generativelanguage.googleapis.com/v1beta"
            : "https://api.openai.com/v1",
    api_key_enc: "fake-encrypted-key",
    enabled: 1,
    models_cache: null,
    models_cached_at: null,
  };
  const config = {
    enabled,
    proxyUrl: "http://proxy.example/prefix",
    providers: { claude: true, api: true, codex: false },
  };
  const logWrite = vi.fn(() => true);
  const modelWrite = vi.fn(() => true);
  const broadcast = vi.fn();
  const parseSSEStream = vi.fn(async () => {});
  const fetchMock = vi.fn(
    async (url: string, _init?: RequestInit): Promise<Response> =>
      url.endsWith("/health")
        ? available
          ? healthy()
          : new Response("not ready", { status: 503 })
        : new Response('data: {"type":"content_block_delta","delta":{"text":"reply"}}\n\n'),
  );
  vi.stubGlobal("fetch", fetchMock);
  const tools = createApiProviderTools({
    db: {
      prepare: (sql) => ({ get: () => (sql.includes("FROM settings") ? { value: JSON.stringify(config) } : provider) }),
    },
    logsDir: ".",
    activeProcesses: new Map(),
    broadcast,
    normalizeStreamChunk: (s) => s.toString(),
    handleTaskRunComplete: vi.fn(),
    createSafeLogStreamOps: () => ({ safeWrite: logWrite, safeEnd: vi.fn(), isClosed: () => false }),
    parseSSEStream,
    parseGeminiSSEStream: vi.fn(),
  });
  const execute = (signal = new AbortController().signal) =>
    tools.executeApiProviderAgent(
      "private prompt",
      "/project",
      {} as fs.WriteStream,
      signal,
      "task",
      "api",
      "test-model",
      modelWrite,
      "high",
    );
  return { execute, provider, config, fetchMock, logWrite, modelWrite, parseSSEStream, broadcast };
}

describe("Headroom API routing", () => {
  it.each(["openai", "anthropic"] as const)(
    "routes %s to the proxy with an explicit original upstream",
    async (type) => {
      const { execute, fetchMock, modelWrite } = fixture(type);
      await execute();
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe(`http://proxy.example/prefix/v1/${type === "anthropic" ? "messages" : "chat/completions"}`);
      expect(init).toMatchObject({
        redirect: "error",
        headers: { "X-Headroom-Base-Url": `https://api.${type === "anthropic" ? "anthropic" : "openai"}.com` },
      });
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init!.body));
      expect(body.model).toBe("test-model");
      expect(body.stream).toBe(true);
      if (type === "openai") expect(body.reasoning_effort).toBe("high");
      expect(JSON.stringify(modelWrite.mock.calls)).not.toContain("Headroom");
    },
  );

  it.each([
    [false, true],
    [true, false],
  ] as const)("keeps the direct destination with enabled=%s available=%s", async (enabled, available) => {
    const { execute, fetchMock } = fixture("openai", enabled, available);
    await execute();
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init!.headers).not.toHaveProperty("X-Headroom-Base-Url");
    expect(init!.headers).toHaveProperty("Authorization", "Bearer fake-api-secret");
  });

  it.each(["ollama", "google"] as const)(
    "keeps unverified/excluded %s traffic direct without probing",
    async (type) => {
      const { execute, fetchMock, logWrite, modelWrite } = fixture(type);
      await execute();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain(
        type === "ollama" ? "localhost:11434" : "generativelanguage.googleapis.com",
      );
      if (type === "ollama") expect(logWrite).toHaveBeenCalledWith(expect.stringContaining("upstream_unverified"));
      expect(JSON.stringify(logWrite.mock.calls)).not.toContain("fake-api-secret");
      expect(JSON.stringify(modelWrite.mock.calls)).not.toContain("Headroom");
    },
  );

  it("falls back once when the proxy refuses a new connection after healthy preflight", async () => {
    const { execute, fetchMock } = fixture();
    fetchMock
      .mockImplementationOnce(async () => healthy())
      .mockRejectedValueOnce(Object.assign(new TypeError("hidden"), { cause: { code: "ECONNREFUSED" } }));
    await execute();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetchMock.mock.calls[2][1]!.headers).not.toHaveProperty("X-Headroom-Base-Url");
  });

  it("does not replay ambiguous transport errors, HTTP errors, or partial streams", async () => {
    const transport = fixture();
    transport.fetchMock
      .mockImplementationOnce(async () => healthy())
      .mockRejectedValueOnce(new TypeError("sensitive URL and fake-api-secret"));
    await expect(transport.execute()).rejects.toThrow("API provider connection failed");
    expect(transport.fetchMock).toHaveBeenCalledTimes(2);
    const http = fixture();
    http.fetchMock
      .mockImplementationOnce(async () => healthy())
      .mockResolvedValueOnce(new Response("private prompt fake-api-secret", { status: 500 }));
    await expect(http.execute()).rejects.toThrow("API provider error (500)");
    expect(http.fetchMock).toHaveBeenCalledTimes(2);
    const partial = fixture();
    partial.parseSSEStream.mockRejectedValueOnce(new Error("private prompt fake-api-secret"));
    await expect(partial.execute()).rejects.toThrow("API provider stream failed");
    expect(partial.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send a model request when aborted during preflight", async () => {
    const { execute, fetchMock } = fixture();
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return healthy();
    });
    await expect(execute(controller.signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
