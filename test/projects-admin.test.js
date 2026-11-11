const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const config = require("../src/core/config");
const admin = require("../src/features/projects-admin");
const { mutate, load } = require("../src/core/data");

const folder = path.join(box.dir, "cuentas");
fs.mkdirSync(folder, { recursive: true });

test("a project created in the panel is shared, keeps its folder on this machine and gets its commands", () => {
  const r = admin.save({ name: "Cuentas personales", taskPrefix: "cuentas", root: folder });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.id, "cuentas-personales");
  assert.deepEqual(r.commands.files, ["soy.md"]);
  const def = load().projectDefs["cuentas-personales"];
  assert.equal(def.taskPrefix, "CUENTAS");
  assert.equal(def.root, undefined);
  assert.equal(def.folder, "cuentas");
  assert.equal(config.localProjects()["cuentas-personales"].root, path.resolve(folder));
  const p = config.project("cuentas-personales");
  assert.equal(p.source, "panel");
  assert.equal(require("../src/core/projects").projectOfPath(path.join(folder, "src")).id, "cuentas-personales");
  const row = admin.list().find((x) => x.id === "cuentas-personales");
  assert.equal(row.editable, true);
  assert.equal(row.rootExists, true);
  assert.equal(admin.list()[0].fromFile, true);
});

test("a new project goes inside workspace, named after the project when no folder is given, and the folder is created", () => {
  const r = admin.save({ name: "Mi App", taskPrefix: "APP" });
  assert.equal(r.error, undefined, r.error);
  const root = path.join(path.dirname(config.mainProject.root), "mi-app");
  assert.equal(fs.existsSync(root), true);
  assert.equal(config.localProjects()["mi-app"].root, root);
  const nested = admin.save({ name: "Otra App", taskPrefix: "OTRA", root: "external/otra" });
  assert.equal(nested.error, undefined, nested.error);
  assert.equal(load().projectDefs["otra-app"].folder, "external/otra");
  assert.equal(fs.existsSync(path.join(path.dirname(config.mainProject.root), "external", "otra")), true);
  admin.remove("mi-app");
  admin.remove("otra-app");
});

test("the panel refuses bad or clashing projects", () => {
  assert.match(admin.save({ name: "" }).error, /nombre/);
  assert.match(admin.save({ name: "Otra", taskPrefix: "CUENTAS" }).error, /ya usa el prefijo/);
  assert.match(admin.save({ name: "Otra", taskPrefix: "WEB" }).error, /proyecto de Jira/);
  assert.match(admin.save({ name: "Otra", root: folder }).error, /ya es de Cuentas personales/);
  assert.match(admin.save({ name: "Otra", root: "/somewhere/else" }).error, /dentro de/);
  assert.match(admin.save({ name: "Otra", root: "../fuera" }).error, /dentro de/);
  assert.match(admin.save({ id: config.mainProject.id, name: "X", root: path.join(box.dir, "otra") }).error, /board\.config\.json/);
});

test("the main project is edited in place, shared through projectDefs, and keeps its folder and modules", () => {
  const main = config.mainProject;
  const before = { root: main.root, jira: main.jira };
  const r = admin.save({ id: main.id, create: false, name: "Renamed", taskPrefix: "REN", daily: false, contextTidy: true });
  assert.equal(r.error, undefined, r.error);
  assert.equal(load().projectDefs[main.id].override, true);
  config.forgetProjects();
  const p = config.project(main.id);
  assert.equal(p, config.mainProject);
  assert.equal(p.name, "Renamed");
  assert.equal(p.taskPrefix, "REN");
  assert.equal(p.daily, false);
  assert.equal(p.root, before.root);
  assert.equal(p.jira, before.jira);
  mutate((d) => delete d.projectDefs[main.id]);
  config.forgetProjects();
  assert.equal(config.project(main.id).name, main.fileValues.name);
});

test("credentials are written to the project's own file and only their presence is reported", () => {
  const r = admin.setCredentials("cuentas-personales", { JIRA_SITE: "x.example", JIRA_TOKEN: "secret-value" });
  assert.deepEqual(r.credentials, { JIRA_SITE: true, JIRA_EMAIL: false, JIRA_TOKEN: true, SENTRY_TOKEN: false });
  assert.doesNotMatch(JSON.stringify(admin.list()), /secret-value/);
  assert.match(fs.readFileSync(path.join(box.workspace, ".env.cuentas-personales"), "utf8"), /JIRA_TOKEN=secret-value/);
  assert.equal(admin.setCredentials("cuentas-personales", { JIRA_TOKEN: "" }).credentials.JIRA_TOKEN, false);
  assert.match(admin.setCredentials(config.mainProject.id, { JIRA_TOKEN: "x" }).error, /principal/);
});

test("a project with open tasks cannot be removed; once closed it goes, on every machine", () => {
  mutate((d) => (d.tasks["CUENTAS-1"] = { key: "CUENTAS-1", project: "cuentas-personales", status: "pending" }));
  assert.match(admin.remove("cuentas-personales").error, /1 tarea abierta/);
  mutate((d) => (d.tasks["CUENTAS-1"].status = "done"));
  assert.equal(admin.remove("cuentas-personales").error, undefined);
  assert.equal(load().projectDefs["cuentas-personales"].removed, true);
  assert.equal(config.project("cuentas-personales"), null);
  assert.match(admin.remove(config.mainProject.id).error, /principal/);
});
