const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const data = require("../src/core/data");
const { mutate, load } = data;

test("the data dir and database come from the sandbox", () => {
  assert.equal(data.DATA_DIR, env.data);
  assert.equal(data.DB_FILE, path.join(env.data, "board.db"));
});

test("mutate stamps updatedAt on new and changed tasks only", async () => {
  mutate((d) => {
    d.tasks["WEB-1"] = { key: "WEB-1", status: "pending" };
    d.tasks["WEB-2"] = { key: "WEB-2", status: "pending" };
  });
  const first = load().tasks;
  assert.ok(first["WEB-1"].updatedAt);
  assert.ok(first["WEB-2"].updatedAt);
  await new Promise((r) => setTimeout(r, 5));
  mutate((d) => {
    d.tasks["WEB-1"].status = "approved";
  });
  const second = load().tasks;
  assert.ok(second["WEB-1"].updatedAt > first["WEB-1"].updatedAt);
  assert.equal(second["WEB-2"].updatedAt, first["WEB-2"].updatedAt);
});

test("mutate does not restamp when only updatedAt differs or nothing changes", async () => {
  const before = load().tasks["WEB-2"].updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  mutate((d) => {
    d.tasks["WEB-2"].updatedAt = "2000-01-01T00:00:00.000Z";
  });
  assert.equal(load().tasks["WEB-2"].updatedAt, "2000-01-01T00:00:00.000Z");
  mutate((d) => {
    d.tasks["WEB-2"] = { ...d.tasks["WEB-2"] };
  });
  assert.equal(load().tasks["WEB-2"].updatedAt, "2000-01-01T00:00:00.000Z");
  mutate((d) => {
    d.tasks["WEB-2"].updatedAt = before;
  });
});

test("keepStamps writes tasks exactly as given", () => {
  mutate(
    (d) => {
      d.tasks["WEB-3"] = { key: "WEB-3", status: "done", updatedAt: "2020-05-05T00:00:00.000Z" };
      d.tasks["WEB-1"].status = "sent";
    },
    { keepStamps: true }
  );
  const t = load().tasks;
  assert.equal(t["WEB-3"].updatedAt, "2020-05-05T00:00:00.000Z");
  assert.equal(t["WEB-1"].status, "sent");
});

test("mutate returns the callback result and rolls back on error", () => {
  assert.equal(mutate(() => 42), 42);
  assert.throws(() =>
    mutate((d) => {
      d.tasks["WEB-9"] = { key: "WEB-9" };
      throw new Error("boom");
    })
  );
  assert.equal(load().tasks["WEB-9"], undefined);
});

test("keys set to undefined are removed and defaults come back on load", () => {
  mutate((d) => {
    d.lastReview = { at: "x" };
  });
  assert.deepEqual(load().lastReview, { at: "x" });
  mutate((d) => {
    d.lastReview = undefined;
    d.reports = undefined;
  });
  const d = load();
  assert.equal(d.lastReview, undefined);
  assert.deepEqual(d.reports, []);
});

test("isEmptyReport only treats a report without event rows as empty", () => {
  assert.equal(data.isEmptyReport("Sin novedades desde las 10:00"), true);
  assert.equal(data.isEmptyReport("Sin novedades\n- 10:05 · WEB-1 movida"), false);
  assert.equal(data.isEmptyReport("Novedades\n- 10:05 · WEB-1"), false);
});
