require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const hours = require("../src/core/hours");
const rotate = require("../src/sessions/rotate");
const macPower = require("../src/features/mac-power");
const { mutate } = require("../src/core/data");

const at = (local) => hours.clock(new Date(`${local}+01:00`));

test("daily rotation only happens on weekday mornings, from 07:30 to 10:00", () => {
  assert.equal(rotate.inRotationWindow(at("2026-11-09T07:29:00")), false);
  assert.equal(rotate.inRotationWindow(at("2026-11-09T07:30:00")), true);
  assert.equal(rotate.inRotationWindow(at("2026-11-09T09:59:00")), true);
  assert.equal(rotate.inRotationWindow(at("2026-11-09T10:00:00")), false);
  assert.equal(rotate.inRotationWindow(at("2026-11-09T10:30:00")), false);
  assert.equal(rotate.inRotationWindow(at("2026-11-14T08:00:00")), false);
});

test("a startup rotates any time before 10:00 on weekdays", () => {
  assert.equal(rotate.morning(at("2026-11-09T06:00:00")), true);
  assert.equal(rotate.morning(at("2026-11-09T09:59:00")), true);
  assert.equal(rotate.morning(at("2026-11-09T10:00:00")), false);
  assert.equal(rotate.morning(at("2026-11-15T08:00:00")), false);
});

test("the Mac power window defaults to 06:00-21:00 on weekdays", () => {
  assert.deepEqual(macPower.schedule(), { wake: "06:00", sleep: "21:00", days: "MTWRF", weeklyOff: true });
  assert.equal(macPower.inWindow(at("2026-11-09T05:59:00")), false);
  assert.equal(macPower.inWindow(at("2026-11-09T06:00:00")), true);
  assert.equal(macPower.inWindow(at("2026-11-09T20:59:00")), true);
  assert.equal(macPower.inWindow(at("2026-11-09T21:00:00")), false);
  assert.equal(macPower.inWindow(at("2026-11-14T12:00:00")), false);
});

test("the Mac power window follows the stored schedule and ignores invalid times", () => {
  assert.deepEqual(macPower.setSchedule({ wake: "07:15" }), { wake: "07:15", sleep: "21:00", days: "MTWRF", weeklyOff: true });
  assert.equal(macPower.inWindow(at("2026-11-09T07:00:00")), false);
  assert.equal(macPower.inWindow(at("2026-11-09T07:15:00")), true);
  mutate((d) => {
    d.config.macSchedule = { wake: "25:00", sleep: "9pm" };
  });
  assert.deepEqual(macPower.schedule(), { wake: "06:00", sleep: "21:00", days: "MTWRF", weeklyOff: true });
});

test("the Friday shutdown can be switched off and is kept with the other times", () => {
  assert.equal(macPower.setSchedule({ weeklyOff: false }).weeklyOff, false);
  assert.equal(macPower.setSchedule({ wake: "06:30" }).weeklyOff, false);
  assert.equal(macPower.setSchedule({ weeklyOff: true }).weeklyOff, true);
});
