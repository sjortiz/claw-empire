import type { DatabaseSync } from "node:sqlite";
import { resolveReviewPolicy } from "../../../../workflow/core/review-policy.ts";
import type { DecisionApplyResult } from "./yolo-mode.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

export function applyAllReviewItemsAutomatically(input: {
  db: Pick<DatabaseSync, "prepare">;
  getDecisionInboxItems: () => DecisionInboxRouteItem[];
  applyDecisionReply: (id: string, body: Record<string, unknown>) => DecisionApplyResult;
}): number {
  const candidates = input.db
    .prepare(
      `
    SELECT DISTINCT t.project_id FROM tasks t JOIN meeting_minutes mm ON mm.task_id = t.id
    WHERE t.status = 'review' AND t.source_task_id IS NULL AND mm.meeting_type = 'review'
      AND mm.status = 'revision_requested' AND mm.round IN (1, 2)
      AND mm.id = (SELECT id FROM meeting_minutes WHERE task_id = t.id AND meeting_type = 'review'
        ORDER BY started_at DESC, created_at DESC LIMIT 1)
  `,
    )
    .all() as Array<{ project_id: string | null }>;
  if (!candidates.some((task) => resolveReviewPolicy(input.db, task.project_id, "reviewItemsAutoApply"))) return 0;
  let applied = 0;
  for (const item of input.getDecisionInboxItems()) {
    if (item.kind !== "review_round_pick" || !resolveReviewPolicy(input.db, item.project_id, "reviewItemsAutoApply"))
      continue;
    const picks = item.options.filter((option) => option.action === "apply_review_pick").map((option) => option.number);
    if (picks.length === 0) continue;
    const result = input.applyDecisionReply(item.id, { option_number: picks[0], selected_option_numbers: picks });
    if (result.status < 400) applied += 1;
  }
  return applied;
}

/** Durable informational cards are independent of readiness and pending revision cards. */
export function buildAutomaticReviewInfoItems(
  db: Pick<DatabaseSync, "prepare">,
  lang: string,
): DecisionInboxRouteItem[] {
  const rows = db
    .prepare(
      `
    SELECT t.id AS task_id, t.title AS task_title, t.project_id,
      p.name AS project_name, p.project_path, MAX(tl.created_at) AS created_at
    FROM task_logs tl JOIN tasks t ON t.id = tl.task_id JOIN projects p ON p.id = t.project_id
    WHERE tl.kind = 'system' AND tl.message = 'Review meeting started automatically (setting)'
    GROUP BY t.id ORDER BY created_at DESC LIMIT 100
  `,
    )
    .all() as Array<{
    task_id: string;
    task_title: string;
    project_id: string;
    project_name: string;
    project_path: string;
    created_at: number;
  }>;
  const summary = {
    ko: "설정에 따라 검토 회의가 자동으로 시작되었습니다. 이 항목은 알림이며 결정이 필요하지 않습니다.",
    en: "Review meeting started automatically (setting). This is an informational item; no decision is required.",
    ja: "設定によりレビュー会議が自動的に開始されました。この項目はお知らせであり、決定は不要です。",
    zh: "评审会议已按设置自动启动。此项仅供知悉，无需决策。",
  };
  return rows.map((row) => ({
    ...row,
    id: `project-review-auto:${row.task_id}`,
    kind: "project_review_ready",
    informational: true,
    summary: `${summary[lang as keyof typeof summary] ?? summary.en}\n${row.task_title}`,
    options: [],
  }));
}
