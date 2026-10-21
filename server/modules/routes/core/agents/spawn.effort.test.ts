import { describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { registerAgentSpawnRoute } from "./spawn.ts";

vi.mock("../../../../gateway/client.ts", () => ({ notifyTaskStatus: vi.fn() }));

describe("agent task spawn effort", () => {
  it.each([
    { provider: "claude", global: undefined, override: null, expected: undefined },
    { provider: "claude", global: "high", override: null, expected: "high" },
    { provider: "claude", global: "high", override: "low", expected: "low" },
    { provider: "codex", global: "high", override: "medium", expected: "medium" },
    { provider: "api", global: undefined, override: "none", expected: "none" },
    { provider: "claude", global: undefined, override: null, expected: undefined, cancelled: true },
  ])(
    "uses $provider global=$global override=$override at the task launcher",
    async ({ provider, global, override, expected, cancelled }) => {
      const agent = {
        id: "agent-1",
        name: "Worker",
        role: "senior",
        cli_provider: provider,
        cli_model: null,
        cli_reasoning_level: override,
        current_task_id: "task-1",
        department_id: null,
        api_provider_id: "ollama",
        api_model: "qwen3.5:9b",
      };
      const task = {
        id: "task-1",
        title: "Task",
        description: "Implement",
        workflow_pack_key: "development",
        project_path: "/work/project",
      };
      let handler: ((req: unknown, res: unknown) => void) | undefined;
      const spawnCliAgent = vi.fn(async () => {
        if (cancelled) throw Object.assign(new Error("cli_launch_cancelled"), { code: "CLI_LAUNCH_CANCELLED" });
        return { on: vi.fn(), pid: 42 };
      });
      const run = vi.fn();
      const launchApiProviderAgent = vi.fn();
      const context = {
        app: {
          post: (_path: string, fn: typeof handler) => {
            handler = fn;
          },
        },
        db: {
          prepare: (sql: string) => ({
            get: () => (sql.includes("FROM tasks") ? task : agent),
            run,
          }),
        },
        logsDir: "/work/logs",
        createWorktree: () => "/work/project-isolated",
        ensureClaudeMd: vi.fn(),
        ensureTaskExecutionSession: () => ({ sessionId: "session-1", agentId: "agent-1", provider }),
        buildTaskExecutionPrompt: () => "Prompt",
        hasExplicitWarningFixRequest: () => false,
        getDeptRoleConstraint: () => "",
        normalizeTextField: () => "",
        appendTaskLog: vi.fn(),
        getProviderModelConfig: () => ({ [provider]: { model: "configured-model", reasoningLevel: global } }),
        getNextHttpAgentPid: () => 42,
        nowMs: () => 0,
        broadcast: vi.fn(),
        launchApiProviderAgent,
        launchHttpAgent: vi.fn(),
        spawnCliAgent,
        handleTaskRunComplete: vi.fn(),
        resolveLang: () => "en",
        pickL: () => "Complete task",
        l: vi.fn(),
      } as unknown as RuntimeContext;
      registerAgentSpawnRoute(context);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handler!({ params: { id: "agent-1" } }, res);
      if (cancelled) {
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({ error: "cli_launch_cancelled" });
        expect(run).not.toHaveBeenCalled();
        expect(context.handleTaskRunComplete).not.toHaveBeenCalled();
        return;
      }
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, pid: 42 }));
      if (provider === "api") {
        expect(spawnCliAgent).not.toHaveBeenCalled();
        expect(launchApiProviderAgent).toHaveBeenCalledWith(
          "task-1",
          "ollama",
          "qwen3.5:9b",
          "Prompt",
          "/work/project-isolated",
          expect.any(String),
          expect.any(AbortController),
          42,
          undefined,
          expected,
        );
      } else {
        expect(spawnCliAgent).toHaveBeenCalledWith(
          "task-1",
          provider,
          "Prompt",
          "/work/project-isolated",
          expect.any(String),
          "configured-model",
          expected,
        );
      }
    },
  );
});
