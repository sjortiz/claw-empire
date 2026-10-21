import { describe, expect, it, vi } from "vitest";
import { parsePlanningGraph } from "../agents/planning-graph.ts";
import { mergeOversizedPlanningGraph } from "./planning-graph-size.ts";

const items = Array.from({ length: 32 }, (_, i) => ({
  key: `item_${i}`,
  title: `Action ${i}`,
  department_id: i === 31 ? "qa" : "dev",
  depends_on: i === 31 ? ["item_0"] : [],
}));
const source = JSON.stringify({ plan_items: items });

describe("oversized planning graph consolidation", () => {
  it("merges a valid 32-item plan once without rejecting it, preserving graph validation", async () => {
    expect(parsePlanningGraph(source)).toHaveLength(32);
    const merged = [
      { ...items[0], title: "Combined development actions", description: "Acceptance checks from all 31 actions" },
      items[31],
    ];
    const merge = vi.fn(async () => ({ text: JSON.stringify({ plan_items: merged }) }));
    const log = vi.fn();
    expect(await mergeOversizedPlanningGraph(source, merge, log)).toEqual(merged);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith(expect.stringContaining("at most 30"));
    expect(merge).toHaveBeenCalledWith(expect.stringContaining('"depends_on":["item_0"]'));
    expect(log).toHaveBeenLastCalledWith("Planning graph merged from 32 to 2 items");
  });

  it.each([
    { text: source },
    { text: "No JSON available" },
    { text: "", error: "timeout after 65000ms" },
    { text: JSON.stringify({ plan_items: [items[31]] }) },
    { text: JSON.stringify({ plan_items: [items[0]] }) },
  ])("keeps the complete validated graph if the single merge attempt fails: %j", async (reply) => {
    const merge = vi.fn(async () => reply);
    const log = vi.fn();
    expect(await mergeOversizedPlanningGraph(source, merge, log)).toEqual(items);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.at(-1)?.[0]).toContain("size target raised to 32");
  });

  it("does not ask to merge a plan within the target or a legacy prose plan", async () => {
    const merge = vi.fn();
    expect(await mergeOversizedPlanningGraph(JSON.stringify({ plan_items: [items[0]] }), merge, vi.fn())).toEqual([
      items[0],
    ]);
    expect(await mergeOversizedPlanningGraph("Legacy prose", merge, vi.fn())).toBeNull();
    expect(merge).not.toHaveBeenCalled();
  });

  it("still rejects invalid original graph dependencies", async () => {
    const merge = vi.fn();
    await expect(
      mergeOversizedPlanningGraph(JSON.stringify({ plan_items: [items[31]] }), merge, vi.fn()),
    ).rejects.toThrow("Invalid planning graph dependency");
    expect(merge).not.toHaveBeenCalled();
  });
});
