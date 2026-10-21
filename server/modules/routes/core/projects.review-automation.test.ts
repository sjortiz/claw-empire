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
      .send({ name: "Review project", project_path: process.cwd(), core_goal: "Review", ...overrides });
  }

  it("inherits by default and persists explicit overrides on create", async () => {
    const inherited = await createProject();
    expect(inherited.body.project).toMatchObject({ review_auto_start: null, review_auto_apply: null });
    db.exec("DELETE FROM projects");

    const created = await createProject({ review_auto_start: "on", review_auto_apply: "off" });
    expect(created.status).toBe(200);
    expect(created.body.project).toMatchObject({ review_auto_start: "on", review_auto_apply: "off" });
  });

  it("updates each override independently and can return to inheritance", async () => {
    const id = (await createProject({ review_auto_start: "on" })).body.project.id;
    const updated = await request(app).patch(`/api/projects/${id}`).send({ review_auto_apply: "on" });
    expect(updated.body.project).toMatchObject({ review_auto_start: "on", review_auto_apply: "on" });
    const reset = await request(app).patch(`/api/projects/${id}`).send({ review_auto_start: null });
    expect(reset.body.project).toMatchObject({ review_auto_start: null, review_auto_apply: "on" });
  });

  it.each([true, "true", "inherit", "", 1])("rejects invalid override %j on create and update", async (value) => {
    const invalid = await createProject({ review_auto_start: value });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_review_automation");
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toMatchObject({ count: 0 });

    const id = (await createProject()).body.project.id;
    const updated = await request(app)
      .patch(`/api/projects/${id}`)
      .send({ review_auto_apply: value, name: "Should not persist" });
    expect(updated.status).toBe(400);
    expect(db.prepare("SELECT name, review_auto_apply FROM projects").get()).toMatchObject({
      name: "Review project",
      review_auto_apply: null,
    });
  });
});
