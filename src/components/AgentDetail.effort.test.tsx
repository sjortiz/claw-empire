import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Agent } from "../types";
import * as api from "../api";
import AgentDetail from "./AgentDetail";

vi.mock("../api", () => ({
  getSettings: vi.fn(),
  getApiProviders: vi.fn(),
  getCliModels: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (m: Record<string, string>) => m.en, language: "en" }),
  localeName: (_: string, value: { name: string }) => value.name,
}));
vi.mock("./AgentAvatar", () => ({ default: () => <div /> }));
vi.mock("./agent-detail/AgentDetailTabContent", () => ({ default: () => <div /> }));

function mount(overrides: Partial<Agent> = {}) {
  const agent = {
    id: "agent-1",
    name: "Effort Agent",
    name_ko: "",
    department_id: null,
    role: "junior",
    cli_provider: "claude",
    avatar_emoji: "A",
    personality: null,
    status: "idle",
    current_task_id: null,
    stats_tasks_done: 0,
    stats_xp: 0,
    created_at: 1,
    ...overrides,
  } as Agent;
  return render(
    <AgentDetail
      agent={agent}
      agents={[agent]}
      department={undefined}
      departments={[]}
      tasks={[]}
      subAgents={[]}
      subtasks={[]}
      activeOfficeWorkflowPack="development"
      onClose={vi.fn()}
      onChat={vi.fn()}
      onAssignTask={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    providerModelConfig: { claude: { model: "", reasoningLevel: "high" } },
  });
  vi.mocked(api.getApiProviders).mockResolvedValue([{ id: "local", type: "ollama" }] as Awaited<
    ReturnType<typeof api.getApiProviders>
  >);
  vi.mocked(api.getCliModels).mockResolvedValue({ claude: [], codex: [], gemini: [] });
  vi.mocked(api.updateAgent).mockResolvedValue(undefined);
});

describe("AgentDetail effort editing", () => {
  it("shows the inherited Claude setting and saves an explicit override without a model list", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTitle("Click to change CLI"));
    const effort = screen.getByRole("combobox", { name: "Agent reasoning effort" });
    await screen.findByRole("option", { name: "Default (Settings: high)" });
    expect(effort).toHaveValue("");
    await user.selectOptions(effort, "max");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateAgent).toHaveBeenCalledWith("agent-1", expect.objectContaining({ cli_reasoning_level: "max" }));
  });

  it("keeps saved effort when switching CLI providers", async () => {
    const user = userEvent.setup();
    mount({ cli_reasoning_level: "max" });
    await user.click(screen.getByTitle("Click to change CLI"));
    await user.selectOptions(screen.getAllByRole("combobox")[0], "gemini");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ cli_provider: "gemini", cli_reasoning_level: "max" }),
    );
  });

  it("distinguishes API thinking off from unset and saves assigned API agents", async () => {
    const user = userEvent.setup();
    mount({ cli_provider: "api", api_provider_id: "local", api_model: "qwen3.5:9b" });
    await user.click(screen.getByTitle("Click to change CLI"));
    const effort = screen.getByRole("combobox", { name: "Agent reasoning effort" });
    await waitFor(() => expect(effort).toBeEnabled());
    expect(effort).toHaveValue("");
    await user.selectOptions(effort, "none");
    expect(screen.getByText("Thinking is disabled for this agent.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ api_model: "qwen3.5:9b", cli_reasoning_level: "none" }),
    );
  });

  it("preserves and explains an unsupported API override", async () => {
    vi.mocked(api.getApiProviders).mockResolvedValue([{ id: "local", type: "anthropic" }] as Awaited<
      ReturnType<typeof api.getApiProviders>
    >);
    const user = userEvent.setup();
    mount({ cli_provider: "api", api_provider_id: "local", api_model: "claude-api", cli_reasoning_level: "future" });
    await user.click(screen.getByTitle("Click to change CLI"));
    const effort = screen.getByRole("combobox", { name: "Agent reasoning effort" });
    expect(effort).toBeDisabled();
    expect(effort).toHaveValue("future");
    expect(screen.getByText(/The saved value is kept/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(api.updateAgent).toHaveBeenCalledWith("agent-1", expect.objectContaining({ cli_reasoning_level: "future" }));
  });
});
