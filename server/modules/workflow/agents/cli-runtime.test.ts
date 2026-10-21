import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeTools } from "./cli-runtime.ts";
import { createCliTools } from "../core/cli-tools.ts";

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
    await runtime.spawnCliAgent("test", provider, "prompt", logsDir, logPath, "model-name", level);
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
      expect.arrayContaining(cliTools.buildAgentArgs(provider, "model-name", level).slice(1)),
      expect.objectContaining({ cwd: logsDir }),
    );
  });
});
