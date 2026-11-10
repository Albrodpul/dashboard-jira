const box = require("./helpers/env").sandbox({ errorsArea: "errors", deployProjects: ["web"] });
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const holds = require("../src/features/holds");
const records = require("../src/core/records");
const { mutate, load } = require("../src/core/data");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const NOW = Date.parse("2026-11-08T10:00:00.000Z");
const HOUR = 3600 * 1000;

require("../src/features/mailman")._test.setEnv({ primary: () => false });
fs.writeFileSync(path.join(box.workspace, "sessions.js"), "");
fs.writeFileSync(path.join(box.data, "sessions.json"), JSON.stringify({ areas: { pay: { title: "Pagos", epics: { "WEB-1": "Checkout" } }, cat: { title: "Catálogo", epics: {} }, errors: { title: "Errores", epics: {} }, deploy: { title: "Subir", epics: {} } } }));

function cli(...args) {
  const env = { ...process.env };
  for (const k of ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"]) delete env[k];
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function reset(tasks = {}, extra = {}) {
  mutate((d) => {
    d.tasks = tasks;
    d.restrictions = [];
    d.deliveries = [];
    d.deployments = [];
    d.followUps = [];
    d.sentry = {};
    d.config = {};
    Object.assign(d, extra);
  });
}

const task = (key, fields = {}) => ({ key, title: `Tarea ${key}`, kind: "new", epicKey: "WEB-1", epicName: "Checkout", status: "pending", proposedArea: "pay", at: "2026-11-08T09:00:00.000Z", ...fields });

function addHold(input, nowMs = Date.now()) {
  const r = mutate((d) => holds.addRestriction(d, input, { areas: ["pay", "cat", "errors", "deploy"], nowMs }));
  assert.ok(!r.error, r.error);
  return r;
}

function reply() {
  const out = {};
  return { out, send: (res, code, body) => Object.assign(out, { code, body: body || {} }) };
}

test("parseUntil reads Madrid dates and times, in winter and in summer", () => {
  assert.equal(holds.parseUntil("9-11", NOW).until, "2026-11-08T23:00:00.000Z");
  assert.equal(holds.parseUntil("2026-11-09 18:00", NOW).until, "2026-11-09T17:00:00.000Z");
  assert.equal(holds.parseUntil("2026-11-09T18:00", NOW).until, "2026-11-09T17:00:00.000Z");
  assert.equal(holds.parseUntil("1-7-2027 10:00", NOW).until, "2027-07-01T08:00:00.000Z");
  assert.equal(holds.parseUntil("", NOW).until, null);
  assert.equal(holds.parseUntil("nunca", NOW).until, null);
});

test("parseUntil rejects past and impossible dates and rolls a bare past day to next year", () => {
  assert.match(holds.parseUntil("2026-11-01", NOW).error, /ya ha pasado/);
  assert.match(holds.parseUntil("31-2", NOW).error, /no existe/);
  assert.match(holds.parseUntil("mañana", NOW).error, /no entiendo/);
  assert.equal(holds.parseUntil("1-11", NOW).until, "2027-10-31T23:00:00.000Z");
});

test("a hold stops applying at its until and when released", () => {
  reset({ "WEB-10": task("WEB-10") });
  const { restriction: r } = addHold({ tasks: ["WEB-10"], reason: "NFL", until: "2026-11-09 00:00" }, NOW);
  const d = load();
  assert.match(holds.checkTask(d, d.tasks["WEB-10"], "pay", NOW), /retenida por la restricción R\d+ \(«NFL»\)/);
  assert.equal(holds.checkTask(d, d.tasks["WEB-10"], "pay", Date.parse(r.until) - 1) !== "", true);
  assert.equal(holds.checkTask(d, d.tasks["WEB-10"], "pay", Date.parse(r.until)), "");
  reset({ "WEB-10": task("WEB-10") });
  const { restriction: open } = addHold({ tasks: ["WEB-10"], reason: "hasta que diga" });
  assert.notEqual(holds.checkTask(load(), load().tasks["WEB-10"], "pay"), "");
  const rel = mutate((x) => holds.releaseRestriction(x, open.id));
  assert.ok(!rel.error);
  assert.equal(holds.checkTask(load(), load().tasks["WEB-10"], "pay"), "");
  assert.match(mutate((x) => holds.releaseRestriction(x, open.id)).error, /ya se levantó/);
});

test("an epic hold applies to tasks that arrive after it, and an area hold to whatever goes to that session", () => {
  reset({});
  addHold({ epics: ["WEB-1"], reason: "evento" });
  addHold({ areas: ["cat"], reason: "catálogo parado" });
  mutate((d) => (d.tasks["WEB-77"] = task("WEB-77")));
  mutate((d) => (d.tasks["API-5"] = task("API-5", { epicKey: "API-2", proposedArea: "pay" })));
  const d = load();
  assert.notEqual(holds.checkTask(d, d.tasks["WEB-77"], "pay"), "");
  assert.equal(holds.checkTask(d, d.tasks["API-5"], "pay"), "");
  assert.notEqual(holds.checkTask(d, d.tasks["API-5"], "cat"), "");
  assert.notEqual(holds.checkArea(d, "El despliegue", "cat"), "");
});

test("adding a hold sends approved tasks back to Pendientes and lists the ones already in a session", () => {
  reset({ "WEB-1": task("WEB-1", { status: "approved", area: "pay", approvedVia: "board", decidedAt: "x" }), "WEB-2": task("WEB-2", { status: "sent", area: "pay", approvedVia: "board" }), "WEB-3": task("WEB-3", { status: "done", area: "pay" }) });
  const r = addHold({ epics: ["WEB-1"], reason: "NFL" });
  assert.deepEqual(r.reverted, ["WEB-1"]);
  assert.deepEqual(r.inSession, ["WEB-2"]);
  const d = load();
  assert.equal(d.tasks["WEB-1"].status, "pending");
  assert.equal(d.tasks["WEB-1"].approvedVia, undefined);
  assert.equal(d.tasks["WEB-1"].proposedArea, "pay");
  assert.deepEqual(holds.pendingStopNotices(d).map((e) => e.task.key), ["WEB-2"]);
});

test("two restrictions created in the same millisecond get different ids", () => {
  reset({});
  for (const k of ["WEB-1", "WEB-2", "WEB-3"]) addHold({ tasks: [k], reason: "x" }, NOW);
  assert.deepEqual(load().restrictions.map((r) => r.id).sort(), ["R20261108100000000", "R20261108100000000-2", "R20261108100000000-3"]);
});

test("a note restriction does not block and validation rejects empty or unknown scopes", () => {
  reset({ "WEB-1": task("WEB-1") });
  addHold({ tasks: ["WEB-1"], mode: "note", reason: "No toques la tabla de pagos" });
  const d = load();
  assert.equal(holds.checkTask(d, d.tasks["WEB-1"], "pay"), "");
  assert.equal(holds.notesFor(d, holds.taskTarget(d.tasks["WEB-1"], "pay")).length, 1);
  const bad = (input) => mutate((x) => holds.addRestriction(x, input, { areas: ["pay"] })).error;
  assert.match(bad({ reason: "x" }), /tareas, epics o sesiones/);
  assert.match(bad({ tasks: ["WEB-1"] }), /falta el motivo/);
  assert.match(bad({ areas: ["nope"], reason: "x" }), /sesiones desconocidas/);
  assert.match(bad({ tasks: ["web 1"], reason: "x" }), /claves no válidas/);
  assert.match(bad({ tasks: ["WEB-1"], reason: "x", mode: "pause" }), /modo desconocido/);
});

test("board routes refuse to approve, batch-approve or resolve by hand a held task", () => {
  const routes = require("../src/server/routes/tasks");
  reset({ "WEB-1": task("WEB-1"), "WEB-2": task("WEB-2", { epicKey: "API-9" }) });
  addHold({ tasks: ["WEB-1"], reason: "NFL" });
  let r = reply();
  routes.handleTask({}, { key: "WEB-1", patch: { status: "approved", area: "pay" } }, r.send);
  assert.equal(r.out.code, 409);
  assert.match(r.out.body.error, /NFL/);
  r = reply();
  routes.handleTask({}, { key: "WEB-1", patch: { status: "sent", manual: true } }, r.send);
  assert.equal(r.out.code, 409);
  r = reply();
  routes.handleBatch({}, { items: [{ key: "WEB-1", area: "pay" }] }, r.send);
  assert.equal(r.out.code, 409);
  assert.equal(load().tasks["WEB-1"].status, "pending");
  r = reply();
  routes.handleBatch({}, { items: [{ key: "WEB-1", area: "pay" }, { key: "WEB-2", area: "pay" }] }, r.send);
  assert.equal(r.out.code, 200);
  assert.equal(r.out.body.approved, 1);
  assert.deepEqual(r.out.body.held.map((x) => x.key), ["WEB-1"]);
  assert.equal(load().tasks["WEB-1"].status, "pending");
  assert.equal(load().tasks["WEB-2"].status, "approved");
});

test("an area hold blocks Desplegar, Errores sentry and Sentry sends to that session", () => {
  const ops = require("../src/server/routes/operations");
  const { POST_ROUTES } = require("../src/server/routes/index");
  reset({}, { followUps: [{ at: "2026-11-08T09:00:00.000Z", text: "x", errors: [{ id: "err-1", text: "fallo", state: "proposed", at: "2026-11-08T09:00:00.000Z" }] }] });
  addHold({ areas: ["deploy", "errors", "cat"], reason: "congelado" });
  let r = reply();
  ops.handleDeploy({}, { projects: ["web"], environment: "develop", area: "deploy" }, r.send);
  assert.equal(r.out.code, 409);
  assert.equal(load().deployments.length, 0);
  r = reply();
  ops.handleFollowUpError({}, { id: "err-1", action: "send" }, r.send);
  assert.equal(r.out.code, 409);
  assert.equal(load().followUps[0].errors[0].state, "proposed");
  r = reply();
  POST_ROUTES["/api/sentry/send"]({}, { issues: [{ id: "WEB-K1", title: "t" }], area: "cat" }, r.send);
  assert.equal(r.out.code, 409);
  assert.deepEqual(load().sentry, {});
});

test("CLI approve-chat, update, sent and the returned-tasks rule cannot get past a hold", () => {
  reset({ "WEB-1": task("WEB-1"), "WEB-2": task("WEB-2", { status: "approved", area: "pay", approvedVia: "board" }) });
  mutate((d) => (d.restrictions = []));
  addHold({ tasks: ["WEB-1"], reason: "NFL" });
  let r = cli("approve-chat", "WEB-1", "pay");
  assert.equal(r.code, 1);
  assert.match(r.err, /retenida/);
  assert.equal(load().tasks["WEB-1"].status, "pending");
  mutate((d) => d.restrictions.push({ id: "R2", scope: { tasks: ["WEB-2"], epics: [], areas: [] }, mode: "hold", reason: "sin revertir", until: null, createdAt: new Date().toISOString(), createdBy: "chat", releasedAt: null }));
  r = cli("sent", "WEB-2");
  assert.equal(r.code, 1);
  assert.match(r.err, /retenida/);
  r = cli("update", "WEB-2", JSON.stringify({ status: "sent" }));
  assert.equal(r.code, 1);
  assert.equal(load().tasks["WEB-2"].status, "approved");
  mutate((d) => {
    d.tasks["WEB-1"] = task("WEB-1", { status: "done", area: "pay", events: [] });
    d.config = { autoReturned: true };
  });
  r = cli("add", JSON.stringify([{ key: "WEB-1", title: "Tarea WEB-1", kind: "returned", epicKey: "WEB-1", event: "ev-1" }]));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Queda en Pendientes/);
  assert.equal(load().tasks["WEB-1"].status, "pending");
  assert.equal(load().tasks["WEB-1"].approvedVia, undefined);
});

test("CLI deployment-update, error-sent and sentry-sent refuse items for a held session", () => {
  reset({}, {
    deployments: [{ id: "D1", projects: ["web"], environment: "develop", area: "deploy", status: "approved", approvedVia: "board", at: new Date().toISOString() }],
    followUps: [{ at: "2026-11-08T09:00:00.000Z", text: "x", errors: [{ id: "err-1", text: "fallo", state: "approved", approvedVia: "board", at: "2026-11-08T09:00:00.000Z" }] }],
    sentry: { "WEB-K1": { id: "WEB-K1", area: "cat", state: "approved", approvedVia: "board", at: new Date().toISOString() } },
  });
  addHold({ areas: ["deploy", "errors", "cat"], reason: "congelado" });
  assert.equal(cli("deployment-update", "D1", JSON.stringify({ status: "sent" })).code, 1);
  assert.equal(cli("sent", "D1").code, 1);
  assert.equal(cli("error-sent", "err-1").code, 1);
  assert.equal(cli("sentry-sent", "WEB-K1").code, 1);
  const d = load();
  assert.equal(d.deployments[0].status, "approved");
  assert.equal(d.followUps[0].errors[0].state, "approved");
  assert.equal(d.sentry["WEB-K1"].state, "approved");
});

test("CLI hold add, list, check and release", () => {
  reset({ "WEB-1": task("WEB-1", { status: "approved", area: "pay", approvedVia: "board" }) });
  let r = cli("hold", "add", "--epics", "WEB-1", "--until", "2099-01-01 10:00", "--reason", "Evento NFL");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Restricción guardada: R\d+ · Retención · epic WEB-1 · «Evento NFL»/);
  assert.match(r.out, /Vuelven a Pendientes .*WEB-1/);
  const id = load().restrictions[0].id;
  assert.equal(load().restrictions[0].createdBy, "chat");
  assert.match(cli("hold", "list").out, new RegExp(id));
  assert.match(cli("hold", "check", "WEB-1").out, /Evento NFL/);
  assert.equal(cli("hold", "add", "--areas", "nope", "--reason", "x").code, 1);
  r = cli("hold", "release", id);
  assert.equal(r.code, 0, r.err);
  assert.match(cli("hold", "list").out, /No hay restricciones activas/);
  assert.match(cli("hold", "check", "WEB-1").out, /sin restricciones/);
});

