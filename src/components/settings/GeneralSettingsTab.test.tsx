import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type UiLanguage } from "../../types";
import GeneralSettingsTab from "./GeneralSettingsTab";
import type { LocalSettings } from "./types";

function SettingsForm({ language, onSave }: { language: UiLanguage; onSave: (form: LocalSettings) => void }) {
  const [form, setForm] = useState<LocalSettings>({ ...DEFAULT_SETTINGS, mergePolicy: undefined, language });
  return (
    <GeneralSettingsTab
      t={(messages) => messages[language]}
      form={form}
      setForm={setForm}
      saved={false}
      onSave={() => onSave(form)}
    />
  );
}

describe("GeneralSettingsTab merge policy", () => {
  it.each([
    ["en", "Merge policy after approval", "Keep branch for manual review", "Save"],
    ["ko", "승인 후 병합 정책", "수동 검토를 위해 브랜치 유지", "저장"],
    ["ja", "承認後のマージ方針", "手動レビュー用にブランチを保持", "保存"],
    ["zh", "批准后的合并策略", "保留分支以供手动审查", "保存"],
  ] as const)("defaults legacy settings to auto and saves manual in %s", (language, label, manualLabel, saveLabel) => {
    const onSave = vi.fn();
    render(<SettingsForm language={language} onSave={onSave} />);

    const selector = screen.getByRole("combobox", { name: label });
    expect(selector).toHaveValue("auto");
    expect(screen.getByRole("option", { name: manualLabel })).toHaveValue("manual");
    expect(selector).toHaveAccessibleDescription();

    fireEvent.change(selector, { target: { value: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mergePolicy: "manual" }));

    fireEvent.change(selector, { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ mergePolicy: "auto" }));
  });
});

describe("GeneralSettingsTab review automation", () => {
  it.each([
    ["en", "Start review meetings automatically", "Apply all review items automatically", "Save"],
    ["ko", "리뷰 회의 자동 시작", "리뷰 항목 모두 자동 반영", "저장"],
    ["ja", "レビュー会議を自動開始", "レビュー項目をすべて自動反映", "保存"],
    ["zh", "自动启动评审会议", "自动应用全部评审项", "保存"],
  ] as const)("defaults both settings off and saves each independently in %s", (language, start, apply, save) => {
    const onSave = vi.fn();
    render(<SettingsForm language={language} onSave={onSave} />);

    const startToggle = screen.getByRole("button", { name: start });
    const applyToggle = screen.getByRole("button", { name: apply });
    expect(startToggle).toHaveAttribute("aria-pressed", "false");
    expect(applyToggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(startToggle);
    fireEvent.click(screen.getByRole("button", { name: save }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ reviewAutoStart: true, reviewAutoApply: false }));

    fireEvent.click(applyToggle);
    fireEvent.click(screen.getByRole("button", { name: save }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ reviewAutoStart: true, reviewAutoApply: true }));
  });
});
