import { describe, expect, it } from "vitest";
import { createCliTools } from "./cli-tools.ts";

function createTools() {
  return createCliTools({
    nowMs: () => 0,
    cliOutputDedupWindowMs: 1000,
  });
}

describe("buildAgentArgs", () => {
  it.each(["claude", "codex", "gemini", "kimi", "opencode"])(
    "resumes %s by its exact native session ID",
    (provider) => {
      const args = createTools().buildAgentArgs(provider, "model", "high", { resumeSessionId: "session-123" });
      if (provider === "codex") {
        expect(args.slice(args.indexOf("exec"))).toEqual(["exec", "resume", "--json", "session-123", "-"]);
      } else {
        const flag = provider === "kimi" || provider === "opencode" ? "--session" : "--resume";
        expect(args.slice(args.indexOf(flag), args.indexOf(flag) + 2)).toEqual([flag, "session-123"]);
      }
      expect(args).not.toContain("--last");
      expect(args).not.toContain("--continue");
    },
  );

  it.each(["", "--last", "a\nb", "a b"])("ignores invalid native session ID %j", (resumeSessionId) => {
    expect(createTools().buildAgentArgs("codex", undefined, undefined, { resumeSessionId })).toEqual(
      createTools().buildAgentArgs("codex"),
    );
  });

  it("claude noTools mode uses --tools= without empty argv", () => {
    const tools = createTools();
    const args = tools.buildAgentArgs("claude", "claude-opus-4-6", undefined, { noTools: true });

    expect(args).toContain("--tools=");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("");
  });
});

describe("reasoning effort arguments", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("passes Claude effort %s in task and meeting modes", (level) => {
    for (const noTools of [false, true]) {
      const args = createTools().buildAgentArgs("claude", "sonnet", level, { noTools });
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", level]);
      expect(args).not.toContain("-c");
    }
  });

  it.each([undefined, "", "none", "minimal", "HIGH", "high --debug"])(
    "does not send unsupported or unset Claude effort %s",
    (level) => {
      expect(createTools().buildAgentArgs("claude", undefined, level)).not.toContain("--effort");
    },
  );

  it("keeps the existing Codex argument format", () => {
    expect(createTools().buildAgentArgs("codex", "gpt-5", "high")).toContain('model_reasoning_effort="high"');
    expect(createTools().buildAgentArgs("codex")).not.toContain("-c");
  });

  it.each(["gemini", "kimi", "opencode"])("ignores effort for unsupported CLI provider %s", (provider) => {
    expect(createTools().buildAgentArgs(provider, undefined, "high")).toEqual(createTools().buildAgentArgs(provider));
  });
});
