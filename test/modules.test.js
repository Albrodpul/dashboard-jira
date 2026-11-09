require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "page" ? [] : files(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

test("every server module loads without side effects", () => {
  for (const f of files(SRC)) {
    if (f === path.join(SRC, "cli.js")) continue;
    assert.doesNotThrow(() => require(f), path.relative(SRC, f));
  }
});

test("the cluster facade keeps its public functions", () => {
  const cluster = require("../src/cluster/cluster");
  for (const name of ["lastReply", "isPrimary", "primaryNow", "info", "peerGet", "projectDir", "keepAwake", "letSleep", "snapshot", "transcripts", "serveTranscript", "tick", "handleYield", "command", "takeHere", "backToAuto", "machines", "sendClaudeToken", "clusterEnabled", "mergeTasks", "mergePeer", "applySnapshot"]) {
    assert.equal(typeof cluster[name], "function", name);
  }
  assert.equal(cluster.clusterEnabled(), false);
  assert.equal(cluster.isPrimary(), true);
  assert.equal(cluster.info().role, "primary");
});
