import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppView } from "./useAppView";
import { useAppViewEffects } from "./useAppViewEffects";
import type { View } from "./types";

vi.mock("../api", () => ({
  getCliStatus: async () => ({}),
  getMeetingPresence: async () => [],
}));

const views: View[] = ["office", "agents", "dashboard", "tasks", "skills", "settings"];

async function traverse(direction: "back" | "forward") {
  await act(async () => {
    const popped = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history[direction]();
    await popped;
  });
}

describe("useAppView", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(views)("restores %s from a shared URL and after a refresh", (view) => {
    window.history.replaceState(null, "", `/?view=${view}`);
    const first = renderHook(useAppView);
    expect(first.result.current[0]).toBe(view);
    first.unmount();

    const refreshed = renderHook(useAppView);
    expect(refreshed.result.current[0]).toBe(view);
    expect(new URLSearchParams(window.location.search).get("view")).toBe(view);
  });

  it.each([null, "", "unknown", "Tasks", "toString", "__proto__"])("falls back to Office for %s", (value) => {
    window.history.replaceState(null, "", value === null ? "/" : `/?view=${value}`);
    const { result } = renderHook(useAppView);
    expect(result.current[0]).toBe("office");
    expect(window.location.search).toBe("?view=office");
  });

  it("writes navigation to the URL and traverses all six views without adding history entries", async () => {
    const { result } = renderHook(useAppView);
    const initialLength = window.history.length;
    for (const view of views.slice(1)) {
      act(() => result.current[1](view));
      expect(result.current[0]).toBe(view);
      expect(window.location.search).toBe(`?view=${view}`);
    }
    const navigatedLength = window.history.length;
    expect(navigatedLength).toBe(initialLength + 5);
    // Re-selecting the current view must not create a duplicate entry.
    act(() => result.current[1]("settings"));
    expect(window.history.length).toBe(navigatedLength);

    for (const view of views.slice(0, -1).reverse()) {
      await traverse("back");
      expect(result.current[0]).toBe(view);
      expect(window.location.search).toBe(`?view=${view}`);
    }
    for (const view of views.slice(1)) {
      await traverse("forward");
      expect(result.current[0]).toBe(view);
    }
    expect(window.history.length).toBe(navigatedLength);
  });

  it("normalizes invalid history entries to Office when navigating back", async () => {
    window.history.replaceState(null, "", "/?view=invalid");
    window.history.pushState(null, "", "/?view=tasks");
    const { result } = renderHook(useAppView);
    await traverse("back");
    expect(result.current[0]).toBe("office");
    expect(window.location.search).toBe("?view=office");
    await traverse("forward");
    expect(result.current[0]).toBe("tasks");
  });

  it("preserves unrelated query parameters, path, hash and history state", () => {
    window.history.replaceState({ retained: true }, "", "/app?other=keep&view=invalid#anchor");
    const { result } = renderHook(useAppView);
    expect(window.location.href).toContain("/app?other=keep&view=office#anchor");
    act(() => result.current[1]("skills"));
    expect(window.location.href).toContain("/app?other=keep&view=skills#anchor");
    expect(window.history.state).toEqual({ retained: true });
  });

  it("does not add history entries on Strict Mode mount or refresh", () => {
    window.history.replaceState(null, "", "/?view=tasks");
    const initialLength = window.history.length;
    const { result, unmount } = renderHook(useAppView, {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    expect(result.current[0]).toBe("tasks");
    expect(window.history.length).toBe(initialLength);
    unmount();
    renderHook(useAppView);
    expect(window.history.length).toBe(initialLength);
  });

  it.each(["oauth=github", "oauth_error=access_denied"])(
    "keeps legacy Settings callbacks working for %s and refreshes on Settings",
    (callback) => {
      window.history.replaceState({ retained: true }, "", `/app?view=tasks&other=keep&${callback}#anchor`);
      const initialLength = window.history.length;
      const setOauthResult = vi.fn();
      const setters = {
        setOauthResult,
        setCliStatus: vi.fn(),
        setMobileNavOpen: vi.fn(),
        setMeetingPresence: vi.fn(),
      };
      const { result, unmount } = renderHook(() => {
        const [view, setView] = useAppView();
        useAppViewEffects({ view, setView, cliStatus: null, ...setters });
        return view;
      });
      expect(result.current).toBe("settings");
      expect(setOauthResult).toHaveBeenCalledWith({
        provider: callback.startsWith("oauth=") ? "github" : null,
        error: callback.startsWith("oauth_error=") ? "access_denied" : null,
      });
      expect(window.location.href).toContain("/app?view=settings&other=keep#anchor");
      expect(window.history.state).toEqual({ retained: true });
      expect(window.history.length).toBe(initialLength);
      unmount();
      expect(renderHook(useAppView).result.current[0]).toBe("settings");
    },
  );
});
