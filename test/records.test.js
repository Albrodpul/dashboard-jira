require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const records = require("../src/core/records");
const cluster = require("../src/cluster/cluster");
const { mutate, load } = require("../src/core/data");

const T1 = "2026-11-09T10:00:00.000Z";
const T2 = "2026-11-09T11:00:00.000Z";
const T3 = "2026-11-09T12:00:00.000Z";
const raw = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, JSON.stringify(v)]));

test("stampRecords stamps changed config fields, list records and documents only", () => {
  const before = { config: { paused: false, autoReturned: true }, deployments: [{ id: "D1", status: "approved", at: T1 }, { id: "D0", status: "sent", at: T1 }], lastReview: { at: T1 } };
  const d = JSON.parse(JSON.stringify(before));
  d.config.paused = true;
  d.deployments[0].status = "sent";
  d.lastReview = { at: T2 };
  records.stampRecords(raw(before), d, null, T3);
  assert.deepEqual(d.syncStamps, { config: { paused: T3 }, deployments: { D1: T3 }, lastReview: { "": T3 } });
});

test("stampRecords leaves a tombstone for removed fields and records", () => {
  const before = { config: { overtime: { since: T1 }, paused: true }, aliases: { a: "x", b: "y" } };
  const d = { config: { paused: true }, aliases: { a: "x" } };
  records.stampRecords(raw(before), d, null, T3);
  assert.deepEqual(d.syncStamps, { config: { overtime: T3 }, aliases: { b: T3 } });
});

test("stampRecords keeps existing stamps, prunes month-old tombstones and skips unchanged keys", () => {
  const before = { aliases: { a: "x" }, messages: [] };
  const d = { aliases: { a: "z" }, messages: [], syncStamps: { aliases: { old: "2026-09-01T00:00:00.000Z", recent: T1 }, messages: { m1: T1 } } };
  records.stampRecords(raw(before), d, null, T3);
  assert.deepEqual(d.syncStamps, { aliases: { recent: T1, a: T3 }, messages: { m1: T1 } });
});

test("stampRecords does nothing for defaults that were never stored", () => {
  const d = { reports: [], deployments: [] };
  records.stampRecords({}, d, null, T3);
  assert.equal(d.syncStamps, undefined);
});

test("stampRecords ignores lists whose records have no usable id", () => {
  const d = { deployments: [{ status: "x" }] };
  records.stampRecords({}, d, null, T3);
  assert.equal(d.syncStamps, undefined);
});

test("mergeRecords: config fields merge one by one, newest wins, ties go to the primary", () => {
  const d = { config: { paused: true, autoReturned: false, macSchedule: { wake: "06:00" } }, syncStamps: { config: { paused: T2, autoReturned: T1 } } };
  const docs = { config: { paused: false, autoReturned: true, macSchedule: { wake: "07:00" } } };
  records.mergeRecords(d, docs, { config: { paused: T1, autoReturned: T2 } }, true);
  assert.deepEqual(d.config, { paused: true, autoReturned: true, macSchedule: { wake: "07:00" } });
  assert.deepEqual(d.syncStamps.config, { paused: T2, autoReturned: T2 });
});

test("mergeRecords: a newer removal wins over an older value and an older removal does not", () => {
  const d = { config: { overtime: { since: T1 } }, syncStamps: { config: { overtime: T1 } } };
  records.mergeRecords(d, { config: {} }, { config: { overtime: T2 } }, false);
  assert.deepEqual(d.config, {});
  assert.deepEqual(d.syncStamps.config, { overtime: T2 });
  const e = { config: { overtime: { since: T3 } }, syncStamps: { config: { overtime: T3 } } };
  records.mergeRecords(e, { config: {} }, { config: { overtime: T2 } }, true);
  assert.deepEqual(e.config, { overtime: { since: T3 } });
});

test("mergeRecords: unstamped records behave as before (primary snapshot replaces, primary keeps its own)", () => {
  const follower = { reports: [{ at: T1, text: "only here" }, { at: T2, text: "mine" }] };
  records.mergeRecords(follower, { reports: [{ at: T2, text: "primary" }, { at: T3, text: "new" }] }, {}, true);
  assert.deepEqual(follower.reports, [{ at: T3, text: "new" }, { at: T2, text: "primary" }]);
  const primary = { reports: [{ at: T2, text: "primary" }] };
  records.mergeRecords(primary, { reports: [{ at: T1, text: "only there" }, { at: T2, text: "follower" }] }, {}, false);
  assert.deepEqual(primary.reports, [{ at: T2, text: "primary" }]);
});

