require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const push = require("../src/server/push");

const call = (route, input) => new Promise((resolve) => push.handlePush(null, route, input, (res, code, body) => resolve({ code, body })));
const sub = (endpoint, device) => ({ subscription: { endpoint, keys: { p256dh: "x", auth: "y" } }, device });

test("each device keeps what it does not want to be told about", async () => {
  await call("/api/push/subscribe", sub("https://push.example/phone", "phone"));
  assert.equal((await call("/api/push/prefs", { endpoint: "https://push.example/nobody", muted: [] })).code, 404);
  const set = await call("/api/push/prefs", { endpoint: "https://push.example/phone", muted: ["deploys", "nope", "test", "deploys"] });
  assert.deepEqual(set.body.muted, ["deploys"]);
  const again = await call("/api/push/subscribe", sub("https://push.example/phone", "phone"));
  assert.deepEqual(again.body.muted, ["deploys"]);
  const renewed = await call("/api/push/subscribe", sub("https://push.example/phone-2", "phone"));
  assert.deepEqual(renewed.body.muted, ["deploys"]);
  assert.deepEqual(push.subscriptions().map((s) => s.endpoint), ["https://push.example/phone-2"]);
  const cleared = await call("/api/push/prefs", { endpoint: "https://push.example/phone-2", muted: [] });
  assert.deepEqual(cleared.body.muted, []);
  assert.equal(push.subscriptions()[0].muted, undefined);
});

test("a muted reason is not sent to that device", async () => {
  await call("/api/push/subscribe", { subscription: { endpoint: "https://push.example/mac" }, device: "mac" });
  await call("/api/push/prefs", { endpoint: "https://push.example/mac", muted: ["tasks"] });
  const real = global.fetch;
  const hits = [];
  global.fetch = async (url) => (hits.push(url), { ok: true, status: 201 });
  try {
    await push.sendPush("tasks", true);
    assert.ok(!hits.includes("https://push.example/mac"));
    hits.length = 0;
    await push.sendPush("deploys", true);
    assert.equal(hits.includes("https://push.example/mac"), !require("../src/core/hours").resting());
  } finally {
    global.fetch = real;
  }
});
