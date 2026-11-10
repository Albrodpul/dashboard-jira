require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const ms = require("../src/features/memory-sync");

test("index merge skips lines for notes deleted on either machine", () => {
  const local = "- [A](a.md) — a\n";
  const peer = "- [A](a.md) — a\n- [B](b.md) — b\n- [C](c.md) — c\n";
  assert.equal(ms.mergeIndex(local, peer, new Set(["b.md"])), "- [A](a.md) — a\n- [C](c.md) — c\n");
  assert.equal(ms.mergeIndex(local, "- [B](b.md) — b\n", new Set(["b.md"])), null);
});

test("deleted notes are dropped from the local index", () => {
  assert.equal(ms.dropFromIndex("- [A](a.md)\n- [N](nfl.md)\n", new Set(["nfl.md"])), "- [A](a.md)\n");
  assert.equal(ms.dropFromIndex("- [A](a.md)\n", new Set(["nfl.md"])), null);
});
