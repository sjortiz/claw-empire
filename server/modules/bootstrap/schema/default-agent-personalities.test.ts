import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildOfficePackPresentation, buildOfficePackStarterAgents } from "../../../../src/app/office-workflow-pack.ts";
import type { Department } from "../../../../src/types/index.ts";
import { syncOfficePackAgentsForPack } from "../../routes/collab/office-pack-agent-hydration.ts";
import type { AgentRow } from "../../workflow/core/conversation-types.ts";
import { createMeetingPromptTools } from "../../workflow/core/meeting-prompt-tools.ts";
import { applyBaseSchema } from "./base-schema.ts";
import { DEFAULT_AGENT_PERSONALITIES, syncDefaultAgentPersonalities } from "./default-agent-personalities.ts";
import { initializeOAuthRuntime } from "./oauth-runtime.ts";
import { applyDefaultSeeds } from "./seeds.ts";
import { applyTaskSchemaMigrations } from "./task-schema-migrations.ts";

const HANGUL = /[가-힣ㄱ-ㆎ]/;

function runInTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function setupSchema(db: DatabaseSync): void {
  applyBaseSchema(db);
  initializeOAuthRuntime({
    db,
    nowMs: () => Date.now(),
    runInTransaction: (fn: () => void) => runInTransaction(db, fn),
  });
  applyTaskSchemaMigrations(db);
}

function personalityByName(db: DatabaseSync): Map<string, string | null> {
  const rows = db.prepare("SELECT name, personality FROM agents").all() as Array<{
    name: string;
    personality: string | null;
  }>;
  return new Map(rows.map((row) => [row.name, row.personality]));
}

