import { describe, expect, it } from "vitest";
import {
  buildDelegatedChecklist,
  buildDelegatedDescription,
  DELEGATED_PARENT_SUMMARY_MAX_CHARS,
} from "../../../server/modules/routes/collab/subtask-delegation-batch-messages.ts";
import type { SubtaskRow } from "../../../server/modules/routes/collab/subtask-summary.ts";
import { parseDelegatedScope } from "./delegated-scope.ts";
import type { Lang } from "../../../server/types/lang.ts";
import type { L10n } from "../../../server/modules/routes/collab/language-policy.ts";

const coordinationLocalizers = {
  l: (ko: string[], en: string[], ja: string[] = en, zh: string[] = en): L10n => ({ ko, en, ja, zh }),
  pickL: (pool: L10n, lang: Lang) => pool[lang][0],
};

// The UI's existing tests use literal descriptions. Feed the actual server
// output into the parser so localized marker drift fails at the boundary.
describe("QA acceptance: persisted description to UI scope contract", () => {
  it.each(["ko", "en", "ja", "zh"] as const)(
    "separates each department's actual generated instructions from parent reference in %s",
    (lang) => {
      const departments = ["Development", "Design", "QA/QC"];
      const parentSummary = `${"Common project background. ".repeat(80)}FULL DIRECTIVE TAIL`;
      const items: SubtaskRow[] = departments.map((department, index) => ({
        id: `owned-${index}`,
        task_id: "parent",
        title: `${department} responsibility`,
        description: `${department} exclusive acceptance criteria.\nPreserve completed peer work.`,
        status: "pending",
        target_department_id: department,
        delegated_task_id: null,
        blocked_reason: null,
        created_at: 1,
      }));

      for (const own of items) {
        const description = buildDelegatedDescription({
          ...coordinationLocalizers,
          lang,
          sourceDeptName: "Planning",
          targetDeptName: own.target_department_id!,
          parentTaskId: "parent",
          parentSummary,
          delegatedChecklist: buildDelegatedChecklist([own]),
        });
        const scope = parseDelegatedScope(description);
        expect(scope).not.toBeNull();
        expect(scope).toMatchObject({
          sourceDept: "Planning",
          scopeDept: own.target_department_id,
          items: [{ index: 1, title: own.title, subtaskId: own.id, detail: own.description }],
        });
        expect(scope!.instruction).toBeTruthy();
        expect(scope!.instruction).not.toContain("Common project background.");
        expect(scope!.parentContext).toContain("GET /api/tasks/parent");
        expect(scope!.parentContext).toContain("Common project background.");
        expect(scope!.parentContext).not.toContain("FULL DIRECTIVE TAIL");
        expect(scope!.parentContext.length).toBeLessThan(DELEGATED_PARENT_SUMMARY_MAX_CHARS + 400);
        for (const peer of items.filter((item) => item.id !== own.id)) {
          expect(description).not.toContain(peer.description!);
          expect(description).not.toContain(`[${peer.id}]`);
        }
      }
    },
  );

  it("leaves an ordinary solo task description to the existing plain renderer", () => {
    expect(parseDelegatedScope("Fix the assigned API regression.")).toBeNull();
  });
});
