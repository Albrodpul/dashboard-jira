const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cluster = require("../src/cluster/cluster");
const { mutate, load, SEEN_FILE } = require("../src/core/data");

const T1 = "2026-11-09T10:00:00.000Z";
const T2 = "2026-11-09T11:00:00.000Z";
const T3 = "2026-11-09T12:00:00.000Z";
const task = (key, updatedAt, extra = {}) => ({ key, status: "pending", ...(updatedAt ? { updatedAt } : {}), ...extra });

test("mergeTasks: the newest updatedAt wins in both directions", () => {
  const d = { tasks: { A: task("A", T2, { from: "mine" }), B: task("B", T1, { from: "mine" }) } };
  cluster.mergeTasks(d, { tasks: { A: task("A", T1, { from: "theirs" }), B: task("B", T2, { from: "theirs" }) } }, true);
  assert.equal(d.tasks.A.from, "mine");
  assert.equal(d.tasks.B.from, "theirs");
});

test("mergeTasks: a tie goes to the side named by theirsOnTie", () => {
  const mine = () => ({ tasks: { A: task("A", T1, { from: "mine" }) } });
  const theirs = { tasks: { A: task("A", T1, { from: "theirs" }) } };
  const a = mine();
  cluster.mergeTasks(a, theirs, true);
  assert.equal(a.tasks.A.from, "theirs");
  const b = mine();
  cluster.mergeTasks(b, theirs, false);
  assert.equal(b.tasks.A.from, "mine");
});

test("mergeTasks: a task without updatedAt loses against a stamped one", () => {
  const d = { tasks: { A: task("A", null, { from: "mine" }) } };
  cluster.mergeTasks(d, { tasks: { A: task("A", T1, { from: "theirs" }) } }, false);
  assert.equal(d.tasks.A.from, "theirs");
  const e = { tasks: { A: task("A", T1, { from: "mine" }) } };
  cluster.mergeTasks(e, { tasks: { A: task("A", null, { from: "theirs" }) } }, true);
  assert.equal(e.tasks.A.from, "mine");
});

test("mergeTasks: tasks that exist on one side only are kept", () => {
  const d = { tasks: { A: task("A", T1) } };
  cluster.mergeTasks(d, { tasks: { B: task("B", T1) } }, true);
  assert.deepEqual(Object.keys(d.tasks).sort(), ["A", "B"]);
});

test("mergeTasks: deleted tombstones remove older tasks, merge by newest and let newer tasks back", () => {
  const d = { tasks: { A: task("A", T1), C: task("C", T3) }, deleted: { A: T2, X: T1 } };
  cluster.mergeTasks(d, { tasks: { A: task("A", T1), B: task("B", T1), C: task("C", T1) }, deleted: { B: T2, C: T2, X: T3 } }, true);
  assert.deepEqual(Object.keys(d.tasks).sort(), ["C"]);
  assert.equal(d.tasks.C.updatedAt, T3);
  assert.deepEqual(d.deleted, { A: T2, B: T2, C: T2, X: T3 });
});

test("mergeTasks: a tombstone equal to the task stamp still deletes it", () => {
  const d = { tasks: { A: task("A", T2) } };
  cluster.mergeTasks(d, { tasks: {}, deleted: { A: T2 } }, false);
  assert.equal(d.tasks.A, undefined);
});

test("mergePeer keeps the primary on ties and takes newer follower changes", () => {
  mutate(
    (d) => {
      d.tasks = { A: task("A", T1, { from: "primary" }), B: task("B", T1, { from: "primary" }) };
    },
    { keepStamps: true }
  );
  assert.equal(cluster.mergePeer({ docs: { tasks: { A: task("A", T1, { from: "follower" }), B: task("B", T2, { from: "follower" }) } } }), true);
  const t = load().tasks;
  assert.equal(t.A.from, "primary");
  assert.equal(t.B.from, "follower");
  assert.equal(t.B.updatedAt, T2);
  assert.equal(cluster.mergePeer(null), false);
  assert.equal(cluster.mergePeer({ docs: {} }), true);
});

test("applySnapshot gives ties to the primary, keeps newer local tasks and writes seen and routes", () => {
  mutate(
    (d) => {
      d.tasks = { A: task("A", T1, { from: "follower" }), B: task("B", T3, { from: "follower" }) };
    },
    { keepStamps: true }
  );
  const ok = cluster.applySnapshot({
    at: T3,
    host: "peer",
    docs: { tasks: { A: task("A", T1, { from: "primary" }), B: task("B", T2, { from: "primary" }) } },
    seen: { ids: { e1: T1 } },
    areas: { wallet: { title: "Wallet", epics: { "WEB-1": true }, conversation: "c0ffee00-0000-0000-0000-000000000000", session: "Wallet" } },
    roles: { reporter: { conversation: "c0ffee00-0000-0000-0000-000000000001", session: "Reporte JIRA" } },
  });
  assert.equal(ok, true);
  const t = load().tasks;
  assert.equal(t.A.from, "primary");
  assert.equal(t.B.from, "follower");
  assert.deepEqual(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")), { ids: { e1: T1 } });
  const routes = JSON.parse(fs.readFileSync(path.join(env.data, "sessions.json"), "utf8"));
  assert.equal(routes.areas.wallet.conversation, "c0ffee00-0000-0000-0000-000000000000");
  assert.equal(routes.reporter.session, "Reporte JIRA");
  assert.equal(cluster.applySnapshot(null), false);
});
