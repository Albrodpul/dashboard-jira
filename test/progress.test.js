require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const progress = require("../src/features/progress");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-test-"));
const line = (at, name, input) => JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name, input }] } });

test("each tool call is said in a few words, with the phase it means", () => {
  assert.deepEqual(progress.describe("Edit", { file_path: "c:\\x\\backend\\web\\js\\booking-list.js" }), { text: "Editando booking-list.js", phase: "working" });
  assert.equal(progress.describe("Agent", { description: "Review TV-111 diff" }).phase, "review");
  assert.equal(progress.describe("Agent", { description: "Find the controller" }).phase, "working");
  assert.equal(progress.describe("Bash", { command: "grep -rn x .", description: "Busca los botones" }).text, "Busca los botones");
  assert.equal(progress.describe("mcp__ccd_turn__update_plan", {}), null);
});

test("a task in a session gets the furthest phase reached and its last action since it was sent", () => {
  const file = path.join(dir, "conv.jsonl");
  fs.writeFileSync(
    file,
    [
      line("2026-11-16T09:00:00.000Z", "Edit", { file_path: "old.js" }),
      line("2026-11-16T10:00:10.000Z", "Read", { file_path: "a.js" }),
      line("2026-11-16T10:02:00.000Z", "Agent", { description: "Review the diff" }),
      line("2026-11-16T10:03:00.000Z", "Edit", { file_path: "a.js" }),
    ].join("\n") + "\n"
  );
  const tasks = [
    { key: "T-1", status: "sent", area: "web", sentAt: "2026-11-16T10:00:00.000Z" },
    { key: "T-2", status: "approved", area: "web", decidedAt: "2026-11-16T10:05:00.000Z" },
  ];
  const out = progress.forTasks(tasks, () => "conv", () => file);
  assert.equal(out["T-1"].phase, "review");
  assert.deepEqual(out["T-1"].action, { text: "Editando a.js", at: "2026-11-16T10:03:00.000Z" });
  assert.equal(out["T-2"].phase, "queued");
  assert.equal(out["T-2"].action, null);
});

test("the usual time counts only the session's own work, and needs a few tasks", () => {
  const done = (min, waitedMin = 0) => ({
    status: "done",
    sentAt: "2026-11-16T10:00:00.000Z",
    history: [{ type: waitedMin ? "partial" : "done", at: new Date(Date.parse("2026-11-16T10:00:00.000Z") + min * 60000).toISOString() }],
    notice: { at: new Date(Date.parse("2026-11-16T10:00:00.000Z") + (min + waitedMin) * 60000).toISOString() },
  });
  assert.equal(progress.typical([done(3), done(5)]), null);
  const band = progress.typical([done(2), done(4, 120), done(6), done(10)]);
  assert.ok(band.high <= 10, JSON.stringify(band));
  assert.equal(band.samples, 4);
});
