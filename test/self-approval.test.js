const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { mutate, load } = require("../src/core/data");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const ORCHESTRATOR = "aaaaaaaa-2222-4333-8444-555555555555";
const REPORTER = "bbbbbbbb-2222-4333-8444-555555555555";
const AREA = "cccccccc-2222-4333-8444-555555555555";
const SIDE_AREA = "dddddddd-2222-4333-8444-555555555555";
const STRANGER = "eeeeeeee-2222-4333-8444-555555555555";

fs.writeFileSync(path.join(box.workspace, "sessions.js"), "");
fs.writeFileSync(path.join(box.data, "sessions.json"), JSON.stringify({ orchestrator: { conversation: ORCHESTRATOR }, reporter: { conversation: REPORTER }, areas: { pay: { title: "Pagos", epics: {}, conversation: AREA }, side: { title: "Side", epics: {}, conversation: SIDE_AREA, project: "side" } } }));

function cli(conversation, ...args) {
  const env = { ...process.env };
  for (const k of ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  if (conversation) env.CLAUDE_CODE_SESSION_ID = conversation;
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const pending = () =>
  mutate((d) => {
    d.tasks = { "WEB-1": { key: "WEB-1", title: "Tarea", kind: "new", status: "pending", at: new Date().toISOString() } };
    d.restrictions = [];
  });

test("approve-chat is accepted only from the orchestrator and the reporter", () => {
  for (const who of [AREA, STRANGER, null]) {
    pending();
    const r = cli(who, "approve-chat", "WEB-1", "pay");
    assert.equal(r.code, 1, String(who));
    assert.match(r.err, /Rechazado: «board\.js approve-chat» solo se acepta desde la orquestadora o la sesión de reporte/);
    assert.equal(load().tasks["WEB-1"].status, "pending");
  }
  assert.match(cli(AREA, "approve-chat", "WEB-1", "pay").err, /lo pide «Pagos»/);
  assert.match(cli(null, "approve-chat", "WEB-1", "pay").err, /falta CLAUDE_CODE_SESSION_ID/);
  for (const who of [ORCHESTRATOR, REPORTER]) {
    pending();
    const r = cli(who, "approve-chat", "WEB-1", "pay");
    assert.equal(r.code, 0, r.err);
    assert.equal(load().tasks["WEB-1"].status, "approved");
    assert.equal(load().tasks["WEB-1"].approvedVia, "chat");
  }
});

test("hold add and release are accepted only from the orchestrator; list and check stay open", () => {
  pending();
  for (const who of [REPORTER, AREA, null]) {
    const r = cli(who, "hold", "add", "--tasks", "WEB-1", "--reason", "x");
    assert.equal(r.code, 1, String(who));
    assert.match(r.err, /solo se acepta desde la orquestadora/);
  }
  assert.deepEqual(load().restrictions, []);
  let r = cli(ORCHESTRATOR, "hold", "add", "--tasks", "WEB-1", "--reason", "x");
  assert.equal(r.code, 0, r.err);
  const id = load().restrictions[0].id;
  assert.equal(cli(AREA, "hold", "list").code, 0);
  assert.equal(cli(AREA, "hold", "check", "WEB-1").code, 0);
  r = cli(AREA, "hold", "release", id);
  assert.equal(r.code, 1);
  assert.equal(load().restrictions[0].releasedAt, null);
  assert.equal(cli(ORCHESTRATOR, "hold", "release", id).code, 0);
});

test("tidy-start and tidy-end come from the orchestrator, or from a session of the project being tidied", () => {
  mutate((d) => {
    d.contextTidy = { id: "tidy-1", status: "approved", approvedVia: "board", at: new Date().toISOString() };
    d.contextTidies = { side: { id: "tidy-2", project: "side", status: "approved", approvedVia: "board", at: new Date().toISOString() } };
  });
  for (const who of [AREA, REPORTER, SIDE_AREA, null]) {
    const r = cli(who, "tidy-start", "tidy-1");
    assert.equal(r.code, 1, String(who));
    assert.match(r.err, /solo se acepta desde la orquestadora/);
  }
  assert.equal(load().contextTidy.status, "approved");
  assert.equal(cli(ORCHESTRATOR, "tidy-start", "tidy-1").code, 0);
  assert.equal(cli(AREA, "tidy-end", "tidy-1", "hecho").code, 1);
  assert.equal(cli(ORCHESTRATOR, "tidy-end", "tidy-1", "hecho").code, 0);
  assert.equal(load().contextTidy.status, "done");
  assert.equal(cli(AREA, "tidy-start", "tidy-2").code, 1);
  let r = cli(SIDE_AREA, "tidy-start", "tidy-2");
  assert.equal(r.code, 0, r.err);
  r = cli(SIDE_AREA, "tidy-end", "tidy-2", "hecho");
  assert.equal(r.code, 0, r.err);
  assert.equal(load().contextTidies.side.status, "done");
});
