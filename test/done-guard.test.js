const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const { sandbox } = require("./helpers/env");

const statuses = { review: "IN REVIEW", returned: ["To Do"], inProgress: ["In Progress"], closed: ["Done"], rejectLabel: "rejected" };
const base = fs.mkdtempSync(path.join(os.tmpdir(), "nutria-done-"));
const mainRoot = path.join(base, "main");
const sideRoot = path.join(base, "side");
for (const d of [mainRoot, sideRoot]) fs.mkdirSync(d, { recursive: true });
const box = sandbox({
  company: undefined,
  root: undefined,
  jira: undefined,
  statuses: undefined,
  followUp: undefined,
  devServers: undefined,
  projects: [
    { id: "acme", name: "Acme", root: mainRoot, jira: { projects: ["WEB"], me: { id: "me", name: "Tester Person" }, reviewer: { id: "rev", name: "Reviewer", mentions: ["@Reviewer"] }, transitions: {} }, statuses },
    { id: "side", name: "Side", root: sideRoot, jira: { projects: ["OPS"], me: { id: "me", name: "Tester Person" }, reviewer: { id: "rev", name: "Reviewer", mentions: ["@Reviewer"] }, transitions: {} }, statuses },
  ],
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { mutate, load } = require("../src/core/data");

const CLI = path.join(__dirname, "..", "src", "cli.js");
fs.writeFileSync(path.join(box.workspace, "sessions.js"), "");
fs.writeFileSync(path.join(box.data, "sessions.json"), JSON.stringify({ areas: { pay: { title: "Pagos", epics: {} } } }));

function cli(...args) {
  const env = { ...process.env };
  for (const k of ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"]) delete env[k];
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const sent = (key, fields = {}) => ({ key, title: `Tarea ${key}`, kind: "new", status: "sent", area: "pay", approvedVia: "board", sentAt: "2026-11-10T09:00:00.000Z", at: "2026-11-10T08:00:00.000Z", ...fields });
const reset = (tasks, extra = {}) =>
  mutate((d) => {
    d.tasks = tasks;
    d.causes = [];
    Object.assign(d, extra);
  });

test("done is refused while pruebas/<KEY> or .attachments/<KEY> remain, in the task's own project folder", () => {
  reset({ "OPS-1": sent("OPS-1"), "WEB-1": sent("WEB-1") });
  const leftover = path.join(sideRoot, "pruebas", "OPS-1");
  fs.mkdirSync(leftover, { recursive: true });
  const attachments = path.join(mainRoot, ".attachments", "WEB-1");
  fs.mkdirSync(attachments, { recursive: true });
  let r = cli("done", "OPS-1,WEB-1", "hecho");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /OPS-1: no se da por hecha porque quedan restos de la prueba en .*side\/pruebas\/OPS-1\. Bórralos .* vuelve a lanzar «board\.js done OPS-1 …»/);
  assert.match(r.err, /WEB-1: .*main\/\.attachments\/WEB-1/);
  assert.match(r.out, /0 de 2 anotada/);
  assert.equal(load().tasks["OPS-1"].status, "sent");
  assert.equal(load().tasks["WEB-1"].status, "sent");
  fs.rmSync(path.join(sideRoot, "pruebas"), { recursive: true });
  r = cli("done", "OPS-1,WEB-1", "hecho");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /1 de 2 anotada/);
  assert.equal(load().tasks["OPS-1"].status, "done");
  fs.rmSync(path.join(mainRoot, ".attachments"), { recursive: true });
  r = cli("done", "WEB-1", "hecho");
  assert.equal(r.code, 0, r.err);
  assert.equal(load().tasks["WEB-1"].status, "done");
});

test("a returned task is not done until its cause is recorded after it came back", () => {
  reset({ "WEB-2": sent("WEB-2", { kind: "returned", returnedAt: "2026-11-10T08:30:00.000Z" }) }, { causes: [{ key: "WEB-2", cause: "written", note: "vuelta anterior", at: "2026-11-01T10:00:00.000Z" }] });
  let r = cli("done", "WEB-2", "hecho");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /WEB-2: no se da por hecha porque volvió de la revisión \(devuelta\) y no tiene apuntada la causa\. Apúntala primero con «board\.js cause WEB-2 written\|new/);
  assert.equal(load().tasks["WEB-2"].status, "sent");
  r = cli("cause", "WEB-2", "new", "apuntado en context/JIRA.md");
  assert.equal(r.code, 0, r.err);
  r = cli("done", "WEB-2", "hecho");
  assert.equal(r.code, 0, r.err);
  assert.equal(load().tasks["WEB-2"].status, "done");
});

test("partial and question are not blocked by leftovers or a missing cause", () => {
  reset({ "WEB-3": sent("WEB-3", { kind: "returned" }) });
  fs.mkdirSync(path.join(mainRoot, "pruebas", "WEB-3"), { recursive: true });
  const r = cli("partial", "WEB-3", "falta el back");
  assert.equal(r.code, 0, r.err);
  assert.equal(load().tasks["WEB-3"].status, "partial");
  fs.rmSync(path.join(mainRoot, "pruebas"), { recursive: true });
});

test("a returned card added by the reporter records when it came back", () => {
  reset({ "WEB-4": sent("WEB-4", { status: "done" }) });
  const r = cli("add", JSON.stringify([{ key: "WEB-4", title: "Tarea WEB-4", kind: "returned", event: "ev-4" }]));
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.parse(load().tasks["WEB-4"].returnedAt) > Date.now() - 60000);
});
