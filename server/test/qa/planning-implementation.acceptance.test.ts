import { describe, expect, it } from "vitest";
import {
  implementationIntentFromTask,
  includeImplementationDepartment,
} from "../../modules/workflow/agents/implementation-intent.ts";
import {
  repairImplementationCoverage,
  validateImplementationCoverage,
} from "../../modules/workflow/agents/planning-graph.ts";
import { nexoSupportPlan } from "../implementation-planning-fixture.ts";

// QA acceptance boundary: use stored CEO directives, not preconstructed intent.
// A support-only model response must be rejected for mixed implementation work
// in each supported UI language before it can be materialized or executed.
describe("QA: mixed code/support directives retain implementation coverage", () => {
  it.each([
    {
      directive:
        "Fix the first two open issues on Nexo, #84 and #85, add tests and documentation, one branch per issue",
      units: ["issue-84", "issue-85"],
      separateBranch: true,
    },
    { directive: "Fix API authentication and documentation", units: ["implementation"], separateBranch: false },
    { directive: "버그를 수정하고 문서를 업데이트해", units: ["implementation"], separateBranch: false },
    { directive: "APIのバグを修正して文書を更新", units: ["implementation"], separateBranch: false },
    { directive: "修复登录功能并更新文档", units: ["implementation"], separateBranch: false },
  ])("requires executable Development work: $directive", ({ directive, units, separateBranch }) => {
    const intent = implementationIntentFromTask(
      "Directive planning",
      `[CEO] ${directive}\n[PROJECT CORE GOAL] Plan the requested work`,
    );
    expect(intent.requiresImplementation).toBe(true);
    expect(intent.implementationUnits.map((unit) => unit.key)).toEqual(units);
    expect(includeImplementationDepartment(["operations"], intent)).toContain("dev");
    expect(validateImplementationCoverage(nexoSupportPlan(), intent)).not.toEqual([]);

    const repaired = repairImplementationCoverage(nexoSupportPlan(), intent)!;
    expect(validateImplementationCoverage(repaired, intent)).toEqual([]);
    const code = repaired.filter((item) => item.department_id === "dev");
    expect(code).toHaveLength(units.length);
    for (const unit of units) {
      const item = code.find((candidate) => candidate.implementation_unit === unit);
      expect(item?.description).toContain("production code");
      expect(item?.description).toContain("regression tests");
      if (separateBranch) expect(item?.description).toContain("separate branch");
    }
  });

  it.each([
    "Update API documentation with regression test examples",
    "API 문서를 업데이트해",
    "APIの文書を更新",
    "更新登录功能文档",
  ])("does not invent implementation from supporting work: %s", (directive) => {
    const intent = implementationIntentFromTask(
      "Documentation follow-up",
      `[CEO] ${directive}\n[PROJECT CORE GOAL] Fix API bug #84 with tests`,
    );
    expect(intent.requiresImplementation).toBe(false);
    expect(includeImplementationDepartment(["operations"], intent)).toEqual(["operations"]);
    expect(validateImplementationCoverage(nexoSupportPlan(), intent)).toEqual([]);
    expect(repairImplementationCoverage(nexoSupportPlan(), intent)).toEqual(nexoSupportPlan());
  });
});
