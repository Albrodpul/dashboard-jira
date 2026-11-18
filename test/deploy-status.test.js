require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { pair } = require("../src/features/deploy-status");

test("a CodeDeploy created while its workflow is still running pairs with that run", () => {
  const runs = [{ id: 2, status: "completed", startedAt: "2026-11-18T14:46:22Z", updatedAt: "2026-11-18T14:53:45Z" }];
  const deployments = [{ id: "d-beta", status: "Succeeded", startedAt: "2026-11-18T14:51:29.725Z" }];
  assert.equal(pair(runs, deployments).byRun.get(2).id, "d-beta");
});

test("each CodeDeploy pairs with the run that started just before it", () => {
  const runs = [
    { id: 2, status: "completed", startedAt: "2026-11-18T14:10:00Z", updatedAt: "2026-11-18T14:18:00Z" },
    { id: 1, status: "completed", startedAt: "2026-11-18T14:00:00Z", updatedAt: "2026-11-18T14:08:00Z" },
  ];
  const deployments = [
    { id: "d-b", status: "Succeeded", startedAt: "2026-11-18T14:12:00Z" },
    { id: "d-a", status: "Succeeded", startedAt: "2026-11-18T14:05:00Z" },
  ];
  const { byRun } = pair(runs, deployments);
  assert.equal(byRun.get(1).id, "d-a");
  assert.equal(byRun.get(2).id, "d-b");
});

test("a CodeDeploy long after the run does not pair", () => {
  const runs = [{ id: 1, status: "completed", startedAt: "2026-11-18T14:00:00Z", updatedAt: "2026-11-18T14:08:00Z" }];
  assert.equal(pair(runs, [{ id: "d-x", status: "Succeeded", startedAt: "2026-11-18T15:00:00Z" }]).byRun.size, 0);
});
