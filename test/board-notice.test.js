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