test("mergeRecords: lists merge by id, keep newer changes from either side, sort newest first and cap", () => {
  const mine = { deployments: [{ id: "D2", status: "approved", at: T2 }, { id: "D1", status: "sent", at: T1 }], syncStamps: { deployments: { D2: T2 } } };
  records.mergeRecords(mine, { deployments: [{ id: "D3", status: "approved", at: T3 }, { id: "D2", status: "sent", at: T2 }] }, { deployments: { D3: T3, D2: T3 } }, false);
  assert.deepEqual(
    mine.deployments.map((x) => [x.id, x.status]),
    [
      ["D3", "approved"],
      ["D2", "sent"],
      ["D1", "sent"],
    ]
  );
  const many = Array.from({ length: 25 }, (_, i) => ({ at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, text: String(i) }));
  const r = { reports: many.slice(0, 20) };
  records.mergeRecords(r, { reports: many.slice(5) }, Object.fromEntries([["reports", Object.fromEntries(many.slice(20).map((x) => [x.at, T3]))]]), false);
  assert.equal(r.reports.length, 20);
  assert.equal(r.reports[0].text, "24");
  assert.equal(r.reports[19].text, "5");
});

test("mergeRecords: permission rules keep their oldest-first order", () => {
  const d = { permissionRules: [{ key: "a", at: T1 }], syncStamps: { permissionRules: { a: T1 } } };
  records.mergeRecords(d, { permissionRules: [{ key: "a", at: T1 }, { key: "b", at: T2 }] }, { permissionRules: { a: T1, b: T2 } }, false);
  assert.deepEqual(d.permissionRules.map((x) => x.key), ["a", "b"]);
  records.mergeRecords(d, { permissionRules: [{ key: "a", at: T1 }] }, { permissionRules: { a: T1, b: T3 } }, false);
  assert.deepEqual(d.permissionRules.map((x) => x.key), ["a"]);
});

test("mergeRecords: whole documents go to the newest stamp", () => {
  const d = { refreshRequest: { id: "r1", handled: true }, syncStamps: { refreshRequest: { "": T2 } } };
  records.mergeRecords(d, { refreshRequest: { id: "r1", handled: false } }, { refreshRequest: { "": T1 } }, true);
  assert.deepEqual(d.refreshRequest, { id: "r1", handled: true });
  records.mergeRecords(d, { refreshRequest: { id: "r2", handled: false } }, { refreshRequest: { "": T3 } }, false);
  assert.deepEqual(d.refreshRequest, { id: "r2", handled: false });
  const tie = { contextTidy: { id: "t1", status: "done" } };
  records.mergeRecords(tie, { contextTidy: { id: "t1", status: "in-progress" } }, {}, true);
  assert.equal(tie.contextTidy.status, "in-progress");
});

test("mergeRecords: keys the peer does not send are left alone, unusable shapes fall back to the primary", () => {
  const d = { aliases: { a: "x" }, deployments: [{ status: "no id" }] };
  records.mergeRecords(d, { deployments: [{ id: "D1", at: T1 }] }, {}, false);
  assert.deepEqual(d.aliases, { a: "x" });
  assert.deepEqual(d.deployments, [{ status: "no id" }]);
  records.mergeRecords(d, { deployments: [{ id: "D1", at: T1 }] }, {}, true);
  assert.deepEqual(d.deployments, [{ id: "D1", at: T1 }]);
});

test("end to end: a config toggle made on the follower reaches the primary and survives the next snapshot", () => {
  mutate((d) => {
    d.config = { paused: false, autoReturned: false };
  });
  const primarySnapshot = cluster.snapshot();
  mutate((d) => {
    d.config.autoReturned = true;
  });
  const followerSnapshot = cluster.snapshot();
  assert.ok(followerSnapshot.stamps.config.autoReturned);
  cluster.applySnapshot({ ...primarySnapshot, docs: { ...primarySnapshot.docs, config: { paused: false, autoReturned: false } } });
  assert.equal(load().config.autoReturned, true);
  mutate(
    (d) => {
      d.config = { paused: false, autoReturned: false };
      d.syncStamps = {};
    },
    { keepStamps: true }
  );
  cluster.mergePeer(followerSnapshot);
  assert.equal(load().config.autoReturned, true);
  assert.equal(load().config.paused, false);
});

test("end to end: jiraEpics is still copied whole from the primary", () => {
  mutate((d) => {
    d.jiraEpics = [{ key: "WEB-1" }];
  });
  cluster.applySnapshot({ at: T3, docs: { jiraEpics: [{ key: "WEB-2" }] } });
  assert.deepEqual(load().jiraEpics, [{ key: "WEB-2" }]);
  cluster.mergePeer({ docs: { jiraEpics: [{ key: "WEB-3" }] } });
  assert.deepEqual(load().jiraEpics, [{ key: "WEB-2" }]);
});
