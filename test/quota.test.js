const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const quota = require("../src/features/quota");

const response = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body });

test("readQuota converts the legacy Spanish fields", () => {
  fs.writeFileSync(path.join(env.data, "quota.json"), JSON.stringify({ at: "x", five_hour: { usado: 12, renueva: "r1" }, seven_day: { used: 30, resetsAt: "r2" } }));
  assert.deepEqual(quota.readQuota(), { at: "x", five_hour: { used: 12, resetsAt: "r1" }, seven_day: { used: 30, resetsAt: "r2" } });
});

test("askUsage saves utilization and reset times", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(200, { five_hour: { utilization: 41, resets_at: "2026-11-09T15:00:00Z" }, seven_day: { utilization: 7 }, other: { utilization: 1 } }));
  const q = await quota.askUsage("token");
  assert.deepEqual(q.five_hour, { used: 41, resetsAt: "2026-11-09T15:00:00Z" });
  assert.deepEqual(q.seven_day, { used: 7, resetsAt: null });
  assert.equal(q.other, undefined);
  assert.deepEqual(quota.readQuota(), q);
});

test("askUsage backs off for retry-after plus a minute on 429", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(429, {}, { "retry-after": "100" }));
  const before = Date.now();
  assert.equal(await quota.askUsage("token"), null);
  const until = JSON.parse(fs.readFileSync(path.join(env.data, "quota-wait.json"), "utf8")).until;
  assert.ok(until >= before + 160000 && until <= Date.now() + 160000);
});

test("askUsage throws on other errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(500, {}));
  await assert.rejects(quota.askUsage("token"), /500/);
});

test("quotaFromHeaders reads the unified rate limit headers", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(200, {}, { "anthropic-ratelimit-unified-7d-utilization": "0.256", "anthropic-ratelimit-unified-7d-reset": "1794240000" }));
  const q = await quota.quotaFromHeaders("token");
  assert.equal(q.source, "headers");
  assert.deepEqual(q.seven_day, { used: 26, resetsAt: new Date(1794240000 * 1000).toISOString() });
  assert.equal(q.five_hour, undefined);
});

test("quotaFromHeaders fails when there are no limit headers", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response(401, {}));
  await assert.rejects(quota.quotaFromHeaders("token"), /401/);
});

test("loginToken uses the login only while it has not expired", () => {
  const file = path.join(env.home, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", expiresAt: Date.now() + 60000 } }));
  assert.equal(quota.loginToken(), "fake-access");
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", expiresAt: Date.now() - 1 } }));
  assert.equal(quota.loginToken(), null);
});
