export type MeetingVerdict = {
  verdict: "approve" | "revise";
  blocking_items: string[];
  non_blocking_notes: string[];
};

/** Only the final JSON fence (or a standalone JSON response) is authoritative. */
export function parseMeetingVerdict(text: string): MeetingVerdict | null {
  const trimmed = text.trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
  const last = fences.at(-1);
  const candidate = last && trimmed.slice((last.index ?? 0) + last[0].length).trim() === "" ? last[1] : trimmed;
  try {
    const value: unknown = JSON.parse(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.verdict !== "approve" && record.verdict !== "revise") return null;
    if (
      !Array.isArray(record.blocking_items) ||
      !Array.isArray(record.non_blocking_notes) ||
      !record.blocking_items.every((item) => typeof item === "string") ||
      !record.non_blocking_notes.every((item) => typeof item === "string")
    )
      return null;
    return {
      verdict: record.verdict,
      blocking_items: record.blocking_items.map((item: string) => item.trim()).filter(Boolean),
      non_blocking_notes: record.non_blocking_notes.map((item: string) => item.trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

export function effectiveMeetingVerdict(verdict: MeetingVerdict): "approve" | "revise" {
  return verdict.verdict === "revise" && verdict.blocking_items.length > 0 ? "revise" : "approve";
}

export function meetingVerdictInstruction(lang: string, verdictOnly = false): string {
  const instructions: Record<string, string> = {
    en: 'End with a final fenced JSON block containing verdict: "approve" | "revise", blocking_items: string[], non_blocking_notes: string[]. Only revise with a nonempty blocking_items list requests changes. Approve with notes is approval; notes are documentation only and must not become work items. Keep executable plan_items in a separate preceding block.',
    ko: '마지막에 JSON 코드 블록으로 verdict: "approve" | "revise", blocking_items: string[], non_blocking_notes: string[]를 반드시 반환하세요. blocking_items가 있는 revise만 보완 요청입니다. 메모가 있는 approve는 승인이고 메모는 문서에만 기록하며 작업 항목으로 만들지 마세요. 실행 plan_items는 앞의 별도 블록에 유지하세요.',
    ja: '最後のJSONコードブロックに verdict: "approve" | "revise", blocking_items: string[], non_blocking_notes: string[] を必ず返してください。blocking_itemsがあるreviseのみ修正要求です。注記付きapproveは承認で、注記は記録のみとし作業項目にしないでください。実行plan_itemsは先行する別ブロックに保持してください。',
    zh: '必须以最终JSON代码块返回 verdict: "approve" | "revise", blocking_items: string[], non_blocking_notes: string[]。只有blocking_items非空的revise才要求整改。带备注的approve是批准，备注仅用于记录，不得转为工作项。可执行plan_items应保留在前面的独立代码块中。',
  };
  const only: Record<string, string> = {
    en: "Your previous response lacked a valid verdict. Return ONLY the verdict JSON block for that response; do not repeat the discussion or plan.",
    ko: "이전 응답에 유효한 판정이 없습니다. 해당 응답의 판정 JSON 블록만 반환하고 논의나 계획을 반복하지 마세요.",
    ja: "前の応答に有効な判定がありません。その応答の判定JSONブロックのみを返し、議論や計画を繰り返さないでください。",
    zh: "上次回复缺少有效判定。只返回该回复的判定JSON代码块，不要重复讨论或计划。",
  };
  return `${verdictOnly ? `${only[lang] ?? only.en}\n` : ""}${instructions[lang] ?? instructions.en}\n\`\`\`json\n{"verdict":"approve","blocking_items":[],"non_blocking_notes":[]}\n\`\`\``;
}

export function appendMeetingVerdict(text: string, verdict: MeetingVerdict): string {
  return `${text.trim()}\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
}
