import type { DatabaseSync } from "node:sqlite";

export type ReviewPolicyKey = "reviewMeetingAutoStart" | "reviewItemsAutoApply";
const PROJECT_COLUMNS = {
  reviewMeetingAutoStart: "review_meeting_auto_start",
  reviewItemsAutoApply: "review_items_auto_apply",
} as const;

/** Missing settings are deliberately off. A project false overrides a global true. */
export function resolveReviewPolicy(
  db: Pick<DatabaseSync, "prepare">,
  projectId: string | null | undefined,
  key: ReviewPolicyKey,
): boolean {
  if (projectId) {
    const project = db.prepare(`SELECT ${PROJECT_COLUMNS[key]} AS value FROM projects WHERE id = ?`).get(projectId) as
      | { value: number | null }
      | undefined;
    if (project?.value === 0 || project?.value === 1) return project.value === 1;
  }
  const global = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: unknown } | undefined;
  return global?.value === "true" || global?.value === true;
}
