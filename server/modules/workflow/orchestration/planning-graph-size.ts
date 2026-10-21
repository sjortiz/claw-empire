import { parsePlanningGraph, type PlanningItem } from "../agents/planning-graph.ts";
import type { OneShotRunResult } from "../core/conversation-types.ts";

export const PLANNING_ITEM_TARGET = 30;

export async function mergeOversizedPlanningGraph(
  text: string,
  merge: (prompt: string) => Promise<OneShotRunResult>,
  log: (message: string) => void,
): Promise<PlanningItem[] | null> {
  const graph = parsePlanningGraph(text);
  if (!graph || graph.length <= PLANNING_ITEM_TARGET) return graph;
  log(
    `Planning graph has ${graph.length} items; asking the summarizer once to merge to at most ${PLANNING_ITEM_TARGET}`,
  );
  try {
    const run = await merge(
      `Merge this validated ${graph.length}-item planning graph into at most ${PLANNING_ITEM_TARGET} actionable items. ` +
        "Combine related items within the same department, preserving every department's ownership, scope, acceptance checks, and real prerequisites. " +
        "Update depends_on references to the merged keys; preserve cross-department prerequisites and independent parallel work. " +
        "Return only a JSON fenced block with the complete plan_items graph and no verdict metadata.\n\n" +
        JSON.stringify({ plan_items: graph }),
    );
    if (run.error) throw new Error(run.error);
    const merged = parsePlanningGraph(run.text);
    if (!merged) throw new Error("summarizer returned no planning graph");
    if (merged.length > PLANNING_ITEM_TARGET) throw new Error(`summarizer still returned ${merged.length} items`);
    const owners = new Set(merged.map((item) => item.department_id));
    if (graph.some((item) => !owners.has(item.department_id)))
      throw new Error("merge omitted a department's ownership");
    log(`Planning graph merged from ${graph.length} to ${merged.length} items`);
    return merged;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(
      `Planning graph size target raised to ${graph.length} for this meeting: merge attempt failed (${reason}); preserving the validated plan's scope, ownership, and dependencies`,
    );
    return graph;
  }
}
