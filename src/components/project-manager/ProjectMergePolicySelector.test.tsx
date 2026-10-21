import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectMergePolicySelector from "./ProjectMergePolicySelector";
import type { I18nTextMap } from "./types";

describe("project merge policy selector", () => {
  it.each([
    ["ko", "병합 정책", "전역 설정 사용", "자동 병합", "수동 검토를 위해 브랜치 유지"],
    ["en", "Merge policy", "Use global setting", "Auto-merge", "Keep branch for manual review"],
    ["ja", "マージ方針", "全体設定を使用", "自動マージ", "手動レビュー用にブランチを保持"],
    ["zh", "合并策略", "使用全局设置", "自动合并", "保留分支供手动审查"],
  ] as const)("shows the inherited and explicit options in %s", (language, label, inherited, automatic, manual) => {
    render(
      <ProjectMergePolicySelector
        t={(messages) => messages[language]}
        value={null}
        onChange={vi.fn()}
        disabled={false}
      />,
    );
    expect(screen.getByRole("combobox", { name: new RegExp(label) })).toHaveValue("inherit");
    expect(screen.getByRole("option", { name: inherited })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: automatic })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: manual })).toBeInTheDocument();
  });

  it("maps the inherit option to null and preserves each explicit policy", () => {
    const onChange = vi.fn();
    const t = (messages: I18nTextMap) => messages.en;
    const { rerender } = render(
      <ProjectMergePolicySelector t={t} value="manual" onChange={onChange} disabled={false} />,
    );
    const selector = screen.getByRole("combobox");
    expect(selector).toHaveValue("manual");
    for (const policy of ["auto", "manual", "inherit"]) {
      fireEvent.change(selector, { target: { value: policy } });
      expect(onChange).toHaveBeenLastCalledWith(policy === "inherit" ? null : policy);
    }

    rerender(<ProjectMergePolicySelector t={t} value="manual" onChange={onChange} disabled />);
    expect(selector).toBeDisabled();
  });
});
