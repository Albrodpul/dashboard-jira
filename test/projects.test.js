const box = require("./helpers/env").sandbox();
const fs = require("fs");
const path = require("path");
const main = path.join(box.dir, "work", "acme");
const client = path.join(box.dir, "work", "client");
const nested = path.join(main, "side");
for (const d of [main, client, nested]) fs.mkdirSync(d, { recursive: true });
const jira = (keys) => ({ projects: keys, me: { id: "me", name: "Me" }, reviewer: { id: "rev", name: "Rev", mentions: [] }, transitions: {} });
const statuses = { review: "IN REVIEW", returned: ["To Do"], inProgress: ["In Progress"], closed: ["Done"], rejectLabel: "rejected" };
fs.writeFileSync(
  path.join(box.workspace, "board.config.json"),
  JSON.stringify({ projects: [{ id: "acme", root: main, jira: jira(["WEB"]), statuses }, { id: "client", name: "Client", root: client, jira: jira(["CLI"]), statuses }, { id: "side", root: nested }] })
);
fs.writeFileSync(path.join(box.data, "sessions.json"), JSON.stringify({ areas: { pay: { title: "Pagos", epics: {} }, shop: { title: "Tienda", epics: {}, project: "client" } } }));

const test = require("node:test");
const assert = require("node:assert/strict");
const projects = require("../src/core/projects");
const holds = require("../src/features/holds");

test("a folder belongs to the deepest project root that contains it", () => {
  assert.equal(projects.projectOfPath(main).id, "acme");
  assert.equal(projects.projectOfPath(path.join(main, "web", "src")).id, "acme");
  assert.equal(projects.projectOfPath(path.join(nested, "x")).id, "side");
  assert.equal(projects.projectOfPath(client).id, "client");
  assert.equal(projects.projectOfPath(path.join(box.dir, "elsewhere")), null);
});

test("records without a project belong to the project of their Jira key, else to the first", () => {
  assert.equal(projects.projectOf({ key: "CLI-4" }), "client");
  assert.equal(projects.projectOf({ key: "WEB-4" }), "acme");
  assert.equal(projects.projectOf({ key: "ZZZ-4" }), "acme");
  assert.equal(projects.projectOf({ key: "WEB-4", project: "side" }), "side");
  assert.equal(projects.projectOf({}), "acme");
});

test("a task never goes to a session of another project", () => {
  const d = { restrictions: [] };
  assert.equal(holds.checkTask(d, { key: "WEB-1" }, "pay"), "");
  assert.equal(holds.checkTask(d, { key: "CLI-1" }, "shop"), "");
  assert.match(holds.checkTask(d, { key: "WEB-1" }, "shop"), /entre proyectos no se envía nada/);
  assert.match(holds.checkTask(d, { key: "CLI-1" }, "pay"), /es de Client/);
});

test("live sessions are kept when their folder is in any project, and carry it", () => {
  const dir = path.join(box.home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const write = (n, cwd) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ kind: "interactive", name: `s${n}`, sessionId: `00000000-0000-4000-8000-00000000000${n}`, cwd, pid: process.pid, startedAt: Date.now(), status: "idle" }));
  write(1, main);
  write(2, client);
  write(3, path.join(box.dir, "elsewhere"));
  const live = require("../src/sessions/registry").liveSessions();
  assert.deepEqual(live.map((s) => [s.name, s.project]).sort(), [["s1", "acme"], ["s2", "client"]]);
});

test("tasks made by hand get their own key, never a Jira one, and are refused without a title", () => {
  const manual = require("../src/features/manual-tasks");
  const d = { tasks: { "SIDE-2": {} }, deleted: { "SIDE-5": "x" } };
  assert.equal(manual.prefixOf(require("../src/core/config").project("side")), "SIDE");
  assert.equal(manual.createTask(d, { project: "side", title: "Cuadrar gastos", description: "de octubre" }).key, "SIDE-6");
  assert.deepEqual({ ...d.tasks["SIDE-6"], at: null }, { key: "SIDE-6", title: "Cuadrar gastos", description: "de octubre", project: "side", source: "manual", kind: "new", status: "pending", at: null, events: [] });
  assert.equal(manual.createTask(d, { project: "side", title: " " }).error, "falta el título");
  assert.match(manual.createTask(d, { project: "nope", title: "x" }).error, /desconocido/);
  assert.equal(manual.prefixOf({ id: "web" }), "WEBL");
});
