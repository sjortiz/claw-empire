import type { Lang } from "../../../types/lang.ts";

type MessengerReportAgent = { name: string; name_ko: string; avatar_emoji: string };

function normalizeMessengerTextLine(raw: string): string {
  return raw
    .replace(/[`*_~>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateMessengerText(value: string, max = 160): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function extractTaskTitleFromReportText(content: string, requestLine: string): string {
  const source = requestLine || content;
  const quoted =
    source.match(/['"]([^'"]{2,220})['"]/) ?? source.match(/「([^」]{2,220})」/) ?? source.match(/『([^』]{2,220})』/);
  const picked = quoted?.[1] ?? "";
  return truncateMessengerText(normalizeMessengerTextLine(picked), 90);
}

function buildMessengerReportIdentityIntro(
  agent: MessengerReportAgent,
  content: string,
  requestLine: string,
  lang: Lang,
): string {
  const hasKorean = lang === "ko";
  const hasJapanese = lang === "ja";
  const hasChinese = lang === "zh";
  const displayName = normalizeMessengerTextLine(
    (hasKorean ? agent.name_ko || agent.name : agent.name || agent.name_ko) || "Agent",
  );
  const avatar = normalizeMessengerTextLine(agent.avatar_emoji || "🤖");
  const taskTitle = extractTaskTitleFromReportText(content, requestLine);

  if (hasKorean) {
    return taskTitle
      ? `${avatar} ${displayName} 보고: '${taskTitle}' 완료 결과를 전달드려요.`
      : `${avatar} ${displayName} 보고: 완료 결과를 전달드려요.`;
  }
  if (hasJapanese) {
    return taskTitle
      ? `${avatar} ${displayName} から報告: '${taskTitle}' の完了結果を共有します。`
      : `${avatar} ${displayName} から報告: 完了結果を共有します。`;
  }
  if (hasChinese) {
    return taskTitle
      ? `${avatar} ${displayName} 汇报：'${taskTitle}' 已完成，现发送结果。`
      : `${avatar} ${displayName} 汇报：任务已完成，现发送结果。`;
  }
  return taskTitle
    ? `${avatar} ${displayName} report: sharing completion result for '${taskTitle}'.`
    : `${avatar} ${displayName} report: sharing completion result.`;
}

export function buildMessengerReportSummary(agent: MessengerReportAgent, content: string, lang: Lang): string {
  const shouldSummarize =
    /\|\s*#\s*\|/i.test(content) ||
    /\|\s*1\s*\|/.test(content) ||
    /📋\s*(결과|Result|結果|结果)\s*:/i.test(content) ||
    content.length >= 900;
  if (!shouldSummarize) return content;

  const rawLines = content.split(/\r?\n/);
  const plainLines = rawLines.map((line) => normalizeMessengerTextLine(line));

  const requestLine =
    plainLines.find((line) =>
      /(업무 완료 보고드립니다|reporting completion|完了をご報告します|汇报.+已完成)/i.test(line),
    ) ?? "";
  const identityIntro = buildMessengerReportIdentityIntro(agent, content, requestLine, lang);
  const progressLine =
    plainLines.find((line) =>
      /(?:전체|total)\s*:\s*\d+\s*\/\s*\d+|(?:완료율|completion|progress|진행)\s*[:：]?\s*(?:\d+\s*%|\d+\s*\/\s*\d+)/i.test(
        line,
      ),
    ) ?? "";

  const tableItems: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .map((cell) => normalizeMessengerTextLine(cell))
      .filter(Boolean);
    if (cells.length < 3) continue;
    const index = Number.parseInt(cells[0] ?? "", 10);
    if (!Number.isFinite(index)) continue;
    const issue = cells[1] || "-";
    const severity = cells[2] || "";
    tableItems.push(`${index}. ${severity ? `[${severity}] ` : ""}${truncateMessengerText(issue, 120)}`);
    if (tableItems.length >= 3) break;
  }

  const resultItems: string[] = [];
  let inResultSection = false;
  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i] ?? "";
    const plain = plainLines[i] ?? "";
    if (!inResultSection) {
      if (/📋\s*(결과|Result|結果|结果)\s*:?/i.test(rawLine) || /^(결과|result|結果|结果)\s*:?$/i.test(plain)) {
        inResultSection = true;
      }
      continue;
    }
    if (!plain || plain === "...") continue;
    if (/^[📌📝]/u.test(rawLine.trim())) break;
    if (/(보완\/협업 진행 요약|Remediation\/Collaboration Progress|変更点|변경사항|Changes)/i.test(plain)) break;
    if (rawLine.trim().startsWith("|")) continue;
    const cleaned = plain.replace(/^[-•]\s*/, "").trim();
    if (!cleaned) continue;
    resultItems.push(truncateMessengerText(cleaned, 150));
    if (resultItems.length >= 3) break;
  }

  const keyItems = tableItems.length > 0 ? tableItems : resultItems.map((line, idx) => `${idx + 1}. ${line}`);
  if (keyItems.length <= 0) return content;

  const hasKorean = lang === "ko";
  const title = hasKorean ? "업무 완료 요약" : "Task Completion Summary";
  const keyLabel = hasKorean ? "핵심 결과" : "Key Results";
  const progressLabel = hasKorean ? "진행 요약" : "Progress";
  const detailHint = hasKorean
    ? "상세 내용은 Claw-Empire 채팅창에서 확인하세요."
    : "See Claw-Empire chat for full details.";

  const out: string[] = [title, identityIntro];
  out.push(`${keyLabel}:`);
  out.push(...keyItems);
  if (progressLine) out.push(`${progressLabel}: ${truncateMessengerText(progressLine, 160)}`);
  out.push(detailHint);
  return out.join("\n");
}
