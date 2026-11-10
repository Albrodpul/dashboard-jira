require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert");
const { liveStatus } = require("../src/sessions/registry");

test("a session whose only activity is its own background shell is idle", () => {
  assert.strictEqual(liveStatus("shell", 0), "idle");
});

test("running subagents still make a session busy", () => {
  assert.strictEqual(liveStatus("shell", 1), "busy");
  assert.strictEqual(liveStatus("idle", 2), "busy");
});

test("other states pass through", () => {
  assert.strictEqual(liveStatus("busy", 0), "busy");
  assert.strictEqual(liveStatus("idle", 0), "idle");
  assert.strictEqual(liveStatus(undefined, 0), "");
});
