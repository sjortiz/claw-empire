import { recoverOrphanInProgressTasks } from "./workflow/core/run-recovery.ts";
import { sweepExpiredWorkflowWaits } from "./workflow/core/persistent-wait.ts";
import { sweepReadyRoots } from "./workflow/core/task-resume.ts";
import { resumeReviewsOnStartup } from "./workflow/core/review-startup.ts";
import type { RuntimeContext } from "../types/runtime-context.ts";
import type { IncomingMessage } from "node:http";
import type { WebSocket as WsSocket } from "ws";
import path from "path";
import { HOST, PKG_VERSION, PORT } from "../config/runtime.ts";
import { startDiscordReceiver } from "../messenger/discord-receiver.ts";
import { startTelegramReceiver } from "../messenger/telegram-receiver.ts";
import { registerGracefulShutdownHandlers } from "./lifecycle/register-graceful-shutdown.ts";

export function startLifecycle(ctx: RuntimeContext): void {
  const {
    IN_PROGRESS_ORPHAN_SWEEP_MS,
    SUBTASK_DELEGATION_SWEEP_MS,
    WebSocket,
    WebSocketServer,
    activeProcesses,
    app,
    appendTaskLog,
    broadcast,
    db,
    dbPath,
    detectAllCli,
    distDir,
    express,
    finishReview,
    getDecryptedOAuthToken,
    isAgentInMeeting,
    isIncomingMessageAuthenticated,
    isIncomingMessageOriginTrusted,
    isProduction,
    killPidTree,
    nowMs,
    processSubtaskDelegations,
    reconcileCrossDeptSubtasks,
    refreshGoogleToken,
    runInTransaction,
    stopRequestedTasks,
    wsClients,
  } = ctx as any;

  // ---------------------------------------------------------------------------
  // Production: serve React UI from dist/
  // ---------------------------------------------------------------------------
  if (isProduction) {
    app.use(express.static(distDir));
    // SPA fallback: serve index.html for non-API routes (Express 5 named wildcard)
    app.get(
      "/{*splat}",
      (
        req: { path: string },
        res: {
          status(code: number): { json(payload: unknown): unknown };
          sendFile(filePath: string): unknown;
        },
      ) => {
        if (req.path.startsWith("/api/") || req.path === "/health" || req.path === "/healthz") {
          return res.status(404).json({ error: "not_found" });
        }
        res.sendFile(path.join(distDir, "index.html"));
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Auto break rotation: idle ↔ break every 60s
  // ---------------------------------------------------------------------------
  function rotateBreaks(): void {
    // Rule: max 1 agent per department on break at a time
    const allAgents = db
      .prepare("SELECT id, department_id, status FROM agents WHERE status IN ('idle','break')")
      .all() as { id: string; department_id: string; status: string }[];

    if (allAgents.length === 0) return;

    // Meeting/CEO-office summoned agents should stay in office, not break room.
    for (const a of allAgents) {
      if (a.status === "break" && isAgentInMeeting(a.id)) {
        db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
      }
    }

    const candidates = allAgents.filter((a) => !isAgentInMeeting(a.id));
    if (candidates.length === 0) return;

    // Group by department
    const byDept = new Map<string, typeof candidates>();
    for (const a of candidates) {
      const list = byDept.get(a.department_id) || [];
      list.push(a);
      byDept.set(a.department_id, list);
    }

    for (const [, members] of byDept) {
      const onBreak = members.filter((a) => a.status === "break");
      const idle = members.filter((a) => a.status === "idle");

      if (onBreak.length > 1) {
        // Too many on break from same dept — return extras to idle
        const extras = onBreak.slice(1);
        for (const a of extras) {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id));
        }
      } else if (onBreak.length === 1) {
        // 40% chance to return from break (avg ~2.5 min break)
        if (Math.random() < 0.4) {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(onBreak[0].id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(onBreak[0].id));
        }
      } else if (onBreak.length === 0 && idle.length > 0) {
        // 50% chance to send one idle agent on break
        if (Math.random() < 0.5) {
          const pick = idle[Math.floor(Math.random() * idle.length)];
          db.prepare("UPDATE agents SET status = 'break' WHERE id = ?").run(pick.id);
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(pick.id));
        }
      }
    }
  }

  function pruneDuplicateReviewMeetings(): void {
    const rows = db
      .prepare(
        `
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY task_id, round, status
          ORDER BY started_at DESC, created_at DESC, id DESC
        ) AS rn
      FROM meeting_minutes
      WHERE meeting_type = 'review'
        AND status IN ('in_progress', 'failed')
    )
    SELECT id
    FROM ranked
    WHERE rn > 1
  `,
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;

    const delEntries = db.prepare("DELETE FROM meeting_minute_entries WHERE meeting_id = ?");
    const delMeetings = db.prepare("DELETE FROM meeting_minutes WHERE id = ?");
    runInTransaction(() => {
      for (const id of rows.map((r) => r.id)) {
        delEntries.run(id);
        delMeetings.run(id);
      }
    });
  }

  type InProgressRecoveryReason = "startup" | "interval";

  function recoverOrphanWorkingAgents(reason: InProgressRecoveryReason): void {
    const workingAgents = db
      .prepare(
        `
    SELECT
      a.id AS agent_id,
      a.name AS agent_name,
      a.current_task_id,
      t.id AS task_id,
      t.status AS task_status
    FROM agents a
    LEFT JOIN tasks t ON t.id = a.current_task_id
    WHERE a.status = 'working'
      AND a.current_task_id IS NOT NULL
      AND TRIM(a.current_task_id) != ''
    ORDER BY a.name ASC
  `,
      )
      .all() as Array<{
      agent_id: string;
      agent_name: string | null;
      current_task_id: string;
      task_id: string | null;
      task_status: string | null;
    }>;

    for (const row of workingAgents) {
      const normalizedTaskStatus = String(row.task_status ?? "")
        .trim()
        .toLowerCase();
      if (row.task_id && normalizedTaskStatus === "in_progress") continue;

      const staleReason = row.task_id ? `task_status_${normalizedTaskStatus || "unknown"}` : "task_missing";
      const cleared = db
        .prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?")
        .run(row.agent_id, row.current_task_id) as { changes?: number };
      if ((cleared.changes ?? 0) === 0) continue;

      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(row.agent_id));
      console.warn(
        `[Claw-Empire] Recovery (${reason}): cleared stale working agent ${row.agent_id} (${row.agent_name || "unknown"}) -> ${row.current_task_id} (${staleReason})`,
      );
    }
  }

  function recoverInterruptedWorkflowOnStartup(): void {
    pruneDuplicateReviewMeetings();
    try {
      reconcileCrossDeptSubtasks();
    } catch (err) {
      console.error("[Claw-Empire] startup reconciliation failed:", err);
    }

    recoverOrphanInProgressTasks(ctx, "startup");
    recoverOrphanWorkingAgents("startup");

    resumeReviewsOnStartup({ db, finishReview, appendTaskLog });
  }

  function sweepPendingSubtaskDelegations(): void {
    const parents = db
      .prepare(
        `
    SELECT DISTINCT t.id
    FROM tasks t
    JOIN subtasks s ON s.task_id = t.id
    WHERE t.status IN ('planned', 'pending', 'collaborating', 'in_progress', 'review')
      AND s.target_department_id IS NOT NULL
      AND s.status NOT IN ('done', 'cancelled')
      AND (s.delegated_task_id IS NULL OR s.delegated_task_id = '')
    ORDER BY t.updated_at ASC
    LIMIT 80
  `,
      )
      .all() as Array<{ id: string }>;

    for (const row of parents) {
      if (!row.id) continue;
      processSubtaskDelegations(row.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-assign agent providers on startup
  // ---------------------------------------------------------------------------
  async function autoAssignAgentProviders(): Promise<void> {
    const autoAssignRow = db.prepare("SELECT value FROM settings WHERE key = 'autoAssign'").get() as
      | { value: string }
      | undefined;
    if (!autoAssignRow || autoAssignRow.value === "false") return;

    const cliStatus = (await detectAllCli()) as Record<string, { installed?: boolean; authenticated?: boolean }>;
    const authenticated = Object.entries(cliStatus)
      .filter(([, s]) => s.installed && s.authenticated)
      .map(([name]) => name);

    if (authenticated.length === 0) {
      console.log("[Claw-Empire] Auto-assign skipped: no authenticated CLI providers");
      return;
    }

    const dpRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider'").get() as
      | { value: string }
      | undefined;
    const defaultProv = dpRow?.value?.replace(/"/g, "") || "claude";
    const fallback = authenticated.includes(defaultProv) ? defaultProv : authenticated[0];

    const agents = db.prepare("SELECT id, name, cli_provider FROM agents").all() as Array<{
      id: string;
      name: string;
      cli_provider: string | null;
    }>;

    let count = 0;
    for (const agent of agents) {
      const prov = agent.cli_provider || "";
      if (prov === "copilot" || prov === "antigravity" || prov === "api") continue;
      if (authenticated.includes(prov)) continue;

      db.prepare("UPDATE agents SET cli_provider = ? WHERE id = ?").run(fallback, agent.id);
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id));
      console.log(`[Claw-Empire] Auto-assigned ${agent.name}: ${prov || "none"} → ${fallback}`);
      count++;
    }
    if (count > 0) console.log(`[Claw-Empire] Auto-assigned ${count} agent(s)`);
  }

  // Run rotation every 60 seconds, and once on startup after 5s
  setTimeout(rotateBreaks, 5_000);
  setInterval(rotateBreaks, 60_000);
  setTimeout(recoverInterruptedWorkflowOnStartup, 3_000);
  setInterval(() => recoverOrphanInProgressTasks(ctx, "interval"), IN_PROGRESS_ORPHAN_SWEEP_MS);
  setInterval(() => recoverOrphanWorkingAgents("interval"), IN_PROGRESS_ORPHAN_SWEEP_MS);
  setTimeout(() => sweepExpiredWorkflowWaits(ctx), 4_000);
  setInterval(() => sweepExpiredWorkflowWaits(ctx), SUBTASK_DELEGATION_SWEEP_MS);
  setTimeout(() => sweepReadyRoots(ctx), 4_000);
  setInterval(() => sweepReadyRoots(ctx), SUBTASK_DELEGATION_SWEEP_MS);
  setTimeout(sweepPendingSubtaskDelegations, 4_000);
  setInterval(sweepPendingSubtaskDelegations, SUBTASK_DELEGATION_SWEEP_MS);
  setTimeout(autoAssignAgentProviders, 4_000);
  const telegramReceiver = startTelegramReceiver({ db });
  const discordReceiver = startDiscordReceiver({ db });

  // ---------------------------------------------------------------------------
  // Start HTTP server + WebSocket
  // ---------------------------------------------------------------------------
  const server = app.listen(PORT, HOST, () => {
    console.log(`[Claw-Empire] v${PKG_VERSION} listening on http://${HOST}:${PORT} (db: ${dbPath})`);
    if (isProduction) {
      console.log(`[Claw-Empire] mode: production (serving UI from ${distDir})`);
    } else {
      console.log(`[Claw-Empire] mode: development (UI served by Vite on separate port)`);
    }
  });

  // Background token refresh: check every 5 minutes for tokens expiring within 5 minutes
  setInterval(
    async () => {
      try {
        const cred = getDecryptedOAuthToken("google_antigravity");
        if (!cred || !cred.refreshToken) return;
        const expiresAtMs = cred.expiresAt && cred.expiresAt < 1e12 ? cred.expiresAt * 1000 : cred.expiresAt;
        if (!expiresAtMs) return;
        // Refresh if expiring within 5 minutes
        if (expiresAtMs < Date.now() + 5 * 60_000) {
          await refreshGoogleToken(cred);
          console.log("[oauth] Background refresh: Antigravity token renewed");
        }
      } catch (err) {
        console.error("[oauth] Background refresh failed:", err instanceof Error ? err.message : err);
      }
    },
    5 * 60 * 1000,
  );

  // WebSocket server on same HTTP server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WsSocket, req: IncomingMessage) => {
    if (!isIncomingMessageOriginTrusted(req) || !isIncomingMessageAuthenticated(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    wsClients.add(ws);
    console.log(`[Claw-Empire] WebSocket client connected (total: ${wsClients.size})`);

    // Send initial state to the newly connected client
    ws.send(
      JSON.stringify({
        type: "connected",
        payload: {
          version: PKG_VERSION,
          app: "Claw-Empire",
        },
        ts: nowMs(),
      }),
    );

    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[Claw-Empire] WebSocket client disconnected (total: ${wsClients.size})`);
    });

    ws.on("error", () => {
      wsClients.delete(ws);
    });
  });

  registerGracefulShutdownHandlers({
    activeProcesses,
    stopRequestedTasks,
    killPidTree,
    db,
    wsClients,
    wss,
    server,
    onBeforeClose: () => {
      (ctx as any).shuttingDown = true;
      telegramReceiver.stop();
      discordReceiver.stop();
    },
  });
}
