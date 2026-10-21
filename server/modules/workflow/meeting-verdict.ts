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
      ? "모든 답변의 마지막 줄은 APPROVE 또는 REVISE 하나로 끝내세요. 이 줄만 판정에 사용됩니다. 바로 앞 JSON 블록에 verdict, blocking_items, non_blocking_notes를 기록하고 두 항목 목록은 문자열 배열로 작성하세요. 구체적인 차단 항목이 있는 REVISE만 수정을 요청합니다. 차단 항목 없는 REVISE는 승인으로 처리됩니다. 비차단 참고 사항은 기록만 하며 작업으로 만들지 않습니다."
      : lang === "ja"
        ? "すべての返信の最終行をAPPROVEまたはREVISEの一語にしてください。この行だけで判定します。直前のJSONブロックにverdict、blocking_items、non_blocking_notesを記載し、項目リストは文字列配列にしてください。具体的な阻害項目のあるREVISEのみ修正依頼です。阻害項目のないREVISEは承認として扱います。非阻害メモは記録のみで作業にしません。"
        : lang === "zh"
          ? "每次回复的最后一行必须仅为APPROVE或REVISE，只有此行决定判定。在前面的JSON块中记录verdict、blocking_items、non_blocking_notes，项目列表必须为字符串数组。仅有具体阻塞项的REVISE会请求修改，没有阻塞项则视为批准。非阻塞备注仅记录，不转为工作。"
          : "End every reply with a single standalone final line: APPROVE or REVISE. Only that line decides the verdict. Immediately before it, include a fenced JSON block with verdict, blocking_items, and non_blocking_notes; item lists must be string arrays. Only REVISE with concrete blocking items requests revision. REVISE without blocking items is treated as approval. Nonblocking notes are recorded only and must not become work items.";
  return `${instruction}\n${formatMeetingVerdict({ verdict: "approve", blocking_items: [], non_blocking_notes: [] })}`;
}

export function meetingVerdictClarification(lang: string): string {
  return lang === "ko"
    ? "명시적 판정이 없습니다. 한 번 재요청했지만 유효한 APPROVE/REVISE를 받지 못했습니다. 판정을 확인한 후 회의를 다시 시작하세요."
    : lang === "ja"
      ? "明示的な判定がありません。1回の再要求後も有効なAPPROVE/REVISEを取得できませんでした。判定を確認して会議を再開してください。"
      : lang === "zh"
        ? "没有明确判定。重试一次后仍未收到有效的APPROVE/REVISE。请确认判定后重新开始会议。"
        : "No verdict: a valid APPROVE/REVISE was not received after one retry. Clarify the verdict and restart the meeting.";
}

export async function resolveMeetingVerdict(opts: {
  text: string;
  lang: string;
  reviewer: string;
  phase: string;
  retry: (prompt: string) => Promise<{ text: string; error?: string }>;
  log: (message: string) => void;
}): Promise<{ verdict: MeetingVerdict; source: "explicit" | "retry" | "no_verdict" }> {
  let verdict = parseMeetingVerdict(opts.text);
  let source: "explicit" | "retry" | "no_verdict" = "explicit";
  if (!verdict) {
    opts.log(`Meeting verdict missing (${opts.phase}, reviewer=${opts.reviewer}); retrying once for verdict only`);
    try {
      const retry = await opts.retry(
        `${meetingVerdictInstruction(opts.lang)}\nReturn only the metadata block and final APPROVE or REVISE line for your previous statement, without tools or additional prose.\n[Previous statement]\n${opts.text}`,
      );
      verdict = retry.error ? null : parseMeetingVerdict(retry.text);
    } catch {
      // Transport failures also end in an explicit no-verdict outcome.
    }
    source = "retry";
    if (!verdict) {
      verdict = { verdict: "no_verdict", blocking_items: [], non_blocking_notes: [] };
      source = "no_verdict";
      opts.log(
        `Meeting verdict: no verdict (${opts.phase}, reviewer=${opts.reviewer}); clarification required after one retry`,
      );
    }
  }
  opts.log(
    `Meeting verdict (${opts.phase}, reviewer=${opts.reviewer}, source=${source}): verdict=${verdict.verdict}, blocking_items=${verdict.blocking_items.length}, effective=${verdict.verdict === "no_verdict" ? "no_verdict" : meetingVerdictNeedsRevision(verdict) ? "revise" : "approve"}`,
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
