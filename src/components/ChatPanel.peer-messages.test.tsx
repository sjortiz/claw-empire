import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Agent, Message } from "../types";
import { ChatPanel } from "./ChatPanel";

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    name_ko: name,
    department_id: null,
    role: "junior",
    cli_provider: "codex",
    avatar_emoji: "",
    personality: null,
    status: "working",
    current_task_id: null,
    stats_tasks_done: 0,
    stats_xp: 0,
    created_at: 0,
  };
}

const aria = agent("dev-agent", "Aria");
const hawk = agent("qa-agent", "Hawk");
const sage = agent("planning-agent", "Sage");
const agents = [aria, hawk, sage];

function message(id: string, senderId: string, receiverId: string, content: string): Message {
  return {
    id,
    sender_type: "agent",
    sender_id: senderId,
    receiver_type: "agent",
    receiver_id: receiverId,
    content,
    message_type: "chat",
    task_id: null,
    created_at: 1000,
  };
}

const messages: Message[] = [
  message("incoming", hawk.id, aria.id, "QA will reuse your branch."),
  message("outgoing", aria.id, hawk.id, "The implementation is ready."),
  message("unrelated", hawk.id, sage.id, "Planning-only coordination."),
  {
    ...message("ceo-request", "ceo", aria.id, "Please report progress."),
    sender_type: "ceo",
  },
  message("ceo-reply", aria.id, "ceo", "Progress report for CEO."),
  {
    ...message("announcement", "ceo", "all", "Company announcement."),
    sender_type: "ceo",
    receiver_type: "all",
    receiver_id: null,
    message_type: "announcement",
  },
];

function renderPanel(selectedAgent: Agent | null, language = "en", panelMessages = messages) {
  return render(
    <I18nProvider language={language}>
      <ChatPanel
        selectedAgent={selectedAgent}
        messages={panelMessages}
        agents={agents}
        onSendMessage={() => {}}
        onSendAnnouncement={() => {}}
        onSendDirective={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>,
  );
}

describe("ChatPanel peer messages", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it.each([
    ["ko", "Hawk · Aria에게", "Aria · Hawk에게"],
    ["en", "Hawk · To Aria", "Aria · To Hawk"],
    ["ja", "Hawk · Aria宛て", "Aria · Hawk宛て"],
    ["zh", "Hawk · 发给 Aria", "Aria · 发给 Hawk"],
  ])("shows incoming and outgoing notes with recipients (%s)", (language, incomingLabel, outgoingLabel) => {
    renderPanel(aria, language);

    expect(screen.getByText("QA will reuse your branch.")).toBeInTheDocument();
    expect(screen.getByText("The implementation is ready.")).toBeInTheDocument();
    expect(screen.getByText(incomingLabel)).toBeInTheDocument();
    expect(screen.getByText(outgoingLabel)).toBeInTheDocument();
    expect(screen.queryByText("Planning-only coordination.")).not.toBeInTheDocument();
    expect(screen.getByText("Please report progress.")).toBeInTheDocument();
    expect(screen.getByText("Progress report for CEO.")).toBeInTheDocument();
    expect(screen.getByText("Company announcement.")).toBeInTheDocument();
    expect(screen.queryByText(/To ceo/)).not.toBeInTheDocument();
  });

  it("keeps private peer notes out of the announcement view", () => {
    renderPanel(null);

    expect(screen.getByText("Company announcement.")).toBeInTheDocument();
    expect(screen.queryByText("QA will reuse your branch.")).not.toBeInTheDocument();
    expect(screen.queryByText("The implementation is ready.")).not.toBeInTheDocument();
  });

  it("shows the recipient ID when its agent is missing from the current list", () => {
    renderPanel(aria, "en", [message("missing-recipient", aria.id, "archived-agent", "Reuse the completed work.")]);

    expect(screen.getByText("Aria · To archived-agent")).toBeInTheDocument();
  });
});
