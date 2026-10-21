import type { DatabaseSync } from "node:sqlite";

// Older databases prohibit cancelled subtasks even though dispatch/dependency
// checks already treat cancellation as terminal. Preserve all columns and indexes.
export function ensureSubtaskCancellation(db: Pick<DatabaseSync, "prepare" | "exec">): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subtasks'").get() as
    | { sql: string }
    | undefined;
  if (!table || table.sql.includes("'cancelled'")) return;
  const schema = table.sql
    .replace(/CREATE TABLE\s+(?:"subtasks"|subtasks)/i, 'CREATE TABLE "subtasks_terminal"')
    .replace(/'done'\s*,\s*'blocked'/, "'done','blocked','cancelled'");
  if (schema === table.sql || !schema.includes("'cancelled'"))
    throw new Error("Cannot migrate subtask terminal statuses");
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = 'subtasks' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all() as Array<{ sql: string }>;
  const columns = (db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>)
    .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
    .join(",");
  db.exec("SAVEPOINT subtask_cancellation");
  try {
    db.exec(schema);
    db.exec(`INSERT INTO subtasks_terminal (${columns}) SELECT ${columns} FROM subtasks`);
    db.exec("DROP TABLE subtasks");
    db.exec("ALTER TABLE subtasks_terminal RENAME TO subtasks");
    for (const { sql } of indexes) db.exec(sql);
    db.exec("RELEASE subtask_cancellation");
  } catch (error) {
    db.exec("ROLLBACK TO subtask_cancellation");
    db.exec("RELEASE subtask_cancellation");
    throw error;
  }
}
