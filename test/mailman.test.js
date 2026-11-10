const box = require("./helpers/env").sandbox({ errorsArea: "errors", deployProjects: ["web"] });
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const mailman = require("../src/features/mailman");
const holds = require("../src/features/holds");
const deliver = require("../src/sessions/deliver");
const { mutate, load } = require("../src/core/data");

const CONV = { pay: "11111111-1111-1111-1111-111111111111", errors: "22222222-2222-2222-2222-222222222222", deploy: "33333333-3333-3333-3333-333333333333", orch: "44444444-4444-4444-4444-444444444444" };
const OLD = "2026-01-01T00:00:00.000Z";

let typed = [];
let pushed = [];
let areas = [];

function stubEnv(over = {}) {
  typed = [];
  pushed = [];
  areas = [
    { id: "pay", name: "Pagos", conversation: CONV.pay, sessionName: "Pagos", open: true, ref: null, repeatedName: false },
    { id: "errors", name: "Errores sentry", conversation: CONV.errors, sessionName: "Errores", open: true, ref: null, repeatedName: false },
    { id: "deploy", name: "Subir", conversation: CONV.deploy, sessionName: "Subir", open: true, ref: null, repeatedName: false },
  ];
  mailman._test.setEnv({
    state: () => ({ areas, orchestrator: { title: "Orquestar agentes", conversation: CONV.orch, session: "Orquestar agentes", open: true, ref: null } }),
    live: () => Object.values(CONV).map((conversation) => ({ conversation, started: OLD })),
    open: () => {},
    hosted: async () => true,
    typeInto: async (conversation, text, token) => {
      typed.push({ conversation, text, token });
      return { ok: true };
    },
    sendMessage: async () => ({ ok: false, error: "no debería usarse" }),
    push: (text) => pushed.push(text),
    ...over,
  });
}

function reset(tasks = {}, extra = {}) {
  mutate((d) => {
    d.tasks = tasks;
    d.restrictions = [];
    d.deliveries = [];
    d.deployments = [];
    d.followUps = [];
    d.sentry = {};
    d.contextTidy = null;
    d.permissions = [];
    Object.assign(d, extra);
  });
}

const task = (key, fields = {}) => ({ key, title: `Tarea ${key}`, kind: "new", epicKey: "WEB-1", epicName: "Checkout", status: "approved", area: "pay", approvedVia: "board", decidedAt: OLD, at: OLD, ...fields });
const hold = (input) => {
  const r = mutate((d) => holds.addRestriction(d, input, { areas: ["pay", "errors", "deploy"] }));
  assert.ok(!r.error, r.error);
  return r.restriction;
};
const runAll = async () => {
  for (const job of mailman.collect(load())) await mailman._test.runJob(job);
};

test("approved tasks of one epic go in one message typed into the session, and are marked sent only after confirmation", async () => {
  stubEnv();
  reset({ "WEB-2": task("WEB-2", { note: "la crea Ana", noteBy: "Tablero" }), "WEB-3": task("WEB-3", { kind: "returned", note: "falta el botón", noteBy: "Reviewer", approvedVia: "chat" }) });
  await runAll();
  assert.equal(typed.length, 1);
  const { text, conversation, token } = typed[0];
  assert.equal(conversation, CONV.pay);
  assert.match(text.split("\n")[0], /^Tablero: Tareas de Jira enrutadas por Tester Person desde el reporte: WEB-2, WEB-3 \(WEB-1 Checkout\) \[envío E\d+\]$/);
  assert.ok(text.includes(token));
  assert.match(text, /- WEB-2 · Tarea WEB-2 · nueva \(Tablero: la crea Ana\)/);
  assert.match(text, /- WEB-3 · Tarea WEB-3 · devuelta \(Reviewer: falta el botón\)\. Al cerrarla, apunta la causa con board\.js cause/);
  assert.match(text, /Tester Person ha aprobado este envío \(en el tablero y por chat\): cuenta como su orden de hacerlas/);
  assert.match(text, /pásala por el agente revisor/);
  assert.match(text, /reply WEB-2,WEB-3/);
  const d = load();
  for (const k of ["WEB-2", "WEB-3"]) {
    assert.equal(d.tasks[k].status, "sent");
    assert.equal(d.tasks[k].deliveredBy.id, token.slice(7, -1));
  }
  assert.equal(d.deliveries[0].status, "confirmed");
  assert.deepEqual(d.deliveries[0].marked, ["WEB-2", "WEB-3"]);
});

