import type { DatabaseSync } from "node:sqlite";
import type { Department } from "../../../../src/types/index.ts";
import {
  localizeOfficePackDepartment,
  localizeOfficePackPersonality,
  type UiLanguageLike,
} from "../../../../src/app/office-workflow-pack.ts";
import { isWorkflowPackKey, type WorkflowPackKey } from "../../workflow/packs/definitions.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Migrate both saved profiles and hydrated rows, without creating agents or changing custom text. */
export function syncOfficePackLocales(db: DbLike, locale: UiLanguageLike): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const agents = db
    .prepare(
      `SELECT id, personality${columns.some((column) => column.name === "workflow_pack_key") ? ", workflow_pack_key" : ""} FROM agents`,
    )
    .all() as Array<{
    id: string;
    personality: string | null;
    workflow_pack_key?: string;
  }>;
  const baseDepartments = db.prepare("SELECT * FROM departments").all() as unknown as Department[];
  const hasPackDepartments = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'office_pack_departments'")
    .get();
  const packDepartments = hasPackDepartments
    ? (db.prepare("SELECT * FROM office_pack_departments").all() as unknown as (Department & {
        workflow_pack_key: string;
        department_id: string;
      })[])
    : [];
  const departmentsFor = (packKey: WorkflowPackKey, profile?: Record<string, unknown>) => [
    ...baseDepartments,
    ...(Array.isArray(profile?.departments) ? (profile.departments as Department[]) : []),
    ...packDepartments
      .filter((department) => department.workflow_pack_key === packKey)
      .map((department) => ({ ...department, id: department.department_id })),
  ];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const row = db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles'").get() as
    | { value: string }
    | undefined;
  let profiles: Record<string, unknown> | null = null;
  try {
    profiles = object(JSON.parse(row?.value ?? "null"));
  } catch {
    /* preserve malformed settings */
  }
  const packByAgentId = new Map<string, WorkflowPackKey>();
  if (profiles) {
    for (const [packKey, raw] of Object.entries(profiles)) {
      if (!isWorkflowPackKey(packKey) || packKey === "development") continue;
      const profile = object(raw);
      if (!profile) continue;
      const departments = departmentsFor(packKey, profile);
      if (Array.isArray(profile.agents)) {
        profile.agents = profile.agents.map((rawAgent) => {
          const agent = object(rawAgent);
          if (!agent || typeof agent.id !== "string") return rawAgent;
          packByAgentId.set(agent.id, packKey);
          const text = typeof agent.personality === "string" ? agent.personality : null;
          const localized = localizeOfficePackPersonality(packKey, text, locale, departments);
          const stored = agentById.get(agent.id);
          // A profile can predate an edit made through the DB-backed manager.
          // Never restore a generated default over that edit (including a cleared value).
          const storedIsCustom =
            stored &&
            (stored.personality === null ||
              localizeOfficePackPersonality(packKey, stored.personality, "en", departments) ===
                localizeOfficePackPersonality(packKey, stored.personality, "ko", departments));
          return {
            ...agent,
            personality:
              storedIsCustom &&
              localizeOfficePackPersonality(packKey, text, "en", departments) !==
                localizeOfficePackPersonality(packKey, text, "ko", departments)
                ? stored.personality
                : localized,
          };
        });
      }
      if (Array.isArray(profile.departments)) {
        profile.departments = profile.departments.map((rawDept) => {
          const dept = object(rawDept);
          if (!dept || typeof dept.id !== "string") return rawDept;
          return {
            ...dept,
            ...localizeOfficePackDepartment(
              packKey,
              {
                id: dept.id,
                description: typeof dept.description === "string" ? dept.description : null,
                prompt: typeof dept.prompt === "string" ? dept.prompt : null,
              },
              locale,
            ),
          };
        });
      }
    }
    const value = JSON.stringify(profiles);
    if (value !== row?.value) db.prepare("UPDATE settings SET value = ? WHERE key = 'officePackProfiles'").run(value);
  }

  const update = db.prepare("UPDATE agents SET personality = ? WHERE id = ? AND personality = ?");
  for (const agent of agents) {
    const prefix = agent.id.split("-seed-")[0];
    const packKey = agent.workflow_pack_key ?? packByAgentId.get(agent.id) ?? prefix;
    if (!isWorkflowPackKey(packKey) || packKey === "development") continue;
    const personality = localizeOfficePackPersonality(packKey, agent.personality, locale, departmentsFor(packKey));
    if (personality !== agent.personality) update.run(personality, agent.id, agent.personality);
  }

  if (!hasPackDepartments) return;
  const departments = db
    .prepare("SELECT workflow_pack_key, department_id, description, prompt FROM office_pack_departments")
    .all() as Array<{
    workflow_pack_key: string;
    department_id: string;
    description: string | null;
    prompt: string | null;
  }>;
  const updateDepartment = db.prepare(
    "UPDATE office_pack_departments SET description = ?, prompt = ? WHERE workflow_pack_key = ? AND department_id = ?",
  );
  for (const department of departments) {
    if (!isWorkflowPackKey(department.workflow_pack_key)) continue;
    const localized = localizeOfficePackDepartment(
      department.workflow_pack_key,
      { ...department, id: department.department_id },
      locale,
    );
    if (localized.description !== department.description || localized.prompt !== department.prompt) {
      updateDepartment.run(
        localized.description,
        localized.prompt,
        department.workflow_pack_key,
        department.department_id,
      );
    }
  }
}
