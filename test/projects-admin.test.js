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
  assert.equal(config.localProjects()["cuentas-personales"].root, path.resolve(folder));
  const p = config.project("cuentas-personales");
  assert.equal(p.source, "panel");
  assert.equal(require("../src/core/projects").projectOfPath(path.join(folder, "src")).id, "cuentas-personales");
  const row = admin.list().find((x) => x.id === "cuentas-personales");
  assert.equal(row.editable, true);
  assert.equal(row.rootExists, true);
  assert.equal(admin.list()[0].editable, false);
});

test("the panel refuses bad or clashing projects and never edits the ones in board.config.json", () => {
  assert.match(admin.save({ name: "" }).error, /nombre/);
  assert.match(admin.save({ name: "Otra", taskPrefix: "CUENTAS" }).error, /ya usa el prefijo/);
  assert.match(admin.save({ name: "Otra", taskPrefix: "WEB" }).error, /proyecto de Jira/);
  assert.match(admin.save({ name: "Otra", root: folder }).error, /ya es de Cuentas personales/);
  assert.match(admin.save({ name: "Otra", root: path.join(box.dir, "nope") }).error, /no existe/);
  assert.match(admin.save({ name: "Otra", root: "relativa" }).error, /ruta completa/);
  assert.match(admin.save({ id: config.mainProject.id, name: "X" }).error, /board\.config\.json/);
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
  assert.match(admin.remove(config.mainProject.id).error, /board\.config\.json/);
});