test("a held task is never typed, even if the job was collected before the hold", async () => {
  stubEnv();
  reset({ "WEB-2": task("WEB-2"), "API-4": task("API-4", { epicKey: "API-1" }) });
  const jobs = mailman.collect(load());
  hold({ tasks: ["WEB-2"], reason: "NFL" });
  assert.deepEqual(mailman.collect(load()).flatMap((j) => j.ids), ["API-4"]);
  for (const job of jobs) await mailman._test.runJob(job);
  assert.equal(typed.length, 1);
  assert.ok(!typed[0].text.includes("WEB-2"));
  assert.equal(load().tasks["API-4"].status, "sent");
  assert.equal(load().tasks["WEB-2"].status, "pending");
});

test("a hold that appears while attachments download stops the delivery before typing", async () => {
  stubEnv({
    attachments: async (key) => {
      if (key === "WEB-2") mutate((d) => d.restrictions.unshift({ id: "R1", scope: { tasks: [], epics: ["WEB-1"], areas: [] }, mode: "hold", reason: "NFL", until: null, createdAt: new Date().toISOString(), releasedAt: null }));
      return { files: [] };
    },
  });
  reset({ "WEB-2": task("WEB-2") });
  await runAll();
  assert.equal(typed.length, 0);
  assert.equal(load().tasks["WEB-2"].status, "approved");
});

test("an expired or released hold lets the task through again", async () => {
  stubEnv();
  reset({ "WEB-2": task("WEB-2") });
  mutate((d) => d.restrictions.push({ id: "R1", scope: { tasks: ["WEB-2"], epics: [], areas: [] }, mode: "hold", reason: "NFL", until: "2026-01-02T00:00:00.000Z", createdAt: OLD, releasedAt: null }));
  await runAll();
  assert.equal(typed.length, 1);
});

test("note restrictions are written into every message for the task, and attachments are listed", async () => {
  stubEnv({ attachments: async () => ({ files: [{ file: "/x/.attachments/WEB-2/a.png" }, { file: "/x/.attachments/WEB-2/d.zip", extracted: "/x/.attachments/WEB-2/d-extracted" }] }) });
  reset({ "WEB-2": task("WEB-2") });
  const r = hold({ epics: ["WEB-1"], mode: "note", reason: "No toques producción hasta el lunes" });
  await runAll();
  assert.match(typed[0].text, new RegExp(`Indicación obligatoria de Tester Person para WEB-2 \\(${r.id}\\): No toques producción hasta el lunes`));
  assert.match(typed[0].text, /Adjuntos de WEB-2, ya descargados: \/x\/\.attachments\/WEB-2\/a\.png, \/x\/\.attachments\/WEB-2\/d\.zip \(zip extraído en \/x\/\.attachments\/WEB-2\/d-extracted\)/);
});

test("a failed delivery leaves the task Por enviar with the error, retries a bounded number of times and tells Alberto", async () => {
  stubEnv({ typeInto: async (c, text, token) => (typed.push({ text, token }), { ok: false, error: "no aparece" }) });
  reset({ "WEB-2": task("WEB-2") });
  await runAll();
  let t = load().tasks["WEB-2"];
  assert.equal(t.status, "approved");
  assert.deepEqual([t.delivery.attempts, t.delivery.error], [1, "no aparece"]);
  assert.equal(mailman.collect(load()).length, 0);
  for (let i = 0; i < 5; i++) {
    mutate((d) => (d.tasks["WEB-2"].delivery.at = OLD));
    await runAll();
  }
  t = load().tasks["WEB-2"];
  assert.equal(t.delivery.attempts, mailman.MAX_ATTEMPTS);
  assert.equal(typed.length, mailman.MAX_ATTEMPTS);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0], /No se pudo entregar WEB-2 a Pagos: no aparece/);
  assert.equal(load().deliveries.filter((x) => x.status === "failed").length, mailman.MAX_ATTEMPTS);
  assert.ok(mailman.status().failing.some((f) => f.id === "WEB-2"));
  assert.equal(mailman.retry({ kind: "task", id: "WEB-2" }), true);
  assert.equal(mailman.collect(load()).length, 1);
});

test("a session that does not open, or does not exist, keeps the task Por enviar without typing", async () => {
  stubEnv();
  areas[0].open = false;
  reset({ "WEB-2": task("WEB-2"), "WEB-5": task("WEB-5", { area: "ghost", epicKey: "WEB-9" }) });
  await runAll();
  assert.equal(typed.length, 0);
  const d = load();
  assert.match(d.tasks["WEB-2"].delivery.error, /no se ha abierto en 2 minutos/);
  assert.match(d.tasks["WEB-5"].delivery.error, /no existe en el tablero/);
  assert.equal(d.tasks["WEB-2"].status, "approved");
});

