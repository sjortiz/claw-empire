import type { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinationDb, coordinationLocalizers } from "../agent-coordination-fixture.ts";
import { registerAgentMessageRoutes } from "../../modules/routes/core/tasks/agent-messages.ts";
import { buildAgentMessageToken } from "../../security/agent-messages.ts";
import { installSecurityMiddleware } from "../../security/auth.ts";
import {
  buildAgentCoordinationContext,
  continueTaskForAgentNotes,
} from "../../modules/workflow/core/agent-coordination.ts";
import { hasUnreadAgentNotes } from "../../modules/workflow/core/agent-message-inbox.ts";

describe("QA acceptance: durable peer-note lifecycle", () => {
  let db: DatabaseSync;
  let app: express.Express;
  let clock: number;
  let failTargetLog: boolean;
  const broadcast = vi.fn();
  const sessions = new Map([
    ["source", { sessionId: "source-session", agentId: "alpha" }],
    ["target", { sessionId: "target-session", agentId: "beta" }],
  ]);
  beforeEach(() => {
    db = createCoordinationDb();
    clock = 100000;
    failTargetLog = false;
    broadcast.mockClear();
    app = express();
    installSecurityMiddleware(app);
    registerAgentMessageRoutes({
      app,
      db,
      nowMs: () => clock,
      taskExecutionSessions: sessions,
      broadcast,
      appendTaskLog: (taskId, kind, message) => {
        if (failTargetLog && taskId === "target") throw new Error("injected log write failure");
        db.prepare("INSERT INTO task_logs(task_id,kind,message) VALUES (?,?,?)").run(taskId, kind, message);
      },
    });
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "test_write_failure" });
    });
  });
  afterEach(() => db.close());

  function send(content = "Reuse my branch.", extra: Record<string, unknown> = {}) {
    return request(app)
      .post("/api/agent-messages")
      .set("Authorization", `Bearer ${buildAgentMessageToken("source", "source-session")}`)
      .send({ task_id: "source", session_id: "source-session", to_task_id: "target", content, ...extra });
  }
  function inbox(after = 0) {
    return request(app)
      .get("/api/agent-messages")
      .set("Authorization", `Bearer ${buildAgentMessageToken("target", "target-session")}`)
      .query({ task_id: "target", session_id: "target-session", after });
  }
  const counts = () =>
    ["messages", "task_agent_notes", "task_logs"].map(
      (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
    );

  it("rolls back the chat, inbox and sender log together if the recipient log cannot be saved", async () => {
    const before = counts();
    failTargetLog = true;
    expect((await send()).status).toBe(500);
    expect(counts()).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
    failTargetLog = false;
    expect((await send()).status).toBe(200);
    expect(counts()).toEqual([1, 1, 2]);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("pages complete maximum-size notes without gaps or duplicates at identical timestamps", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 14; index++) {
      const prefix = `${index}: `;
      const result = await send(`${prefix}${"x".repeat(2000 - prefix.length)}`);
      expect(result.status).toBe(200);
      ids.push(result.body.note_id);
    }
    const seen: number[] = [];
    let after = 0;
    for (let pageIndex = 0; pageIndex < 15; pageIndex++) {
      const page = await inbox(after);
      expect(page.status).toBe(200);
      if (!page.body.notes.length) break;
      for (const note of page.body.notes) {
        expect(note.content).toMatch(/\d+: x+$/);
        expect(note.content.split("\n")[1]).toHaveLength(2000);
        seen.push(note.id);
      }
      expect(page.body.next_cursor).toBeGreaterThan(after);
      after = page.body.next_cursor;
    }
    expect(seen).toEqual(ids);
    expect(hasUnreadAgentNotes(db, "target")).toBe(true);
  });

  it("caps the recipient backlog independently of the sender's rolling minute quota", async () => {
    for (let index = 0; index < 100; index++) {
      clock += 61000;
      expect((await send(`note ${index}`)).status).toBe(200);
    }
    clock += 61000;
    expect((await send()).status).toBe(429);
    const first = await inbox();
    expect(first.body.notes).toHaveLength(12);
    expect(
      (
        await request(app)
          .post("/api/agent-messages")
          .set("Authorization", `Bearer ${buildAgentMessageToken("target", "target-session")}`)
          .send({ task_id: "target", session_id: "target-session", acknowledge_through: first.body.next_cursor })
      ).status,
    ).toBe(200);
    expect((await send("room after acknowledgement")).status).toBe(200);
  });

  it("derives sender identity from the session even when body fields spoof another agent", async () => {
    expect((await send("real source", { sender_id: "beta", source_task_id: "unrelated" })).status).toBe(200);
    const page = await inbox();
    expect(page.body.notes[0]).toMatchObject({
      sender_id: "alpha",
      source_task_id: "source",
      target_task_id: "target",
    });
    expect((await send("double recipient", { to_agent_id: "beta" })).status).toBe(400);
    expect(counts()).toEqual([1, 1, 2]);
  });

  it("coordinates family members without project IDs but never authorizes by matching filesystem path alone", async () => {
    db.exec("UPDATE tasks SET project_id=NULL,project_path='/same/legacy/path'");
    expect((await send()).status).toBe(200);
    expect((await send("outside family", { to_task_id: "unrelated" })).status).toBe(403);
  });

  it("rejects final or unassigned recipients without writing partial artifacts", async () => {
    for (const status of ["done", "cancelled"]) {
      db.prepare("UPDATE tasks SET status=? WHERE id='target'").run(status);
      expect((await send()).status).toBe(409);
    }
    db.exec("UPDATE tasks SET status='pending',assigned_agent_id=NULL WHERE id='target'");
    expect((await send()).status).toBe(409);
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("delivers an actual posted late note in the recipient's next prompt without pausing", async () => {
    const session = { sessionId: "target-session", agentId: "beta" };
    const initial = buildAgentCoordinationContext(db, "target", session, "en", coordinationLocalizers, clock);
    expect(initial).not.toContain("PEER HELPER READY");
    expect((await send("PEER HELPER READY")).status).toBe(200);
    const start = vi.fn(() =>
      buildAgentCoordinationContext(db, "target", session, "en", coordinationLocalizers, clock),
    );
    expect(
      continueTaskForAgentNotes({ db, taskId: "target", exitCode: 0, session, stopped: false, start, log: vi.fn() }),
    ).toBe(true);
    expect(start.mock.results[0].value).toContain("PEER HELPER READY");
    expect(hasUnreadAgentNotes(db, "target")).toBe(false);
    expect(db.prepare("SELECT status FROM tasks WHERE id='target'").get()).toEqual({ status: "in_progress" });
  });
});
