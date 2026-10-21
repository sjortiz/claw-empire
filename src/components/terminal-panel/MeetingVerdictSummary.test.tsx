import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import MeetingVerdictSummary from "./MeetingVerdictSummary";

function statement(verdict: string, blocking_items: string[] = [], non_blocking_notes: string[] = []) {
  return `#47 blocks downstream observability work; risk is documented.\n\n\`\`\`json\n${JSON.stringify({
    verdict,
    blocking_items,
    non_blocking_notes,
  })}\n\`\`\``;
}

function renderVerdict(content: string, language = "en") {
  return render(
    <I18nProvider language={language}>
      <MeetingVerdictSummary content={content} />
    </I18nProvider>,
  );
}

describe("meeting minutes verdicts", () => {
  it("shows structured approval despite risk and blocks keywords, with non-blocking notes", () => {
    renderVerdict(statement("approve", [], ["Track observability risk in the project memo."]));

    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Blocking items: 0")).toBeInTheDocument();
    expect(screen.getByText("Non-blocking notes")).toBeInTheDocument();
    expect(screen.getByText("Track observability risk in the project memo.")).toBeInTheDocument();
    expect(screen.queryByText("Revise")).not.toBeInTheDocument();
  });

  it("shows the revision verdict and its blocking items", () => {
    renderVerdict(statement("revise", ["Fix verdict persistence before approval."]));

    expect(screen.getByText("Revise")).toBeInTheDocument();
    expect(screen.getByText("Blocking items: 1")).toBeInTheDocument();
    expect(screen.getByText("Fix verdict persistence before approval.")).toBeInTheDocument();
  });

  it("shows approval when revise has no blocking items", () => {
    renderVerdict(statement("revise"));

    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.queryByText("Revise")).not.toBeInTheDocument();
  });

  it("does not invent a verdict for historical unstructured minutes", () => {
    const { container } = renderVerdict("Approval: this blocks downstream work; risk is documented.");

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["ko", "승인", "차단 항목: 0", "참고 사항"],
    ["ja", "承認", "ブロッキング項目: 0", "非ブロッキングの注記"],
    ["zh", "批准", "阻塞项: 0", "非阻塞备注"],
  ])("localizes the verdict summary in %s", (language, approval, blockerCount, notesLabel) => {
    renderVerdict(statement("approve", [], ["Follow-up note."]), language);

    expect(screen.getByText(approval)).toBeInTheDocument();
    expect(screen.getByText(blockerCount)).toBeInTheDocument();
    expect(screen.getByText(notesLabel)).toBeInTheDocument();
  });
});
