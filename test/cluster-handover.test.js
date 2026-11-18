require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { st } = require("../src/cluster/role");
const { keepsCommand } = require("../src/cluster/handover");

test("when both computers command, the one that commanded first keeps it", () => {
  Object.assign(st, { role: "primary", since: "2026-11-18T05:00:00.000Z", manual: false });
  assert.equal(keepsCommand({ role: "primary", since: "2026-11-18T16:17:41.000Z", manual: false }), true);
  Object.assign(st, { since: "2026-11-18T16:17:41.000Z" });
  assert.equal(keepsCommand({ role: "primary", since: "2026-11-18T05:00:00.000Z", manual: false }), false);
});

test("a command taken by hand beats one taken automatically", () => {
  Object.assign(st, { role: "primary", since: "2026-11-18T16:29:00.000Z", manual: true });
  assert.equal(keepsCommand({ role: "primary", since: "2026-11-18T05:00:00.000Z", manual: false }), true);
  Object.assign(st, { since: "2026-11-18T05:00:00.000Z", manual: false });
  assert.equal(keepsCommand({ role: "primary", since: "2026-11-18T16:29:00.000Z", manual: true }), false);
});
