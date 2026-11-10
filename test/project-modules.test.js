const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const config = require("../src/core/config");
const admin = require("../src/features/projects-admin");
const { mutate, load } = require("../src/core/data");

const folder = path.join(box.dir, "side");
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(box.data, "sessions.json"), JSON.stringify({ areas: { pay: { title: "Pagos", epics: {} }, books: { title: "Libros", epics: {}, project: "side", session: "Libros", conversation: "c-side" } } }));
require("../src/features/mailman")._test.setEnv({ primary: () => false });

test("daily and context tidy are opt-in for panel projects and on for the main one", () => {
  assert.equal(admin.save({ id: "side", name: "Side", taskPrefix: "SIDE", root: folder }).error, undefined);
  assert.equal(config.project("side").daily, false);
  assert.equal(config.mainProject.daily, true);
  assert.equal(admin.save({ id: "side", name: "Side", taskPrefix: "SIDE", root: folder, daily: true, contextTidy: true, create: false }).error, undefined);
  const p = config.project("side");
  assert.equal(p.daily, true);
  assert.equal(p.contextTidy, true);
  assert.deepEqual(Object.keys(require("../src/features/daily").dailyStates()).sort(), [config.mainProject.id, "side"].sort());
});

test("a project's daily only counts its own tasks and is stored apart", async () => {
  const daily = require("../src/features/daily");
  const day = daily.lastWorkday();
  const at = `${day}T10:00:00.000Z`;
  mutate((d) => {
    d.tasks["SIDE-1"] = { key: "SIDE-1", title: "Libro de gastos", project: "side", source: "manual", status: "sent", sentAt: at };
    d.tasks["WEB-1"] = { key: "WEB-1", title: "Web", status: "sent", sentAt: at };
  });
  const facts = daily.dailyState("side").facts;
  assert.equal(facts.errors.length, 0);
  mutate((d) => (d.tasks["SIDE-1"].sentAt = "2000-01-01T10:00:00.000Z"));
  await daily.dailyFor(day, false, "side");
  assert.equal(load().projectDailies.side[day].empty, true);
  assert.equal((load().dailies || {})[day], undefined);
});

test("ordering a project's context waits for its own tasks and goes to one of its sessions with its own rules", () => {
  const { tidyBlockers } = require("../src/server/state");
  mutate((d) => {
    delete d.tasks["SIDE-1"];
    delete d.tasks["WEB-1"];
    d.tasks["SIDE-2"] = { key: "SIDE-2", title: "x", project: "side", status: "pending" };
  });
  assert.deepEqual(tidyBlockers(load(), "side"), ["1 tarea en Pendientes"]);
  assert.deepEqual(tidyBlockers(load(), config.mainProject.id), []);
  mutate((d) => delete d.tasks["SIDE-2"]);
  let sent = null;
  require("../src/server/routes/operations").handleTidy({}, (res, code, body) => (sent = { code, body }), { project: "side" });
  assert.equal(sent.code, 200, JSON.stringify(sent.body));
  const o = load().contextTidies.side;
  assert.match(o.id, /^tidy-side-/);
  assert.equal(load().contextTidy, undefined);
  const { composeTidy } = require("../src/features/mailman");
  const text = composeTidy(o, "E1");
  assert.match(text, /proyecto Side/);
  assert.match(text, /sus propias reglas: su AGENTS\.md/);
  assert.doesNotMatch(text, /orquesta\.md/);
});
