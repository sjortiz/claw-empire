import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { bearerToken, isLoopbackHostname, isLoopbackRequest } from "../../../../security/auth.ts";
import { hasValidAgentMessageToken } from "../../../../security/agent-messages.ts";
import { resolveRelatedWorkScope } from "../../../workflow/core/related-work.ts";
import {
  acknowledgeAgentNotes,
  AGENT_NOTE_MAX_CHARS,
  buildAgentInboxBlock,
  loadAgentNotes,
} from "../../../workflow/core/agent-message-inbox.ts";

type Deps = Pick<RuntimeContext, "app" | "db" | "nowMs" | "taskExecutionSessions" | "appendTaskLog" | "broadcast">;

type TaskRecipient = { id: string; assigned_agent_id: string | null; status: string };

export function registerAgentMessageRoutes({
  app,
  db,
  nowMs,
  taskExecutionSessions,
  appendTaskLog,
  broadcast,
}: Deps): void {
  function authenticate(req: Request, res: Response): { taskId: string; agentId: string } | null {
    let loopbackHost = false;
    try {
      loopbackHost = isLoopbackHostname(new URL(`http://${req.header("host") ?? ""}`).hostname);
    } catch {
      /* invalid host */
    }
    if (
      !isLoopbackRequest(req) ||
      !loopbackHost ||
      req.header("origin") ||
      req.header("x-forwarded-for") ||
      req.header("forwarded")
    ) {
      res.status(403).json({ error: "local_agent_only" });
      return null;
    }
    const data = req.method === "GET" ? req.query : (req.body ?? {});
    const taskId = typeof data.task_id === "string" ? data.task_id : "";
    const sessionId = typeof data.session_id === "string" ? data.session_id : "";
    const session = taskExecutionSessions.get(taskId);
    if (
      !sessionId ||
      !session ||
      session.sessionId !== sessionId ||
      !hasValidAgentMessageToken(taskId, sessionId, bearerToken(req) ?? "")
    ) {
      res.status(403).json({ error: "agent_session_invalid" });
      return null;
    }
    const task = db.prepare("SELECT assigned_agent_id, status FROM tasks WHERE id = ?").get(taskId) as
      | TaskRecipient
      | undefined;
    if (!task || task.assigned_agent_id !== session.agentId || task.status !== "in_progress") {
      res.status(409).json({ error: "agent_task_not_running" });
      return null;
    }
    return { taskId, agentId: session.agentId };
  }

  function isRelated(sourceId: string, targetId: string): boolean {
    const source = resolveRelatedWorkScope(db, sourceId);
    const target = resolveRelatedWorkScope(db, targetId);
    return (
      !!source &&
      !!target &&
      (source.rootTaskId === target.rootTaskId || (!!source.projectId && source.projectId === target.projectId))
    );
  }

  app.get("/api/agent-messages", (req, res) => {
    const actor = authenticate(req, res);
    if (!actor) return;
    // Reference access never grants the agent general task/CEO API credentials.
    if (typeof req.query.reference_task_id === "string") {
      const referenceId = req.query.reference_task_id;
      if (!isRelated(actor.taskId, referenceId)) return res.status(403).json({ error: "unrelated_task" });
      const task = db.prepare("SELECT id, title, description FROM tasks WHERE id = ?").get(referenceId) as {
        id: string;
        title: string;
        description: string | null;
      };
      const offset = Number(req.query.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: "invalid_offset" });
      const description = task.description ?? "";
      return res.json({
        reference: {
          id: task.id,
          title: task.title,
          description: description.slice(offset, offset + 8000),
          offset,
          total_chars: description.length,
        },
      });
    }
    const after = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "invalid_cursor" });
    const notes = loadAgentNotes(db, actor.taskId, after);
    const bounded = buildAgentInboxBlock(notes);
    const visible = notes.filter((note) => note.id <= bounded.through);
    return res.json({ notes: visible, next_cursor: bounded.through || after });
  });

  app.post("/api/agent-messages", (req, res) => {
    const actor = authenticate(req, res);
    if (!actor) return;
    const body = req.body ?? {};
    if (body.acknowledge_through !== undefined) {
      const through = body.acknowledge_through;
      if (!Number.isSafeInteger(through) || through < 0 || body.content !== undefined)
        return res.status(400).json({ error: "invalid_acknowledgement" });
      acknowledgeAgentNotes(db, actor.taskId, through, nowMs());
      return res.json({ ok: true });
    }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (
      !content ||
      content.length > AGENT_NOTE_MAX_CHARS ||
      // eslint-disable-next-line no-control-regex -- notes must not contain control characters
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)
    ) {
      return res.status(400).json({ error: "invalid_note", max_chars: AGENT_NOTE_MAX_CHARS });
    }
    const toTask = typeof body.to_task_id === "string" ? body.to_task_id : "";
    const toAgent = typeof body.to_agent_id === "string" ? body.to_agent_id : "";
    if (!!toTask === !!toAgent) return res.status(400).json({ error: "one_recipient_required" });
    const targets = (
      toTask
        ? db.prepare("SELECT id, assigned_agent_id, status FROM tasks WHERE id = ?").all(toTask)
        : db
            .prepare(
              "SELECT id, assigned_agent_id, status FROM tasks WHERE assigned_agent_id = ? AND status IN ('in_progress', 'pending', 'planned', 'collaborating') ORDER BY updated_at DESC LIMIT 100",
            )
            .all(toAgent)
    ) as TaskRecipient[];
    const related = targets.filter((target) => target.id !== actor.taskId && isRelated(actor.taskId, target.id));
    if (related.length !== 1)
      return res
        .status(related.length ? 409 : 403)
        .json({ error: related.length ? "ambiguous_recipient_use_task_id" : "unrelated_or_missing_recipient" });
    const target = related[0];
    if (!target.assigned_agent_id || ["done", "cancelled"].includes(target.status))
      return res.status(409).json({ error: "recipient_unavailable" });
    const now = nowMs();
    const recent = db
      .prepare(
        "SELECT COUNT(*) AS count FROM task_agent_notes n JOIN messages m ON m.id = n.message_id WHERE n.source_task_id = ? AND m.created_at >= ?",
      )
      .get(actor.taskId, now - 60000) as { count: number };
    const pending = db
      .prepare("SELECT COUNT(*) AS count FROM task_agent_notes WHERE target_task_id = ? AND delivered_at IS NULL")
      .get(target.id) as { count: number };
    if (recent.count >= 30 || pending.count >= 100) return res.status(429).json({ error: "agent_note_limit" });
    const messageId = randomUUID();
    const displayContent = `[Agent note: ${actor.taskId} → ${target.id}]\n${content}`;
    db.exec("SAVEPOINT agent_note_write");
    let noteId: number;
    try {
      db.prepare(
        "INSERT INTO messages (id, sender_type, sender_id, receiver_type, receiver_id, content, message_type, task_id, created_at) VALUES (?, 'agent', ?, 'agent', ?, ?, 'chat', ?, ?)",
      ).run(messageId, actor.agentId, target.assigned_agent_id, displayContent, target.id, now);
      const inserted = db
        .prepare("INSERT INTO task_agent_notes (message_id, source_task_id, target_task_id) VALUES (?, ?, ?)")
        .run(messageId, actor.taskId, target.id);
      noteId = Number(inserted.lastInsertRowid);
      appendTaskLog(actor.taskId, "agent_note", displayContent);
      appendTaskLog(target.id, "agent_note", displayContent);
      db.exec("RELEASE agent_note_write");
    } catch (error) {
      db.exec("ROLLBACK TO agent_note_write; RELEASE agent_note_write");
      throw error;
    }
    const message = db
      .prepare(
        "SELECT m.*, a.name AS sender_name, a.avatar_emoji AS sender_avatar FROM messages m LEFT JOIN agents a ON a.id = m.sender_id WHERE m.id = ?",
      )
      .get(messageId);
    broadcast("new_message", message);
    return res.json({ ok: true, note_id: noteId, message_id: messageId, target_task_id: target.id });
  });
}
