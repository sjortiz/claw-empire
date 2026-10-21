import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsTab } from "./types";
import { useSettingsTab } from "./useSettingsTab";

describe("useSettingsTab", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each<SettingsTab>(["general", "cli", "oauth", "api", "gateway"])(
    "keeps the %s tab when Settings is remounted or refreshed",
    (tab) => {
      const first = renderHook(() => useSettingsTab(false));
      act(() => first.result.current[1](tab));
      first.unmount();
      expect(renderHook(() => useSettingsTab(false)).result.current[0]).toBe(tab);
    },
  );

  it("falls back to General for an invalid saved tab", () => {
    window.localStorage.setItem("climpire.settingsTab", "invalid");
    expect(renderHook(() => useSettingsTab(false)).result.current[0]).toBe("general");
  });

  it("gives OAuth callbacks priority over the saved tab", () => {
    window.localStorage.setItem("climpire.settingsTab", "api");
    const { result, unmount } = renderHook(() => useSettingsTab(true));
    expect(result.current[0]).toBe("oauth");
    unmount();
    expect(renderHook(() => useSettingsTab(false)).result.current[0]).toBe("oauth");
  });

  it("allows navigation when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const { result } = renderHook(() => useSettingsTab(false));
    expect(result.current[0]).toBe("general");
    act(() => result.current[1]("cli"));
    expect(result.current[0]).toBe("cli");
  });
});
