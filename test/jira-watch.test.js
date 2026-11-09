require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { mutate, load } = require("../src/core/data");
const watch = require("../src/features/jira-watch");

let notes, quiets, fresh, minute;
function setup({ primary = true, n = 0, clockMin = 10 * 60, weekend = false, overtime = null } = {}) {
  watch._test.reset();
  notes = [];
  quiets = [];
  fresh = n;
  minute = 0;
  watch._test.setDeps({
    primary: () => primary,
    fresh: async () => fresh,
    quiet: (label, last) => (quiets.push(label), mutate((d) => (d.lastReview = { at: new Date(Date.now() - 120000).toISOString(), text: "sin novedades", empty: true })), true),
    notify: (text) => notes.push(text),
    clock: () => ({ weekend, min: clockMin }),
    overtime: () => overtime,
    parts: () => ({ weekday: "Mon", hour: "10", minute: String(minute).padStart(2, "0") }),
  });
  mutate((d) => {
    d.config = {};
    d.refreshRequest = null;
    d.lastReview = { at: new Date(Date.now() - 120000).toISOString(), text: "x", empty: true };
  });
}

test("no news: the server writes the quiet review itself and wakes nobody", async () => {
  setup({ n: 0 });
  await watch.tick();
  assert.deepEqual(quiets, ["10:00"]);
  assert.equal(notes.length, 0);
});

test("news: the reporter is told once and not again while it works", async () => {
  setup({ n: 3 });
  await watch.tick();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Tablero: hay 3 novedades sin contar en Jira/);
  minute = 1;
  await watch.tick();
  assert.equal(notes.length, 1);
});

test("a failed check still wakes the reporter", async () => {
  setup({ n: null });
  await watch.tick();
  assert.equal(notes.length, 1);
});

test("outside hours, paused, or on the follower nothing is checked", async () => {
  setup({ n: 2, clockMin: 19 * 60 });
  await watch.tick();
  setup({ n: 2, weekend: true });
  await watch.tick();
  assert.equal(notes.length + quiets.length, 0);
  setup({ n: 2 });
  mutate((d) => (d.config = { paused: true }));
  await watch.tick();
  assert.equal(notes.length + quiets.length, 0);
  setup({ n: 2, primary: false });
  await watch.tick();
  assert.equal(notes.length + quiets.length, 0);
});

test("overtime keeps checking outside hours", async () => {
  setup({ n: 1, clockMin: 20 * 60, overtime: { since: "x" } });
  await watch.tick();
  assert.equal(notes.length, 1);
});

test("Refrescar reaches the reporter once, even when paused or outside hours", async () => {
  setup({ clockMin: 20 * 60 });
  mutate((d) => {
    d.config = { paused: true };
    d.refreshRequest = { id: "r1", at: new Date().toISOString(), handled: false };
  });
  await watch.tick();
  await watch.tick();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /ha pulsado Refrescar/);
  assert.ok(load().refreshRequest.notifiedAt);
});
