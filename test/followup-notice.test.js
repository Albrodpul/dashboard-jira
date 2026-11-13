require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../src/sessions/registry");

const sent = [];
let answer = true;
registry.wakeSession = async (name, notice) => (sent.push({ name, notice }), answer);
const { noticeFollowUp } = require("../src/server/startup");
const { mutate } = require("../src/core/data");

test("the follow-up startup notice goes out once even when several paths ask for it at the same time", async () => {
  const r = await Promise.all([noticeFollowUp({ session: "palc-de" }), noticeFollowUp({ session: "palc-de" }), noticeFollowUp({ session: "palc-de" })]);
  assert.equal(sent.length, 1);
  assert.deepEqual(r.filter((x) => x === null).length, 2);
  assert.equal(await noticeFollowUp({ session: "palc-de" }), null);
  assert.equal(sent.length, 1);
});

test("a failed notice can be retried, and a later day's notice goes out again", async () => {
  mutate((d) => (d.followUpNoticeAt = null));
  sent.length = 0;
  answer = false;
  assert.equal(await noticeFollowUp({ session: "palc-de" }), false);
  answer = true;
  assert.equal(await noticeFollowUp({ session: "palc-de" }), true);
  mutate((d) => (d.followUpNoticeAt = new Date(Date.now() - 20 * 60000).toISOString()));
  assert.equal(await noticeFollowUp({ session: "palc-de" }), true);
  assert.equal(sent.length, 3);
});
