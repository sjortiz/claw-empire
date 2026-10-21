import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { formatMeetingVerdict, type MeetingVerdict } from "../lib/meeting-verdict";
import TerminalPanel from "./TerminalPanel";
const mocks = vi.hoisted(() => ({ getTaskMeetingMinutes: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getTaskMeetingMinutes: mocks.getTaskMeetingMinutes,
}));
afterEach(cleanup);

describe("meeting minutes verdict display", () => {
  it.each([
    [{ verdict: "approve", blocking_items: [], non_blocking_notes: ["Monitor risk later"] }, "Approve"],
    [{ verdict: "revise", blocking_items: ["Repair parser"], non_blocking_notes: [] }, "Revise"],
    [{ verdict: "revise", blocking_items: [], non_blocking_notes: [] }, "Approve"],
  ] as [MeetingVerdict, string][])("shows effective verdict for %j", async (verdict, label) => {
    mocks.getTaskMeetingMinutes.mockResolvedValue([
      {
        id: "meeting",
        task_id: "task",
        meeting_type: "review",
        round: 1,
        status: "completed",
        started_at: 0,
        entries: [
          {
            id: 1,
            seq: 1,
            speaker_name: "Dev",
            role_label: "Leader",
            content: `#47 blocks downstream work with risk.\n${formatMeetingVerdict(verdict)}`,
          },
        ],
      },
    ]);
    render(
      <I18nProvider language="en">
        <TerminalPanel
          taskId="task"
          task={undefined}
          agent={undefined}
          agents={[]}
          initialTab="minutes"
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText(label === "Revise" ? /Revise · 1 blocking/ : label)).toBeInTheDocument();
    expect(screen.queryByText(/```json/)).not.toBeInTheDocument();
    if (verdict.non_blocking_notes.length) expect(screen.getByText("Note: Monitor risk later")).toBeInTheDocument();
    if (verdict.blocking_items.length) expect(screen.getByText("Blocking: Repair parser")).toBeInTheDocument();
  });
});
