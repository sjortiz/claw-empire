import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mapWorkflowDecisionItemsLocalized } from "../app/decision-inbox";
import DecisionInboxModal from "./DecisionInboxModal";

describe("automatically started review inbox information", () => {
  it.each([
    ["en", "Started automatically. No CEO action is needed."],
    ["ko", "자동으로 시작되었습니다. CEO의 조치가 필요하지 않습니다."],
    ["ja", "自動で開始されました。CEO の操作は不要です。"],
    ["zh", "已自动启动，无需 CEO 操作。"],
  ] as const)("opens retained information without showing a pending decision in %s", (language, information) => {
    const items = mapWorkflowDecisionItemsLocalized(
      [
        {
          id: "project-review-auto:task-1",
          kind: "project_review_ready",
          informational: true,
          created_at: 1000,
          summary: "Review meeting started automatically (setting)",
          project_id: "project-1",
          project_name: "Review automation",
          project_path: "/workspace/review",
          task_id: "task-1",
          task_title: "Review automation",
          options: [],
        },
      ],
      language,
    );
    render(
      <DecisionInboxModal
        open
        loading={false}
        items={items}
        agents={[]}
        busyKey={null}
        uiLanguage={language}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onReplyOption={vi.fn()}
        onOpenChat={vi.fn()}
      />,
    );
    expect(screen.getByText(information)).toBeInTheDocument();
    expect(screen.getByText("Review meeting started automatically (setting)")).toBeInTheDocument();
    expect(screen.queryByText(/consolidating opinions|의견 취합중|意見を集約中|正在汇总意见/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start Team-Lead Meeting/ })).not.toBeInTheDocument();
  });
});
