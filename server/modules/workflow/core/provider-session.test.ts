import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliTools } from "./cli-tools.ts";
import { createProviderSessionCapture, readProviderSession } from "./provider-session.ts";

let db: DatabaseSync;
let directory: string;
afterEach(() => {
  db?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe("provider session recovery", () => {
  it.each([
    ["codex", { type: "thread.started", thread_id: "native-codex" }],
    ["claude", { type: "system", subtype: "init", session_id: "native-claude" }],
    ["gemini", { type: "init", session_id: "native-gemini" }],
    ["opencode", { type: "step_start", sessionID: "ses_native" }],
    ["kimi", { type: "init", session_id: "native-kimi" }],
  ])("captures split %s JSONL and restores the native ID after runtime loss", (provider, event) => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE task_logs(task_id TEXT,message TEXT)");
    const persisted = vi.fn((id: string) =>
      db
        .prepare("INSERT INTO task_logs VALUES (?,?)")
        .run("task", "Provider session: " + JSON.stringify({ provider, id })),
    );
    const capture = createProviderSessionCapture(provider, persisted);
    const line = JSON.stringify(event) + "\n";
    capture(line.slice(0, 10));
    capture(line.slice(10));
    capture(line);
    expect(persisted).toHaveBeenCalledOnce();
    const native = readProviderSession(db, "task", provider, "/missing/log");
    expect(native).toBe(persisted.mock.calls[0][0]);
    const args = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 }).buildAgentArgs(
      provider,
      "model",
      "high",
      { resumeSessionId: native! },
    );
    if (provider === "codex")
      expect(args.slice(args.indexOf("exec"))).toEqual(["exec", "resume", "native-codex", "--json"]);
    else
      expect(args).toEqual(
        expect.arrayContaining([["opencode", "kimi"].includes(provider) ? "--session" : "--resume", native]),
      );
  });

  it("recovers older Codex runs from their terminal log and never guesses the last session", () => {
    directory = fs.mkdtempSync(path.join(process.env.LOGS_DIR!, "native-session-"));
    const log = path.join(directory, "task.log");
    fs.writeFileSync(log, 'header\n{"type":"thread.started","thread_id":"legacy-id"}\npartial');
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE task_logs(task_id TEXT,message TEXT)");
    expect(readProviderSession(db, "task", "codex", log)).toBe("legacy-id");
    expect(readProviderSession(db, "task", "claude", log)).toBeNull();
    expect(readProviderSession(db, "task", "api", log)).toBeNull();
  });

  it("does not reuse a session saved for another provider", () => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE task_logs(task_id TEXT,message TEXT)");
    db.prepare("INSERT INTO task_logs VALUES (?,?)").run(
      "task",
      'Provider session: {"provider":"claude","id":"claude-id"}',
    );
    expect(readProviderSession(db, "task", "codex", "/missing")).toBeNull();
  });
});
