require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { findings, repeatedNotices, apply } = require("../src/features/watchdog");
const { load } = require("../src/core/data");

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const userLine = (min, content) => JSON.stringify({ type: "user", timestamp: ago(min), message: { role: "user", content } });

test("the same startup notice twice within 15 minutes is a repeat, even from different senders or with different marks", () => {
  const notice = "Aviso del arranque: arranca el seguimiento. Eres la sesión de seguimiento registrada.";
  const lines = [userLine(30, `<cross-session-message from-name="palc-3c">\n${notice}\n</cross-session-message>`), userLine(29, `<cross-session-message from-name="palc-4c">\n${notice}\n</cross-session-message>`), userLine(10, `Aviso del tablero: arranca la sesión del tablero [envío E1]`), userLine(1, "Aviso del tablero: algo distinto")];
  const r = repeatedNotices(lines, Date.now() - 3600000);
  assert.equal(r.length, 1);
  assert.match(r[0].notice, /arranca el seguimiento/);
  assert.equal(repeatedNotices([userLine(40, notice), userLine(10, notice)], Date.now() - 3600000).length, 0);
});

test("a session waiting with no question on the board is flagged; one whose question the board shows is not", () => {
  const s = { sessions: { list: [{ conversation: "c1", name: "Errores sentry", status: "waiting", statusSince: ago(6) }, { conversation: "c2", name: "Otra", status: "waiting", statusSince: ago(6) }, { conversation: "c3", name: "Reciente", status: "waiting", statusSince: ago(1) }] }, stuckDialogs: [] };
  const d = { permissions: [{ conversation: "c2", status: "pending" }], deliveries: [{ id: "E9", status: "typing", at: ago(10), area: "pagos", kind: "tasks", ids: ["WEB-1"] }] };
  const f = findings(s, d);
  assert.deepEqual(f.map((x) => `${x.kind}:${x.conversation}`).sort(), ["typing:undefined", "waiting:c1"].sort());
});

test("each problem is announced once, stays listed while it lasts and goes away when fixed", () => {
  const f = { key: "waiting|c1|x", kind: "waiting", conversation: "c1", name: "A", title: "t", detail: "d" };
  assert.equal(apply([f]).length, 1);
  assert.equal(apply([f]).length, 0);
  assert.equal(load().watchdog.alerts.length, 1);
  assert.equal(apply([{ ...f, key: "waiting|c1|y" }]).length, 0);
  apply([]);
  assert.equal(load().watchdog.alerts.length, 0);
});
