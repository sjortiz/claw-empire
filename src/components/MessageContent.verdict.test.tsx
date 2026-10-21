import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { formatMeetingVerdict } from "../lib/meeting-verdict";
import MessageContent from "./MessageContent";

afterEach(cleanup);
describe("meeting verdicts in chat and summaries", () => {
  it("separates approval from risk rationale and collapses informational notes without showing blockers", () => {
    const content = `#47 blocks downstream work with risk.\n${formatMeetingVerdict({ verdict: "approve", blocking_items: ["not a revision request"], non_blocking_notes: ["Monitor logs", "Monitor latency", "Monitor traces", "Monitor capacity"] })}`;
    render(
      <I18nProvider language="en">
        <MessageContent content={content} />
      </I18nProvider>,
    );
    expect(screen.getByText("APPROVE")).toBeInTheDocument();
    expect(screen.getByText("#47 blocks downstream work with risk.")).toBeInTheDocument();
    expect(screen.queryByText(/blocking_items|non_blocking_notes|not a revision request/)).not.toBeInTheDocument();
    expect(screen.getByText("Notes (4)").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Note: Monitor logs")).not.toHaveClass("text-amber-300");
  });
  it.each([
    ["en", "Waiting for this leader"],
    ["ko", "이 팀장의"],
    ["ja", "このリーダー"],
    ["zh", "等待此负责人"],
  ] as const)("shows a neutral missing-verdict state in %s", (language, copy) => {
    render(
      <I18nProvider language={language}>
        <MessageContent
          content={formatMeetingVerdict({ verdict: "no_verdict", blocking_items: [], non_blocking_notes: [] })}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("NO VERDICT")).toHaveClass("text-slate-400");
    expect(screen.getByText(new RegExp(copy))).toBeInTheDocument();
    expect(screen.queryByText("APPROVE")).not.toBeInTheDocument();
  });
});
