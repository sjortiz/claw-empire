import { DatabaseSync } from "node:sqlite";
import { applyBaseSchema } from "../modules/bootstrap/schema/base-schema.ts";

export function createCoordinationDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyBaseSchema(db);
  db.exec(`
    ALTER TABLE tasks ADD COLUMN source_task_id TEXT;
    ALTER TABLE tasks ADD COLUMN base_branch TEXT;
    INSERT INTO departments (id, name, name_ko, icon, color) VALUES ('dev', 'Development', '개발', '', '');
    INSERT INTO agents (id, name, department_id, role, cli_provider) VALUES
      ('alpha', 'Alpha', 'dev', 'senior', 'codex'), ('beta', 'Beta', 'dev', 'junior', 'codex');
    INSERT INTO projects (id, name, project_path, core_goal) VALUES ('project', 'Coordination', '/missing/test-repo', 'Coordinate'), ('other', 'Other', '/missing/other-repo', 'Other');
    INSERT INTO tasks (id, title, description, assigned_agent_id, department_id, project_id, source_task_id, status) VALUES
      ('parent', 'Parent directive', 'Full parent directive reference.', NULL, 'dev', 'project', NULL, 'collaborating'),
      ('source', 'Scoped implementation', 'Implement only assigned code.', 'alpha', 'dev', 'project', 'parent', 'in_progress'),
      ('target', 'Scoped tests', 'Tests only.', 'beta', 'dev', 'project', 'parent', 'in_progress'),
      ('unrelated', 'Other work', '', 'beta', 'dev', 'other', NULL, 'in_progress');
  `);
  return db;
}

export const coordinationLocalizers = {
  l: (ko: string[], en: string[], ja: string[] = en, zh: string[] = en) => ({ ko, en, ja, zh }),
  pickL: (pool: Record<string, string[]>, lang: string) => pool[lang][0],
};
