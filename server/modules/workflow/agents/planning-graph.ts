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
  if (!Array.isArray(parsed.plan_items) || parsed.plan_items.length === 0 || parsed.plan_items.length > 30) {
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
