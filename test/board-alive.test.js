require("./helpers/env").sandbox({ boardAliveMinutes: 7 });
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const alive = require("../src/features/board-alive");

const MIN = 60000;

function clockChecker(minutes = 5) {
  let t = 0;
  const pushes = [];
  const c = alive.createChecker({ minutes, push: async (x) => pushes.push(x), nowMs: () => t });
  const step = async (ok, ms = MIN) => {
    t += ms;
    return c.record(ok);
  };
  return { step, pushes };
}

test("the minutes come from board.config.json and default to five", () => {
  assert.equal(require("../src/core/config").boardAliveMinutes, 7);
});

test("one push when the board stops answering for N minutes, one when it comes back", async () => {
  const { step, pushes } = clockChecker(5);
  assert.equal(await step(true), "ok");
  for (let i = 0; i < 4; i++) assert.equal(await step(false), "waiting");
  assert.equal(await step(false), "alert");
  assert.match(pushes[0], /El tablero no responde desde hace 5 min/);
  for (let i = 0; i < 10; i++) assert.equal(await step(false), "alerted");
  assert.equal(pushes.length, 1);
  assert.equal(await step(true), "recovered");
  assert.match(pushes[1], /vuelve a responder/);
  assert.equal(await step(true), "ok");
  assert.equal(pushes.length, 2);
});

test("a long outage is reminded every hour, and a short blip says nothing", async () => {
  const { step, pushes } = clockChecker(5);
  await step(false);
  await step(true);
  assert.equal(pushes.length, 0);
  for (let i = 0; i < 5; i++) await step(false);
  assert.equal(pushes.length, 1);
  for (let i = 0; i < 60; i++) await step(false);
  assert.equal(pushes.length, 2);
});

test("waking from sleep does not count the sleep as minutes without answer", async () => {
  const { step, pushes } = clockChecker(5);
  await step(true);
  assert.equal(await step(false, 8 * 60 * MIN), "waiting");
  assert.equal(pushes.length, 0);
});

test("probe sees a server that answers, and not one that hangs or is down", async () => {
  const okServer = http.createServer((req, res) => res.end("{}"));
  const hung = http.createServer(() => {});
  await new Promise((r) => okServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await alive.probe(`http://127.0.0.1:${okServer.address().port}/x`, 2000), true);
    assert.equal(await alive.probe(`http://127.0.0.1:${hung.address().port}/x`, 300), false);
    assert.equal(await alive.probe("http://127.0.0.1:1/x", 300), false);
  } finally {
    okServer.close();
    hung.closeAllConnections && hung.closeAllConnections();
    hung.close();
  }
});
