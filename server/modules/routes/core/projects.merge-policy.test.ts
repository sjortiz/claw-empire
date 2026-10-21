import express from "express";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { registerProjectRoutes } from "./projects.ts";

describe("project merge policy routes", () => {
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

  function createProject(policy?: unknown) {
    return request(app)
      .post("/api/projects")
      .send({
        name: "Merge policy project",
        project_path: process.cwd(),
        core_goal: "Review approved task branches",
        ...(policy === undefined ? {} : { merge_policy: policy }),
      });
  }

  it.each([undefined, null, "auto", "manual"])("persists a new project's policy %s", async (policy) => {
    const response = await createProject(policy);
    expect(response.status).toBe(200);
    expect(response.body.project.merge_policy).toBe(policy ?? null);
    const listResponse = await request(app).get("/api/projects");
    expect(listResponse.body.projects[0].merge_policy).toBe(policy ?? null);
  });

  it("updates the override and can return to global inheritance without losing other fields", async () => {
    const response = await createProject("manual");
    const id = response.body.project.id;

    for (const policy of ["auto", "manual", null]) {
      const updated = await request(app).patch(`/api/projects/${id}`).send({ merge_policy: policy });
      expect(updated.status).toBe(200);
      expect(updated.body.project).toMatchObject({
        name: "Merge policy project",
        core_goal: "Review approved task branches",
        merge_policy: policy,
      });
    }

    const unchanged = await request(app).patch(`/api/projects/${id}`).send({ name: "Renamed" });
    expect(unchanged.body.project.merge_policy).toBeNull();
  });

  it.each(["inherit", "automatic", "", false, 1, {}, []])(
    "rejects invalid policy %j on create and update",
    async (policy) => {
      const invalid = await createProject(policy);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toBe("invalid_merge_policy");
      expect(db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toMatchObject({ count: 0 });

      const created = await createProject("manual");
      const updated = await request(app)
        .patch(`/api/projects/${created.body.project.id}`)
        .send({ merge_policy: policy, name: "Should not persist" });
      expect(updated.status).toBe(400);
      expect(updated.body.error).toBe("invalid_merge_policy");
      expect(
        db.prepare("SELECT name, merge_policy FROM projects WHERE id = ?").get(created.body.project.id),
      ).toMatchObject({
        name: "Merge policy project",
        merge_policy: "manual",
      });
    },
  );
});
