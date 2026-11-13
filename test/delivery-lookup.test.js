require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { mutate } = require("../src/core/data");

function run(id) {
  process.argv = ["node", "board.js", "delivery", id];
  delete require.cache[require.resolve("../src/commands/args")];
  delete require.cache[require.resolve("../src/commands/delivery")];
  const out = [];
  const log = console.log;
  const exit = process.exit;
  const err = console.error;
  console.log = console.error = (m) => out.push(String(m));
  process.exit = () => {
    throw new Error("exit");
  };
  try {
    require("../src/commands/delivery").delivery();
  } catch (e) {
  } finally {
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
  return out.join("\n");
}

test("a delivery is found by its envío id and also by the id of the order it carried", () => {
  mutate((d) => (d.deliveries = [{ id: "E2026111313104802824", kind: "deployment", area: "deploys", ids: ["D20261113131047"], status: "confirmed", at: "2026-11-13T13:10:48.000Z" }]));
  assert.match(run("E2026111313104802824"), /entregado y confirmado/);
  assert.match(run("D20261113131047"), /^E2026111313104802824: despliegue/);
  assert.match(run("[envío E2026111313104802824]"), /entregado y confirmado/);
  assert.match(run("D19990101000000"), /no ha entregado/);
});
