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
