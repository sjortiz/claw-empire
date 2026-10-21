import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRelatedWorkContext,
  RELATED_WORK_MAX_CHARS,
  RELATED_WORK_MAX_TASKS,
  resolveRelatedWorkScope,
} from "./related-work.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const databases: DatabaseSync[] = [];
const git = vi.mocked(execFileSync);

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'planned',
      source_task_id TEXT, project_id TEXT, project_path TEXT, base_branch TEXT,
      assigned_agent_id TEXT, department_id TEXT, result TEXT, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, name_ko TEXT, name_ja TEXT, name_zh TEXT, department_id TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY, name TEXT, name_ko TEXT, name_ja TEXT, name_zh TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, message_type TEXT, content TEXT, created_at INTEGER);
    CREATE TABLE task_logs (id INTEGER PRIMARY KEY, task_id TEXT, kind TEXT, message TEXT, created_at INTEGER);
    INSERT INTO departments VALUES ('dev', 'Development', '개발', '開発', '开发');
    INSERT INTO agents VALUES ('nova', 'Nova', '노바', 'ノヴァ', '诺娃', 'dev');
  `);
  return db;
}

function addTask(db: DatabaseSync, id: string, values: Record<string, string | number | null> = {}): void {
  const row = { id, title: `Task ${id}`, ...values };
  db.prepare(
    `INSERT INTO tasks (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(", ")})`,
  ).run(...Object.values(row));
}

beforeEach(() => {
  git.mockReset();
  git.mockImplementation(() => {
    throw new Error("Git data unavailable");
  });
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("resolveRelatedWorkScope", () => {
  it("inherits project metadata through nested delegation", () => {
    const db = createDb();
    addTask(db, "root", { project_id: "project-a", project_path: "/repo" });
    addTask(db, "revision", { source_task_id: "root" });
    addTask(db, "current", { source_task_id: "revision" });
    expect(resolveRelatedWorkScope(db, "current")).toEqual({
      rootTaskId: "root",
      projectId: "project-a",
      projectPath: "/repo",
    });
  });

  it("terminates cyclic and broken parent links without throwing", () => {
    const db = createDb();
    addTask(db, "first", { source_task_id: "second" });
    addTask(db, "second", { source_task_id: "first" });
    addTask(db, "orphan", { source_task_id: "missing" });
    expect(resolveRelatedWorkScope(db, "first")?.rootTaskId).toBe("second");
    expect(resolveRelatedWorkScope(db, "orphan")?.rootTaskId).toBe("orphan");
    expect(resolveRelatedWorkScope(db, "missing")).toBeNull();
  });
});

describe("buildRelatedWorkContext", () => {
  it("leaves single tasks, missing tasks and incomplete schemas unchanged", () => {
    const db = createDb();
    addTask(db, "solo", { project_id: "project-a" });
    expect(buildRelatedWorkContext(db, "solo")).toBe("");
    expect(buildRelatedWorkContext(db, "missing")).toBe("");
    db.exec("DROP TABLE messages");
    addTask(db, "sibling", { project_id: "project-a" });
    expect(buildRelatedWorkContext(db, "solo")).toBe("");
    expect(git).not.toHaveBeenCalled();
  });

  it("includes parent, nested siblings and project peers while excluding self and unrelated tasks", () => {
    const db = createDb();
    addTask(db, "root", { project_id: "project-a" });
    addTask(db, "current", { source_task_id: "root" });
    addTask(db, "sibling", { source_task_id: "root", assigned_agent_id: "nova", status: "in_progress" });
    addTask(db, "revision", { source_task_id: "sibling", status: "done", result: "Reuse completed implementation." });
    addTask(db, "peer", { project_id: "project-a" });
    addTask(db, "unrelated", { project_id: "project-b" });
    const context = buildRelatedWorkContext(db, "current");
    expect(context).toContain("[Related Work]");
    expect(context).toContain("Task root");
    expect(context).toContain("Task sibling | Nova / Development | in_progress");
    expect(context).toContain("Task revision");
    expect(context).toContain("Reuse completed implementation.");
    expect(context).toContain("Task peer");
    expect(context).not.toContain("Task current");
    expect(context).not.toContain("Task unrelated");
    expect(context).toContain("branch: unavailable; commits ahead of base: unavailable");
  });

  it("matches legacy project paths without mixing two explicit project IDs", () => {
    const db = createDb();
    addTask(db, "current", { project_id: "project-a", project_path: "/repo" });
    addTask(db, "legacy-peer", { project_path: "/repo" });
    addTask(db, "other-project", { project_id: "project-b", project_path: "/repo" });
    const context = buildRelatedWorkContext(db, "current");
    expect(context).toContain("Task legacy-peer");
    expect(context).not.toContain("Task other-project");
  });

  it("shows the latest report message ahead of the result or log fallback", () => {
    const db = createDb();
    addTask(db, "current", { project_id: "project-a" });
    addTask(db, "peer", { project_id: "project-a", result: "Outdated result" });
    db.exec(`
      INSERT INTO messages VALUES ('report-old', 'peer', 'report', 'Old report', 10);
      INSERT INTO messages VALUES ('report-new', 'peer', 'report', 'Use commit abc123 for the API.', 20);
      INSERT INTO messages VALUES ('chat-new', 'peer', 'chat', 'Ordinary chat', 30);
      INSERT INTO task_logs VALUES (1, 'peer', 'report', 'Old log', 40);
    `);
    const context = buildRelatedWorkContext(db, "current");
    expect(context).toContain("latest report: Use commit abc123 for the API.");
    expect(context).not.toContain("Old report");
    expect(context).not.toContain("Outdated result");
    expect(context).not.toContain("Ordinary chat");
    expect(context).not.toContain("Old log");
  });

  it("uses the active worktree branch and the task's explicit base for commit counts", () => {
    const db = createDb();
    addTask(db, "current", { project_id: "project-a" });
    addTask(db, "peer", { project_id: "project-a", base_branch: "dev" });
    const head = "a".repeat(40);
    const branch = "b".repeat(40);
    const base = "c".repeat(40);
    git.mockImplementation((_file, args) => {
      const command = (args as string[]).join(" ");
      if (command.includes("HEAD^{commit}")) return Buffer.from(head);
      if (command.includes("refs/heads/climpire/peer-2^{commit}")) return Buffer.from(branch);
      if (command.includes("dev^{commit}")) return Buffer.from(base);
      if (command === `rev-list --count ${base}..${branch}`) return Buffer.from("3\n");
      return Buffer.from("");
    });
    const taskWorktrees = new Map([
      [
        "peer",
        { projectPath: "/repo", worktreePath: "/repo/.climpire-worktrees/peer-2", branchName: "climpire/peer-2" },
      ],
    ]);
    const context = buildRelatedWorkContext(db, "current", "en", { taskWorktrees });
    expect(context).toContain("branch: climpire/peer-2; commits ahead of base: 3");
    expect(git).toHaveBeenCalledWith(
      "git",
      ["rev-list", "--count", `${base}..${branch}`],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("discovers existing suffixed worktree branches after a server restart", () => {
    const db = createDb();
    addTask(db, "current", { project_path: "/repo" });
    addTask(db, "sibling1-uuid", { project_path: "/repo" });
    const head = "a".repeat(40);
    const branch = "b".repeat(40);
    git.mockImplementation((_file, args) => {
      const command = (args as string[]).join(" ");
      if (command.includes("HEAD^{commit}")) return Buffer.from(head);
      if (command === "worktree list --porcelain")
        return Buffer.from("worktree /repo/.climpire-worktrees/sibling1-1\nbranch refs/heads/climpire/sibling1-1\n");
      if (command.includes("refs/heads/climpire/sibling1-1^{commit}")) return Buffer.from(branch);
      if (command.startsWith("rev-list --count")) return Buffer.from("0");
      return Buffer.from("");
    });
    expect(buildRelatedWorkContext(db, "current")).toContain("branch: climpire/sibling1-1; commits ahead of base: 0");
  });

  it("caps rows, fields and overall prompt size while prioritizing in-flight siblings", () => {
    const db = createDb();
    addTask(db, "root");
    addTask(db, "current", { source_task_id: "root" });
    for (let i = 0; i < RELATED_WORK_MAX_TASKS + 5; i += 1) {
      addTask(db, `peer-${i}`, {
        source_task_id: "root",
        title: `Peer ${i} ${"long ".repeat(300)}`,
        result: "report ".repeat(500),
        status: i === 0 ? "in_progress" : "done",
        updated_at: i,
      });
    }
    const context = buildRelatedWorkContext(db, "current");
    expect(context.length).toBeLessThanOrEqual(RELATED_WORK_MAX_CHARS);
    expect(context.match(/^- /gm)).toHaveLength(RELATED_WORK_MAX_TASKS);
    expect(context).toContain("Peer 0");
    expect(context).toContain("Additional related tasks omitted.");
    expect(context).not.toContain("report ".repeat(100));
  });

  it.each([
    ["ko", "[관련 작업]", "노바 / 개발", "최신 보고"],
    ["ja", "[関連作業]", "ノヴァ / 開発", "最新報告"],
    ["zh", "[相关工作]", "诺娃 / 开发", "最新报告"],
  ] as const)("localizes the section and peer names in %s", (lang, heading, name, reportLabel) => {
    const db = createDb();
    addTask(db, "current", { project_id: "project-a" });
    addTask(db, "peer", { project_id: "project-a", assigned_agent_id: "nova" });
    const context = buildRelatedWorkContext(db, "current", lang);
    expect(context).toContain(heading);
    expect(context).toContain(name);
    expect(context).toContain(reportLabel);
  });
});
