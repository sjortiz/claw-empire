import type { DatabaseSync } from "node:sqlite";
import type { AgentRow } from "./direct-chat.ts";
import { DEFAULT_WORKFLOW_PACK_KEY } from "../../workflow/packs/definitions.ts";
import {
  isOAuthBackedProviderReady,
  loadActiveOAuthAccountIdsByProvider,
} from "../core/tasks/execution-run-auto-assign.ts";

// A preferred subordinate can have a reservation despite an idle status. Scan
// the remaining eligible department members rather than waiting on that one.
export function pickAvailableDepartmentAgent(
  db: Pick<DatabaseSync, "prepare">,
  departmentId: string,
  candidateAgentIds: string[] | null | undefined,
  workflowPackKey?: string | null,
): AgentRow | null {
  if (candidateAgentIds?.length === 0) return null;
  const scope = candidateAgentIds ? new Set(candidateAgentIds) : null;
  const activeOAuth = loadActiveOAuthAccountIdsByProvider(db);
  const agents = db
    .prepare(
      `SELECT * FROM agents WHERE department_id = ? AND status IN ('idle', 'break')
       AND (current_task_id IS NULL OR current_task_id = '') AND cli_provider IS NOT NULL
       ORDER BY CASE status WHEN 'idle' THEN 0 ELSE 1 END,
       CASE role WHEN 'senior' THEN 0 WHEN 'junior' THEN 1 WHEN 'intern' THEN 2 ELSE 3 END, id`,
    )
    .all(departmentId) as unknown as Array<AgentRow & { workflow_pack_key?: string | null }>;
  return (
    agents.find(
      (agent) =>
        (!scope || scope.has(agent.id)) &&
        (agent.workflow_pack_key || DEFAULT_WORKFLOW_PACK_KEY) === (workflowPackKey || DEFAULT_WORKFLOW_PACK_KEY) &&
        isOAuthBackedProviderReady(agent, activeOAuth),
    ) ?? null
  );
}
