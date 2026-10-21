/** Deterministic planning inputs. Project context can disambiguate an action,
 * but must never turn an announcement or documentation request into code work. */
export interface ImplementationUnit {
  key: string;
  reference?: string;
  description: string;
  requiresTests: boolean;
  separateBranch: boolean;
}
export interface ImplementationIntent {
  requiresImplementation: boolean;
  implementationUnits: ImplementationUnit[];
}

const action =
  /\b(?:fix|implement|build|develop|patch|refactor|repair|resolve|change|modify|update|add|write|create|open)\b|수정|구현|개발|고쳐|고치|추가|修正|実装|開発|追加|修改|实现|修复|开发|新增/i;
const codeTarget =
  /\b(?:code|bug|issues?|pull requests?|PR|tests?|API|UI|app|application|feature|endpoint|component|function|handler|frontend|backend|login|authentication|pagination|crash|exception|database|router|regression|repository|repo)\b|\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|css|vue|svelte)\b|#\d+|코드|버그|이슈|테스트|기능|コード|バグ|機能|テスト|代码|缺陷|功能|测试/i;
const supportingTarget =
  /\b(?:documentation|docs?|readme|specifications?|specs?|report|research|analysis|announcement|meeting|readiness|checklist|evidence|proposal|plan)\b|\.md\b|문서|명세|보고|회의|조사|仕様|文書|会議|調査|文档|规范|报告|会议|研究/i;
const nonExecution =
  /^(?:please\s+)?(?:announce|report|research|investigate|analy[sz]e|discuss|summari[sz]e|review|explain|document|describe|draft|prepare|plan|write\s+(?:a\s+)?(?:report|specification|spec|plan))\b|^(?:공지|보고|조사)|^(?:調査|報告)|^(?:研究|报告)/i;

export function directiveTextFromTask(title: string, description?: string | null): string {
  if (!description) return title;
  // Stored project goals, round-goal repeats and meeting memos are background,
  // not fresh directives (especially important for docs-only follow-up rounds).
  const ceo = description.match(/^\[CEO\]\s*([\s\S]*?)(?=\n\[(?:PROJECT|ROUND GOAL)|$)/);
  return ceo?.[1]?.trim() || `${title}\n${description}`;
}

export function implementationIntentFromTask(title: string, description?: string | null): ImplementationIntent {
  const context = [...(description ?? "").matchAll(/^\[PROJECT(?: CORE GOAL| CONTEXT)?\]\s*(.*)$/gm)]
    .map((match) => match[1])
    .join("\n");
  return detectImplementationIntent(directiveTextFromTask(title, description), context);
}

export function detectImplementationIntent(directiveText: string, projectContext = ""): ImplementationIntent {
  const directive = directiveText
    .replace(/^\s*\$\s*/, "")
    .split(/\n(?:What happened|Background|History|For example|Example|Context)\s*[:(]/i)[0];
  const clauses = directive
    .split(
      /(?:[.!?;]\s+|\n|\b(?:and|then|also)\b(?=\s+(?:fix|implement|build|develop|patch|refactor|repair|resolve|change|modify|update|add|write|create|open|document|review|research|report|prepare|draft)\b))/i,
    )
    .map((s) => s.trim().replace(/^(?:please|can you|could you|we need to|I want you to|I need you to)\s+/i, ""))
    .filter(Boolean);
  const executionClauses = clauses.filter((clause) => {
    if (!action.test(clause) || nonExecution.test(clause)) return false;
    if (
      /^[a-z]/i.test(clause) &&
      !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(clause) &&
      !/^(?:(?:please|can you|could you|we need to|I want you to)\s+)?(?:fix|implement|build|develop|patch|refactor|repair|resolve|change|modify|update|add|write|create|open)\b/i.test(
        clause,
      )
    )
      return false;
    if (
      /^(?:please\s+)?(?:fix|implement|build|develop|patch|repair|change|modify|update|add|write|create)\s+(?:(?:the|a|an)\s+)?(?:documentation|docs?|readme|specifications?|specs?|reports?|research|announcements?|meetings?|readiness|checklists?|evidence|proposals?|plans?)\b/i.test(
        clause,
      )
    )
      return false;
    // Supporting deliverables cannot establish code intent, even when their
    // subject is an API, code fix, PR or implementation. Mixed action clauses
    // are considered independently above.
    if (supportingTarget.test(clause)) return false;
    if (codeTarget.test(clause)) return true;
    if (
      /\b(?:implement|build|develop|refactor)\s+\S+|구현|개발|実装|開発|实现|开发/i.test(clause) &&
      !supportingTarget.test(clause)
    )
      return true;
    return (
      /\b(?:fix|patch|repair|change|modify|update)\s+(?:it|this|that)\b/i.test(clause) &&
      codeTarget.test(projectContext)
    );
  });
  if (executionClauses.length === 0) return { requiresImplementation: false, implementationUnits: [] };

  const references = [
    ...new Set(
      [...executionClauses.join(" ").matchAll(/#(\d+)\b|\/(?:issues|pull)\/(\d+)\b|\b(?:issue|PR)\s+(\d+)\b/gi)].map(
        (m) => `#${m[1] ?? m[2] ?? m[3]}`,
      ),
    ),
  ];
  const separateBranch =
    /\b(?:one|separate|each|per)[^.!?\n]{0,35}\bbranch|\bbranch[^.!?\n]{0,35}\b(?:each|per|issue)|이슈별.{0,15}브랜치|ブランチ|分支/i.test(
      directive,
    );
  const targets = references.length
    ? references
    : /\b(?:first\s+)?two\s+(?:open\s+)?issues\b/i.test(directive)
      ? ["issue-1", "issue-2"]
      : ["implementation"];
  return {
    requiresImplementation: true,
    implementationUnits: targets.map((target) => ({
      key: target.startsWith("#") ? `issue-${target.slice(1)}` : target,
      ...(target.startsWith("#") ? { reference: target } : {}),
      description:
        target === "implementation"
          ? executionClauses.join("; ")
          : executionClauses.filter((clause) => clause.includes(target)).join("; ") ||
            `Implement requested fix for ${target}`,
      requiresTests: true,
      separateBranch,
    })),
  };
}

export function includeImplementationDepartment(departments: string[], intent: ImplementationIntent): string[] {
  return [...new Set([...departments, ...(intent.requiresImplementation ? ["dev"] : [])])];
}

export function implementationPlanningRules(intent: ImplementationIntent): string {
  if (!intent.requiresImplementation) return "";
  return [
    "[Required implementation coverage]",
    '- Include one concrete implementation item per unit, owned by Development (department_id: "dev").',
    "- Each implementation item must change the requested product behavior in production code and deliver regression tests. Name the code change in the title.",
    "- Specifications, documentation, readiness checks, test planning and evidence consolidation cannot replace implementation. Never defer code work to an implementation owner who has no plan item.",
    "- Preserve all requested tests and per-issue branch constraints in each item's description. Use a separate implementation item for every unit; do not combine issues.",
    "- Independent implementation items start together. Verification that consumes a code change must depend on its implementation key; independent preparation remains parallel.",
    ...intent.implementationUnits.map(
      (unit) =>
        `- Unit ${unit.key}${unit.reference ? ` (${unit.reference})` : ""}: ${unit.description}; code + regression tests${unit.separateBranch ? "; one separate branch for this issue" : ""}. Set implementation_unit to \"${unit.key}\" on its item.`,
    ),
  ].join("\n");
}