test("a session outside the host with a repeated name and no ref is not guessed", async () => {
  stubEnv({ hosted: async () => false });
  areas[0].repeatedName = true;
  reset({ "WEB-2": task("WEB-2") });
  await runAll();
  assert.match(load().tasks["WEB-2"].delivery.error, /varias sesiones abiertas con el nombre «Pagos»/);
});

test("an open permission prompt in the session postpones delivery without spending attempts", async () => {
  stubEnv();
  reset({ "WEB-2": task("WEB-2") });
  mailman._test.setEnv({ ...{}, state: () => ({ areas, orchestrator: null }), live: () => [], hosted: async () => true, typeInto: async () => (typed.push(1), { ok: true }), nativePrompt: () => true, push: (x) => pushed.push(x) });
  await runAll();
  const t = load().tasks["WEB-2"];
  assert.equal(typed.length, 0);
  assert.equal(t.delivery.soft, true);
  assert.equal(t.delivery.attempts, 0);
});

test("adding a hold sends a stop notice to the session that already has the task, once", async () => {
  stubEnv();
  reset({ "WEB-2": task("WEB-2", { status: "sent", sentAt: OLD }), "WEB-3": task("WEB-3", { status: "done" }) });
  const r = hold({ epics: ["WEB-1"], reason: "evento NFL", until: "2099-11-09" });
  await runAll();
  assert.equal(typed.length, 1);
  assert.match(typed[0].text.split("\n")[0], /^Aviso del tablero: para la tarea WEB-2 \[envío E\d+\]$/);
  assert.match(typed[0].text, new RegExp(`${r.id}, «evento NFL»\\), hasta el .* 9-11-2099 a las 00:00`));
  assert.match(typed[0].text, /no la retomes hasta que el tablero te la vuelva a mandar/);
  assert.ok(load().tasks["WEB-2"].stopNotices[r.id]);
  await runAll();
  assert.equal(typed.length, 1);
});

test("answers, deployments, follow-up errors, Sentry issues and Ordenar contexto are delivered with their own texts", async () => {
  stubEnv();
  reset(
    { "WEB-2": task("WEB-2", { status: "waiting", notice: { type: "question", text: "¿A o B?" }, answer: { text: "B", at: OLD, delivered: false } }) },
    {
      deployments: [{ id: "D1", projects: ["web", "api"], environment: "both", version: "y", area: "deploy", status: "approved", approvedVia: "board", at: OLD }],
      followUps: [{ at: OLD, text: "r", errors: [{ id: "err-1", text: "Falla el login", state: "approved", approvedVia: "board", at: OLD }] }],
      sentry: { "WEB-K1": { id: "WEB-K1", title: "TypeError", culprit: "app.js", project: "web", url: "https://s/1", count: 3, users: 2, lastSeen: OLD, area: "errors", state: "approved", approvedVia: "board", at: OLD, rounds: 2 } },
      contextTidy: { id: "tidy-1", at: OLD, status: "approved", approvedVia: "board" },
    }
  );
  await runAll();
  const byFirst = (re) => typed.find((x) => re.test(x.text.split("\n")[0]));
  const answer = byFirst(/^Tablero: Respuesta de Tester Person desde el tablero: WEB-2/);
  assert.match(answer.text, /Lo que preguntabas: ¿A o B\?\n  Respuesta de Tester Person, literal: B/);
  const deploy = byFirst(/^Tablero: Despliegue ordenado por Tester Person desde el tablero \(D1\): web, api a develop y producción/);
  assert.match(deploy.text, /Primero el deploy a develop/);
  assert.match(deploy.text, /Tag: incrementar Y \(menor\)/);
  assert.equal(deploy.conversation, CONV.deploy);
  const errors = typed.filter((x) => x.conversation === CONV.errors).map((x) => x.text).join("\n");
  assert.match(errors, /Posibles errores enviados por Tester Person desde el tablero: err-1/);
  assert.match(errors, /Falla el login/);
  assert.match(errors, /- WEB-K1 \(web\): TypeError · reenvío: ya se mandó antes/);
  const tidy = typed.find((x) => x.conversation === CONV.orch);
  assert.match(tidy.text, /^Aviso del tablero: Tester Person ha pulsado Ordenar contexto \(tidy-1\)/);
  const d = load();
  assert.equal(d.tasks["WEB-2"].answer.delivered, true);
  assert.equal(d.tasks["WEB-2"].status, "sent");
  assert.equal(d.deployments[0].status, "sent");
  assert.equal(d.followUps[0].errors[0].state, "sent");
  assert.equal(d.sentry["WEB-K1"].state, "sent");
  assert.ok(d.contextTidy.notifiedAt);
  assert.equal(d.contextTidy.status, "approved");
  await runAll();
  assert.equal(typed.length, 5);
});

