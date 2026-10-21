import type { DatabaseSync } from "node:sqlite";
import type { Response } from "express";
import { REVIEW_AUTO_APPLY_LOG, resolveReviewAutomation } from "../../../../workflow/core/review-automation.ts";
import { runYoloDecisionAutopilot, type DecisionApplyResult, type YoloDecisionReplyPayload } from "./yolo-mode.ts";
import type { DecisionInboxRouteItem, DecisionOption, ReviewAutoStartNoticeItem } from "./types.ts";

const NOTICE_ID_PREFIX = "review-auto-started:";
const ACKNOWLEDGE_ACTION = "acknowledge_review_auto_start";

type Localize = (ko: string[], en: string[], ja?: string[], zh?: string[]) => unknown;

export function createReviewAutoStartNoticeItems(deps: {
  db: Pick<DatabaseSync, "prepare">;
  getPreferredLanguage: () => string;
  pickL: (pool: any, lang: any) => string;
  l: Localize;
}) {
  const { db, getPreferredLanguage, pickL, l } = deps;

  // Informational items for review meetings the reviewAutoStart setting started without a CEO decision.
  function buildReviewAutoStartNoticeItems(): ReviewAutoStartNoticeItem[] {
    const lang = getPreferredLanguage();
    const t = (ko: string, en: string, ja: string, zh: string) => pickL(l([ko], [en], [ja], [zh]), lang);
    const rows = db
      .prepare(
        `
      SELECT n.id, n.project_id, n.task_ids_json, n.created_at, p.name AS project_name, p.project_path
      FROM review_auto_start_notices n
      JOIN projects p ON p.id = n.project_id
      WHERE n.acknowledged_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT 50
    `,
      )
      .all() as Array<{
      id: string;
      project_id: string;
      task_ids_json: string;
      created_at: number;
      project_name: string | null;
      project_path: string | null;
    }>;

    return rows.map((row) => {
      let taskIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.task_ids_json);
        if (Array.isArray(parsed)) taskIds = parsed.filter((id): id is string => typeof id === "string");
      } catch {
        // malformed rows still show the project-level notice
      }
      const tasks = taskIds
        .map((id) => db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(id) as { id: string; title: string })
        .filter(Boolean);
      const projectName = (row.project_name || row.project_id).trim();
      const taskList = tasks.map((task) => `- ${task.title}`).join("\n");
      const summary = t(
        `프로젝트 '${projectName}'의 팀장 회의가 설정에 따라 자동으로 시작되었습니다 (${tasks.length}건).\n${taskList}\n결정할 사항은 없으며, 진행 상황은 각 작업 로그에서 확인할 수 있습니다.`,
        `Project '${projectName}': the team-lead review meeting started automatically by setting (${tasks.length} task(s)).\n${taskList}\nNo decision is needed; follow progress in each task's log.`,
        `プロジェクト'${projectName}'のチームリーダー会議を設定により自動開始しました（${tasks.length}件）。\n${taskList}\n判断は不要です。進行状況は各タスクのログで確認できます。`,
        `项目'${projectName}'的组长评审会议已按设置自动启动（${tasks.length} 个任务）。\n${taskList}\n无需决策，可在各任务日志中查看进度。`,
      );
      const options: DecisionOption[] = [
        { number: 1, action: ACKNOWLEDGE_ACTION, label: t("확인", "Acknowledge", "確認", "确认") },
      ];
      return {
        id: `${NOTICE_ID_PREFIX}${row.id}`,
        kind: "review_auto_started",
        created_at: row.created_at,
        summary,
        project_id: row.project_id,
        project_name: row.project_name,
        project_path: row.project_path,
        task_id: tasks[0]?.id ?? null,
        task_title: tasks[0]?.title ?? null,
        options,
      };
    });
  }

  return { buildReviewAutoStartNoticeItems };
}

export function handleReviewAutoStartNoticeReply(input: {
  res: Response;
  currentItem: DecisionInboxRouteItem;
  selectedOption: DecisionOption;
  deps: { db: Pick<DatabaseSync, "prepare">; nowMs: () => number };
}): boolean {
  const { res, currentItem, selectedOption, deps } = input;
  if (currentItem.kind !== "review_auto_started") return false;
  if (selectedOption.action !== ACKNOWLEDGE_ACTION) {
    res.status(400).json({ error: "unsupported_review_auto_start_action", action: selectedOption.action });
    return true;
  }
  deps.db
    .prepare("UPDATE review_auto_start_notices SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL")
    .run(deps.nowMs(), currentItem.id.slice(NOTICE_ID_PREFIX.length));
  res.json({ ok: true, resolved: true, kind: "review_auto_started", action: ACKNOWLEDGE_ACTION });
  return true;
}

// Picks every review item of a round; skipping to the next round stays a CEO decision.
export function buildReviewAutoApplyReplyPayload(item: DecisionInboxRouteItem): YoloDecisionReplyPayload | null {
  if (item.kind !== "review_round_pick") return null;
  const picks = item.options.filter((option) => option.action === "apply_review_pick").map((option) => option.number);
  if (picks.length <= 0) return null;
  return { option_number: picks[0], selected_option_numbers: picks };
}

export function isReviewAutoApplyConfigured(db: Pick<DatabaseSync, "prepare">): boolean {
  if (resolveReviewAutomation(db, "reviewAutoApply", null).enabled) return true;
  return Boolean(db.prepare("SELECT 1 FROM projects WHERE review_auto_apply = 'on' LIMIT 1").get());
}

export function runReviewAutoApplyAutopilot(input: {
  db: Pick<DatabaseSync, "prepare">;
  getReviewRoundItems: () => DecisionInboxRouteItem[];
  applyDecisionReply: (decisionId: string, body: Record<string, unknown>) => DecisionApplyResult;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
}): number {
  const { db, appendTaskLog } = input;
  const taskIdByDecisionId = new Map<string, string | null>();
  return runYoloDecisionAutopilot({
    getDecisionInboxItems: () => {
      const items = input.getReviewRoundItems();
      for (const item of items) taskIdByDecisionId.set(item.id, item.task_id);
      return items;
    },
    buildReplyPayload: buildReviewAutoApplyReplyPayload,
    shouldSkipItem: (item) => {
      if (item.kind !== "review_round_pick") return true;
      return !resolveReviewAutomation(db, "reviewAutoApply", item.project_id).enabled;
    },
    applyDecisionReply: (decisionId, body) => {
      const result = input.applyDecisionReply(decisionId, body);
      const taskId = taskIdByDecisionId.get(decisionId);
      if (result.status < 400 && taskId) appendTaskLog(taskId, "system", REVIEW_AUTO_APPLY_LOG);
      return result;
    },
  });
}
