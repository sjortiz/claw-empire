import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { registerOpsSettingsStatsRoutes } from "./settings-stats.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🏢',
      color TEXT NOT NULL DEFAULT '#64748b',
      description TEXT,
      prompt TEXT,
      sort_order INTEGER NOT NULL DEFAULT 99,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT,
      role TEXT NOT NULL DEFAULT 'senior',
      acts_as_planning_leader INTEGER NOT NULL DEFAULT 0,
      cli_provider TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      personality TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      current_task_id TEXT,
      stats_tasks_done INTEGER NOT NULL DEFAULT 0,
      stats_xp INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      sprite_number INTEGER,
      cli_model TEXT,
      cli_reasoning_level TEXT
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT,
      department_id TEXT,
      title TEXT,
      updated_at INTEGER,
      assigned_agent_id TEXT
    );

    CREATE TABLE task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function createHarness(db: DatabaseSync) {
  const getRoutes = new Map<string, RouteHandler>();
  const putRoutes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      getRoutes.set(path, handler);
      return this;
    },
    put(path: string, handler: RouteHandler) {
      putRoutes.set(path, handler);
      return this;
    },
  };

  registerOpsSettingsStatsRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
  } as any);

  return { getRoutes, putRoutes };
}

describe("ops settings seed init guard", () => {
  it("서버 재시작 시 officePackProfiles가 있어도 seed agent를 대량 주입하지 않는다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning" }],
            agents: [{ id: "video_preprod-seed-1", department_id: "planning" }],
          },
        }),
      );
      db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("dev-leader", "Dev Leader");

      createHarness(db);

      const totalAgents = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
      const seedAgents = (
        db.prepare("SELECT COUNT(*) AS c FROM agents WHERE id LIKE '%-seed-%'").get() as {
          c: number;
        }
      ).c;
      const initFlag = db.prepare("SELECT value FROM settings WHERE key = 'officePackSeedAgentsInitialized'").get() as
        | { value: string }
        | undefined;

      expect(totalAgents).toBe(1);
      expect(seedAgents).toBe(0);
      expect(initFlag?.value).toBe("true");
    } finally {
      db.close();
    }
  });

  it("PUT /api/settings 로 officePackProfiles 저장해도 seed agent를 주입하지 않는다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("dev-leader", "Dev Leader");
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");
      expect(putHandler).toBeTypeOf("function");

      const res = createFakeResponse();
      putHandler?.(
        {
          body: {
            officePackProfiles: {
              video_preprod: {
                departments: [{ id: "planning" }],
                agents: [{ id: "video_preprod-seed-1", department_id: "planning" }],
              },
            },
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);

      const totalAgents = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
      const seedAgents = (
        db.prepare("SELECT COUNT(*) AS c FROM agents WHERE id LIKE '%-seed-%'").get() as {
          c: number;
        }
      ).c;
      const initFlag = db.prepare("SELECT value FROM settings WHERE key = 'officePackSeedAgentsInitialized'").get() as
        | { value: string }
        | undefined;

      expect(totalAgents).toBe(1);
      expect(seedAgents).toBe(0);
      expect(initFlag?.value).toBe("true");
    } finally {
      db.close();
    }
  });

  it("GET /api/settings 시 활성 오피스팩 seed를 1회 hydrate한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning", name: "Planning", name_ko: "기획팀", icon: "🎬", color: "#f59e0b" }],
            agents: [
              {
                id: "video_preprod-seed-1",
                name: "Rian",
                name_ko: "리안",
                department_id: "planning",
                role: "team_leader",
                cli_provider: "claude",
                avatar_emoji: "🎬",
                sprite_number: 6,
              },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officeWorkflowPack",
        JSON.stringify("video_preprod"),
      );

      const { getRoutes } = createHarness(db);
      const getHandler = getRoutes.get("/api/settings");
      expect(getHandler).toBeTypeOf("function");

      const res = createFakeResponse();
      getHandler?.({}, res);
      expect(res.statusCode).toBe(200);

      const seedAgent = db.prepare("SELECT id, sprite_number FROM agents WHERE id = 'video_preprod-seed-1'").get() as
        | { id?: string; sprite_number?: number }
        | undefined;
      const hydratedPacks = db.prepare("SELECT value FROM settings WHERE key = 'officePackHydratedPacks'").get() as
        | { value: string }
        | undefined;

      expect(seedAgent?.id).toBe("video_preprod-seed-1");
      expect(seedAgent?.sprite_number).toBe(6);
      expect(hydratedPacks?.value).toContain("video_preprod");
    } finally {
      db.close();
    }
  });

  it("officeWorkflowPack 첫 선택 시 해당 팩 seed를 1회 hydrate한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("dev-leader", "Dev Leader");
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");
      expect(putHandler).toBeTypeOf("function");

      const res = createFakeResponse();
      putHandler?.(
        {
          body: {
            officePackProfiles: {
              video_preprod: {
                departments: [
                  {
                    id: "planning",
                    name: "Planning",
                    name_ko: "기획팀",
                    icon: "🎬",
                    color: "#f59e0b",
                  },
                ],
                agents: [
                  {
                    id: "video_preprod-seed-1",
                    name: "Rian",
                    name_ko: "리안",
                    department_id: "planning",
                    role: "team_leader",
                    cli_provider: "claude",
                    avatar_emoji: "🎬",
                  },
                ],
              },
            },
            officeWorkflowPack: "video_preprod",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);

      const seedAgentCount = (
        db.prepare("SELECT COUNT(*) AS c FROM agents WHERE id LIKE 'video_preprod-seed-%'").get() as {
          c: number;
        }
      ).c;
      const hydratedPacks = db.prepare("SELECT value FROM settings WHERE key = 'officePackHydratedPacks'").get() as
        | { value: string }
        | undefined;

      expect(seedAgentCount).toBe(1);
      expect(hydratedPacks?.value).toContain("video_preprod");
    } finally {
      db.close();
    }
  });

  it("이미 hydrate된 팩은 재선택해도 재주입하지 않는다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("dev-leader", "Dev Leader");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning", name: "Planning", name_ko: "기획팀", icon: "🎬", color: "#f59e0b" }],
            agents: [
              {
                id: "video_preprod-seed-1",
                name: "Rian",
                name_ko: "리안",
                department_id: "planning",
                role: "team_leader",
                cli_provider: "claude",
                avatar_emoji: "🎬",
              },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackHydratedPacks",
        JSON.stringify(["video_preprod"]),
      );

      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");
      expect(putHandler).toBeTypeOf("function");

      // 해고된 상태를 가정(= seed 없음)
      db.prepare("DELETE FROM agents WHERE id LIKE 'video_preprod-seed-%'").run();

      const res = createFakeResponse();
      putHandler?.({ body: { officeWorkflowPack: "video_preprod" } }, res);
      expect(res.statusCode).toBe(200);

      const seedAgentCount = (
        db.prepare("SELECT COUNT(*) AS c FROM agents WHERE id LIKE 'video_preprod-seed-%'").get() as {
          c: number;
        }
      ).c;
      expect(seedAgentCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("이미 hydrate된 팩은 officePackProfiles와 함께 저장해도 재주입하지 않는다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("dev-leader", "Dev Leader");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning", name: "Planning", name_ko: "기획팀", icon: "🎬", color: "#f59e0b" }],
            agents: [
              {
                id: "video_preprod-seed-1",
                name: "Rian",
                name_ko: "리안",
                department_id: "planning",
                role: "team_leader",
                cli_provider: "claude",
                avatar_emoji: "🎬",
              },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackHydratedPacks",
        JSON.stringify(["video_preprod"]),
      );

      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");
      expect(putHandler).toBeTypeOf("function");

      // 이미 hydrate된 팩의 seed를 비운 상태를 가정
      db.prepare("DELETE FROM agents WHERE id LIKE 'video_preprod-seed-%'").run();

      const res = createFakeResponse();
      putHandler?.(
        {
          body: {
            officeWorkflowPack: "video_preprod",
            officePackProfiles: {
              video_preprod: {
                departments: [{ id: "planning", name: "Planning", name_ko: "기획팀", icon: "🎬", color: "#f59e0b" }],
                agents: [
                  {
                    id: "video_preprod-seed-1",
                    name: "Rian",
                    name_ko: "리안",
                    department_id: "planning",
                    role: "team_leader",
                    cli_provider: "gemini",
                    avatar_emoji: "🎬",
                  },
                ],
              },
            },
          },
        },
        res,
      );
      expect(res.statusCode).toBe(200);

      const seedAgentCount = (
        db.prepare("SELECT COUNT(*) AS c FROM agents WHERE id LIKE 'video_preprod-seed-%'").get() as {
          c: number;
        }
      ).c;
      expect(seedAgentCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("PUT /api/settings language change re-localizes default personalities but keeps edited ones", () => {
    const db = setupDb();
    try {
      const insertAgent = db.prepare("INSERT INTO agents (id, name, personality) VALUES (?, ?, ?)");
      insertAgent.run("aria", "Aria", "꼼꼼한 시니어 개발자");
      insertAgent.run("bolt", "Bolt", "My own custom persona");
      const { putRoutes } = createHarness(db);
      const putHandler = putRoutes.get("/api/settings");

      const res = createFakeResponse();
      putHandler?.({ body: { language: "en" } }, res);
      expect(res.statusCode).toBe(200);

      const readPersonality = (id: string) =>
        (db.prepare("SELECT personality FROM agents WHERE id = ?").get(id) as { personality: string | null })
          .personality;
      expect(readPersonality("aria")).toBe("Meticulous senior developer");
      expect(readPersonality("bolt")).toBe("My own custom persona");

      putHandler?.({ body: { language: "ko" } }, createFakeResponse());
      expect(readPersonality("aria")).toBe("꼼꼼한 시니어 개발자");
    } finally {
      db.close();
    }
  });
});

