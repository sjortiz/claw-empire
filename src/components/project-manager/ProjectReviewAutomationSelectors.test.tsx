import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectReviewAutomationSettings } from "../ReviewAutomationSettings";

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
    ["ko", "검토 회의 자동 시작", "모든 검토 항목 자동 적용", "전역 설정 사용", "켜짐", "꺼짐"],
    ["ja", "レビュー会議を自動で開始", "すべてのレビュー項目を自動で適用", "全体設定を使用", "オン", "オフ"],
    ["zh", "自动开始评审会议", "自动应用所有评审项", "使用全局设置", "开启", "关闭"],
  ] as const)("renders inherited and explicit settings in %s", (language, start, apply, inherit, on, off) => {
    render(
      <ProjectReviewAutomationSettings
        t={(messages) => messages[language]}
        autoStart={null}
        autoApply={false}
        onAutoStartChange={vi.fn()}
        onAutoApplyChange={vi.fn()}
        disabled={false}
      />,
    );
    const startSelector = screen.getByRole("combobox", { name: start });
    const applySelector = screen.getByRole("combobox", { name: apply });
    expect(startSelector).toHaveValue("inherit");
    expect(applySelector).toHaveValue("off");
    for (const selector of [startSelector, applySelector]) {
      expect(selector).toHaveAccessibleDescription();
      expect(within(selector).getByRole("option", { name: inherit })).toHaveValue("inherit");
      expect(within(selector).getByRole("option", { name: on })).toHaveValue("on");
      expect(within(selector).getByRole("option", { name: off })).toHaveValue("off");
    }
  });

  it("keeps null, false, and true distinct for each control and disables read-only fields", () => {
    const onAutoStartChange = vi.fn();
    const onAutoApplyChange = vi.fn();
    const props = {
      t: (messages: { en: string }) => messages.en,
      autoStart: true,
      autoApply: false,
      onAutoStartChange,
      onAutoApplyChange,
      disabled: false,
    };
    const { rerender } = render(<ProjectReviewAutomationSettings {...props} />);
    const controls = screen.getAllByRole("combobox");
    for (const [index, onChange] of [onAutoStartChange, onAutoApplyChange].entries()) {
      for (const value of ["off", "on", "inherit"]) {
        fireEvent.change(controls[index], { target: { value } });
        expect(onChange).toHaveBeenLastCalledWith(value === "inherit" ? null : value === "on");
      }
    }
    rerender(<ProjectReviewAutomationSettings {...props} disabled />);
    controls.forEach((control) => expect(control).toBeDisabled());
  });
});
