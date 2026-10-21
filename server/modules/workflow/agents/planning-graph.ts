export interface PlanningItem {
  key: string;
  title: string;
  description?: string;
  department_id: string;
  depends_on: string[];
}

// Keys are local to one plan; seeding resolves them to actual subtask IDs.
// Legacy prose remains valid. A declared but invalid graph must never silently
// lose its dependencies and turn into independent work.
export function parsePlanningGraph(text: string): PlanningItem[] | null {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const source = fence?.[1] ?? text.trim();
  if (!source.startsWith("{") || !source.includes('"plan_items"')) return null;
  const parsed = JSON.parse(source) as { plan_items?: unknown };
  if (!Array.isArray(parsed.plan_items) || parsed.plan_items.length === 0) {
    throw new Error("Invalid planning graph items");
  }
  const keys = new Set<string>();
  const items = parsed.plan_items.map((raw: unknown): PlanningItem => {
    const item = raw as Partial<PlanningItem> | null;
    if (
      !item ||
      typeof item.key !== "string" ||
      !/^[a-z0-9_-]+$/i.test(item.key) ||
      keys.has(item.key) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof item.department_id !== "string" ||
      !item.department_id.trim() ||
      (item.description !== undefined && typeof item.description !== "string") ||
      !Array.isArray(item.depends_on) ||
      item.depends_on.some((key) => typeof key !== "string")
    ) {
      throw new Error("Invalid planning graph item");
    }
    keys.add(item.key);
    return { ...item, title: item.title.trim(), depends_on: [...new Set(item.depends_on)] } as PlanningItem;
  });
  const byKey = new Map(items.map((item) => [item.key, item]));
  const complete = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string) => {
    if (complete.has(key)) return;
    const item = byKey.get(key);
    if (!item || visiting.has(key)) throw new Error("Invalid planning graph dependency");
    visiting.add(key);
    item.depends_on.forEach(visit);
    visiting.delete(key);
    complete.add(key);
  };
  items.forEach((item) => visit(item.key));
  return items;
}

/** Check a model's item grouping before replacing an already validated plan. */
export function parseMergedPlanningGraph(text: string, original: PlanningItem[]): PlanningItem[] {
  const merged = parsePlanningGraph(text);
  if (!merged) throw new Error("Merged planning graph is missing");
  const originalByKey = new Map(original.map((item) => [item.key, item]));
  const destinationBySource = new Map<string, string>();
  for (const item of merged) {
    const sourceKeys = (item as PlanningItem & { source_keys?: unknown }).source_keys;
    if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) throw new Error("Merged item is missing source keys");
    for (const key of sourceKeys) {
      const source = originalByKey.get(key);
      if (!source || destinationBySource.has(key) || source.department_id !== item.department_id) {
        throw new Error("Merged planning graph lost item ownership or coverage");
      }
      destinationBySource.set(key, item.key);
    }
  }
  if (destinationBySource.size !== original.length) throw new Error("Merged planning graph lost source items");
  const mergedByKey = new Map(merged.map((item) => [item.key, item]));
  const hasPrerequisite = (key: string, prerequisite: string, seen = new Set<string>()): boolean => {
    if (key === prerequisite) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return mergedByKey.get(key)!.depends_on.some((dependency) => hasPrerequisite(dependency, prerequisite, seen));
  };
  for (const item of original) {
    const destination = destinationBySource.get(item.key)!;
    for (const prerequisite of item.depends_on) {
      if (!hasPrerequisite(destination, destinationBySource.get(prerequisite)!)) {
        throw new Error("Merged planning graph lost a prerequisite");
      }
    }
  }
  // Source mappings are validation metadata, not persisted execution fields.
  return merged.map(({ key, title, description, department_id, depends_on }) => ({
    key,
    title,
    ...(description === undefined ? {} : { description }),
    department_id,
    depends_on,
  }));
}
