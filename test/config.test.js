require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CONFIG = path.join(__dirname, "..", "src", "core", "config.js");
const jira = { projects: ["WEB"], me: { id: "me", name: "Me" }, reviewer: { id: "rev", name: "Rev", mentions: [] }, transitions: {} };
const statuses = { review: "IN REVIEW", returned: ["To Do"], inProgress: ["In Progress"], closed: ["Done"], rejectLabel: "rejected" };

function load(config, files = {}, expr = "c") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutria-config-"));
  fs.writeFileSync(path.join(dir, "board.config.json"), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const env = { ...process.env, TOWER_WORKSPACE: dir };
  for (const k of ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"]) delete env[k];
  const code = `const c = require(${JSON.stringify(CONFIG)}); process.stdout.write(JSON.stringify(${expr}));`;
  const r = cp.spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env });
  if (r.status !== 0) return { error: r.stderr };
  return JSON.parse(r.stdout);
}

test("the old flat format becomes one project named after the company, and the file is upgraded", () => {
  const flat = { company: "Ácme Corp", root: "/tmp/acme", jira, statuses, cluster: { label: "Mac" }, devServers: [{ id: "web" }] };
  const r = load(flat, {}, "{ ids: c.projects.map((p) => p.id), company: c.company, cluster: c.cluster, jql: c.jira.projectsJql, dev: c.devServers.length, file: JSON.parse(require('fs').readFileSync(process.env.TOWER_WORKSPACE + '/board.config.json', 'utf8')), backup: JSON.parse(require('fs').readFileSync(process.env.TOWER_WORKSPACE + '/board.config.json.flat.bak', 'utf8')) }");
  assert.deepEqual(r.ids, ["acme-corp"]);
  assert.equal(r.company, "Ácme Corp");
  assert.deepEqual(r.cluster, { label: "Mac" });
  assert.equal(r.jql, "project in (WEB)");
  assert.equal(r.dev, 1);
  assert.deepEqual(Object.keys(r.file), ["cluster", "projects"]);
  assert.equal(r.file.projects[0].id, "acme-corp");
  assert.deepEqual(r.backup, flat);
});

test("the projects format exposes the first project flat and every project by id", () => {
  const r = load(
    { cluster: { label: "Mac" }, projects: [{ id: "acme", name: "Acme", root: "/tmp/acme", jira, statuses, deployProjects: ["web"] }, { id: "cuentas", name: "Cuentas", root: "/tmp/cuentas" }] },
    {},
    "{ ids: c.projects.map((p) => p.id), company: c.company, deploy: c.deployProjects, other: { jira: c.project('cuentas').jira, statuses: c.project('cuentas').statuses, root: c.project('cuentas').root }, missing: c.project('nope'), page: c.forPage().workspaces }"
  );
  assert.deepEqual(r.ids, ["acme", "cuentas"]);
  assert.equal(r.company, "Acme");
  assert.deepEqual(r.deploy, ["web"]);
  assert.deepEqual(r.other, { jira: null, statuses: null, root: path.resolve("/tmp/cuentas") });
  assert.equal(r.missing, null);
  assert.deepEqual(r.page.map(({ id, name, jira }) => ({ id, name, jira })), [{ id: "acme", name: "Acme", jira: true }, { id: "cuentas", name: "Cuentas", jira: false }]);
  assert.deepEqual(r.page[1].modules, { jira: false, followUp: false, sentry: false, deploy: false, devServers: false, context: false, daily: false });
  assert.equal(r.page[0].modules.deploy, true);
});

test("each project reads its own credentials and never the first project's", () => {
  const r = load(
    { projects: [{ id: "acme", jira, statuses }, { id: "client", jira, statuses }, { id: "solo" }] },
    { ".env": "JIRA_SITE=acme.example\nJIRA_EMAIL=a\nJIRA_TOKEN=t1\nSENTRY_TOKEN=s1\n", ".env.client": "JIRA_SITE=client.example\nJIRA_EMAIL=b\nJIRA_TOKEN=t2\n" },
    "{ main: c.credentials().site, client: c.project('client').credentials().site, clientSentry: c.project('client').secret('SENTRY_TOKEN') || null, mainSentry: c.secret('SENTRY_TOKEN'), solo: (() => { try { return c.project('solo').credentials(); } catch (e) { return 'missing'; } })() }"
  );
  assert.deepEqual(r, { main: "acme.example", client: "client.example", clientSentry: null, mainSentry: "s1", solo: "missing" });
});

test("bad project lists are refused", () => {
  assert.match(load({ projects: [{ id: "Bad Id", jira, statuses }] }).error, /lowercase/);
  assert.match(load({ projects: [{ id: "a", jira, statuses }, { id: "a" }] }).error, /unique/);
  assert.match(load({ projects: [{ id: "a" }] }).error, /first project still needs jira/);
});
