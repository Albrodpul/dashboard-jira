require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const hours = require("../src/core/hours");
const { mutate, load } = require("../src/core/data");

const at = (local) => new Date(`${local}+01:00`);

test("workHours covers 07:30 to 18:30 on weekdays only", () => {
  const w = (s) => hours.workHours(hours.clock(at(s)));
  assert.equal(w("2026-11-09T07:29:00"), false);
  assert.equal(w("2026-11-09T07:30:00"), true);
  assert.equal(w("2026-11-09T18:29:00"), true);
  assert.equal(w("2026-11-09T18:30:00"), false);
  assert.equal(w("2026-11-14T10:00:00"), false);
  assert.equal(w("2026-11-15T10:00:00"), false);
});

test("clock reads Madrid time regardless of the host time zone", () => {
  const c = hours.clock(new Date("2026-07-01T05:30:00Z"));
  assert.equal(c.hour, 7);
  assert.equal(c.min, 7 * 60 + 30);
  assert.equal(c.weekday, "Wed");
  assert.equal(c.weekend, false);
});

test("overtime turned on before the workday expires when the workday starts", () => {
  const ot = { since: at("2026-11-09T06:09:00").toISOString() };
  assert.equal(hours.expired(ot, at("2026-11-09T06:30:00")), false);
  assert.equal(hours.expired(ot, at("2026-11-09T07:30:00")), true);
  assert.equal(hours.expired(ot, at("2026-11-09T11:00:00")), true);
});

test("overtime turned on in the evening ends at midnight", () => {
  const ot = { since: at("2026-11-09T19:00:00").toISOString() };
  assert.equal(hours.expired(ot, at("2026-11-09T23:59:00")), false);
  assert.equal(hours.expired(ot, at("2026-11-10T00:00:00")), true);
});

test("overtime turned on during the workday ends at midnight too", () => {
  const ot = { since: at("2026-11-09T18:00:00").toISOString() };
  assert.equal(hours.expired(ot, at("2026-11-09T21:00:00")), false);
  assert.equal(hours.expired(ot, at("2026-11-10T00:00:00")), true);
});

test("overtime on weekends ends at midnight of the same day", () => {
  const saturday = { since: at("2026-11-14T10:00:00").toISOString() };
  assert.equal(hours.expired(saturday, at("2026-11-14T23:00:00")), false);
  assert.equal(hours.expired(saturday, at("2026-11-15T00:00:00")), true);
  const sundayDawn = { since: at("2026-11-15T06:00:00").toISOString() };
  assert.equal(hours.expired(sundayDawn, at("2026-11-15T09:00:00")), false);
});

test("missing overtime never counts as expired", () => {
  assert.equal(hours.expired(null, at("2026-11-09T10:00:00")), false);
  assert.equal(hours.expired({}, at("2026-11-09T10:00:00")), false);
});

test("overtime() drops an expired flag from the stored config and keeps a fresh one", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: at("2026-11-09T10:00:00").getTime() });
  mutate((d) => {
    d.config = { paused: true, overtime: { since: at("2026-11-09T06:00:00").toISOString() } };
  });
  assert.equal(hours.overtime(), null);
  assert.deepEqual(load().config, { paused: true });
  const on = hours.setOvertime(true);
  assert.equal(on.since, at("2026-11-09T10:00:00").toISOString());
  assert.deepEqual(hours.overtime(), on);
  assert.equal(hours.setOvertime(false), null);
  assert.equal(load().config.overtime, undefined);
});
