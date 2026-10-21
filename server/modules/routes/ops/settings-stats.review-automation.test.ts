import express from "express";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { registerOpsSettingsStatsRoutes } from "./settings-stats.ts";

describe("review automation settings", () => {
  let db: DatabaseSync;
  let app: express.Express;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyBaseSchema(db);
    app = express();
    app.use(express.json());
    registerOpsSettingsStatsRoutes({ app, db, nowMs: () => 100 } as RuntimeContext);
  });
  afterEach(() => db.close());

  it("defaults both independent settings off", async () => {
    const response = await request(app).get("/api/settings");
    expect(response.body.settings).toMatchObject({ reviewMeetingAutoStart: false, reviewItemsAutoApply: false });
  });

  it("persists each boolean without enabling the other", async () => {
    await request(app).put("/api/settings").send({ reviewMeetingAutoStart: true }).expect(200);
    expect((await request(app).get("/api/settings")).body.settings).toMatchObject({
      reviewMeetingAutoStart: true,
      reviewItemsAutoApply: false,
    });
    await request(app)
      .put("/api/settings")
      .send({ reviewMeetingAutoStart: false, reviewItemsAutoApply: true })
      .expect(200);
    expect((await request(app).get("/api/settings")).body.settings).toMatchObject({
      reviewMeetingAutoStart: false,
      reviewItemsAutoApply: true,
    });
  });

  describe.each(["reviewMeetingAutoStart", "reviewItemsAutoApply"])("%s validation", (key) => {
    it.each([null, 0, 1, "true", "false", {}, []])("rejects nonboolean %j before writing", async (value) => {
      const response = await request(app)
        .put("/api/settings")
        .send({ unrelated: "must not persist", [key]: value });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(`invalid_${key}`);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'unrelated'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM settings WHERE key = ?").get(key)).toBeUndefined();
    });
  });
});
