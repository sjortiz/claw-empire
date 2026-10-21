import { describe, expect, it } from "vitest";
import { buildMessengerReportSummary } from "./messenger-report.ts";

const agent = { name: "Aria", name_ko: "아리아", avatar_emoji: "A" };
const content = [
  "reporting completion for 'Demo'. 한국어 메모",
  "| # | Issue | Severity |",
  "| 1 | Fix verified | HIGH |",
  "total: 1/1",
].join("\n");

describe("messenger report language", () => {
  it("uses the English setting for generated headings and names even when report content contains Korean", () => {
    const result = buildMessengerReportSummary(agent, content, "en");
    expect(result).toBe(
      [
        "Task Completion Summary",
        "A Aria report: sharing completion result for 'Demo'.",
        "Key Results:",
        "1. [HIGH] Fix verified",
        "Progress: total: 1/1",
        "See Claw-Empire chat for full details.",
      ].join("\n"),
    );
    expect(result).not.toMatch(/[\uAC00-\uD7A3\u3131-\u318E]/u);
  });

  it("retains Korean wording when Korean is selected", () => {
    expect(buildMessengerReportSummary(agent, content, "ko")).toBe(
      [
        "업무 완료 요약",
        "A 아리아 보고: 'Demo' 완료 결과를 전달드려요.",
        "핵심 결과:",
        "1. [HIGH] Fix verified",
        "진행 요약: total: 1/1",
        "상세 내용은 Claw-Empire 채팅창에서 확인하세요.",
      ].join("\n"),
    );
  });

  it("retains Japanese and Chinese intro wording", () => {
    expect(buildMessengerReportSummary(agent, content, "ja")).toContain(
      "A Aria から報告: 'Demo' の完了結果を共有します。",
    );
    expect(buildMessengerReportSummary(agent, content, "zh")).toContain("A Aria 汇报：'Demo' 已完成，现发送结果。");
  });

  it("preserves authored content and report items verbatim", () => {
    expect(buildMessengerReportSummary(agent, "사용자 문장", "en")).toBe("사용자 문장");
    expect(buildMessengerReportSummary(agent, content.replace("Fix verified", "사용자가 작성한 결과"), "en")).toContain(
      "사용자가 작성한 결과",
    );
  });
});
