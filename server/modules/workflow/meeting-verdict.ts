import {
  formatMeetingVerdict,
  meetingVerdictNeedsRevision,
  parseMeetingVerdict,
  stripMeetingVerdict,
  type MeetingVerdict,
} from "../../../src/lib/meeting-verdict.ts";

export function meetingVerdictInstruction(lang: string): string {
  const instruction =
    lang === "ko"
      ? '마지막에 JSON 코드 블록으로 판정을 반드시 작성하세요. verdict는 "approve" 또는 "revise", blocking_items와 non_blocking_notes는 문자열 배열입니다. 승인을 막는 구체적 수정 사항이 있을 때만 revise를 사용하세요. 차단 항목 없는 revise는 승인으로 처리됩니다. 비차단 참고 사항은 기록만 하며 작업으로 만들지 않습니다.'
      : lang === "ja"
        ? '最後にJSONコードブロックで判定を必ず記載してください。verdictは"approve"または"revise"、blocking_itemsとnon_blocking_notesは文字列配列です。承認を妨げる具体的な修正がある場合のみreviseを使用してください。阻害項目のないreviseは承認として扱います。非阻害メモは記録のみで作業にしません。'
        : lang === "zh"
          ? '必须在最后的JSON代码块中给出判定。verdict为"approve"或"revise"，blocking_items和non_blocking_notes为字符串数组。只有存在阻止批准的具体修改项时才使用revise。没有阻塞项的revise视为批准。非阻塞备注仅记录，不转为工作。'
          : 'End with a required final fenced JSON verdict. verdict must be "approve" or "revise"; blocking_items and non_blocking_notes must be string arrays. Use revise only for concrete changes that block approval. Revise without blocking items is treated as approval. Nonblocking notes are recorded only and must not become work items.';
  return `${instruction}\n${formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] })}`;
}

export async function resolveMeetingVerdict(opts: {
  text: string;
  lang: string;
  reviewer: string;
  phase: string;
  retry: (prompt: string) => Promise<{ text: string; error?: string }>;
  fallback: (text: string) => boolean;
  log: (message: string) => void;
}): Promise<{ verdict: MeetingVerdict; source: "structured" | "retry" | "legacy" }> {
  let verdict = parseMeetingVerdict(opts.text);
  let source: "structured" | "retry" | "legacy" = "structured";
  if (!verdict) {
    opts.log(`Meeting verdict missing (${opts.phase}, reviewer=${opts.reviewer}); retrying once for verdict only`);
    try {
      const retry = await opts.retry(
        `${meetingVerdictInstruction(opts.lang)}\nReturn only the verdict block for your previous statement, without tools or additional prose.\n[Previous statement]\n${opts.text}`,
      );
      verdict = retry.error ? null : parseMeetingVerdict(retry.text);
    } catch {
      // A failed verdict-only request still uses the original reply's legacy decision.
    }
    source = "retry";
    if (!verdict) {
      const revise = opts.fallback(opts.text);
      verdict = {
        verdict: revise ? "revise" : "approve",
        blocking_items: revise ? [opts.text] : [],
        non_blocking_notes: [],
      };
      source = "legacy";
      opts.log(`Meeting verdict legacy classifier fallback (${opts.phase}, reviewer=${opts.reviewer})`);
    }
  }
  opts.log(
    `Meeting verdict (${opts.phase}, reviewer=${opts.reviewer}, source=${source}): verdict=${verdict.verdict}, blocking_items=${verdict.blocking_items.length}, effective=${meetingVerdictNeedsRevision(verdict) ? "revise" : "approve"}`,
  );
  return { verdict, source };
}

// Preserve executable department drafts while excluding informational verdict notes from planning input.
export function planningWorkFromVerdict(text: string, verdict: MeetingVerdict): string {
  let work = stripMeetingVerdict(text);
  for (const note of verdict.non_blocking_notes) work = work.split(note).join("");
  if (meetingVerdictNeedsRevision(verdict)) work += `\nBlocking items:\n${verdict.blocking_items.join("\n")}`;
  return work.trim();
}
