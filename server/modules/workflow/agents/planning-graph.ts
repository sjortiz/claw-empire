export interface PlanningItem {
  key: string;
  title: string;
  description?: string;
  implementation_unit?: string;
  department_id: string;
  depends_on: string[];
}

// Keys are local to one plan; seeding resolves them to actual subtask IDs.
// Legacy prose remains valid. A declared but invalid graph must never silently
// lose its dependencies and turn into independent work.
export function parsePlanningGraph(text: string): PlanningItem[] | null {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const source = fence?.[1] ?? text.trim();
  if (!source.startsWith("{") || !source.includes('"plan_items"')) return null;
  const parsed = JSON.parse(source) as { plan_items?: unknown };
  if (!Array.isArray(parsed.plan_items) || parsed.plan_items.length === 0 || parsed.plan_items.length > 30) {
    throw new Error("Invalid planning graph items");
  }
  const keys = new Set<string>();
  const items = parsed.plan_items.map((raw: unknown): PlanningItem => {
    const item = raw as Partial<PlanningItem> | null;
    if (
      !item ||
      typeof item.key !== "string" ||
      !/^[a-z0-9_-]+$/i.test(item.key) ||
      keys.has(item.key) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof item.department_id !== "string" ||
      !item.department_id.trim() ||
      (item.description !== undefined && typeof item.description !== "string") ||
      (item.implementation_unit !== undefined && typeof item.implementation_unit !== "string") ||
      !Array.isArray(item.depends_on) ||
      item.depends_on.some((key) => typeof key !== "string")
    ) {
      throw new Error("Invalid planning graph item");
    }
    keys.add(item.key);
    return { ...item, title: item.title.trim(), depends_on: [...new Set(item.depends_on)] } as PlanningItem;
  });
  const byKey = new Map(items.map((item) => [item.key, item]));
  const complete = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string) => {
    if (complete.has(key)) return;
    const item = byKey.get(key);
    if (!item || visiting.has(key)) throw new Error("Invalid planning graph dependency");
    visiting.add(key);
    item.depends_on.forEach(visit);
    visiting.delete(key);
    complete.add(key);
  };
  items.forEach((item) => visit(item.key));
  return items;
}

/** Validate semantics separately from graph syntax. A department label alone is
 * not evidence that the plan actually delivers the requested code changes. */
export function validateImplementationCoverage(
  graph: PlanningItem[] | null,
  intent: import("./implementation-intent.ts").ImplementationIntent,
): string[] {
  if (!intent.requiresImplementation) return [];
  if (!graph)
    return [
      "Code-change directive requires a structured plan_items graph with Development-owned production code and regression tests; prose alone cannot be accepted.",
    ];
  const errors: string[] = [];
  const candidates = graph.filter((item) => {
    if (item.department_id !== "dev") return false;
    const title = item.title.replace(/^Development\s*[:—-]\s*/i, "");
    // Descriptions may mention code merely to defer it to someone else.
    if (
      /\b(?:specifications?|specs?|documentation|docs?|readiness|evidence|checklist|test[- ]planning)\b|명세|문서|仕様|文档/i.test(
        title,
      )
    )
      return false;
    if (/\b(?:plan|draft|document|describe|verify|review|consolidate|prepare|assess|research)\b/i.test(title))
      return false;
    if (
      !/\b(?:fix|implement|build|patch|refactor|repair|resolve|change|modify|update|add|write|create)\b|수정|구현|개발|고치|추가|修正|実装|追加|修改|实现|修复|新增/i.test(
        title,
      )
    )
      return false;
    const text = `${title} ${item.description ?? ""}`;
    const testsOnly =
      /^(?:add|write|create|implement|update)\s+(?:(?:regression|unit|integration|automated)\s+)*tests?\b/i.test(title);
    if (
      testsOnly &&
      !intent.implementationUnits.every((unit) =>
        /^(?:add|write|create|implement|update)\s+(?:(?:regression|unit|integration|automated)\s+)*tests?\b/i.test(
          unit.description,
        ),
      )
    )
      return false;
    if (
      /\b(?:specifications?|specs?|documentation|readiness|evidence|checklist)\b/i.test(item.description ?? "") &&
      !/\b(?:change|modify|patch|update|fix|implement|deliver|commit)\s+(?:(?:the|production|source)\s+)*code\b/i.test(
        text,
      )
    )
      return false;
    if (/\b(?:defer|left to|handoff to|hand off to|implementation by|no code changes)\b/i.test(text)) return false;
    // An explicit code deliverable or concrete issue/feature action is required.
    return (
      testsOnly ||
      /\b(?:code|API|UI|app|feature|endpoint|component|function|handler|frontend|backend|login|authentication|database|router)\b|\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|css|vue|svelte)\b|코드|기능|コード|機能|代码|功能/i.test(
        text,
      )
    );
  });
  const used = new Set<string>();
  for (const unit of intent.implementationUnits) {
    const matches = candidates.filter((item) => {
      const text = `${item.title} ${item.description ?? ""}`;
      return (
        item.implementation_unit === unit.key ||
        (unit.reference
          ? new RegExp(`${unit.reference}\\b`).test(text)
          : intent.implementationUnits.length === 1 || text.includes(unit.key))
      );
    });
    // A single item mentioning both issues cannot cover two distinct units.
    const item = matches.find(
      (candidate) =>
        !used.has(candidate.key) &&
        (intent.implementationUnits.length === 1 ||
          intent.implementationUnits.filter(
            (other) =>
              candidate.implementation_unit === other.key ||
              (other.reference &&
                new RegExp(`${other.reference}\\b`).test(`${candidate.title} ${candidate.description ?? ""}`)),
          ).length <= 1),
    );
    if (!item) {
      errors.push(
        `Missing Development implementation for ${unit.key}${unit.reference ? ` (${unit.reference})` : ""}: add a distinct dev item that changes production behavior, delivers code + regression tests, and owns this unit. Specifications, readiness and evidence do not qualify.`,
      );
      continue;
    }
    used.add(item.key);
    const text = `${item.title} ${item.description ?? ""}`;
    if (
      unit.requiresTests &&
      (!/\b(?:tests?|regression)\b|테스트|テスト|测试/i.test(text) ||
        /\b(?:no tests|without tests|skip tests|do not (?:add|write|run) tests)\b/i.test(text))
    )
      errors.push(`${item.key}: include regression tests for ${unit.key} in the implementation deliverables.`);
    if (
      unit.separateBranch &&
      (!/\b(?:separate|dedicated|own|one)\s+(?:issue\s+)?branch\b|\bbranch\b.{0,35}\b(?:per issue|for each issue)\b|이슈별.{0,15}브랜치|個別.{0,15}ブランチ|单独.{0,15}分支/i.test(
        text,
      ) ||
        /\b(?:same|shared|single)\s+branch\b/i.test(text))
    )
      errors.push(`${item.key}: preserve the requested separate branch for ${unit.key}.`);
  }
  return errors;
}
