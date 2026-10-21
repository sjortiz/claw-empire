export interface MeetingVerdict {
  verdict: "approve" | "revise" | "no_verdict";
  blocking_items: string[];
  non_blocking_notes: string[];
}

function trailingMetadata(text: string): { start: number; value: MeetingVerdict } | null {
  const last = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].at(-1);
  if (!last || text.slice(last.index! + last[0].length).trim()) return null;
  try {
    const value = JSON.parse(last[1]);
    if (!value || !["approve", "revise", "no_verdict"].includes(value.verdict)) return null;
    const normalizeItems = (items: unknown): string[] | null => {
      if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) return null;
      return [...new Set(items.map((item: string) => item.trim()).filter(Boolean))];
    };
    const blocking = normalizeItems(value.blocking_items);
    const notes = normalizeItems(value.non_blocking_notes);
    if (!blocking || !notes) return null;
    return {
      start: last.index!,
      value: { verdict: value.verdict, blocking_items: blocking, non_blocking_notes: notes },
    };
  } catch {
    return null;
  }
}

// HTTP/API providers end their output with a "---\n[provider] Done." footer.
const PROVIDER_FOOTER = /\n-{3}\n\[[\w:-]+\] Done\.\s*$/;

// Only the final standalone line decides a live reply. Earlier prose/JSON never votes.
export function parseMeetingVerdict(text: string): MeetingVerdict | null {
  const trimmed = text.replace(PROVIDER_FOOTER, "").trimEnd();
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  if (lastLine !== "APPROVE" && lastLine !== "REVISE") return null;
  const body = trimmed.slice(0, trimmed.lastIndexOf("\n") + 1).trimEnd();
  if ((body.match(/```/g)?.length ?? 0) % 2 !== 0) return null;
  const metadata = trailingMetadata(body)?.value;
  // A malformed metadata block must be clarified, rather than silently losing blockers.
  if (body.endsWith("```") && !metadata) return null;
  return {
    verdict: lastLine === "APPROVE" ? "approve" : "revise",
    blocking_items: metadata?.blocking_items ?? [],
    non_blocking_notes: metadata?.non_blocking_notes ?? [],
  };
}

// Historical JSON-only minutes stay readable, but never enter live decision classification.
export function parseStoredMeetingVerdict(text: string): MeetingVerdict | null {
  const explicit = parseMeetingVerdict(text);
  if (explicit) return explicit;
  const body = text
    .trimEnd()
    .replace(/(?:^|\n)NO VERDICT$/, "")
    .trimEnd();
  return trailingMetadata(body)?.value ?? null;
}

export function meetingVerdictNeedsRevision(verdict: MeetingVerdict): boolean {
  return verdict.verdict === "revise" && verdict.blocking_items.length > 0;
}

export function formatMeetingVerdict(verdict: MeetingVerdict): string {
  const line = verdict.verdict === "no_verdict" ? "NO VERDICT" : verdict.verdict.toUpperCase();
  return "```json\n" + JSON.stringify(verdict, null, 2) + "\n```\n" + line;
}

export function stripMeetingVerdict(text: string): string {
  const body = text
    .trimEnd()
    .replace(/(?:^|\n)[ \t]*(?:APPROVE|REVISE|NO VERDICT)$/, "")
    .trimEnd();
  const metadata = trailingMetadata(body);
  return (metadata ? body.slice(0, metadata.start) : body).trim();
}
