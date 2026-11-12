const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const config = require("../src/core/config");
const { mutate } = require("../src/core/data");
const devservers = require("../src/features/devservers");

test("dev servers come from every project, tagged with it, and a project's own run in its folder", async () => {
  const folder = path.join(path.dirname(config.mainProject.root), "otra");
  fs.mkdirSync(folder, { recursive: true });
  mutate((d) => (d.projectDefs = { ...(d.projectDefs || {}), otra: { id: "otra", name: "Otra", taskPrefix: "OTRA", folder: "otra", devServers: [{ id: "web", name: "Web", port: 39998, command: "true" }] } }));
  config.forgetProjects();
  const list = devservers.servers();
  const main = list.filter((s) => s.project === config.mainProject.id);
  assert.ok(main.length > 0);
  assert.ok(main.every((s) => config.mainProject.devServers.some((x) => x.id === s.id)));
  const other = list.find((s) => s.project === "otra");
  assert.equal(other.id, "otra-web");
  assert.equal(other.root, path.resolve(folder));
  assert.deepEqual(devservers.servers("otra").map((s) => s.id), ["otra-web"]);
  const st = await devservers.status();
  assert.equal(st.servers.find((s) => s.id === "otra-web").project, "otra");
  fs.rmSync(folder, { recursive: true, force: true });
  config.forgetProjects();
  assert.equal(devservers.servers().some((s) => s.project === "otra"), false);
});
