import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { Lang } from "../../../types/lang.ts";
import type { WorktreeInfo } from "./worktree/lifecycle.ts";

type DbLike = Pick<DatabaseSync, "prepare">;
type L10n = Record<Lang, string[]>;

export const RELATED_WORK_MAX_TASKS = 6;
export const RELATED_WORK_MAX_CHARS = 6000;

export interface RelatedWorkScope {
  rootTaskId: string;
  projectId: string | null;
  projectPath: string | null;
}

interface ScopeRow {
  id: string;
  source_task_id: string | null;
  project_id: string | null;
  project_path: string | null;
}

interface RelatedTaskRow {
  id: string;
  title: string;
  status: string;
  project_path: string | null;
  base_branch: string | null;
  agent_name: string | null;
  agent_name_ko: string | null;
  agent_name_ja: string | null;
  agent_name_zh: string | null;
  dept_name: string | null;
  dept_name_ko: string | null;
  dept_name_ja: string | null;
  dept_name_zh: string | null;
  summary: string | null;
}

function l(ko: string[], en: string[], ja: string[], zh: string[]): L10n {
  return { ko, en, ja, zh };
}

function pickL(pool: L10n, lang: Lang): string {
  return pool[lang][0];
}

function compact(value: unknown, maxChars: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Resolve inherited coordination scope without following an unbounded or cyclic parent chain. */
export function resolveRelatedWorkScope(db: DbLike, taskId: string): RelatedWorkScope | null {
  try {
    const getTask = db.prepare("SELECT id, source_task_id, project_id, project_path FROM tasks WHERE id = ?");
    let row = getTask.get(taskId) as ScopeRow | undefined;
    if (!row) return null;
    const scope: RelatedWorkScope = {
      rootTaskId: row.id,
      projectId: row.project_id?.trim() || null,
      projectPath: row.project_path?.trim() || null,
    };
    const visited = new Set<string>();
    while (row && !visited.has(row.id) && visited.size < 32) {
      visited.add(row.id);
      scope.rootTaskId = row.id;
      scope.projectId ||= row.project_id?.trim() || null;
      scope.projectPath ||= row.project_path?.trim() || null;
      row = row.source_task_id ? (getTask.get(row.source_task_id) as ScopeRow | undefined) : undefined;
    }
    return scope;
  } catch {
    // Coordination context must not prevent a task from starting during migrations.
    return null;
  }
}

function readGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 1000, maxBuffer: 256 * 1024 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function resolveCommit(cwd: string, ref: string): string | null {
  const hash = readGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  return hash && /^[a-f0-9]{40,64}$/i.test(hash) ? hash : null;
}

/** A bounded, read-only snapshot. No related tasks means no prompt change. */
export function buildRelatedWorkContext(
  db: DbLike,
  taskId: string,
  lang: Lang = "en",
  options: { taskWorktrees?: ReadonlyMap<string, WorktreeInfo> } = {},
): string {
  const scope = resolveRelatedWorkScope(db, taskId);
  if (!scope) return "";

  let rows: RelatedTaskRow[];
  try {
    rows = db
      .prepare(
        `WITH RECURSIVE family(id) AS (
          SELECT ?
          UNION
          SELECT t.id FROM tasks t JOIN family f ON t.source_task_id = f.id
        )
        SELECT t.id, t.title, t.status, t.project_path, t.base_branch,
          a.name AS agent_name, a.name_ko AS agent_name_ko,
          a.name_ja AS agent_name_ja, a.name_zh AS agent_name_zh,
          d.name AS dept_name, d.name_ko AS dept_name_ko,
          d.name_ja AS dept_name_ja, d.name_zh AS dept_name_zh,
          COALESCE(
            (SELECT NULLIF(TRIM(m.content), '') FROM messages m
              WHERE m.task_id = t.id AND m.message_type = 'report'
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
            NULLIF(TRIM(t.result), ''),
            (SELECT tl.message FROM task_logs tl WHERE tl.task_id = t.id
              AND tl.kind = 'report' ORDER BY tl.created_at DESC, tl.id DESC LIMIT 1)
          ) AS summary
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.assigned_agent_id
        LEFT JOIN departments d ON d.id = COALESCE(t.department_id, a.department_id)
        WHERE t.id <> ? AND (
          t.id IN (SELECT id FROM family)
          OR (? IS NOT NULL AND t.project_id = ?)
          OR (? IS NOT NULL AND t.project_path = ? AND (t.project_id IS NULL OR ? IS NULL))
        )
        ORDER BY CASE WHEN t.id IN (SELECT id FROM family) THEN 0 ELSE 1 END,
          CASE WHEN t.status IN ('in_progress', 'collaborating', 'review') THEN 0 ELSE 1 END,
          t.updated_at DESC, t.id ASC
        LIMIT ?`,
      )
      .all(
        scope.rootTaskId,
        taskId,
        scope.projectId,
        scope.projectId,
        scope.projectPath,
        scope.projectPath,
        scope.projectId,
        RELATED_WORK_MAX_TASKS + 1,
      ) as unknown as RelatedTaskRow[];
  } catch {
    return "";
  }
  if (rows.length === 0) return "";

  const text = (ko: string, en: string, ja: string, zh: string) => pickL(l([ko], [en], [ja], [zh]), lang);
  const unavailable = text("확인 불가", "unavailable", "確認不可", "不可用");
  const unassigned = text("미배정", "unassigned", "未割当", "未分配");
  const noReport = text("아직 보고 없음", "no report yet", "報告なし", "暂无报告");
  const lines = [
    text("[관련 작업]", "[Related Work]", "[関連作業]", "[相关工作]"),
    text(
      "아래는 참고용 작업 현황입니다. 담당 범위에 집중하고 이미 완료되었거나 진행 중인 작업을 중복하지 마세요.",
      "These are reference snapshots. Keep your assigned scope and reuse completed or in-flight work instead of duplicating it.",
      "以下は参照用の作業状況です。担当範囲を守り、完了済みや進行中の作業を重複しないでください。",
      "以下为参考工作快照。请专注于分配的范围，复用已完成或进行中的工作，避免重复。",
    ),
  ];
  const projectSnapshots = new Map<string, { head: string | null; worktrees: string | null }>();
  for (const row of rows.slice(0, RELATED_WORK_MAX_TASKS)) {
    const worktree = options.taskWorktrees?.get(row.id);
    const projectPath = worktree?.projectPath || row.project_path || scope.projectPath;
    let branch = worktree?.branchName || "";
    let ahead: number | null = null;
    if (projectPath) {
      let snapshot = projectSnapshots.get(projectPath);
      if (!snapshot) {
        snapshot = {
          head: resolveCommit(projectPath, "HEAD"),
          worktrees: readGit(projectPath, ["worktree", "list", "--porcelain"]),
        };
        projectSnapshots.set(projectPath, snapshot);
      }
      if (!branch) {
        const expectedBranch = `climpire/${row.id.slice(0, 8)}`;
        branch =
          snapshot.worktrees
            ?.split("\n")
            .find(
              (line) =>
                line === `branch refs/heads/${expectedBranch}` ||
                line.startsWith(`branch refs/heads/${expectedBranch}-`),
            )
            ?.slice("branch refs/heads/".length) || expectedBranch;
      }
      const branchCommit = resolveCommit(projectPath, `refs/heads/${branch}`);
      const baseCommit = (row.base_branch ? resolveCommit(projectPath, row.base_branch) : null) || snapshot.head;
      if (branchCommit && baseCommit) {
        const count = readGit(projectPath, ["rev-list", "--count", `${baseCommit}..${branchCommit}`]);
        if (count && /^\d+$/.test(count)) ahead = Number(count);
      }
      if (!branchCommit && !worktree) branch = "";
    }
    const localizedName = (prefix: "agent_name" | "dept_name") =>
      compact((lang !== "en" && row[`${prefix}_${lang}`]) || row[prefix], 70) || unassigned;
    lines.push(
      `- ${compact(row.id, 64)} | ${compact(row.title, 140)} | ${localizedName("agent_name")} / ${localizedName("dept_name")} | ${compact(row.status, 32)}`,
      `  ${text("브랜치", "branch", "ブランチ", "分支")}: ${compact(branch, 140) || unavailable}; ${text("기준 대비 커밋", "commits ahead of base", "基準より先のコミット", "领先基准的提交")}: ${ahead ?? unavailable}`,
      `  ${text("최신 보고", "latest report", "最新報告", "最新报告")}: ${compact(row.summary, 420) || noReport}`,
    );
  }
  if (rows.length > RELATED_WORK_MAX_TASKS) {
    lines.push(
      text(
        "추가 관련 작업은 생략되었습니다.",
        "Additional related tasks omitted.",
        "他の関連作業は省略されました。",
        "其他相关任务已省略。",
      ),
    );
  }
  return lines.join("\n").slice(0, RELATED_WORK_MAX_CHARS);
}
