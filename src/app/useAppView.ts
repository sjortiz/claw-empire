import { useCallback, useEffect, useState } from "react";
import type { View } from "./types";

const VIEWS: readonly View[] = ["office", "agents", "dashboard", "tasks", "skills", "settings"];

function readView(): View {
  const params = new URLSearchParams(window.location.search);
  // OAuth redirects predate view URLs and must still open Settings.
  if (params.get("oauth") || params.get("oauth_error")) return "settings";
  const view = params.get("view");
  return VIEWS.includes(view as View) ? (view as View) : "office";
}

function viewUrl(view: View): URL {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  return url;
}

export function useAppView() {
  const [view, setCurrentView] = useState<View>(readView);

  useEffect(() => {
    const restoreView = () => {
      const next = readView();
      // Normalize the current entry without adding history on load or traversal.
      window.history.replaceState(window.history.state, "", viewUrl(next));
      setCurrentView(next);
    };
    restoreView();
    window.addEventListener("popstate", restoreView);
    return () => window.removeEventListener("popstate", restoreView);
  }, []);

  const setView = useCallback((next: View) => {
    const url = viewUrl(next);
    if (url.href !== window.location.href) {
      window.history.pushState(window.history.state, "", url);
    }
    setCurrentView(next);
  }, []);

  return [view, setView] as const;
}
