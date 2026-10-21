export type MergePolicy = "auto" | "manual";

type MergePolicyDb = {
  prepare(sql: string): { get(...args: any[]): unknown };
};

export function isMergePolicy(value: unknown): value is MergePolicy {
  return value === "auto" || value === "manual";
}

function parsePolicy(value: unknown): MergePolicy | null {
  if (isMergePolicy(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isMergePolicy(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveTaskMergePolicy(
  db: MergePolicyDb,
  projectId: string | null,
): { policy: MergePolicy; source: "project" | "global" | "default" } {
  if (projectId) {
    const project = db.prepare("SELECT merge_policy FROM projects WHERE id = ?").get(projectId) as
      | { merge_policy?: unknown }
      | undefined;
    const policy = parsePolicy(project?.merge_policy);
    if (policy) return { policy, source: "project" };
  }
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'mergePolicy'").get() as
    | { value?: unknown }
    | undefined;
  const policy = parsePolicy(setting?.value);
  // Missing settings retain the historical local auto-merge behavior.
  return { policy: policy ?? "auto", source: policy ? "global" : "default" };
}
