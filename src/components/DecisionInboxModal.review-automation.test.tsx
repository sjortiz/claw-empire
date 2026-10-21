import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mapWorkflowDecisionItemsLocalized } from "../app/decision-inbox";
import DecisionInboxModal from "./DecisionInboxModal";

describe("automatically started review inbox information", () => {
  it.each([
    ["en", "Review Meeting Auto-Started (Notice)"],
    ["ko", "리뷰 회의 자동 시작 (알림)"],
    ["ja", "レビュー会議の自動開始（通知）"],
    ["zh", "评审会议已自动启动（通知）"],
  ] as const)("opens an informational notice and acknowledges it in %s", (language, information) => {
    const items = mapWorkflowDecisionItemsLocalized(
      [
        {
          id: "review-auto-started:notice-1",
          kind: "review_auto_started",
          created_at: 1000,
          summary: "Review meeting started automatically (setting)",
          project_id: "project-1",
          project_name: "Review automation",
          project_path: "/workspace/review",
          task_id: "task-1",
          task_title: "Review automation",
          options: [{ number: 1, action: "acknowledge_review_auto_start" }],
        },
      ],
      language,
    );
    const onReplyOption = vi.fn();
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
        onReplyOption={onReplyOption}
        onOpenChat={vi.fn()}
      />,
    );
    expect(screen.getByText(information)).toBeInTheDocument();
    expect(screen.getByText("Review meeting started automatically (setting)")).toBeInTheDocument();
    expect(screen.queryByText(/consolidating opinions|의견 취합중|意見を集約中|正在汇总意见/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start Team-Lead Meeting/ })).not.toBeInTheDocument();
    const acknowledge = { en: "Acknowledge", ko: "확인", ja: "確認", zh: "确认" }[language];
    fireEvent.click(screen.getByRole("button", { name: new RegExp(acknowledge) }));
    expect(onReplyOption).toHaveBeenCalledExactlyOnceWith(items[0], 1);
  });
});
