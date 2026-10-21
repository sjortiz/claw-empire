import { describe, expect, it } from "vitest";
import { createProjectContextTools } from "./project-context-tools.ts";
import { initializeCollabLanguagePolicy } from "../../routes/collab/language-policy.ts";

const LEGACY_POLICIES = [
  "[Execution Continuity / 실행 연속성]",
  "- Continue from the latest state without self-introduction or kickoff narration / 자기소개·착수 멘트 없이 최신 상태에서 바로 이어서 작업",
  "- Reuse prior codebase understanding and read only files needed for this delta / 기존 코드베이스 이해를 재사용하고 이번 변경에 필요한 파일만 확인",
  "- Focus on unresolved checklist items and produce concrete diffs first / 미해결 체크리스트 중심으로 즉시 코드 변경부터 진행",
  "[Git Workflow Guardrail / Git 워크플로우 가드레일]",
  "- Do NOT run git merge/rebase/cherry-pick/push during task execution. Merge is performed only by the system after final review approval / 작업 실행 중 git merge/rebase/cherry-pick/push 금지. 병합은 최종 리뷰 승인 후 시스템이 수행",
  "[MVP Code Review Policy / 코드 리뷰 정책]",
  "- CRITICAL/HIGH: fix immediately / 즉시 수정",
  "- MEDIUM/LOW: warning report only, no code changes / 경고 보고서만, 코드 수정 금지",
].join("\n");

const LEGACY_WARNING_OVERRIDE =
  "- Exception override: User explicitly requested warning-level fixes for this task. You may fix the requested MEDIUM/LOW items / 예외: 이 작업에서 사용자 요청 시 MEDIUM/LOW도 해당 요청 범위 내에서 수정 가능";

function createTools(initialLanguage: string) {
  let language = initialLanguage;
  const db = {
    prepare: () => ({
      get: () => ({ value: JSON.stringify(language) }),
      all: () => [],
    }),
  };
  const { getPreferredLanguage } = initializeCollabLanguagePolicy({ db });
  return {
    ...createProjectContextTools({
      db,
      getPreferredLanguage,
      isGitRepo: () => false,
      taskWorktrees: new Map(),
    }),
    setLanguage: (nextLanguage: string) => {
      language = nextLanguage;
    },
  };
}

describe("task execution policy language", () => {
  it.each([false, true])("emits English-only guardrails, with warning override %s", (allowWarningFix) => {
    const { buildTaskExecutionPrompt } = createTools("en");
    const prompt = buildTaskExecutionPrompt(["Complete the English task.", null, ""], { allowWarningFix });

    expect(prompt).toMatch(/^Complete the English task\.\n\[Execution Continuity\]/);
    expect(prompt).not.toMatch(/[\uAC00-\uD7A3\u3131-\u318E]/u);
    expect(prompt).toContain("Do NOT run git merge/rebase/cherry-pick/push during task execution.");
    expect(prompt).toContain("- CRITICAL/HIGH: fix immediately");
    expect(prompt).toContain("- MEDIUM/LOW: warning report only, no code changes");
    expect(prompt.includes("Exception override:")).toBe(allowWarningFix);
  });

  it.each(["ko", "ja", "zh"])("preserves the existing %s policy wording verbatim", (language) => {
    const { buildTaskExecutionPrompt } = createTools(language);
    expect(buildTaskExecutionPrompt([])).toBe(LEGACY_POLICIES);
    expect(buildTaskExecutionPrompt([], { allowWarningFix: true })).toBe(
      `${LEGACY_POLICIES}\n${LEGACY_WARNING_OVERRIDE}`,
    );
  });

  it("reads the current setting for each execution and preserves authored task content", () => {
    const tools = createTools("ko");
    expect(tools.buildTaskExecutionPrompt([])).toBe(LEGACY_POLICIES);
    tools.setLanguage("en");
    const taskContent = "User-authored content: 한국어 메모";
    const prompt = tools.buildTaskExecutionPrompt([taskContent]);
    expect(prompt).toContain(`${taskContent}\n[Execution Continuity]`);
    expect(prompt.slice(taskContent.length)).not.toMatch(/[\uAC00-\uD7A3\u3131-\u318E]/u);
    tools.setLanguage("ko");
    expect(tools.buildTaskExecutionPrompt([])).toBe(LEGACY_POLICIES);
  });
});
