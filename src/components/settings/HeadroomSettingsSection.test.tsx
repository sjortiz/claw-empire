import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHeadroomStatus } from "../../api/headroom";
import { DEFAULT_HEADROOM, type HeadroomSettings, type HeadroomStatus } from "../../lib/headroom";
import { DEFAULT_SETTINGS } from "../../types";
import GeneralSettingsTab from "./GeneralSettingsTab";
import HeadroomSettingsSection from "./HeadroomSettingsSection";
import { HEADROOM_COPY } from "./headroom-copy";
import type { LocalSettings, Locale } from "./types";

vi.mock("../../api/headroom", () => ({ getHeadroomStatus: vi.fn() }));
const healthy: HeadroomStatus = {
  state: "healthy",
  reason: null,
  checkedAt: 1_790_000_000_000,
  version: "0.37.0",
  tokensSaved: 1284301,
  capabilities: { claude: true, codex: false, api: true },
};
const enabled = { ...DEFAULT_HEADROOM, enabled: true };
function Form({
  initial = DEFAULT_HEADROOM,
  savedValue = DEFAULT_HEADROOM,
  locale = "en",
  onSave = vi.fn(),
}: {
  initial?: HeadroomSettings;
  savedValue?: HeadroomSettings;
  locale?: Locale;
  onSave?: (form: LocalSettings) => void;
}) {
  const [form, setForm] = useState<LocalSettings>({ ...DEFAULT_SETTINGS, language: locale, headroom: initial });
  return (
    <GeneralSettingsTab
      t={(messages) => messages[locale]}
      form={form}
      setForm={setForm}
      saved={false}
      savedHeadroom={savedValue}
      onSave={() => onSave(form)}
    />
  );
}

