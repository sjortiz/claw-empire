import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectReviewAutomationSelectors from "./ProjectReviewAutomationSelectors";

describe("project review automation overrides", () => {
  it.each([
    [
      "en",
      "Start review meetings automatically",
      "Apply all review items automatically",
      "Use global setting",
      "On",
      "Off",
    ],
    ["ko", "리뷰 회의 자동 시작", "모든 리뷰 항목 자동 적용", "전역 설정 사용", "켜기", "끄기"],
    ["ja", "レビュー会議を自動で開始", "すべてのレビュー項目を自動で適用", "全体設定を使用", "有効", "無効"],
    ["zh", "自动启动评审会议", "自动应用所有评审项", "使用全局设置", "开启", "关闭"],
  ] as const)("renders inherited and explicit settings in %s", (language, start, apply, inherit, on, off) => {
    render(
      <ProjectReviewAutomationSelectors
        t={(messages) => messages[language]}
        reviewMeetingAutoStart={null}
        reviewItemsAutoApply={false}
        onChange={vi.fn()}
        disabled={false}
      />,
    );
    const startSelector = screen.getByRole("combobox", { name: start });
    const applySelector = screen.getByRole("combobox", { name: apply });
    expect(startSelector).toHaveValue("inherit");
    expect(applySelector).toHaveValue("false");
    for (const selector of [startSelector, applySelector]) {
      expect(selector).toHaveAccessibleDescription();
      expect(within(selector).getByRole("option", { name: inherit })).toHaveValue("inherit");
      expect(within(selector).getByRole("option", { name: on })).toHaveValue("true");
      expect(within(selector).getByRole("option", { name: off })).toHaveValue("false");
    }
  });

  it("keeps null, false, and true distinct for each control and disables read-only fields", () => {
    const onChange = vi.fn();
    const props = {
      t: (messages: { en: string }) => messages.en,
      reviewMeetingAutoStart: true,
      reviewItemsAutoApply: false,
      onChange,
      disabled: false,
    };
    const { rerender } = render(<ProjectReviewAutomationSelectors {...props} />);
    const controls = screen.getAllByRole("combobox");
    for (const [index, key] of ["reviewMeetingAutoStart", "reviewItemsAutoApply"].entries()) {
      for (const value of ["false", "true", "inherit"]) {
        fireEvent.change(controls[index], { target: { value } });
        expect(onChange).toHaveBeenLastCalledWith(key, value === "inherit" ? null : value === "true");
      }
    }
    rerender(<ProjectReviewAutomationSelectors {...props} disabled />);
    controls.forEach((control) => expect(control).toBeDisabled());
  });
});
