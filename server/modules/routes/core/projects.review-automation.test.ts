import express from "express";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { registerProjectRoutes } from "./projects.ts";

describe("project review automation routes", () => {
  let db: DatabaseSync;
  let app: express.Express;

  beforeEach(() => {
    vi.stubEnv("PROJECT_PATH_ALLOWED_ROOTS", process.cwd());
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    db.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT");
    app = express();
    app.use(express.json());
    registerProjectRoutes({
      app,
      db,
      firstQueryValue: (value) => (typeof value === "string" ? value : undefined),
      normalizeTextField: (value) => (typeof value === "string" ? value.trim() || null : null),
      runInTransaction: (fn) => {
        db.exec("BEGIN");
        try {
          fn();
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      nowMs: () => 100,
    });
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  function createProject(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post("/api/projects")
      .send({
        name: "Review automation project",
        project_path: process.cwd(),
        core_goal: "Start review meetings without a CEO click",
        ...overrides,
      });
  }

  it.each([undefined, null, false, true])("round trips project override %s through all responses", async (value) => {
    const overrides = value === undefined ? {} : { review_meeting_auto_start: value, review_items_auto_apply: value };
    const created = await createProject(overrides);
    expect(created.status).toBe(200);
    const expected = { review_meeting_auto_start: value ?? null, review_items_auto_apply: value ?? null };
    expect(created.body.project).toMatchObject(expected);
    const id = created.body.project.id;
    const listed = await request(app).get("/api/projects");
    expect(listed.body.projects[0]).toMatchObject(expected);
    const detail = await request(app).get(`/api/projects/${id}`);
    expect(detail.body.project).toMatchObject(expected);
    const renamed = await request(app).patch(`/api/projects/${id}`).send({ name: "Renamed" });
    expect(renamed.body.project).toMatchObject(expected);
  });

  it("preserves independent overrides and restores global inheritance", async () => {
    const created = await createProject({ review_meeting_auto_start: true, review_items_auto_apply: false });
    const id = created.body.project.id;
    for (const value of [false, true, null]) {
      const updated = await request(app).patch(`/api/projects/${id}`).send({ review_meeting_auto_start: value });
      expect(updated.status).toBe(200);
      expect(updated.body.project).toMatchObject({ review_meeting_auto_start: value, review_items_auto_apply: false });
    }
    const updated = await request(app).patch(`/api/projects/${id}`).send({ review_items_auto_apply: null });
    expect(updated.body.project.review_items_auto_apply).toBeNull();
  });

  describe.each(["review_meeting_auto_start", "review_items_auto_apply"])("%s validation", (field) => {
    it.each([0, 1, "true", "false", "", {}, []])("rejects invalid override %j without other writes", async (value) => {
      const invalid = await createProject({ [field]: value });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe(`invalid_${field}`);
      expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toMatchObject({ count: 0 });
      const created = await createProject({ [field]: true });
      const id = created.body.project.id;
      const updated = await request(app)
        .patch(`/api/projects/${id}`)
        .send({ [field]: value, name: "Must not persist" });
      expect(updated.status).toBe(400);
      expect(updated.body.error).toBe(`invalid_${field}`);
      expect(db.prepare(`SELECT name, ${field} FROM projects WHERE id = ?`).get(id)).toMatchObject({
        name: "Review automation project",
        [field]: 1,
      });
    });
  });
});
