import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneShotRunner } from "./one-shot-runner.ts";
import { createCliTools } from "./cli-tools.ts";
import type { AgentRow } from "./conversation-types.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture(globalEffort?: string) {
  const logsDir = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "meeting-effort-"));
  directories.push(logsDir);
  const tools = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
  const executeApiProviderAgent = vi.fn(async (...args: unknown[]) => {
    (args[7] as (text: string) => void)("API response");
  });
  const runner = createOneShotRunner({
    db: { prepare: () => ({ get: () => undefined }) },
    logsDir,
    broadcast: vi.fn(),
    getProviderModelConfig: () => ({ claude: { model: "sonnet", reasoningLevel: globalEffort } }),
    executeApiProviderAgent,
    executeCopilotAgent: vi.fn(),
    executeAntigravityAgent: vi.fn(),
    killPidTree: vi.fn(),
    prettyStreamJson: (raw) => raw,
    getPreferredLanguage: () => "en",
    normalizeStreamChunk: tools.normalizeStreamChunk,
    hasStructuredJsonLines: tools.hasStructuredJsonLines,
    normalizeConversationReply: (raw) => raw,
    buildAgentArgs: tools.buildAgentArgs,
    withCliPathFallback: tools.withCliPathFallback,
  });
  const agent: AgentRow = {
    id: "meeting-agent",
    name: "Planner",
    name_ko: "기획",
    role: "team_leader",
    personality: null,
    status: "idle",
    department_id: null,
    current_task_id: null,
    avatar_emoji: "",
    cli_provider: "claude",
    oauth_account_id: null,
    api_provider_id: null,
    api_model: null,
    cli_model: null,
    cli_reasoning_level: null,
  };
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stdout.write("Meeting response");
      child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  });
  return { logsDir, runner, agent, executeApiProviderAgent };
}

describe("one-shot reasoning effort", () => {
  it.each([
    { global: undefined, override: null, expected: undefined },
    { global: "high", override: null, expected: "high" },
    { global: "high", override: "low", expected: "low" },
    { global: "high", override: "none", expected: "high" },
  ])(
    "threads Claude global=$global override=$override into meeting argv and logs",
    async ({ global, override, expected }) => {
      const { logsDir, runner, agent } = fixture(global);
      agent.cli_reasoning_level = override;
      const result = await runner.runAgentOneShot(agent, "Meeting prompt", { noTools: true });
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(result).toEqual({ text: "Meeting response" });
      expect(args).toContain("--tools=");
      const log = fs.readFileSync(path.join(logsDir, fs.readdirSync(logsDir)[0]), "utf8");
      if (expected) {
        expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", expected]);
        expect(log).toContain(`provider=claude | model=sonnet | effort=${expected}`);
      } else {
        expect(args).not.toContain("--effort");
        expect(log).toBe("Meeting response");
      }
    },
  );

  it("threads thinking-off to API one-shot and meeting runs", async () => {
    const { runner, agent, executeApiProviderAgent } = fixture();
    agent.cli_provider = "api";
    agent.api_provider_id = "ollama-provider";
    agent.api_model = "qwen3.5:9b";
    agent.cli_reasoning_level = "none";
    expect(await runner.runAgentOneShot(agent, "Meeting prompt", { noTools: true })).toEqual({ text: "API response" });
    expect(executeApiProviderAgent).toHaveBeenCalledWith(
      "Meeting prompt",
      expect.any(String),
      expect.anything(),
      expect.any(AbortSignal),
      undefined,
      "ollama-provider",
      "qwen3.5:9b",
      expect.any(Function),
      "none",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
