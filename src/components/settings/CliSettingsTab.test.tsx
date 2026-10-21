import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type CliStatusMap, type CliModelInfo } from "../../types";
import CliSettingsTab from "./CliSettingsTab";
import type { LocalSettings, Locale } from "./types";

const readyStatus = { installed: true, authenticated: true, version: "1.0", authHint: "" };
const cliStatus: CliStatusMap = {
  claude: readyStatus,
  codex: readyStatus,
  gemini: readyStatus,
  opencode: readyStatus,
  kimi: readyStatus,
  copilot: readyStatus,
  antigravity: readyStatus,
  api: readyStatus,
};
const claudeModels = [{ slug: "claude-first" }, { slug: "claude-second" }];

function Harness({
  effort = "",
  language = "en",
  loading = false,
  models = { claude: claudeModels },
  persist = vi.fn(),
}: {
  effort?: string;
  language?: Locale;
  loading?: boolean;
  models?: Record<string, CliModelInfo[]>;
  persist?: (settings: LocalSettings) => void;
}) {
  const [form, setForm] = useState<LocalSettings>({
    ...DEFAULT_SETTINGS,
    language,
    providerModelConfig: {
      claude: { model: "claude-first", subModel: "claude-first", reasoningLevel: effort },
      codex: { model: "codex-first", reasoningLevel: "high" },
    },
  });
  return (
    <CliSettingsTab
      t={(messages) => messages[language]}
      cliStatus={cliStatus}
      cliModels={models}
      cliModelsLoading={loading}
      form={form}
      setForm={setForm}
      persistSettings={persist}
      onRefresh={vi.fn()}
    />
  );
}

describe("CliSettingsTab Claude reasoning effort", () => {
  it("saves all five explicit effort levels and restores the empty CLI default", async () => {
    const user = userEvent.setup();
    const persist = vi.fn();
    render(<Harness persist={persist} />);
    const select = screen.getByRole("combobox", { name: "Claude reasoning effort" });

    expect(select).toHaveValue("");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect(within(select).getByRole("option", { name: "CLI default (no --effort)" })).toBeInTheDocument();
    for (const effort of ["low", "medium", "high", "xhigh", "max", ""]) {
      await user.selectOptions(select, effort);
      expect(select).toHaveValue(effort);
      expect(persist.mock.lastCall?.[0].providerModelConfig.claude.reasoningLevel).toBe(effort);
    }
  });

  it("keeps effort when changing Claude main and sub-agent models", async () => {
    const user = userEvent.setup();
    const persist = vi.fn();
    render(<Harness effort="max" persist={persist} />);
    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0], "claude-second");
    await user.selectOptions(selects[2], "claude-second");

    expect(screen.getByRole("combobox", { name: "Claude reasoning effort" })).toHaveValue("max");
    expect(persist.mock.lastCall?.[0].providerModelConfig.claude).toEqual({
      model: "claude-second",
      subModel: "claude-second",
      reasoningLevel: "max",
    });
  });

  it.each([false, true])("offers static effort options without model data (loading=%s)", (loading) => {
    render(<Harness effort="high" loading={loading} models={{}} />);
    expect(screen.getByRole("combobox", { name: "Claude reasoning effort" })).toHaveValue("high");
  });

  it("preserves an unknown stored effort as a custom option", () => {
    render(<Harness effort="future-effort" />);
    const select = screen.getByRole("combobox", { name: "Claude reasoning effort" });
    expect(select).toHaveValue("future-effort");
    expect(within(select).getByRole("option", { name: "future-effort (custom)" })).toBeInTheDocument();
  });

  it.each([
    ["ko", "Claude 추론 레벨", "CLI 기본값 (--effort 생략)", "max (최대 깊이, 가장 느림)"],
    ["en", "Claude reasoning effort", "CLI default (no --effort)", "max (Maximum depth, slowest)"],
    ["ja", "Claude 推論レベル", "CLI デフォルト (--effort なし)", "max (最大の深さ、最も低速)"],
    ["zh", "Claude 推理级别", "CLI 默认（不传 --effort）", "max (最大深度、最慢)"],
  ] as const)("localizes labels and options in %s", (language, label, defaultLabel, maxLabel) => {
    render(<Harness language={language} />);
    const select = screen.getByRole("combobox", { name: label });
    expect(within(select).getByRole("option", { name: defaultLabel })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: maxLabel })).toBeInTheDocument();
  });

  it("continues to select the new model's default effort for Codex", async () => {
    const user = userEvent.setup();
    const persist = vi.fn();
    render(
      <Harness
        persist={persist}
        models={{
          claude: [],
          codex: [
            {
              slug: "codex-first",
              defaultReasoningLevel: "high",
              reasoningLevels: [{ effort: "high", description: "High" }],
            },
            {
              slug: "codex-second",
              defaultReasoningLevel: "low",
              reasoningLevels: [{ effort: "low", description: "Low" }],
            },
          ],
        }}
      />,
    );
    const modelSelect = screen
      .getAllByRole("combobox")
      .find((select) => within(select).queryByRole("option", { name: "codex-second" }));
    await user.selectOptions(modelSelect!, "codex-second");
    expect(persist.mock.lastCall?.[0].providerModelConfig.codex).toEqual({
      model: "codex-second",
      reasoningLevel: "low",
    });
  });
});
