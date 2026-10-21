import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeTools } from "./agents/cli-runtime.ts";
import { createOneShotRunner } from "./core/one-shot-runner.ts";
import type { AgentRow } from "./core/conversation-types.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const cleanup: (() => void)[] = [];
const logStreams: fs.WriteStream[] = [];
const createWriteStream = fs.createWriteStream;
afterEach(async () => {
  await Promise.all(logStreams.splice(0).map((stream) => finished(stream)));
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const health = () =>
  new Response(JSON.stringify({ service: "headroom-proxy", status: "healthy", ready: true, version: "0.37.0" }));

function setup(enabled: boolean, available = true) {
  vi.spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
    const stream = createWriteStream(file, options);
    logStreams.push(stream);
    return stream;
  });
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, assigned_agent_id TEXT)",
  );
  db.prepare("INSERT INTO settings VALUES ('headroom', ?)").run(
    JSON.stringify({
      enabled,
      proxyUrl: "http://proxy.example:8787/prefix",
      providers: { claude: true, codex: true, api: true },
    }),
  );
  db.prepare("INSERT INTO tasks VALUES ('task', 'in_progress', 'agent')").run();
  const logsDir = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "headroom-"));
  cleanup.push(() => {
    db.close();
    fs.rmSync(logsDir, { recursive: true, force: true });
  });
  const fetchMock = vi.fn(async () => (available ? health() : new Response("unavailable", { status: 503 })));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://inherited.example");
  vi.stubEnv("OPENAI_BASE_URL", "http://inherited.example/v1");
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-test-secret");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Headroom-Base-Url: http://wrong.example\nX-Custom: keep");
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    });
    setImmediate(() => {
      child.stdout.write("model reply");
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  });
  const appendTaskLog = vi.fn();
  const broadcast = vi.fn();
  const runtime = createCliRuntimeTools({
    db,
    logsDir,
    buildAgentArgs: (p) => [p, "run"],
    clearCliOutputDedup: vi.fn(),
    normalizeStreamChunk: (b) => b.toString(),
    shouldSkipDuplicateCliOutput: () => false,
    broadcast,
    TASK_RUN_IDLE_TIMEOUT_MS: 0,
    TASK_RUN_HARD_TIMEOUT_MS: 0,
    killPidTree: vi.fn(),
    appendTaskLog,
    activeProcesses: new Map(),
    createSubtaskFromCli: vi.fn(),
    completeSubtaskFromCli: vi.fn(),
  });
  const runner = createOneShotRunner({
    db,
    logsDir,
    appendTaskLog,
    broadcast,
    getProviderModelConfig: () => ({}),
    executeApiProviderAgent: vi.fn(),
    executeCopilotAgent: vi.fn(),
    executeAntigravityAgent: vi.fn(),
    killPidTree: vi.fn(),
    prettyStreamJson: (s) => s,
    getPreferredLanguage: () => "en",
    normalizeStreamChunk: (s) => s.toString(),
    hasStructuredJsonLines: () => false,
    normalizeConversationReply: (s) => s,
    buildAgentArgs: (p) => [p, "run"],
    withCliPathFallback: (s) => s ?? "",
  });
  return { db, logsDir, runtime, runner, fetchMock, appendTaskLog, broadcast };
}

for (const mode of ["task", "meeting"] as const) {
  describe(`Headroom ${mode} launch`, () => {
    it.each([
      ["claude", true, true],
      ["claude", false, true],
      ["claude", true, false],
      ["codex", true, true],
      ["codex", false, false],
      ["gemini", true, true],
    ] as const)("uses explicit routing for %s enabled=%s available=%s", async (provider, enabled, available) => {
      const { runtime, runner, logsDir, appendTaskLog, fetchMock } = setup(enabled, available);
      if (mode === "task") {
        await runtime.spawnCliAgent("task", provider, "prompt", logsDir, path.join(logsDir, "task.log"));
        await new Promise(setImmediate);
      } else {
        const result = await runner.runAgentOneShot({ id: "agent", cli_provider: provider } as AgentRow, "prompt", {
          streamTaskId: "task",
        });
        expect(result).toEqual({ text: "model reply" });
      }
      const [, argv, options] = vi.mocked(spawn).mock.calls[0];
      const env = options!.env!;
      expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe("fake-test-secret");
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Custom: keep");
      expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain("wrong.example");
      expect(env.ANTHROPIC_BASE_URL).toBe(
        provider === "claude" && enabled && available ? "http://proxy.example:8787/prefix" : undefined,
      );
      expect(argv.join(" ")).not.toContain("openai_base_url");
      expect(process.env.ANTHROPIC_BASE_URL).toBe("http://inherited.example");
      expect(JSON.stringify(appendTaskLog.mock.calls)).not.toContain("fake-test-secret");
      if (provider !== "claude" || !enabled) expect(fetchMock).not.toHaveBeenCalled();
      if (provider === "claude" && enabled && !available)
        expect(appendTaskLog).toHaveBeenCalledWith("task", "system", expect.stringContaining("http_error"));
    });
  });
}

it("does not spawn or recreate logs when a task is canceled during preflight", async () => {
  const { db, runtime, logsDir, fetchMock } = setup(true);
  let resolveHealth!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveHealth = resolve;
      }),
  );
  const launch = runtime.spawnCliAgent("task", "claude", "prompt", logsDir, path.join(logsDir, "task.log"));
  db.prepare("UPDATE tasks SET status = 'canceled' WHERE id = 'task'").run();
  resolveHealth(health());
  await expect(launch).rejects.toMatchObject({ code: "CLI_LAUNCH_CANCELLED" });
  expect(spawn).not.toHaveBeenCalled();
  expect(fs.readdirSync(logsDir)).toEqual([]);
});
