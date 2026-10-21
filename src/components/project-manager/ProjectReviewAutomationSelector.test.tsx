import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectReviewAutomationSelector from "./ProjectReviewAutomationSelector";
import type { I18nTextMap } from "./types";

const INHERIT = { review_auto_start: null, review_auto_apply: null };

describe("project review automation selector", () => {
  it.each([
    ["ko", "리뷰 회의 자동 시작", "리뷰 항목 모두 자동 반영", "전역 설정 사용", "켜기", "끄기"],
    [
      "en",
      "Start review meetings automatically",
      "Apply all review items automatically",
      "Use global setting",
      "On",
      "Off",
    ],
    ["ja", "レビュー会議を自動開始", "レビュー項目をすべて自動反映", "全体設定を使用", "オン", "オフ"],
    ["zh", "自动启动评审会议", "自动应用全部评审项", "使用全局设置", "开启", "关闭"],
  ] as const)("shows both overrides with inherit, on and off in %s", (language, start, apply, inherit, on, off) => {
    render(
      <ProjectReviewAutomationSelector
        t={(messages) => messages[language]}
        value={INHERIT}
        onChange={vi.fn()}
        disabled={false}
      />,
    );
    for (const label of [start, apply]) {
      expect(screen.getByRole("combobox", { name: new RegExp(label) })).toHaveValue("inherit");
    }
    for (const option of [inherit, on, off]) {
      expect(screen.getAllByRole("option", { name: option })).toHaveLength(2);
    }
  });

  it("changes one override at a time and maps inherit back to null", () => {
    const onChange = vi.fn();
    const t = (messages: I18nTextMap) => messages.en;
    const { rerender } = render(
      <ProjectReviewAutomationSelector
        t={t}
        value={{ review_auto_start: "on", review_auto_apply: null }}
        onChange={onChange}
        disabled={false}
      />,
    );
    const [startSelect, applySelect] = screen.getAllByRole("combobox");
    expect(startSelect).toHaveValue("on");

    fireEvent.change(applySelect, { target: { value: "on" } });
    expect(onChange).toHaveBeenLastCalledWith({ review_auto_start: "on", review_auto_apply: "on" });
    fireEvent.change(startSelect, { target: { value: "inherit" } });
    expect(onChange).toHaveBeenLastCalledWith({ review_auto_start: null, review_auto_apply: null });

    rerender(<ProjectReviewAutomationSelector t={t} value={INHERIT} onChange={onChange} disabled />);
    expect(startSelect).toBeDisabled();
    expect(applySelect).toBeDisabled();
  });
});
