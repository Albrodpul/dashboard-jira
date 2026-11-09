require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const hours = require("../src/core/hours");
const fu = require("../src/features/followup-schedule");
const { mutate } = require("../src/core/data");

const at = (local) => new Date(`${local}+01:00`);
const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

test("defaults are 07:30 to 18:30 with the old follow-up slots", () => {
  mutate((d) => (d.config = {}));
  assert.deepEqual(hours.schedule(), { start: "07:30", end: "18:30" });
  assert.deepEqual(fu.slots("beta", 1).map(hm), ["9:03", "10:03", "11:03", "12:03", "13:03", "14:03", "15:03", "16:03", "17:03", "18:03"]);
  assert.deepEqual(fu.slots("production", 2).map(hm), ["9:33", "11:33", "13:33", "15:33", "17:33"]);
});

test("a custom workday moves work hours, overtime expiry and follow-up slots", () => {
  assert.deepEqual(hours.setSchedule({ start: "08:30", end: "17:00" }), { schedule: { start: "08:30", end: "17:00" } });
  const w = (s) => hours.workHours(hours.clock(at(s)));
  assert.equal(w("2026-11-09T08:29:00"), false);
  assert.equal(w("2026-11-09T08:30:00"), true);
  assert.equal(w("2026-11-09T16:59:00"), true);
  assert.equal(w("2026-11-09T17:00:00"), false);
  const dawn = { since: at("2026-11-09T07:00:00").toISOString() };
  assert.equal(hours.expired(dawn, at("2026-11-09T08:00:00")), false);
  assert.equal(hours.expired(dawn, at("2026-11-09T08:30:00")), true);
  assert.deepEqual(fu.slots("beta", 1).map(hm), ["10:03", "11:03", "12:03", "13:03", "14:03", "15:03", "16:03"]);
  assert.deepEqual(fu.dueNow([{ id: "beta", everyHours: 1 }], hours.clock(at("2026-11-09T17:01:00"))), { environments: ["beta"], slot: 17 * 60 + 1 });
});

test("invalid schedules are refused", () => {
  assert.ok(hours.setSchedule({ start: "25:00" }).error);
  assert.ok(hours.setSchedule({ start: "17:30", end: "18:00" }).error);
  assert.deepEqual(hours.schedule(), { start: "08:30", end: "17:00" });
});
