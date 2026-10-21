import {
  appendMeetingVerdict,
  effectiveMeetingVerdict,
  meetingVerdictInstruction,
  parseMeetingVerdict,
  type MeetingVerdict,
} from "../../../../shared/meeting-verdict.ts";

export type ResolvedMeetingVerdict = {
  verdict: MeetingVerdict;
  source: "structured" | "retry" | "fallback";
  content: string;
  originalText: string;
};

/** A malformed verdict receives exactly one independent verdict-only attempt. */
export async function resolveMeetingVerdict(opts: {
  text: string;
  lang: string;
  retry: (prompt: string) => Promise<{ text?: string; error?: string }>;
  fallback: (text: string) => boolean;
  log: (message: string) => void;
}): Promise<ResolvedMeetingVerdict> {
  let verdict = parseMeetingVerdict(opts.text);
  let source: ResolvedMeetingVerdict["source"] = "structured";
  if (!verdict) {
    opts.log("missing/unparseable verdict; retrying once for verdict only");
    try {
      const retry = await opts.retry(
        `${meetingVerdictInstruction(opts.lang, true)}\n\nPrevious response:\n${opts.text}`,
      );
      verdict = retry.error ? null : parseMeetingVerdict(retry.text ?? "");
    } catch {
      verdict = null;
    }
    source = "retry";
  }
  if (!verdict) {
    source = "fallback";
    const revise = opts.fallback(opts.text);
    verdict = {
      verdict: revise ? "revise" : "approve",
      blocking_items: revise ? [opts.text] : [],
      non_blocking_notes: [],
    };
    opts.log("verdict retry missing/unparseable; using legacy classifier fallback");
  }
  opts.log(
    `verdict=${verdict.verdict}, effective=${effectiveMeetingVerdict(verdict)}, blocking_items=${verdict.blocking_items.length}, source=${source}`,
  );
  return {
    verdict,
    source,
    content: source === "structured" ? opts.text : appendMeetingVerdict(opts.text, verdict),
    originalText: opts.text,
  };
}
