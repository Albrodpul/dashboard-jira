require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { changeRoutes, loadRoutes, targets } = require("../src/sessions/registry");
const { handleSession } = require("../src/server/routes/sessions");
const { load } = require("../src/core/data");

const call = (input) => {
  let out;
  handleSession({}, input, (res, code, body) => (out = { code, body }));
  return out;
};

test("an area session can be pinned so it never sleeps on its own, and unpinned again", () => {
  changeRoutes((r) => (r.areas.herrero = { title: "Investigación inicial", epics: {}, conversation: "11111111-2222-3333-4444-555555555555" }));
  assert.equal(call({ name: "Investigación inicial", areaId: "herrero", keepOpen: true }).code, 200);
  assert.equal(loadRoutes().areas.herrero.keepOpen, true);
  assert.equal(targets(load(), loadRoutes()).find((a) => a.id === "herrero").keepOpen, true);
  assert.equal(call({ name: "Investigación inicial", areaId: "herrero", keepOpen: false }).code, 200);
  assert.equal(loadRoutes().areas.herrero.keepOpen, undefined);
  assert.equal(call({ name: "x", areaId: "nope", keepOpen: true }).code, 400);
});
