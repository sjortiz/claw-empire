import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;
export const AGENT_NOTE_MAX_CHARS = 2000;
export const AGENT_INBOX_LIMIT = 12;
export const AGENT_INBOX_MAX_CHARS = 8000;

export interface AgentNote {
  id: number;
  source_task_id: string;
  target_task_id: string;
  sender_id: string;
  content: string;
  created_at: number;
}

export function loadAgentNotes(db: DbLike, taskId: string, after = 0, unreadOnly = false): AgentNote[] {
  return db
    .prepare(
      `
    SELECT n.id, n.source_task_id, n.target_task_id, m.sender_id, m.content, m.created_at
    FROM task_agent_notes n JOIN messages m ON m.id = n.message_id
    WHERE n.target_task_id = ? AND n.id > ? ${unreadOnly ? "AND n.delivered_at IS NULL" : ""}
    ORDER BY n.id ASC LIMIT ?
  `,
    )
    .all(taskId, after, AGENT_INBOX_LIMIT) as unknown as AgentNote[];
}

export function acknowledgeAgentNotes(db: DbLike, taskId: string, through: number, now: number): void {
  db.prepare(
    "UPDATE task_agent_notes SET delivered_at = ? WHERE target_task_id = ? AND id <= ? AND delivered_at IS NULL",
  ).run(now, taskId, through);
}

export function hasUnreadAgentNotes(db: DbLike, taskId: string): boolean {
  // Older/minimal fixtures without the additive table keep their existing behavior.
  try {
    return !!db
      .prepare("SELECT 1 FROM task_agent_notes WHERE target_task_id = ? AND delivered_at IS NULL LIMIT 1")
      .get(taskId);
  } catch {
    return false;
  }
}

export function buildAgentInboxBlock(notes: AgentNote[]): { text: string; through: number } {
  const lines: string[] = [];
  let length = 0;
  let through = 0;
  for (const note of notes) {
    const line = `[note ${note.id}; from task ${note.source_task_id}; agent ${note.sender_id}] ${note.content}`;
    if (length + line.length > AGENT_INBOX_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 1;
    through = note.id;
  }
  return { text: lines.join("\n"), through };
}