describe("default agent personalities", () => {
  it("seeds a fresh install with English personalities when language is en", () => {
    const db = new DatabaseSync(":memory:");
    try {
      setupSchema(db);
      applyDefaultSeeds(db);

      const personalities = personalityByName(db);
      expect(personalities.get("Aria")).toBe("Meticulous senior developer");
      for (const [name, localized] of Object.entries(DEFAULT_AGENT_PERSONALITIES)) {
        expect(personalities.get(name)).toBe(localized.en);
        expect(personalities.get(name)).not.toMatch(HANGUL);
      }
    } finally {
      db.close();
    }
  });

  it("localizes an existing Korean-seeded install on startup without touching edited personalities", () => {
    const db = new DatabaseSync(":memory:");
    try {
      setupSchema(db);
      applyDefaultSeeds(db);
      syncDefaultAgentPersonalities(db, "ko");
      db.prepare("UPDATE agents SET personality = ? WHERE name = 'Bolt'").run("내가 직접 쓴 성격");
      db.prepare("UPDATE agents SET personality = NULL WHERE name = 'Nova'").run();

      applyDefaultSeeds(db);

      const personalities = personalityByName(db);
      expect(personalities.get("Aria")).toBe(DEFAULT_AGENT_PERSONALITIES.Aria.en);
      expect(personalities.get("Bolt")).toBe("내가 직접 쓴 성격");
      expect(personalities.get("Nova")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("switches between languages and restores the original Korean wording", () => {
    const db = new DatabaseSync(":memory:");
    try {
      setupSchema(db);
      applyDefaultSeeds(db);

      syncDefaultAgentPersonalities(db, "ja");
      expect(personalityByName(db).get("Hawk")).toBe(DEFAULT_AGENT_PERSONALITIES.Hawk.ja);
      syncDefaultAgentPersonalities(db, "zh");
      expect(personalityByName(db).get("Hawk")).toBe(DEFAULT_AGENT_PERSONALITIES.Hawk.zh);
      syncDefaultAgentPersonalities(db, "ko");
      expect(personalityByName(db).get("Hawk")).toBe("날카로운 품질 감시자");
      expect(personalityByName(db).get("Aria")).toBe("꼼꼼한 시니어 개발자");

      expect(syncDefaultAgentPersonalities(db, "unknown")).toBe(Object.keys(DEFAULT_AGENT_PERSONALITIES).length);
      expect(personalityByName(db).get("Hawk")).toBe(DEFAULT_AGENT_PERSONALITIES.Hawk.en);
    } finally {
      db.close();
    }
  });
});

describe("default agent prompt personalities", () => {
  function buildEnglishPrompt(agent: AgentRow): string {
    const tools = createMeetingPromptTools({
      getDeptName: () => "Development",
      getDeptRoleConstraint: () => "",
      getRoleLabel: () => "Team member",
      getRecentConversationContext: () => "",
      getAgentDisplayName: (entry) => entry.name,
      formatMeetingTranscript: () => "",
      compactTaskDescriptionForMeeting: () => "",
      normalizeMeetingLang: () => "en",
      localeInstruction: () => "Respond in English.",
      resolveLang: () => "en",
    });
    return tools.buildDirectReplyPrompt(agent, "Please summarize your work.", "chat").prompt;
  }

  it.each(Object.entries(DEFAULT_AGENT_PERSONALITIES))(
    "injects the migrated English personality for %s",
    (name, personality) => {
      const db = new DatabaseSync(":memory:");
      try {
        setupSchema(db);
        applyDefaultSeeds(db);
        syncDefaultAgentPersonalities(db, "ko");
        applyDefaultSeeds(db);

        const agent = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as unknown as AgentRow;
        const prompt = buildEnglishPrompt(agent);
        expect(prompt).toContain(`tone, wording, and attitude: ${personality.en}`);
        expect(prompt).toContain("Respond in English.");
        expect(prompt).not.toMatch(HANGUL);
      } finally {
        db.close();
      }
    },
  );

  it("injects an edited Korean persona verbatim rather than rewriting authored content", () => {
    const db = new DatabaseSync(":memory:");
    try {
      setupSchema(db);
      applyDefaultSeeds(db);
      const personality = "사용자가 직접 작성한 성격: 근거를 들어 설명합니다.";
      db.prepare("UPDATE agents SET personality = ? WHERE name = 'Aria'").run(personality);
      syncDefaultAgentPersonalities(db, "ko");
      syncDefaultAgentPersonalities(db, "en");

      const agent = db.prepare("SELECT * FROM agents WHERE name = 'Aria'").get() as unknown as AgentRow;
      expect(agent.personality).toBe(personality);
      expect(buildEnglishPrompt(agent)).toContain(`tone, wording, and attitude: ${personality}`);
    } finally {
      db.close();
    }
  });
});

describe("persisted office-pack localization", () => {
  it.each(["report", "web_research_report", "novel", "video_preprod", "roleplay"] as const)(
    "migrates %s profiles and hydrated prompt data while retaining edits and cleared personas",
    (packKey) => {
      const db = new DatabaseSync(":memory:");
      try {
        setupSchema(db);
        applyDefaultSeeds(db);
        const departments = db.prepare("SELECT * FROM departments").all() as unknown as Department[];
        const build = (locale: "ko" | "en" | "ja" | "zh") => {
          const presentation = buildOfficePackPresentation({
            packKey,
            locale,
            departments,
            agents: [],
            customRoomThemes: {},
          });
          return {
            departments: presentation.departments,
            agents: buildOfficePackStarterAgents({ packKey, locale, departments: presentation.departments }).map(
              (agent, index) => ({
                ...agent,
                id: `${packKey}-seed-${index + 1}`,
                cli_provider: "codex",
              }),
            ),
          };
        };
        const original = build("ko");
        const profile = structuredClone(original);
        profile.agents[1].personality = "사용자가 편집한 성격";
        profile.agents[2].personality = null;
        profile.departments[1].description = "사용자가 편집한 설명";
        profile.departments[1].prompt = "사용자가 편집한 프롬프트";
        db.prepare("INSERT INTO settings (key, value) VALUES ('officePackProfiles', ?)").run(
          JSON.stringify({ [packKey]: profile }),
        );
        // Initial hydration occurs in Korean, then an existing installation switches to English.
        db.prepare("UPDATE settings SET value = 'ko' WHERE key = 'language'").run();
        syncOfficePackAgentsForPack(db, { [packKey]: profile }, packKey, Date.now);
        db.prepare("UPDATE agents SET personality = ? WHERE id = ?").run("DB에서 편집한 성격", profile.agents[3].id);
        db.prepare("UPDATE agents SET personality = NULL WHERE id = ?").run(profile.agents[4].id);

        for (const locale of ["en", "ja", "zh", "ko", "en"] as const) {
          db.prepare("UPDATE settings SET value = ? WHERE key = 'language'").run(locale);
          applyDefaultSeeds(db); // Real startup migration, not only the helper.
          const expected = build(locale);
          const stored = JSON.parse(
            (db.prepare("SELECT value FROM settings WHERE key = 'officePackProfiles'").get() as { value: string })
              .value,
          )[packKey];
          const rows = db
            .prepare("SELECT id, personality FROM agents WHERE workflow_pack_key = ? ORDER BY id")
            .all(packKey) as Array<{ id: string; personality: string | null }>;
          const byId = new Map(rows.map((row) => [row.id, row.personality]));
          for (const [index, agent] of profile.agents.entries()) {
            const wanted =
              index === 1
                ? "사용자가 편집한 성격"
                : index === 2 || index === 4
                  ? null
                  : index === 3
                    ? "DB에서 편집한 성격"
                    : expected.agents[index].personality;
            expect(byId.get(agent.id)).toBe(wanted);
            expect(stored.agents[index].personality).toBe(wanted);
          }
          const department = db
            .prepare(
              "SELECT description, prompt FROM office_pack_departments WHERE workflow_pack_key = ? AND department_id = ?",
            )
            .get(packKey, "planning") as { description: string; prompt: string };
          expect(department.description).toBe(expected.departments[0].description);
          expect(department.prompt).toBe(expected.departments[0].prompt);
          expect(stored.departments[1].description).toBe("사용자가 편집한 설명");
          expect(stored.departments[1].prompt).toBe("사용자가 편집한 프롬프트");
          if (locale === "en") {
            expect(byId.get(profile.agents[0].id)).not.toMatch(HANGUL);
            expect(department.prompt).not.toMatch(HANGUL);
          }
          // A stale saved profile must not overwrite DB-edited or cleared personalities.
          syncOfficePackAgentsForPack(db, { [packKey]: original }, packKey, Date.now);
          expect(
            (
              db.prepare("SELECT personality FROM agents WHERE id = ?").get(profile.agents[3].id) as {
                personality: string;
              }
            ).personality,
          ).toBe("DB에서 편집한 성격");
          expect(
            (
              db.prepare("SELECT personality FROM agents WHERE id = ?").get(profile.agents[4].id) as {
                personality: null;
              }
            ).personality,
          ).toBeNull();
        }
      } finally {
        db.close();
      }
    },
  );
});
