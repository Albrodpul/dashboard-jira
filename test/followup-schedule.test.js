require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const hours = require("../src/core/hours");
const { mutate, load } = require("../src/core/data");
const fs = require("../src/features/followup-schedule");

const at = (local) => hours.clock(new Date(`${local}+01:00`));
const envs = [{ id: "beta", everyHours: 1 }, { id: "production", everyHours: 2 }];

test("slots follow the same hours as the old crons", () => {
  assert.deepEqual(fs.slots("beta", 1).map((m) => `${Math.floor(m / 60)}:${m % 60}`), ["9:3", "10:3", "11:3", "12:3", "13:3", "14:3", "15:3", "16:3", "17:3", "18:3"]);
  assert.deepEqual(fs.slots("production", 2).map((m) => `${Math.floor(m / 60)}:${m % 60}`), ["9:33", "11:33", "13:33", "15:33", "17:33"]);
});

test("dueNow fires inside the ten-minute window of a slot, on weekdays only", () => {
  assert.deepEqual(fs.dueNow(envs, at("2026-11-09T10:03:00")), { environments: ["beta"], slot: 10 * 60 + 3 });
  assert.deepEqual(fs.dueNow(envs, at("2026-11-09T10:12:00")), { environments: ["beta"], slot: 10 * 60 + 3 });
  assert.equal(fs.dueNow(envs, at("2026-11-09T10:13:00")), null);
  assert.equal(fs.dueNow(envs, at("2026-11-09T10:33:00")), null);
  assert.deepEqual(fs.dueNow(envs, at("2026-11-09T11:35:00")), { environments: ["production"], slot: 11 * 60 + 33 });
  assert.equal(fs.dueNow(envs, at("2026-11-14T10:05:00")), null);
});

test("closing run covers both environments at 18:31", () => {
  assert.deepEqual(fs.dueNow(envs, at("2026-11-09T18:31:00")), { environments: ["beta", "production"], slot: 18 * 60 + 31 });
});

test("pending lists environments fired after their last scheduled summary and survives storage", () => {
  mutate((d) => (d.followUpDue = { beta: { key: "k", at: "2026-11-09T09:03:10.000Z" }, production: { key: "k", at: "2026-11-09T08:33:10.000Z" } }));
  const d = load();
  assert.deepEqual(fs.pending(d, [{ id: "beta", lastScheduled: "2026-11-09T08:05:00.000Z" }, { id: "production", lastScheduled: "2026-11-09T08:40:00.000Z" }]), ["beta"]);
});
