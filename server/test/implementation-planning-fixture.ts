import type { PlanningItem } from "../modules/workflow/agents/planning-graph.ts";

export const nexoDirective =
  "Fix the first two open issues on Nexo, #84 and #85. Add regression tests, run lint/tests and check observability. Use one branch per issue.";

export const nexoImplementation = (issue: number): PlanningItem => ({
  key: `fix${issue}`,
  title: `Fix Nexo #${issue}`,
  description: `Change production code and add regression tests on a separate branch for #${issue}.`,
  implementation_unit: `issue-${issue}`,
  department_id: "dev",
  depends_on: [],
});

export const nexoSupportPlan = (): PlanningItem[] =>
  [
    ["automation", "Set up test automation", "Prepare tooling for future tests", "operations"],
    [
      "observability",
      "Configure observability",
      "Configuration code changes left to the implementation owner",
      "operations",
    ],
    ["docs", "Assess documentation/change impact", "Assess the requested changes", "planning"],
    ["readiness", "Prepare CI/CD readiness", "Prepare the pipeline", "operations"],
    ["spec", "Issue separate implementation specifications", "Describe #84 and #85", "planning"],
    [
      "evidence",
      "Consolidate completion evidence",
      "Collect completed fixes and test results for #84 and #85",
      "planning",
    ],
    ["verify84", "Verify completed fix #84", "Run regression tests against the implemented code", "operations"],
  ].map(([key, title, description, department_id]) => ({ key, title, description, department_id, depends_on: [] }));
