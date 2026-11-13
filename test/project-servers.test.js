require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("../src/features/projects-admin");
const { load } = require("../src/core/data");
const config = require("../src/core/config");

test("a panel project's local servers are set from the panel, checked, and kept when the form does not send them", () => {
  assert.equal(admin.save({ name: "Libro", root: "libro" }).error, undefined);
  assert.match(admin.save({ id: "libro", create: false, name: "Libro", devServers: [{ name: "Web", port: 39999, command: "npm run dev" }] }).error, /ya lo usa/);
  assert.match(admin.save({ id: "libro", create: false, name: "Libro", devServers: [{ name: "Web", port: 80, command: "npm run dev" }] }).error, /1024/);
  assert.match(admin.save({ id: "libro", create: false, name: "Libro", devServers: [{ name: "Web", port: 3100, command: "" }] }).error, /comando/);
  assert.equal(admin.save({ id: "libro", create: false, name: "Libro", devServers: [{ name: "Web", port: 3100, command: "npm run dev -- -p 3100" }, { name: "", port: "", command: "" }] }).error, undefined);
  assert.deepEqual(load().projectDefs.libro.devServers, [{ id: "web", name: "Web", role: "Web", port: 3100, url: "http://localhost:3100", command: "npm", args: ["run", "dev", "--", "-p", "3100"] }]);
  assert.equal(admin.save({ id: "libro", create: false, name: "Libro 2" }).error, undefined);
  assert.equal(load().projectDefs.libro.devServers.length, 1);
  assert.equal(admin.list().find((p) => p.id === "libro").devServers[0].command, "npm run dev -- -p 3100");
  assert.match(admin.save({ id: config.mainProject.id, create: false, name: config.mainProject.name, devServers: [] }).error, /board\.config\.json/);
});
