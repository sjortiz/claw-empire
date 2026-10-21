export interface MeetingVerdict {
  verdict: "approve" | "revise";
  blocking_items: string[];
  non_blocking_notes: string[];
}

// Only the final fenced block is authoritative; examples earlier in a reply are not decisions.
export function parseMeetingVerdict(text: string): MeetingVerdict | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)];
  const last = blocks.at(-1);
  if (!last || text.slice(last.index! + last[0].length).trim()) return null;
  try {
    const value = JSON.parse(last[1]);
    if (!value || (value.verdict !== "approve" && value.verdict !== "revise")) return null;
    const normalizeItems = (items: unknown): string[] | null => {
      if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) return null;
      return [...new Set(items.map((item: string) => item.trim()).filter(Boolean))];
    };
    const blocking = normalizeItems(value.blocking_items);
    const notes = normalizeItems(value.non_blocking_notes);
    if (!blocking || !notes) return null;
    return { verdict: value.verdict, blocking_items: blocking, non_blocking_notes: notes };
  } catch {
    return null;
  }
}

export function meetingVerdictNeedsRevision(verdict: MeetingVerdict): boolean {
  return verdict.verdict === "revise" && verdict.blocking_items.length > 0;
}

export function formatMeetingVerdict(verdict: MeetingVerdict): string {
  return "```json\n" + JSON.stringify(verdict, null, 2) + "\n```";
}

export function stripMeetingVerdict(text: string): string {
  if (!parseMeetingVerdict(text)) return text;
  return text.slice(0, text.lastIndexOf("```", text.lastIndexOf("```") - 1)).trim();
}
