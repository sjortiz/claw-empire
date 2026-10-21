import { useEffect, useState } from "react";
import type { SettingsTab } from "./types";

const STORAGE_KEY = "climpire.settingsTab";
const TABS: readonly SettingsTab[] = ["general", "cli", "oauth", "api", "gateway"];

export function useSettingsTab(hasOAuthResult: boolean) {
  const [tab, setTab] = useState<SettingsTab>(() => {
    if (hasOAuthResult) return "oauth";
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (TABS.includes(stored as SettingsTab)) return stored as SettingsTab;
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
    return "general";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, tab);
    } catch {
      // Tab navigation still works when storage is unavailable.
    }
  }, [tab]);

  return [tab, setTab] as const;
}