describe("merge policy settings", () => {
  it.each(["auto", "manual"])("round-trips %s", (mergePolicy) => {
    const db = setupDb();
    try {
      const { getRoutes, putRoutes } = createHarness(db);
      const save = createFakeResponse();
      putRoutes.get("/api/settings")?.({ body: { mergePolicy } }, save);
      expect(save.statusCode).toBe(200);
      const read = createFakeResponse();
      getRoutes.get("/api/settings")?.({}, read);
      expect(read.payload).toMatchObject({ settings: { mergePolicy } });
    } finally {
      db.close();
    }
  });

  it.each([null, false, "invalid", '"manual"', {}])(
    "rejects invalid policy %j before writing other settings",
    (mergePolicy) => {
      const db = setupDb();
      try {
        const { putRoutes } = createHarness(db);
        db.prepare("INSERT INTO settings VALUES ('mergePolicy', 'manual')").run();
        const res = createFakeResponse();
        putRoutes.get("/api/settings")?.({ body: { companyName: "Changed", mergePolicy } }, res);
        expect(res.statusCode).toBe(400);
        expect(res.payload).toMatchObject({ error: "invalid_merge_policy" });
        expect(db.prepare("SELECT value FROM settings WHERE key = 'mergePolicy'").get()).toMatchObject({
          value: "manual",
        });
        expect(db.prepare("SELECT value FROM settings WHERE key = 'companyName'").get()).toBeUndefined();
      } finally {
        db.close();
      }
    },
  );
});