beforeEach(() => {
  vi.mocked(getHeadroomStatus).mockResolvedValue(healthy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Headroom settings", () => {
  it("keeps default disabled choices, allows URL setup, and does not poll", () => {
    const save = vi.fn();
    render(<Form onSave={save} />);
    expect(screen.getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    fireEvent.change(screen.getByLabelText("Proxy URL"), { target: { value: "http://localhost:9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        headroom: expect.objectContaining({
          enabled: false,
          proxyUrl: "http://localhost:9999",
          providers: DEFAULT_HEADROOM.providers,
        }),
      }),
    );
    expect(getHeadroomStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Enter a proxy URL."],
    ["ftp://localhost", "Use an http:// or https:// URL."],
    ["http://user:secret@localhost", "Do not put a username or password in the URL."],
    ["http://localhost?secret=value", "Remove the query string or # fragment."],
  ])("blocks invalid URL %s even while off", (url, message) => {
    const save = vi.fn();
    render(<Form onSave={save} />);
    const input = screen.getByLabelText("Proxy URL");
    fireEvent.change(input, { target: { value: url } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("normalizes /v1 on blur and resets a custom URL", () => {
    render(<Form />);
    const input = screen.getByLabelText("Proxy URL");
    fireEvent.change(input, { target: { value: " http://localhost:9999/v1/ " } });
    fireEvent.blur(input);
    expect(input).toHaveValue("http://localhost:9999");
    expect(screen.getByText(/Saved as http:\/\/localhost:9999/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(input).toHaveValue(DEFAULT_HEADROOM.proxyUrl);
  });

  it("shows saved routing and savings while draft changes await save", async () => {
    render(<Form initial={enabled} savedValue={enabled} />);
    await screen.findByText("Proxy compression tokens saved:");
    expect(screen.getByText("1,284,301")).toBeInTheDocument();
    expect(screen.getAllByText("Next run: Headroom")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Codex" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Custom upstreams and Ollama connect directly/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(screen.getByText("Unsaved changes · status shows the saved URL")).toBeInTheDocument();
    expect(screen.getAllByText("Next run: Headroom")).toHaveLength(2);
    expect(getHeadroomStatus).toHaveBeenCalledTimes(1);
  });

  it("renders unavailable fallback and sanitized reason without disabling controls", async () => {
    vi.mocked(getHeadroomStatus).mockResolvedValue({ ...healthy, state: "unavailable", reason: "health_timeout" });
    render(<Form initial={enabled} savedValue={enabled} />);
    await screen.findByText("No response within 1 second");
    expect(screen.getAllByText("Next run: direct · proxy unavailable")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("1,284,301")).not.toBeInTheDocument();
  });

  it.each([0, null, -1, Number.NaN])("handles savings %s without changing healthy state", async (tokensSaved) => {
    vi.mocked(getHeadroomStatus).mockResolvedValue({ ...healthy, tokensSaved });
    render(<Form initial={enabled} savedValue={enabled} />);
    await screen.findAllByText("Healthy · v0.37.0");
    expect(screen.getByText(tokensSaved === 0 ? "0" : "Savings not reported by this proxy")).toBeInTheDocument();
  });

  it("reports status errors without exposing raw server errors", async () => {
    vi.mocked(getHeadroomStatus).mockRejectedValue(new Error("private url and credential"));
    render(<Form initial={enabled} savedValue={enabled} />);
    await screen.findAllByText("Could not load Headroom status.");
    expect(screen.queryByText(/private url/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled();
  });

  it.each(["en", "ko", "ja", "zh"] as const)("localizes controls and limits in %s", (locale) => {
    render(<Form locale={locale} />);
    expect(screen.getByRole("heading", { name: HEADROOM_COPY["Section title"][locale] })).toBeInTheDocument();
    expect(screen.getByLabelText(HEADROOM_COPY["URL label"][locale])).toBeInTheDocument();
    expect(screen.getByText(HEADROOM_COPY["API coverage"][locale])).toBeInTheDocument();
    expect(screen.getByText(HEADROOM_COPY["Codex unverified"][locale])).toBeInTheDocument();
  });

  it("aborts an in-flight check when saved URL changes and ignores stale responses", async () => {
    let completeOld: (value: HeadroomStatus) => void = () => {};
    vi.mocked(getHeadroomStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeOld = resolve;
        }),
    );
    const props = {
      t: (messages: Record<Locale, string>) => messages.en,
      value: enabled,
      savedValue: enabled,
      locale: "en" as const,
      onChange: vi.fn(),
    };
    const { rerender } = render(<HeadroomSettingsSection {...props} />);
    const originalSignal = vi.mocked(getHeadroomStatus).mock.calls[0][0]!;
    rerender(<HeadroomSettingsSection {...props} savedValue={{ ...enabled, proxyUrl: "http://localhost:9999" }} />);
    expect(originalSignal.aborted).toBe(true);
    await screen.findAllByText("Healthy · v0.37.0");
    await act(async () => {
      completeOld({ ...healthy, state: "unavailable", reason: "health_timeout" });
    });
    expect(screen.queryByText("No response within 1 second")).not.toBeInTheDocument();
    expect(screen.getAllByText("Healthy · v0.37.0")).toHaveLength(2);
  });

  it("polls only while visible and aborts on saved URL change and unmount", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const props = {
      t: (messages: Record<Locale, string>) => messages.en,
      value: enabled,
      savedValue: enabled,
      locale: "en" as const,
      onChange,
    };
    const { rerender, unmount } = render(<HeadroomSettingsSection {...props} />);
    await act(async () => {});
    expect(getHeadroomStatus).toHaveBeenCalledTimes(1);
    const firstSignal = vi.mocked(getHeadroomStatus).mock.calls[0][0]!;
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(getHeadroomStatus).toHaveBeenCalledTimes(2);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getHeadroomStatus).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(getHeadroomStatus).toHaveBeenCalledTimes(3);
    vi.mocked(getHeadroomStatus).mockImplementation(() => new Promise(() => {}));
    rerender(<HeadroomSettingsSection {...props} savedValue={{ ...enabled, proxyUrl: "http://localhost:9999" }} />);
    const lastSignal = vi.mocked(getHeadroomStatus).mock.calls.at(-1)![0]!;
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    unmount();
    expect(lastSignal.aborted).toBe(true);
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    visibility.mockRestore();
  });
});