test("a delivery interrupted by a restart is resolved from the transcript, not typed twice", async () => {
  stubEnv({ seen: (conversation, token) => token === "[envío E1]" });
  reset({ "WEB-2": task("WEB-2"), "WEB-3": task("WEB-3", { epicKey: "WEB-8" }) }, {
    deliveries: [
      { id: "E1", kind: "tasks", area: "pay", ids: ["WEB-2"], conversation: CONV.pay, status: "typing", at: OLD, pid: -1 },
      { id: "E2", kind: "tasks", area: "pay", ids: ["WEB-3"], conversation: CONV.pay, status: "typing", at: OLD, pid: -1 },
    ],
  });
  mailman._test.recover();
  const d = load();
  assert.equal(d.tasks["WEB-2"].status, "sent");
  assert.equal(d.tasks["WEB-3"].status, "approved");
  assert.equal(d.deliveries.find((x) => x.id === "E2").status, "failed");
});

test("only the primary machine delivers", async () => {
  stubEnv({ primary: () => false });
  reset({ "WEB-2": task("WEB-2") });
  await mailman.tick();
  await mailman._test.idle();
  assert.equal(typed.length, 0);
});

test("typeInto pastes, submits and confirms by finding the mark in the transcript", async () => {
  const file = path.join(box.dir, "t.jsonl");
  fs.writeFileSync(file, '{"type":"user","message":{"content":"antes [envío E9]"}}\n');
  const writes = [];
  const deps = (appearOn) => ({
    transcript: () => file,
    wait: () => Promise.resolve(),
    write: async (c, data) => {
      writes.push(data);
      if (writes.filter((x) => x === "\r").length === appearOn) fs.appendFileSync(file, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "Tablero: hola\nmundo [envío E9]" }) + "\n");
      return { ok: true };
    },
  });
  let r = await deliver.typeInto(CONV.pay, "Tablero: hola\r\nmundo\x1b[201~ [envío E9]", "[envío E9]", deps(1));
  assert.deepEqual(r, { ok: true });
  assert.equal(writes[0], "\x1b[200~Tablero: hola\nmundo[201~ [envío E9]\x1b[201~");
  assert.equal(writes[1], "\r");
  writes.length = 0;
  fs.writeFileSync(file, "");
  r = await deliver.typeInto(CONV.pay, "Tablero: x [envío E9]", "[envío E9]", deps(2));
  assert.deepEqual(r, { ok: true, retried: true });
  writes.length = 0;
  fs.writeFileSync(file, "");
  r = await deliver.typeInto(CONV.pay, "Tablero: x [envío E9]", "[envío E9]", deps(99));
  assert.equal(r.ok, false);
  assert.equal(writes.length, 3);
});

test("a message that shows up late in the transcript is confirmed on the retry instead of being typed again", async () => {
  let late = null;
  stubEnv({ typeInto: async (c, text, token) => (typed.push({ text, token }), (late = token), { ok: false, error: "no aparece" }), seen: (c, token) => token === late });
  reset({ "WEB-7": task("WEB-7") });
  await runAll();
  assert.equal(typed.length, 1);
  mutate((d) => (d.tasks["WEB-7"].delivery.at = OLD));
  await runAll();
  assert.equal(typed.length, 1);
  assert.equal(load().tasks["WEB-7"].status, "sent");
  assert.ok(load().deliveries.some((x) => x.status === "confirmed" && x.late));
});

test("a session in an unknown state (a dialog may be open) is not typed into and spends no attempt", async () => {
  stubEnv({ live: () => Object.values(CONV).map((conversation) => ({ conversation, started: OLD, status: "waiting" })) });
  reset({ "WEB-8": task("WEB-8") });
  await runAll();
  assert.equal(typed.length, 0);
  const t = load().tasks["WEB-8"];
  assert.equal(t.status, "approved");
  assert.ok(t.delivery.soft);
});

test("a task made by hand is sent without Jira wording", () => {
  const { composeTasks } = require("../src/features/mailman");
  const text = composeTasks({ restrictions: [] }, [{ key: "SIDE-1", title: "Cuadrar gastos", description: "de octubre", source: "manual", kind: "new", approvedVia: "board" }], "E1");
  assert.match(text, /^Tablero: Tareas creadas por .* en el tablero: SIDE-1 \[envío E1\]/);
  assert.match(text, /SIDE-1 · Cuadrar gastos · nueva, sin ticket de Jira: de octubre/);
  assert.match(text, /No las busques ni las muevas en Jira/);
  assert.doesNotMatch(text, /desde el reporte/);
});
