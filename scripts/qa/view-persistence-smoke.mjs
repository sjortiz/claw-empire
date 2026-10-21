#!/usr/bin/env node

// Run after pnpm build. All API traffic uses fixtures; no backend or database is needed.
// QA_DIST_DIR selects an archived candidate build without changing this worktree's production files.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const dist = path.resolve(process.env.QA_DIST_DIR ?? "dist");
const views = ["office", "agents", "dashboard", "tasks", "skills", "settings"];
const labels = {
  office: "Office",
  agents: "Agents",
  dashboard: "Dashboard",
  tasks: "Tasks",
  skills: "Library",
  settings: "Settings",
};
const fixtures = {
  "/api/settings": {
    settings: { language: "en", companyName: "QA", ceoName: "QA", officeWorkflowPack: "development" },
  },
  "/api/departments": { departments: [] },
  "/api/agents": { agents: [] },
  "/api/tasks": { tasks: [] },
  "/api/subtasks": { subtasks: [] },
  "/api/meeting-presence": { presence: [] },
  "/api/decision-inbox": { items: [] },
  "/api/stats": {
    stats: {
      tasks: {
        total: 0,
        done: 0,
        in_progress: 0,
        inbox: 0,
        planned: 0,
        collaborating: 0,
        review: 0,
        cancelled: 0,
        completion_rate: 0,
      },
      agents: { total: 0, working: 0, idle: 0 },
      top_agents: [],
      tasks_by_department: [],
      recent_activity: [],
    },
  },
  "/api/cli-status": { providers: {} },
  "/api/cli-models": { models: {} },
  "/api/oauth/status": { providers: {}, storageReady: true },
  "/api/skills": { skills: [] },
};
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${dist}${path.sep}`) || pathname.startsWith("/api/")) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    // Keep WebSocket bootstrap disconnected; every request is isolated from real services.
    if (url.pathname === "/api/auth/session") return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: fixtures[url.pathname] ?? {
        providers: {},
        models: {},
        skills: [],
        items: [],
        history: [],
        packs: [],
        sessions: [],
      },
    });
  });
  const nav = () => page.locator("aside:visible nav");
  async function checkView(view) {
    await expect(nav().locator("button.active")).toContainText(labels[view]);
    expect(new URL(page.url()).searchParams.get("view")).toBe(view);
  }

  for (const view of views) {
    await page.goto(`${origin}/?view=${view}`);
    await checkView(view);
    await page.reload();
    await checkView(view);
    console.log(`PASS: ${view} shared URL and refresh restore ?view=${view}`);
  }
  console.log("PASS: shared URLs and actual reloads restore all six views");

  await page.goto(`${origin}/?view=office&keep=yes#anchor`);
  await checkView("office");
  const initialLength = await page.evaluate(() => history.length);
  for (const view of views.slice(1)) {
    await nav().getByRole("button", { name: labels[view] }).click();
    await checkView(view);
  }
  await nav().getByRole("button", { name: "Settings" }).click();
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 5);
  await page.reload();
  await checkView("settings");
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 5);
  for (const view of views.slice(0, -1).reverse()) {
    await page.goBack();
    await checkView(view);
  }
  for (const view of views.slice(1)) {
    await page.goForward();
    await checkView(view);
  }
  expect(new URL(page.url()).searchParams.get("keep")).toBe("yes");
  expect(new URL(page.url()).hash).toBe("#anchor");
  console.log("PASS: sidebar navigation, back/forward, duplicate suppression and URL preservation");

  for (const query of ["", "?view=", "?view=unknown", "?view=Tasks", "?view=__proto__"]) {
    await page.goto(`${origin}/${query}`);
    await checkView("office");
  }
  console.log("PASS: missing, empty and invalid values fall back to Office");

  await page.evaluate(() => history.replaceState(null, "", "/?view=invalid"));
  await nav().getByRole("button", { name: "Tasks" }).click();
  await checkView("tasks");
  await page.goBack();
  await checkView("office");
  await page.goForward();
  await checkView("tasks");
  console.log("PASS: invalid history entries normalize to Office without breaking forward navigation");

  await page.goto(`${origin}/?view=settings`);
  await checkView("settings");
  const cliTab = () => page.getByRole("button", { name: "CLI Tools", exact: false });
  await cliTab().click();
  await page.reload();
  await expect(cliTab()).toHaveClass(/border-b-2/);
  await nav().getByRole("button", { name: "Tasks" }).click();
  await checkView("tasks");
  await nav().getByRole("button", { name: "Settings" }).click();
  await checkView("settings");
  await expect(cliTab()).toHaveClass(/border-b-2/);
  console.log("PASS: Settings CLI tab survives leaving and returning to Settings");
  for (const callback of ["oauth=github", "oauth_error=access_denied"]) {
    await page.goto(`${origin}/?view=tasks&keep=yes&${callback}#anchor`);
    await checkView("settings");
    await expect(page.getByRole("button", { name: "OAuth", exact: false }).first()).toHaveClass(/border-b-2/);
    expect(new URL(page.url()).searchParams.has("oauth")).toBe(false);
    expect(new URL(page.url()).searchParams.has("oauth_error")).toBe(false);
    expect(new URL(page.url()).searchParams.get("keep")).toBe("yes");
    expect(new URL(page.url()).hash).toBe("#anchor");
    await page.reload();
    await checkView("settings");
    console.log(`PASS: ${callback} opens Settings/OAuth, cleans callback params and survives refresh`);
  }
  console.log("PASS: Settings sub-tab reload and existing OAuth success/error deep links");
  expect(errors).toEqual([]);
  console.log("PASS: no uncaught browser errors");
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
