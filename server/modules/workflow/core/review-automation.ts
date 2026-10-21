export type ReviewAutomationOverride = "on" | "off";
export type ReviewAutomationSetting = "reviewAutoStart" | "reviewAutoApply";

type ReviewAutomationDb = {
  prepare(sql: string): { get(...args: any[]): unknown };
};

// Global setting key -> nullable project override column.
const PROJECT_COLUMNS: Record<ReviewAutomationSetting, string> = {
  reviewAutoStart: "review_auto_start",
  reviewAutoApply: "review_auto_apply",
};

export const REVIEW_AUTO_START_LOG = "Review meeting started automatically (setting)";
export const REVIEW_AUTO_APPLY_LOG = "Review items applied automatically (setting)";

export function isReviewAutomationOverride(value: unknown): value is ReviewAutomationOverride {
  return value === "on" || value === "off";
}

function parseGlobal(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveReviewAutomation(
  db: ReviewAutomationDb,
  setting: ReviewAutomationSetting,
  projectId: string | null,
): { enabled: boolean; source: "project" | "global" | "default" } {
  if (projectId) {
    const column = PROJECT_COLUMNS[setting];
    const project = db.prepare(`SELECT ${column} AS value FROM projects WHERE id = ?`).get(projectId) as
      | { value?: unknown }
      | undefined;
    if (isReviewAutomationOverride(project?.value)) return { enabled: project.value === "on", source: "project" };
  }
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(setting) as { value?: unknown } | undefined;
  const enabled = parseGlobal(row?.value);
  // Missing settings keep the CEO in the loop, as before these settings existed.
  return { enabled: enabled ?? false, source: enabled === null ? "default" : "global" };
}
