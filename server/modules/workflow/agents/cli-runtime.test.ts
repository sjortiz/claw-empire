import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeTools } from "./cli-runtime.ts";
import { createCliTools } from "../core/cli-tools.ts";
import { loadTaskExecutionSession, type TaskExecutionSessionState } from "../core/execution-session.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("CLI run header", () => {
  it.each([
    ["claude", "max", "max"],
    ["claude", "none", undefined],
    ["claude", undefined, undefined],
    ["codex", "high", "high"],
    ["gemini", "high", undefined],
    ["kimi", "high", undefined],
  ])("logs only the effort actually passed to %s (%s)", async (provider, level, expectedEffort) => {
    const logsDir = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "cli-effort-"));
    directories.push(logsDir);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    const cliTools = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
    const runtime = createCliRuntimeTools({
      db: {},
      logsDir,
      buildAgentArgs: cliTools.buildAgentArgs,
      clearCliOutputDedup: vi.fn(),
      normalizeStreamChunk: (chunk) => chunk.toString(),
      shouldSkipDuplicateCliOutput: () => false,
      broadcast: vi.fn(),
      TASK_RUN_IDLE_TIMEOUT_MS: 0,
      TASK_RUN_HARD_TIMEOUT_MS: 0,
      killPidTree: vi.fn(),
      appendTaskLog: vi.fn(),
      activeProcesses: new Map(),
      createSubtaskFromCli: vi.fn(),
      completeSubtaskFromCli: vi.fn(),
    });
    const logPath = path.join(logsDir, "test.log");
    runtime.spawnCliAgent("test", provider, "prompt", logsDir, logPath, "model-name", level);
    child.emit("close", 0);

    await vi.waitFor(() => {
      const log = fs.readFileSync(logPath, "utf8");
      if (expectedEffort) {
        expect(log).toContain(`provider=${provider} | model=model-name | effort=${expectedEffort}`);
      } else {
        expect(log).toContain(`provider=${provider} =====`);
        expect(log).not.toContain("effort=");
        expect(log).not.toContain("model=");
      }
    });
    expect(spawn).toHaveBeenCalledWith(
      provider,
      cliTools.buildAgentArgs(provider, "model-name", level).slice(1),
      expect.objectContaining({ cwd: logsDir }),
    );
  });
});

