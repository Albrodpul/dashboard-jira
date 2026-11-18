require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { noticeBoard } = require("../src/server/startup");
const { mutate } = require("../src/core/data");

test("the board session gets its startup notice once, however many paths fire", async () => {
  const sent = [];
  const wake = async (s, n) => (sent.push([s, n]), true);
  assert.equal(await noticeBoard("Tablero", false, wake), true);
  assert.equal(await noticeBoard("Tablero", false, wake), null);
  assert.equal(await noticeBoard("Tablero", true, wake), null);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /arranca la sesión del tablero/);
});

test("a reopened board session is not told again the same day, but taking command later is", async () => {
  const sent = [];
  const wake = async (s, n) => (sent.push(s), true);
  mutate((d) => (d.boardNoticeAt = new Date(Date.now() - 20 * 60000).toISOString()));
  assert.equal(await noticeBoard("Tablero", true, wake), null);
  assert.equal(await noticeBoard("Tablero", false, wake), true);
  assert.equal(sent.length, 1);
});

test("a failed notice can be retried at once", async () => {
  mutate((d) => (d.boardNoticeAt = null));
  assert.equal(await noticeBoard("Tablero", false, async () => false), false);
  assert.equal(await noticeBoard("Tablero", false, async () => true), true);
});

test("the reporter gets its startup notice once when the daily start and the respawn both fire", async () => {
  const { noticeReporter } = require("../src/server/startup");
  const sent = [];
  const wake = async (s) => (sent.push(s), true);
  assert.equal(await noticeReporter("Reporte JIRA", wake), true);
  assert.equal(await noticeReporter("Reporte JIRA", wake), null);
  assert.equal(sent.length, 1);
  mutate((d) => (d.reporterNoticeAt = null));
  assert.equal(await noticeReporter("Reporte JIRA", async () => false), false);
  assert.equal(await noticeReporter("Reporte JIRA", wake), true);
});

test("the orchestrator startup notice goes out once per quarter hour", () => {
  const { claimOrchestratorNotice } = require("../src/server/startup");
  require("../src/core/data").mutate((d) => (d.orchestratorNoticeAt = null));
  assert.equal(claimOrchestratorNotice(), true);
  assert.equal(claimOrchestratorNotice(), false);
});

test("startup notice stamps travel in the snapshot to the other computer", () => {
  require("../src/core/data").mutate((d) => (d.followUpNoticeAt = "2026-11-18T16:19:00.000Z"));
  assert.equal(require("../src/cluster/snapshot").snapshot().docs.followUpNoticeAt, "2026-11-18T16:19:00.000Z");
});
