const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cluster = require("../src/cluster/cluster");
const { mergeTranscript } = require("../src/sessions/transcriptmerge");

const CONV = "0a1b2c3d-0000-4000-8000-000000000001";
const line = (o) => JSON.stringify(o);
const user = (text) => ({ type: "user", message: { content: text } });
const assistant = (...texts) => ({ type: "assistant", message: { content: texts.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)) } });

function writeTranscript(conv, entries) {
  const dir = cluster.projectDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${conv}.jsonl`), entries.map(line).join("\n") + "\n");
}

test("projectDir lives under the sandbox home", () => {
  assert.ok(cluster.projectDir().startsWith(path.join(env.home, ".claude", "projects")));
});

test("lastReply joins the assistant texts after the last real user message", () => {
  writeTranscript(CONV, [
    user("first question"),
    assistant("old answer"),
    user("second question"),
    assistant("Looking.", { type: "tool_use", name: "Bash", input: {} }),
    { type: "user", message: { content: [{ type: "tool_result", content: "out" }] } },
    { type: "user", isMeta: true, message: { content: "meta text" } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent noise" }] } },
    assistant("  ", "Done: all good."),
    "not json at all",
  ]);
  assert.equal(cluster.lastReply(CONV), "Looking.\n\nDone: all good.");
});

test("lastReply rejects ids that are not conversation uuids and unknown conversations", () => {
  assert.equal(cluster.lastReply("../../etc/passwd"), null);
  assert.equal(cluster.lastReply("0a1b2c3d-0000-4000-8000-00000000ffff"), null);
});

test("lastReply finds transcripts in other project folders", () => {
  const other = "0a1b2c3d-0000-4000-8000-000000000002";
  const dir = path.join(env.home, ".claude", "projects", "elsewhere");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${other}.jsonl`), [user("q"), assistant("from elsewhere")].map(line).join("\n"));
  assert.equal(cluster.lastReply(other), "from elsewhere");
});

test("serveTranscript sends the tail from an offset with the hash of what precedes it", () => {
  const whole = fs.readFileSync(path.join(cluster.projectDir(), `${CONV}.jsonl`));
  const full = cluster.serveTranscript(CONV, 0);
  assert.equal(full.tail, "");
  assert.deepEqual(full.body, whole);
  const part = cluster.serveTranscript(CONV, 10);
  assert.deepEqual(part.body, whole.subarray(10));
  assert.equal(part.tail, require("crypto").createHash("sha1").update(whole.subarray(0, 10)).digest("hex"));
  assert.deepEqual(cluster.serveTranscript(CONV, whole.length + 5).body, whole);
  assert.equal(cluster.serveTranscript("nope", 0), null);
});

test("mergeTranscript takes, keeps or chains both continuations", () => {
  const l = (uuid, parentUuid, timestamp) => JSON.stringify({ uuid, parentUuid, timestamp });
  const buf = (...xs) => Buffer.from(xs.join("\n") + "\n");
  const base = [l("a", null, "1"), l("b", "a", "2")];
  assert.equal(mergeTranscript(buf(...base), buf(...base, l("c", "b", "3"))).action, "take");
  assert.equal(mergeTranscript(buf(...base, l("c", "b", "3")), buf(...base)).action, "keep");
  const m = mergeTranscript(buf(...base, l("mine", "b", "3")), buf(...base, l("theirs", "b", "4")));
  assert.equal(m.action, "merge");
  const lines = m.body.toString().trim().split("\n").map((x) => JSON.parse(x));
  assert.deepEqual(lines.map((x) => x.uuid), ["a", "b", "mine", "theirs"]);
  assert.equal(lines[3].parentUuid, "mine");
});
