const box = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const admin = require("../src/features/projects-admin");
const agent = require("../src/agents").claude;

const side = path.join(box.dir, "side");
fs.mkdirSync(side, { recursive: true });
const CONV = "11111111-2222-4333-8444-555555555555";
const OLD = "11111111-2222-4333-8444-666666666666";

test("the peer list carries every project's recent conversations with their project, and memory per project", () => {
  assert.equal(admin.save({ id: "side", name: "Side", taskPrefix: "SIDE", root: side }).error, undefined);
  const dir = path.join(agent.transcriptsDir(), agent.transcriptFolder(side));
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${CONV}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(dir, `${OLD}.jsonl`), '{"type":"user"}\n');
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(dir, `${OLD}.jsonl`), old, old);
  fs.writeFileSync(path.join(dir, "memory", "note.md"), "hola");
  const list = require("../src/cluster/transcripts").transcripts();
  const mine = list.find((t) => t.conversation === CONV);
  assert.equal(mine.project, "side");
  assert.equal(mine.hosted, false);
  assert.ok(mine.tail);
  assert.equal(list.some((t) => t.conversation === OLD), false);
  assert.equal(require("../src/core/projects").projectOfConversation(CONV).id, "side");
  const mem = require("../src/features/memory-sync");
  assert.equal(mem.projectSnapshot("side").files["note.md"].text, "hola");
  assert.equal(mem.projectSnapshot("nope"), null);
  assert.equal(mem.projectSnapshot(require("../src/core/config").mainProject.id), null);
});
