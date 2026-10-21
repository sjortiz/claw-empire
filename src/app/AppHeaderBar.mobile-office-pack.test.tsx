import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { I18nProvider } from "../i18n";
import AppHeaderBar from "./AppHeaderBar";

function createBaseProps(): ComponentProps<typeof AppHeaderBar> {
  return {
    currentView: "office" as const,
    connected: true,
    viewTitle: "Office",
    tasksPrimaryLabel: "Tasks",
    decisionLabel: "Decisions",
    decisionInboxLoading: false,
    decisionInboxCount: 0,
    agentStatusLabel: "Agent Status",
    reportLabel: "Reports",
    announcementLabel: "Announcement",
    roomManagerLabel: "Room Manager",
    officePackControl: null,
    theme: "dark" as const,
    mobileHeaderMenuOpen: true,
    onOpenMobileNav: vi.fn(),
    onOpenTasks: vi.fn(),
    onOpenDecisionInbox: vi.fn(),
    onOpenAgentStatus: vi.fn(),
    onOpenReportHistory: vi.fn(),
    onOpenAnnouncement: vi.fn(),
    onOpenRoomManager: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleMobileHeaderMenu: vi.fn(),
    onCloseMobileHeaderMenu: vi.fn(),
  };
}

describe("AppHeaderBar mobile office pack selector", () => {
  it("모바일 더보기 메뉴에서 오피스팩을 변경할 수 있다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCloseMobileHeaderMenu = vi.fn();
    const props = createBaseProps();
    props.officePackControl = {
      label: "Office Pack",
      value: "development",
      onChange,
      options: [
        { key: "development", label: "Development", summary: "", slug: "DEV", accent: 0 },
        { key: "report", label: "Report", summary: "", slug: "REP", accent: 1 },
      ],
    };
    props.onCloseMobileHeaderMenu = onCloseMobileHeaderMenu;

    render(<AppHeaderBar {...props} />);

    const selector = document.getElementById("mobile-office-pack-selector") as HTMLSelectElement | null;
    expect(selector).not.toBeNull();
    if (!selector) return;
    await user.selectOptions(selector, "report");

    expect(onChange).toHaveBeenCalledWith("report");
    expect(onCloseMobileHeaderMenu).toHaveBeenCalled();
  });

  it("오피스팩 컨트롤이 없으면 모바일 메뉴에 셀렉터를 표시하지 않는다", () => {
    const props = createBaseProps();
    render(<AppHeaderBar {...props} />);

    expect(screen.queryByLabelText("Office Pack")).not.toBeInTheDocument();
  });
});

describe("AppHeaderBar i18n", () => {
  it("renders English theme toggle title and mobile menu label when language is en", () => {
    const props = createBaseProps();
    render(
      <I18nProvider language="en">
        <AppHeaderBar {...props} />
      </I18nProvider>,
    );

    expect(screen.getByTitle("Light mode")).toBeInTheDocument();
    expect(screen.getByLabelText("More menu")).toBeInTheDocument();
    expect(screen.queryByTitle("라이트 모드")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("더보기 메뉴")).not.toBeInTheDocument();
  });

  it("keeps Korean labels when language is ko", () => {
    const props = createBaseProps();
    props.theme = "light";
    render(
      <I18nProvider language="ko">
        <AppHeaderBar {...props} />
      </I18nProvider>,
    );

    expect(screen.getByTitle("다크 모드")).toBeInTheDocument();
    expect(screen.getByLabelText("더보기 메뉴")).toBeInTheDocument();
  });
});
