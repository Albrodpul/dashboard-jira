require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("../src/features/projects-admin");
const { load } = require("../src/core/data");
const config = require("../src/core/config");

const mainKey = config.mainProject.jira.projects[0];

test("a panel project turns Jira and Sentry on and off from the panel, checked against the other projects", () => {
  assert.equal(admin.save({ name: "Cliente", root: "cliente", taskPrefix: "CLI" }).error, undefined);
  assert.match(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: { projects: "" } }).error, /al menos un proyecto/);
  assert.match(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: { projects: mainKey } }).error, /ya es de/);
  assert.match(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: { projects: "CLI" } }).error, /prefijo de las tareas/);
  assert.equal(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: { projects: "ops, sup" } }).error, undefined);
  assert.deepEqual(load().projectDefs.cliente.jira, { projects: ["OPS", "SUP"] });
  assert.match(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", sentry: { org: "Mi Empresa", projects: "web" } }).error, /organización/);
  assert.match(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", sentry: { org: "mi-empresa", projects: "" } }).error, /al menos un proyecto/);
  assert.equal(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", sentry: { org: "mi-empresa", projects: "web, api" } }).error, undefined);
  const p = admin.list().find((x) => x.id === "cliente");
  assert.deepEqual(p.jiraConfig.projects, ["OPS", "SUP"]);
  assert.equal(p.jiraConfig.connected, false);
  assert.deepEqual(p.sentryConfig, { org: "mi-empresa", projects: ["web", "api"], errorsArea: "" });
  assert.equal(admin.save({ id: "cliente", create: false, name: "Cliente 2", taskPrefix: "CLI" }).error, undefined);
  assert.ok(load().projectDefs.cliente.jira && load().projectDefs.cliente.sentry, "saving without the sections keeps them");
  assert.equal(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: null, sentry: null }).error, undefined);
  assert.equal(load().projectDefs.cliente.jira, undefined);
  assert.equal(load().projectDefs.cliente.sentry, undefined);
  assert.match(admin.save({ id: config.mainProject.id, create: false, name: config.mainProject.name, jira: { projects: "XX" } }).error, /board\.config\.json/);
});

test("connecting a project's Jira stores its account, reviewer and the steps to «En curso» and «Por hacer»", async () => {
  assert.equal(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: { projects: "OPS" } }).error, undefined);
  assert.match((await admin.connectJira("cliente", {})).error, /credenciales/);
  assert.equal(admin.setCredentials("cliente", { JIRA_SITE: "otra.atlassian.net", JIRA_EMAIL: "yo@otra.example", JIRA_TOKEN: "t" }).error, undefined);
  const ask = async (route) => {
    if (route === "/myself") return { accountId: "acc-me", displayName: "Yo Mismo" };
    if (route.startsWith("/user/search")) return [{ accountId: "acc-rev", displayName: "Ana Revisa", accountType: "atlassian" }];
    if (route === "/issue/OPS-7/transitions")
      return { transitions: [
        { id: "11", name: "Empezar", to: { name: "En curso", statusCategory: { key: "indeterminate" } } },
        { id: "21", name: "Volver", to: { name: "Por hacer", statusCategory: { key: "new" } } },
        { id: "31", name: "Bloquear", to: { name: "Bloqueada", statusCategory: { key: "indeterminate" } } },
      ] };
    throw new Error("Jira 404");
  };
  assert.match((await admin.connectJira("cliente", { sample: "WEB-1" }, ask)).error, /no es de OPS/);
  const r = await admin.connectJira("cliente", { sample: "ops-7", reviewer: "Ana" }, ask);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.notes, []);
  const j = load().projectDefs.cliente.jira;
  assert.deepEqual(j.me, { id: "acc-me", name: "Yo Mismo" });
  assert.equal(j.reviewer.id, "acc-rev");
  assert.deepEqual(j.transitions, { start: "11", todo: "21", block: "31" });
  assert.equal(config.project("cliente").jira.me.id, "acc-me");
  assert.equal(admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", jira: { projects: "OPS, SOP" } }).error, undefined);
  assert.equal(load().projectDefs.cliente.jira.me.id, "acc-me", "changing the keys keeps the connection");
});

test("Errores reads every project with Sentry and closes each issue in its own organisation", async () => {
  const sentry = require("../src/features/sentry");
  admin.setCredentials("cliente", { SENTRY_TOKEN: "st" });
  admin.save({ id: "cliente", create: false, name: "Cliente", taskPrefix: "CLI", sentry: { org: "mi-empresa", projects: "web" } });
  assert.ok(sentry.sources().some((p) => p.id === "cliente"));
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, auth: opts.headers && opts.headers.authorization, method: opts.method || "GET" });
    if (/\/issues\/\?/.test(url)) return { ok: true, json: async () => [{ shortId: "WEB-1", id: "99", title: "Boom", permalink: "u", count: "2", userCount: 1, lastSeen: new Date().toISOString() }] };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const v = await sentry.listIssues(true);
    const mine = v.issues.find((i) => i.owner === "cliente");
    assert.ok(mine);
    assert.ok(calls.some((c) => c.url.includes("/projects/mi-empresa/web/issues/") && c.auth === "Bearer st"));
    await sentry.setStatus("99", "WEB-1", "resolved", "cliente");
    assert.ok(calls.some((c) => c.method === "PUT" && c.url.includes("/organizations/mi-empresa/issues/99/") && c.auth === "Bearer st"));
  } finally {
    global.fetch = real;
  }
});
