require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { runBounded } = require("../src/sessions/registry");

test("a process that answers in time is read", async () => {
  const r = await runBounded(process.execPath, ["-e", "console.log('ok')"], {}, 5000);
  assert.equal(r.ok, true);
  assert.match(r.out, /ok/);
});

test("a hung process whose child keeps the output open is cut off at the limit", async () => {
  const grandchild = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'}); setTimeout(()=>{},60000)";
  const started = Date.now();
  const r = await runBounded(process.execPath, ["-e", grandchild], {}, 800);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 3000);
});

test("a process that exits with the output still held by its child does not wait for it", async () => {
  const grandchild = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit',detached:true}).unref(); console.log('ok')";
  const started = Date.now();
  const r = await runBounded(process.execPath, ["-e", grandchild], {}, 10000);
  assert.equal(r.ok, true);
  assert.ok(Date.now() - started < 3000);
});
