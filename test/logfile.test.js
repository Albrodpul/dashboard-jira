const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { appendLog, rotate, rotateInPlace, MAX_BYTES } = require("../src/core/logfile");

const file = (name) => path.join(env.data, name);

test("appendLog appends and rotates past the limit keeping one previous copy", () => {
  const f = file("a.log");
  appendLog(f, "one\n", 10);
  appendLog(f, "two\n", 10);
  assert.equal(fs.readFileSync(f, "utf8"), "one\ntwo\n");
  appendLog(f, "three\n", 10);
  assert.equal(fs.readFileSync(f, "utf8"), "one\ntwo\nthree\n");
  appendLog(f, "four\n", 10);
  assert.equal(fs.readFileSync(`${f}.1`, "utf8"), "one\ntwo\nthree\n");
  assert.equal(fs.readFileSync(f, "utf8"), "four\n");
  for (const x of ["five\n", "six\n", "seven\n"]) appendLog(f, x, 10);
  assert.equal(fs.readFileSync(`${f}.1`, "utf8"), "four\nfive\n");
  assert.equal(fs.readFileSync(f, "utf8"), "six\nseven\n");
});

test("the default limit is about 1 MB", () => {
  assert.equal(MAX_BYTES, 1024 * 1024);
  const f = file("big.log");
  fs.writeFileSync(f, Buffer.alloc(MAX_BYTES - 1, 120));
  assert.equal(rotate(f), false);
  fs.appendFileSync(f, "x");
  assert.equal(rotate(f), true);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.statSync(`${f}.1`).size, MAX_BYTES);
});

test("appendLog never throws, even when the folder is missing", () => {
  assert.doesNotThrow(() => appendLog(path.join(env.data, "missing", "x.log"), "x\n"));
  assert.equal(rotate(path.join(env.data, "missing", "x.log")), false);
});

test("rotateInPlace keeps the same file so a process holding it open keeps logging", () => {
  const f = file("serve.log");
  fs.writeFileSync(f, "old output\n");
  const fd = fs.openSync(f, "a");
  assert.equal(rotateInPlace(f, 5), true);
  fs.writeSync(fd, "after\n");
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(`${f}.1`, "utf8"), "old output\n");
  assert.equal(fs.readFileSync(f, "utf8"), "after\n");
  assert.equal(rotateInPlace(f, 1000), false);
});

test("the permission hook writes hook.log through the rotating helper", () => {
  const hook = path.join(__dirname, "..", "bin", "permission-hook.js");
  fs.writeFileSync(file("hook.log"), Buffer.alloc(MAX_BYTES, 120));
  const r = cp.spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: "abcdef123456", tool_name: "Read", tool_input: {} }), env: { ...process.env, TOWER_PORT: "1" }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(fs.statSync(file("hook.log.1")).size, MAX_BYTES);
  assert.match(fs.readFileSync(file("hook.log"), "utf8"), /abcdef12 Read sin-tablero/);
});
