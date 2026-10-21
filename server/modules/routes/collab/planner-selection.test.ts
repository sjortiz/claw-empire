import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { selectPlanningAgent } from "./planner-selection.ts";

let db: DatabaseSync;
afterEach(() => db?.close());
function fixture() {
  db = new DatabaseSync(":memory:");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('planning', 'Planning', '기획', 'P', '#111');
    INSERT INTO agents (id, name, department_id, role, cli_provider, status) VALUES
      ('lead', 'Lead', 'planning', 'team_leader', 'codex', 'idle'),
      ('senior', 'Senior', 'planning', 'senior', 'codex', 'idle'),
      ('junior', 'Junior', 'planning', 'junior', 'codex', 'idle'),
      ('offline', 'Offline', 'planning', 'senior', 'codex', 'offline');
  `);
}
function assign(id: string, agentId: string, created = 1, status = "planned") {
  db.prepare("INSERT INTO tasks (id, title, assigned_agent_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    id,
    agentId,
    status,
    created,
  );
}

describe("planning load balancing", () => {
  it("reserves both leaders and seniors across roots before CLI status changes", () => {
    fixture();
    const first = selectPlanningAgent(db)!;
    expect(first.id).toBe("lead");
    assign("root-1", first.id);
    const second = selectPlanningAgent(db)!;
    expect(second.id).toBe("senior");
    assign("root-2", second.id, 2);
    expect(selectPlanningAgent(db)?.id).toBe("lead");
  });
  it("prefers idle capable agents, respects scope, and excludes juniors/offline", () => {
    fixture();
    db.prepare("UPDATE agents SET status = 'working' WHERE id = 'lead'").run();
    expect(selectPlanningAgent(db)?.id).toBe("senior");
    expect(selectPlanningAgent(db, ["lead"])?.id).toBe("lead");
    expect(selectPlanningAgent(db, ["junior", "offline"])).toBeNull();
    expect(selectPlanningAgent(db, [])).toBeNull();
  });
  it("uses least assigned workload and rotates idle planners using completed history", () => {
    fixture();
    assign("recent", "lead", 5, "done");
    assign("older", "senior", 2, "done");
    expect(selectPlanningAgent(db)?.id).toBe("senior");
    assign("a", "lead", 6);
    assign("b", "lead", 7);
    assign("c", "senior", 8);
    expect(selectPlanningAgent(db)?.id).toBe("senior");
  });
  it("excludes planners from other workflow packs even without a constrained agent scope", () => {
    fixture();
    db.exec("UPDATE agents SET workflow_pack_key = 'report' WHERE id = 'lead'");
    expect(selectPlanningAgent(db)?.id).toBe("senior");
    expect(selectPlanningAgent(db, null, "report")?.id).toBe("lead");
    expect(selectPlanningAgent(db, ["lead"], "development")).toBeNull();
  });
  it("excludes disconnected OAuth planners and missing providers", () => {
    fixture();
    db.exec("UPDATE agents SET cli_provider = 'copilot' WHERE id = 'lead'");
    expect(selectPlanningAgent(db)?.id).toBe("senior");
    db.exec(
      "INSERT INTO oauth_accounts (id, provider, access_token_enc, status, created_at, updated_at) VALUES ('github', 'github', 'test', 'active', 1, 1)",
    );
    expect(selectPlanningAgent(db)?.id).toBe("lead");
    db.exec("UPDATE agents SET oauth_account_id = 'missing' WHERE id = 'lead'");
    expect(selectPlanningAgent(db)?.id).toBe("senior");
    db.exec("UPDATE agents SET cli_provider = NULL WHERE id = 'lead'");
    expect(selectPlanningAgent(db)?.id).toBe("senior");
  });
});