test("dispatches never lists a held task", () => {
  reset({ "WEB-1": task("WEB-1", { status: "approved", area: "pay", approvedVia: "board" }), "WEB-2": task("WEB-2", { epicKey: "API-3", status: "approved", area: "pay", approvedVia: "board" }) });
  mutate((d) => d.restrictions.push({ id: "R9", scope: { tasks: ["WEB-1"], epics: [], areas: [] }, mode: "hold", reason: "NFL", until: null, createdAt: new Date().toISOString(), createdBy: "chat", releasedAt: null }));
  const out = JSON.parse(cli("dispatches").out);
  assert.deepEqual(out.tasks.map((t) => t.key), ["WEB-2"]);
  assert.deepEqual(out.held.map((t) => t.key), ["WEB-1"]);
});

test("restrictions merge record by record between machines and a release wins when newer", () => {
  const T1 = "2026-11-09T10:00:00.000Z";
  const T2 = "2026-11-09T11:00:00.000Z";
  const a = { id: "R1", scope: { tasks: ["WEB-1"], epics: [], areas: [] }, mode: "hold", reason: "NFL", until: null, createdAt: T1, releasedAt: null };
  const b = { id: "R2", scope: { tasks: [], epics: ["WEB-1"], areas: [] }, mode: "note", reason: "ojo", until: null, createdAt: T2, releasedAt: null };
  const d = { restrictions: [a], syncStamps: { restrictions: { R1: T1 } } };
  records.mergeRecords(d, { restrictions: [b, { ...a, releasedAt: T2 }] }, { restrictions: { R1: T2, R2: T2 } }, true);
  assert.deepEqual(d.restrictions.map((r) => r.id), ["R2", "R1"]);
  assert.equal(d.restrictions.find((r) => r.id === "R1").releasedAt, T2);
  const mine = { restrictions: [{ ...a, releasedAt: T2 }], syncStamps: { restrictions: { R1: T2 } } };
  records.mergeRecords(mine, { restrictions: [a] }, { restrictions: { R1: T1 } }, true);
  assert.equal(mine.restrictions[0].releasedAt, T2);
  const fresh = { restrictions: [] };
  records.mergeRecords(fresh, { restrictions: [a] }, { restrictions: { R1: T1 } }, false);
  assert.equal(fresh.restrictions.length, 1);
});