describe("provider session continuity", () => {
  it("pins Kimi's native session durably before first output, then resumes that exact ID after restart", async () => {
    const logsDir = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "kimi-resume-"));
    directories.push(logsDir);
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE task_logs (task_id TEXT, kind TEXT, message TEXT, created_at INTEGER)");
    const children: ChildProcess[] = [];
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const nativeSessionId = args![args!.indexOf("--session") + 1];
      expect(loadTaskExecutionSession(db, "test")?.nativeSessionId).toBe(nativeSessionId);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        unref: vi.fn(),
      }) as unknown as ChildProcess;
      children.push(child);
      return child;
    });
    const cliTools = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
    const runtime = createCliRuntimeTools({
      db,
      logsDir,
      buildAgentArgs: cliTools.buildAgentArgs,
      clearCliOutputDedup: vi.fn(),
      normalizeStreamChunk: (chunk) => chunk.toString(),
      shouldSkipDuplicateCliOutput: () => false,
      broadcast: vi.fn(),
      TASK_RUN_IDLE_TIMEOUT_MS: 0,
      TASK_RUN_HARD_TIMEOUT_MS: 0,
      killPidTree: vi.fn(),
      appendTaskLog: (taskId, kind, message) => {
        db.prepare("INSERT INTO task_logs VALUES (?, ?, ?, ?)").run(taskId, kind, message, Date.now());
      },
      activeProcesses: new Map(),
      createSubtaskFromCli: vi.fn(),
      completeSubtaskFromCli: vi.fn(),
    });
    const executionSession: TaskExecutionSessionState = {
      sessionId: "task-session",
      taskId: "test",
      agentId: "same-agent",
      provider: "kimi",
      openedAt: 100,
      lastTouchedAt: 100,
    };
    const logPath = path.join(logsDir, "test.log");
    try {
      runtime.spawnCliAgent("test", "kimi", "prompt", logsDir, logPath, undefined, undefined, { executionSession });
      children[0].emit("close", 1);
      const recovered = loadTaskExecutionSession(db, "test")!;
      expect(recovered.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/);
      runtime.spawnCliAgent("test", "kimi", "resume", logsDir, logPath, undefined, undefined, {
        executionSession: recovered,
        resumeSessionId: recovered.nativeSessionId,
      });
      children[1].emit("close", 0);
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "kimi",
        expect.arrayContaining(["--session", recovered.nativeSessionId]),
        expect.objectContaining({ cwd: logsDir }),
      );
      await vi.waitFor(() => expect(fs.readFileSync(logPath, "utf8").match(/task run start/g)).toHaveLength(2));
    } finally {
      db.close();
    }
  });

  it.each([
    ["codex", { type: "thread.started", thread_id: "native-session" }],
    ["claude", { type: "system", subtype: "init", session_id: "native-session" }],
    ["gemini", { type: "init", session_id: "native-session" }],
    ["opencode", { type: "step_start", sessionID: "native-session" }],
  ])("captures split %s events durably and resumes by ID in the existing cwd", async (provider, event) => {
    const logsDir = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "cli-resume-"));
    directories.push(logsDir);
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    const appendTaskLog = vi.fn();
    const cliTools = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
    const runtime = createCliRuntimeTools({
      db: {},
      logsDir,
      buildAgentArgs: cliTools.buildAgentArgs,
      clearCliOutputDedup: vi.fn(),
      normalizeStreamChunk: (chunk) => chunk.toString(),
      shouldSkipDuplicateCliOutput: () => false,
      broadcast: vi.fn(),
      TASK_RUN_IDLE_TIMEOUT_MS: 0,
      TASK_RUN_HARD_TIMEOUT_MS: 0,
      killPidTree: vi.fn(),
      appendTaskLog,
      activeProcesses: new Map(),
      createSubtaskFromCli: vi.fn(),
      completeSubtaskFromCli: vi.fn(),
    });
    const executionSession: TaskExecutionSessionState = {
      sessionId: "task-session",
      taskId: "test",
      agentId: "same-agent",
      provider,
      openedAt: 100,
      lastTouchedAt: 100,
    };
    runtime.spawnCliAgent(
      "test",
      provider,
      "resume prompt",
      logsDir,
      path.join(logsDir, "test.log"),
      undefined,
      undefined,
      {
        executionSession,
        resumeSessionId: "native-session",
      },
    );
    const line = JSON.stringify(event) + "\n";
    child.stdout!.emit("data", Buffer.from(line.slice(0, 9)));
    child.stdout!.emit("data", Buffer.from(line.slice(9)));
    child.stdout!.emit("data", Buffer.from(line));
    child.emit("close", 0);

    expect(executionSession.nativeSessionId).toBe("native-session");
    expect(appendTaskLog).toHaveBeenCalledWith("test", "system", "Run process pid: 12345");
    expect(appendTaskLog.mock.calls.filter((call) => call[2].startsWith("Execution session state: "))).toHaveLength(1);
    expect(appendTaskLog).toHaveBeenCalledWith(
      "test",
      "system",
      expect.stringContaining('"nativeSessionId":"native-session"'),
    );
    expect(spawn).toHaveBeenCalledWith(
      provider,
      cliTools.buildAgentArgs(provider, undefined, undefined, { resumeSessionId: "native-session" }).slice(1),
      expect.objectContaining({ cwd: logsDir }),
    );
    await vi.waitFor(() => expect(fs.readFileSync(path.join(logsDir, "test.log"), "utf8")).toContain(line));
  });
});
