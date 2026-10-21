import type { DatabaseSync } from "node:sqlite";
import type { AgentRow } from "./direct-chat.ts";
import {
  isOAuthBackedProviderReady,
  loadActiveOAuthAccountIdsByProvider,
} from "../core/tasks/execution-run-auto-assign.ts";
import { DEFAULT_WORKFLOW_PACK_KEY, type WorkflowPackKey } from "../../workflow/packs/definitions.ts";

type PlanningAgent = AgentRow & { workflow_pack_key?: string | null; oauth_account_id?: string | null };

export function isPlanningAgent(agent: PlanningAgent): boolean {
  return (
    (agent.role === "team_leader" || agent.role === "senior") &&
    (agent.department_id === "planning" || Number(agent.acts_as_planning_leader ?? 0) === 1)
  );
}

// Count assigned work as well as agent status: planned tasks reserve a planner
// before the asynchronous meeting/CLI launch updates the agent's status.
export function selectPlanningAgent(
  db: Pick<DatabaseSync, "prepare">,
  candidateAgentIds?: string[] | null,
  workflowPackKey: WorkflowPackKey = DEFAULT_WORKFLOW_PACK_KEY,
): AgentRow | null {
  if (Array.isArray(candidateAgentIds) && candidateAgentIds.length === 0) return null;
  const scope = Array.isArray(candidateAgentIds) ? new Set(candidateAgentIds) : null;
  const activeOAuth = loadActiveOAuthAccountIdsByProvider(db);
  const agents = (db.prepare("SELECT * FROM agents WHERE status != 'offline'").all() as unknown as PlanningAgent[])
    .filter(isPlanningAgent)
    .filter((agent) => (agent.workflow_pack_key || DEFAULT_WORKFLOW_PACK_KEY) === workflowPackKey)
    .filter((agent) =>
      isOAuthBackedProviderReady(
        { cli_provider: agent.cli_provider, oauth_account_id: agent.oauth_account_id ?? null },
        activeOAuth,
      ),
    )
    .filter((agent) => !scope || scope.has(agent.id));
  const workload = db
    .prepare(
      `SELECT assigned_agent_id,
         SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS pending,
         MAX(created_at) AS last_assigned
       FROM tasks WHERE assigned_agent_id IS NOT NULL
       GROUP BY assigned_agent_id`,
    )
    .all() as Array<{ assigned_agent_id: string; pending: number; last_assigned: number }>;
  const loads = new Map(workload.map((row) => [row.assigned_agent_id, row]));
  const statusRank = (agent: AgentRow) => (agent.status === "idle" ? 0 : agent.status === "break" ? 1 : 2);
  agents.sort((a, b) => {
    const loadA = loads.get(a.id);
    const loadB = loads.get(b.id);
    const busyA = Number((loadA?.pending ?? 0) > 0 || !!a.current_task_id || a.status === "working");
    const busyB = Number((loadB?.pending ?? 0) > 0 || !!b.current_task_id || b.status === "working");
    return (
      busyA - busyB ||
      statusRank(a) - statusRank(b) ||
      (loadA?.pending ?? 0) - (loadB?.pending ?? 0) ||
      (loadA?.last_assigned ?? 0) - (loadB?.last_assigned ?? 0) ||
      a.id.localeCompare(b.id)
    );
  });
  return agents[0] ?? null;
}