test("a restriction written with mutate gets a sync stamp and travels in the snapshot", () => {
  reset({});
  addHold({ tasks: ["WEB-4"], reason: "x" });
  const d = load();
  const id = d.restrictions[0].id;
  assert.ok(d.syncStamps.restrictions[id]);
  const snap = require("../src/cluster/snapshot").snapshot();
  assert.equal(snap.docs.restrictions[0].id, id);
  assert.ok(snap.stamps.restrictions[id]);
});

test("a returned task whose card was deleted goes back to the session that did it", () => {
  reset({}, { config: { autoReturned: true }, deleted: { "WEB-9": new Date().toISOString() } });
  fs.writeFileSync(path.join(box.data, "task-history.jsonl"), JSON.stringify({ key: "WEB-9", status: "done", area: "cat", removedAt: new Date().toISOString() }) + "\n");
  const r = cli("add", JSON.stringify([{ key: "WEB-9", title: "Tarea WEB-9", kind: "returned", epicKey: "WEB-1", event: "ev-9" }]));
  assert.equal(r.code, 0, r.err);
  const t = load().tasks["WEB-9"];
  assert.equal(t.status, "approved");
  assert.equal(t.area, "cat");
  assert.equal(t.approvedVia, "rule");
  assert.equal(load().deleted["WEB-9"], undefined);
  const n = cli("add", JSON.stringify([{ key: "WEB-10", title: "Tarea WEB-10", kind: "new", epicKey: "WEB-1", event: "ev-10" }]));
  assert.equal(n.code, 0, n.err);
  assert.equal(load().tasks["WEB-10"].status, "pending");
});
