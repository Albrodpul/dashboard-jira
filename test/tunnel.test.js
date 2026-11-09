const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const cluster = require("../src/cluster/cluster");
const tunnel = require("../src/features/tunnel");

const STATE = path.join(env.data, "tunnel.json");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
};

function fakeTunnel() {
  const child = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(STATE, JSON.stringify({ pid: child.pid, host: "u@peer", label: "Mac", since: "2026-11-09T10:00:00.000Z" }));
  return child;
}

const exited = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", resolve)));

test("status lists the dev server ports with a url", () => {
  assert.deepEqual(tunnel.status().ports, [39999]);
  assert.equal(tunnel.status().open, false);
});

test("guard leaves the tunnel open while this machine does not lead", async (t) => {
  t.mock.method(cluster, "primaryNow", () => false);
  const child = fakeTunnel();
  tunnel.guard();
  assert.equal(alive(child.pid), true);
  assert.equal(tunnel.status().open, true);
  assert.equal(tunnel.status().host, "u@peer");
  tunnel.close();
  await exited(child);
  assert.equal(fs.existsSync(STATE), false);
});

test("guard closes the tunnel as soon as this machine leads", async (t) => {
  t.mock.method(cluster, "primaryNow", () => true);
  const child = fakeTunnel();
  tunnel.guard();
  await exited(child);
  assert.equal(alive(child.pid), false);
  assert.equal(fs.existsSync(STATE), false);
});

test("a tunnel whose process died is forgotten", (t) => {
  t.mock.method(cluster, "primaryNow", () => true);
  fs.writeFileSync(STATE, JSON.stringify({ pid: 999999, host: "u@peer" }));
  tunnel.guard();
  assert.equal(fs.existsSync(STATE), false);
  assert.equal(tunnel.status().open, false);
});

test("open refuses on the leading machine", async (t) => {
  t.mock.method(cluster, "primaryNow", () => true);
  await assert.rejects(tunnel.open(), /este ordenador manda/);
});
