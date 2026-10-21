import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_REASONING_LEVELS } from "../../../../../src/lib/api-reasoning-effort.ts";
import { createApiProviderTools } from "./api-provider-tools.ts";
import type { ApiProviderRow, ApiProviderType } from "./types.ts";

const compatibleTypes: ApiProviderType[] = ["openai", "ollama", "openrouter", "together", "groq", "cerebras", "custom"];
const providerTypes: ApiProviderType[] = [...compatibleTypes, "anthropic", "google"];

function setup(type: ApiProviderType, logsDir = ".") {
  const provider: ApiProviderRow = {
    id: "provider-1",
    name: "Test provider",
    type,
    base_url: "https://provider.example",
    api_key_enc: null,
    enabled: 1,
    models_cache: null,
    models_cached_at: null,
  };
  const safeWrite = vi.fn(() => true);
  const broadcast = vi.fn();
  const parseSSEStream = vi.fn();
  const parseGeminiSSEStream = vi.fn();
  const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const tools = createApiProviderTools({
    db: { prepare: vi.fn(() => ({ get: vi.fn(() => provider) })) },
    logsDir,
    activeProcesses: new Map(),
    broadcast,
    normalizeStreamChunk: (raw) => String(raw),
    handleTaskRunComplete: vi.fn(),
    createSafeLogStreamOps: (stream) => ({
      safeWrite,
      safeEnd: (callback) => stream.end(callback),
      isClosed: () => false,
    }),
    parseSSEStream,
    parseGeminiSSEStream,
  });

  async function execute(effort?: string | null) {
    await tools.executeApiProviderAgent(
      "Implement the change",
      "/project",
      {} as fs.WriteStream,
      new AbortController().signal,
      "task-1",
      provider.id,
      "test-model",
      safeWrite,
      effort,
    );
    const request = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    return { url: request[0], headers: request[1].headers, body: JSON.parse(String(request[1].body)) };
  }

  return { ...tools, execute, safeWrite, broadcast, parseSSEStream, parseGeminiSSEStream };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API provider reasoning effort", () => {
  it.each(compatibleTypes)("sends configured effort in %s chat-completions requests", async (type) => {
    const { execute, safeWrite, broadcast, parseSSEStream } = setup(type);
    const { body, url } = await execute("high");
    expect(body).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "You are a coding assistant. Project path: /project" },
        { role: "user", content: "Implement the change" },
      ],
      stream: true,
      reasoning_effort: "high",
    });
    expect(url).toBe("https://provider.example/v1/chat/completions");
    const header = `[api:${type}] Provider: Test provider, Model: test-model, Effort: high (agent)\n---\n`;
    expect(safeWrite).toHaveBeenCalledWith(header);
    expect(broadcast).toHaveBeenCalledWith("cli_output", {
      task_id: "task-1",
      stream: "stderr",
      data: header,
    });
    expect(parseSSEStream).toHaveBeenCalledOnce();
  });

  it.each(API_REASONING_LEVELS)("sends the explicit %s effort unchanged to Ollama", async (level) => {
    const { execute, safeWrite } = setup("ollama");
    const { body } = await execute(level);
    expect(body.reasoning_effort).toBe(level);
    if (level === "none") {
      expect(safeWrite).toHaveBeenCalledWith(
        "[api:ollama] Provider: Test provider, Model: test-model, Effort: none (thinking off, agent)\n---\n",
      );
    }
  });

  it.each(providerTypes)("preserves %s request body and header when effort is unset", async (type) => {
    const { execute, safeWrite } = setup(type);
    const baseline = await execute();
    expect(await execute("")).toEqual(baseline);
    expect(await execute(null)).toEqual(baseline);
    expect(baseline.body).not.toHaveProperty("reasoning_effort");
    expect(baseline.body).not.toHaveProperty("thinking");
    expect(safeWrite).toHaveBeenCalledWith(`[api:${type}] Provider: Test provider, Model: test-model\n---\n`);
  });

  it.each(["anthropic", "google"] as const)("keeps unsupported %s requests unchanged", async (type) => {
    const { execute, safeWrite, parseGeminiSSEStream } = setup(type);
    const baseline = await execute();
    expect(await execute("high")).toEqual(baseline);
    expect(await execute("none")).toEqual(baseline);
    expect(safeWrite).toHaveBeenCalledWith(
      `[api:${type}] Provider: Test provider, Model: test-model, Effort: high (not sent: unsupported for ${type})\n---\n`,
    );
    if (type === "google") {
      expect(baseline.body).toEqual({
        contents: [{ role: "user", parts: [{ text: "Implement the change" }] }],
        systemInstruction: { parts: [{ text: "You are a coding assistant. Project path: /project" }] },
      });
      expect(parseGeminiSSEStream).toHaveBeenCalledTimes(3);
    } else {
      expect(baseline.body).toEqual({
        model: "test-model",
        max_tokens: 16384,
        stream: true,
        messages: [{ role: "user", content: "Implement the change" }],
        system: "You are a coding assistant. Project path: /project",
      });
    }
  });

  it("does not send an unrecognized saved effort or claim that it was applied", async () => {
    const { execute, safeWrite } = setup("openai");
    expect((await execute("future-level")).body).not.toHaveProperty("reasoning_effort");
    expect(safeWrite).toHaveBeenCalledWith(
      "[api:openai] Provider: Test provider, Model: test-model, Effort: future-level (not sent: invalid level)\n---\n",
    );
  });

  it("threads task launch effort to the request and preserves completion callbacks", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-api-effort-"));
    try {
      const { launchApiProviderAgent, safeWrite } = setup("ollama", logsDir);
      const onComplete = vi.fn();
      await new Promise<void>((resolve) => {
        launchApiProviderAgent(
          "task-1",
          "provider-1",
          "test-model",
          "Implement the change",
          "/project",
          path.join(logsDir, "task-1.log"),
          new AbortController(),
          -1,
          (exitCode) => {
            onComplete(exitCode);
            resolve();
          },
          "none",
        );
      });
      expect(onComplete).toHaveBeenCalledWith(0);
      expect(safeWrite).toHaveBeenCalledWith(
        "[api:ollama] Provider: Test provider, Model: test-model, Effort: none (thinking off, agent)\n---\n",
      );
      expect(fs.existsSync(path.join(logsDir, "task-1.prompt.txt"))).toBe(false);
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
