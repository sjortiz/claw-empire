import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createCoordinationDb } from "../../../../test/agent-coordination-fixture.ts";
import { buildAgentMessageToken } from "../../../../security/agent-messages.ts";
import { buildTaskInterruptControlToken, installSecurityMiddleware } from "../../../../security/auth.ts";
import { SESSION_AUTH_TOKEN } from "../../../../config/runtime.ts";
import { hasUnreadAgentNotes } from "../../../workflow/core/agent-message-inbox.ts";
import { registerAgentMessageRoutes } from "./agent-messages.ts";

describe("local task agent messages", () => {
  let db: DatabaseSync;
  let app: express.Express;
  let sessions: Map<string, { sessionId: string; agentId: string }>;
  const broadcast = vi.fn();
  beforeEach(() => {
    db = createCoordinationDb();
    app = express();
    sessions = new Map([
      ["source", { sessionId: "source-session", agentId: "alpha" }],
      ["target", { sessionId: "target-session", agentId: "beta" }],
    ]);
    broadcast.mockClear();
    installSecurityMiddleware(app);
    registerAgentMessageRoutes({
      app,
      db,
      nowMs: () => 100000,
      taskExecutionSessions: sessions,
      broadcast,
      appendTaskLog: (taskId, kind, message) => {
        db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, ?, ?)").run(taskId, kind, message);
      },
    });
    app.get("/api/private-test", (_req, res) => res.json({ ok: true }));
  });
  afterEach(() => db.close());

  function send(extra: Record<string, unknown> = {}) {
    return request(app)
      .post("/api/agent-messages")
      .set("Authorization", `Bearer ${buildAgentMessageToken("source", "source-session")}`)
      .send({
        task_id: "source",
        session_id: "source-session",
        to_task_id: "target",
        content: "Reuse my completed helper; branch is ready.",
        ...extra,
      });
  }
  function inbox(taskId = "target", after = 0) {
    return request(app)
      .get("/api/agent-messages")
      .query({ task_id: taskId, session_id: `${taskId}-session`, after })
      .set("Authorization", `Bearer ${buildAgentMessageToken(taskId, `${taskId}-session`)}`);
  }
  it("delivers to a running task without pausing and persists chat and both task logs", async () => {
    const sent = await send();
    expect(sent.status).toBe(200);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'target'").get()).toMatchObject({ status: "in_progress" });
    const received = await inbox();
    expect(received.body.notes).toHaveLength(1);
    expect(received.body.notes[0]).toMatchObject({
      source_task_id: "source",
      target_task_id: "target",
      sender_id: "alpha",
    });
    expect(received.body.notes[0].content).toContain("Reuse my completed helper");
    expect((await inbox("source")).body.notes).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_logs WHERE kind = 'agent_note'").get()).toMatchObject({ n: 2 });
    expect(broadcast).toHaveBeenCalledWith(
      "new_message",
      expect.objectContaining({ sender_type: "agent", sender_id: "alpha", receiver_id: "beta", task_id: "target" }),
    );
    expect(hasUnreadAgentNotes(db, "target")).toBe(true);
  });
  it("rejects forged, stale, cross-task and CEO credentials without granting other APIs", async () => {
    const body = { task_id: "source", session_id: "source-session", to_task_id: "target", content: "note" };
    for (const token of [
      "",
      SESSION_AUTH_TOKEN,
      buildTaskInterruptControlToken("source", "source-session"),
      buildAgentMessageToken("target", "target-session"),
    ]) {
      expect(
        (await request(app).post("/api/agent-messages").set("Authorization", `Bearer ${token}`).send(body)).status,
      ).toBe(403);
    }
    sessions.set("source", { sessionId: "rotated-session", agentId: "alpha" });
    expect((await send()).status).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/private-test")
          .set("Authorization", `Bearer ${buildAgentMessageToken("source", "rotated-session")}`)
      ).status,
    ).toBe(401);
  });
  it("rejects non-loopback sockets, external hosts, browser origins and forwarded requests", async () => {
    for (const [name, value] of [
      ["Host", "example.test"],
      ["Origin", "http://localhost:8800"],
      ["X-Forwarded-For", "203.0.113.2"],
      ["Forwarded", "for=203.0.113.2"],
    ]) {
      expect((await send().set(name, value)).status).toBe(403);
    }
    const remoteApp = express();
    remoteApp.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: "203.0.113.2", configurable: true });
      next();
    });
    installSecurityMiddleware(remoteApp);
    registerAgentMessageRoutes({
      app: remoteApp,
      db,
      nowMs: () => 1,
      taskExecutionSessions: sessions,
      broadcast,
      appendTaskLog: vi.fn(),
    });
    expect(
      (
        await request(remoteApp)
          .get("/api/agent-messages")
          .query({ task_id: "source", session_id: "source-session" })
          .set("Authorization", `Bearer ${buildAgentMessageToken("source", "source-session")}`)
      ).status,
    ).toBe(403);
  });
  it("rejects unrelated recipients and stale assignment/status", async () => {
    expect((await send({ to_task_id: "unrelated" })).status).toBe(403);
    expect((await send({ to_task_id: "source" })).status).toBe(403);
    db.prepare("UPDATE tasks SET assigned_agent_id = 'beta' WHERE id = 'source'").run();
    expect((await send()).status).toBe(409);
    db.prepare("UPDATE tasks SET assigned_agent_id = 'alpha', status = 'pending' WHERE id = 'source'").run();
    expect((await send()).status).toBe(409);
  });
  it("resolves an agent to its related task and requires task id for ambiguity", async () => {
    expect((await send({ to_task_id: undefined, to_agent_id: "beta" })).status).toBe(200);
    db.exec(
      "INSERT INTO tasks(id,title,assigned_agent_id,project_id,status) VALUES ('second-target','Second','beta','project','in_progress')",
    );
    expect((await send({ to_task_id: undefined, to_agent_id: "beta" })).status).toBe(409);
    expect((await send()).status).toBe(200);
  });
  it("bounds content and rate, and paginates without timestamp collisions", async () => {
    for (const content of ["", "a".repeat(2001), "bad\u0000note"]) expect((await send({ content })).status).toBe(400);
    for (let n = 0; n < 30; n++) expect((await send({ content: `note ${n}` })).status).toBe(200);
    expect((await send()).status).toBe(429);
    const page = await inbox();
    expect(page.body.notes).toHaveLength(12);
    const second = await inbox("target", page.body.next_cursor);
    expect(second.body.notes[0].id).toBeGreaterThan(page.body.next_cursor);
    expect((await inbox("target", -1)).status).toBe(400);
  });
  it("acknowledges only the authenticated task inbox", async () => {
    const sent = await send();
    const noteId = sent.body.note_id;
    const ack = (taskId: string) =>
      request(app)
        .post("/api/agent-messages")
        .set("Authorization", `Bearer ${buildAgentMessageToken(taskId, `${taskId}-session`)}`)
        .send({ task_id: taskId, session_id: `${taskId}-session`, acknowledge_through: noteId });
    expect((await ack("source")).status).toBe(200);
    expect(hasUnreadAgentNotes(db, "target")).toBe(true);
    expect((await ack("target")).status).toBe(200);
    expect(hasUnreadAgentNotes(db, "target")).toBe(false);
  });
  it("provides bounded read-only parent reference pages with the same scope checks", async () => {
    db.prepare("UPDATE tasks SET description = ? WHERE id = 'parent'").run("x".repeat(16001));
    const ref = (id: string, offset = 0) => inbox().query({ reference_task_id: id, offset });
    expect((await ref("parent")).body.reference.description).toHaveLength(8000);
    expect((await ref("parent", 16000)).body.reference.description).toBe("x");
    expect((await ref("unrelated")).status).toBe(403);
    expect((await ref("parent", -1)).status).toBe(400);
  });
});