describe("review automation settings", () => {
  it.each(["reviewAutoStart", "reviewAutoApply"])("round-trips %s as a boolean", (key) => {
    const db = setupDb();
    try {
      const { getRoutes, putRoutes } = createHarness(db);
      for (const value of [true, false]) {
        const save = createFakeResponse();
        putRoutes.get("/api/settings")?.({ body: { [key]: value } }, save);
        expect(save.statusCode).toBe(200);
        const read = createFakeResponse();
        getRoutes.get("/api/settings")?.({}, read);
        expect(read.payload).toMatchObject({ settings: { [key]: value } });
      }
    } finally {
      db.close();
    }
  });

  it.each([null, "true", 1, "on", {}])("rejects non-boolean %j before writing other settings", (value) => {
    const db = setupDb();
    try {
      const { putRoutes } = createHarness(db);
      const res = createFakeResponse();
      putRoutes.get("/api/settings")?.({ body: { companyName: "Changed", reviewAutoStart: value } }, res);
      expect(res.statusCode).toBe(400);
      expect(res.payload).toMatchObject({ error: "invalid_review_automation", key: "reviewAutoStart" });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'companyName'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("Headroom settings contract", () => {
  it("returns defaults and persists normalized settings while omission preserves them", () => {
    const db = setupDb();
    try {
      const { getRoutes, putRoutes } = createHarness(db);
      const initial = createFakeResponse();
      getRoutes.get("/api/settings")?.({}, initial);
      expect(initial.payload).toMatchObject({
        settings: {
          headroom: {
            enabled: false,
            proxyUrl: "http://127.0.0.1:8787",
            providers: { claude: true, codex: false, api: true },
          },
        },
      });
      const save = createFakeResponse();
      putRoutes.get("/api/settings")?.(
        { body: { headroom: { enabled: true, proxyUrl: "http://localhost:9898/v1/", providers: { claude: false } } } },
        save,
      );
      expect(save.statusCode).toBe(200);
      const update = createFakeResponse();
      putRoutes.get("/api/settings")?.({ body: { ceoName: "Updated" } }, update);
      const read = createFakeResponse();
      getRoutes.get("/api/settings")?.({}, read);
      expect(read.payload).toMatchObject({
        settings: {
          ceoName: "Updated",
          headroom: {
            enabled: true,
            proxyUrl: "http://localhost:9898",
            providers: { claude: false, codex: false, api: true },
          },
        },
      });
    } finally {
      db.close();
    }
  });
  it.each([
    { enabled: false, proxyUrl: "https://user:secret@example.com" },
    { enabled: false, proxyUrl: "http://localhost:8787?token=secret" },
    { enabled: false, proxyUrl: "ftp://localhost" },
    { enabled: "true" },
    { providers: { api: "false" } },
    null,
  ])("rejects invalid config %j before writing any settings", (headroom) => {
    const db = setupDb();
    try {
      const { putRoutes } = createHarness(db);
      const save = createFakeResponse();
      putRoutes.get("/api/settings")?.({ body: { ceoName: "Must not save", headroom } }, save);
      expect(save.statusCode).toBe(400);
      expect(save.payload).toEqual({ ok: false, error: "invalid_headroom" });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'ceoName'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM settings WHERE key = 'headroom'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it("provides a sanitized status endpoint with defaults", async () => {
    const db = setupDb();
    try {
      const { getRoutes } = createHarness(db);
      const res = createFakeResponse();
      await getRoutes.get("/api/headroom/status")?.({}, res);
      expect(res.payload).toEqual({
        state: "disabled",
        reason: "disabled",
        checkedAt: null,
        version: null,
        tokensSaved: null,
        capabilities: { claude: true, codex: false, api: true },
      });
    } finally {
      db.close();
    }
  });
});
