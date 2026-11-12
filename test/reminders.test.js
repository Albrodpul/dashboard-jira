require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const mailman = require("../src/features/mailman");
const reminders = require("../src/features/reminders");
const { mutate, load } = require("../src/core/data");

const CONV = "55555555-5555-5555-5555-555555555555";
const at = (iso) => Date.parse(iso);
let typed = [];

mailman._test.setEnv({
  state: () => ({ areas: [{ id: "herrero", name: "Herrero", conversation: CONV, sessionName: "Herrero", open: true, ref: null, repeatedName: false }] }),
  live: () => [{ conversation: CONV, started: "2026-01-01T00:00:00.000Z" }],
  open: () => {},
  hosted: async () => true,
  typeInto: async (conversation, text, token) => (typed.push({ conversation, text, token }), { ok: true }),
  sendMessage: async () => ({ ok: false, error: "no" }),
  push: () => {},
});

const base = { id: "rem-1", area: "herrero", text: "Ejecuta la revisión diaria.", time: "08:23", from: "2026-11-12", until: "2026-11-19", weekdays: false };

test("a reminder is due from its time on each day of its range, once a day, and weekdays-only skips weekends", () => {
  assert.equal(reminders.isDue(base, at("2026-11-13T07:20:00Z")), false);
  assert.equal(reminders.isDue(base, at("2026-11-13T07:24:00Z")), true);
  assert.equal(reminders.isDue({ ...base, lastDay: "2026-11-13" }, at("2026-11-13T10:00:00Z")), false);
  assert.equal(reminders.isDue(base, at("2026-11-20T08:00:00Z")), false);
  assert.equal(reminders.isDue(base, at("2026-11-11T08:00:00Z")), false);
  assert.equal(reminders.isDue({ ...base, weekdays: true }, at("2026-11-14T08:00:00Z")), false);
  assert.equal(reminders.isDue(base, at("2026-11-14T08:00:00Z")), true);
});

test("the mailman types a due reminder into its session with the board mark, and not again that day", async () => {
  typed = [];
  mutate((d) => ((d.reminders = [{ ...base, from: "2000-01-01", until: "2999-12-31", time: "00:00" }]), (d.deliveries = []), (d.restrictions = [])));
  for (const job of mailman.collect(load())) await mailman._test.runJob(job);
  assert.equal(typed.length, 1);
  assert.equal(typed[0].conversation, CONV);
  assert.match(typed[0].text, /^Aviso del tablero: aviso programado de las 00:00/);
  assert.match(typed[0].text, /Ejecuta la revisión diaria\./);
  assert.ok(typed[0].text.includes(typed[0].token));
  assert.equal(load().reminders[0].lastDay, reminders.madrid().day);
  assert.equal(mailman.collect(load()).filter((j) => j.kind === "reminder").length, 0);
});

test("a reminder needs text, a valid time and a range that ends after it starts", () => {
  assert.match(reminders.add({ area: "x", text: "", time: "08:00", until: "2999-01-01" }).error, /escribe/);
  assert.match(reminders.add({ area: "x", text: "a", time: "8", until: "2999-01-01" }).error, /HH:MM/);
  assert.match(reminders.add({ area: "x", text: "a", time: "08:00", from: "2026-11-20", until: "2026-11-19" }).error, /antes/);
});
