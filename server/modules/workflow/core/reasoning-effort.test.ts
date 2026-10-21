import { describe, expect, it } from "vitest";
import { resolveCliReasoningLevel } from "./reasoning-effort.ts";

describe("resolveCliReasoningLevel", () => {
  it.each(["claude", "codex"])("uses agent override before the %s global default", (provider) => {
    expect(resolveCliReasoningLevel(provider, "low", "high")).toBe("low");
    expect(resolveCliReasoningLevel(provider, null, "high")).toBe("high");
    expect(resolveCliReasoningLevel(provider, "", "high")).toBe("high");
    expect(resolveCliReasoningLevel(provider, null, undefined)).toBeUndefined();
  });

  it("omits stale overrides incompatible with Claude and falls back to a valid global setting", () => {
    expect(resolveCliReasoningLevel("claude", "none", "xhigh")).toBe("xhigh");
    expect(resolveCliReasoningLevel("claude", "minimal", "invalid")).toBeUndefined();
    expect(resolveCliReasoningLevel("claude", "max", "invalid")).toBe("max");
  });

  it("preserves existing Codex levels and other providers' default resolution", () => {
    expect(resolveCliReasoningLevel("codex", "minimal", "high")).toBe("minimal");
    expect(resolveCliReasoningLevel("gemini", "low", "high")).toBe("high");
    expect(resolveCliReasoningLevel("gemini", "low", undefined)).toBeUndefined();
  });
});
