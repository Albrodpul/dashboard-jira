const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR, ENTRY, UUID } = require("./data");
const { openInVsCode, wakeSession } = require("./sessions");
const { state, ping, wait } = require("./state");
const config = require("./config");

const STARTUP_LOG = path.join(DATA_DIR, "startup.log");
const STARTUP_LOCK = path.join(DATA_DIR, "startup.lock");
const FOLLOW_UP_NOTICE = `Aviso del arranque: arranca el resumen de ${config.jira.reviewer.name}. Eres la sesión de seguimiento registrada: ejecuta ahora .claude/commands/seguimiento.md (regla de AGENTS.md).`;
const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function madridTime() {
  const p = Object.fromEntries(madrid.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { weekend: ["Sat", "Sun"].includes(p.weekday), min: Number(p.hour) * 60 + Number(p.minute) };
}

function log(text) {
  try {
    fs.appendFileSync(STARTUP_LOG, `${new Date().toISOString()} ${text}\n`);
  } catch (e) {}
}

async function openAndWait(read, who) {
  let e = read();
  if (e.open) return e;
  openInVsCode(e.conversation);
  log(`abro ${who} en VS Code`);
  for (let i = 0; i < 24 && !e.open; i++) {
    await wait(5000);
    e = read();
  }
  if (!e.open) return null;
  await wait(8000);
  return e;
}

async function startFollowUp() {
  if (!require("./cluster").isPrimary()) return log("este ordenador no manda: no arranco el seguimiento");
  const t = madridTime();
  if (t.weekend || t.min < 7 * 60 + 50 || t.min >= 18 * 60 + 30) return;
  const e0 = state().followUpStatus;
  if (!e0) return log("no hay sesión de seguimiento registrada");
  if (e0.paused) return log("revisiones en pausa desde el tablero: no se arranca el seguimiento");
  if (e0.last && Date.now() - new Date(e0.last).getTime() < 70 * 60000) return log("el seguimiento está al día");
  const e = await openAndWait(() => state().followUpStatus, "la sesión de seguimiento");
  if (!e) return log("la sesión de seguimiento no se abre");
  const ok = await wakeSession(e.session, FOLLOW_UP_NOTICE);
  log(`aviso de arranque a la sesión de seguimiento (${e.session}): ${ok ? "enviado" : "falló"}`);
}

async function startReporter() {
  if (!require("./cluster").isPrimary()) return log("este ordenador no manda: no arranco el reporte");
  try {
    if (Date.now() - fs.statSync(STARTUP_LOCK).mtimeMs < 10 * 60000) return;
  } catch (e) {}
  fs.writeFileSync(STARTUP_LOCK, String(process.pid));
  const t = madridTime();
  if (t.weekend || t.min >= 18 * 60 + 30) return log("fuera de horario: no se arranca nada");
  if (t.min < 7 * 60 + 55) {
    log("antes de las 7:55: espero");
    while (madridTime().min < 7 * 60 + 55) {
      await wait(60000);
      fs.writeFileSync(STARTUP_LOCK, String(process.pid));
    }
  }
  await wait(25000);
  if (!(await new Promise((r) => ping(r)))) {
    cp.spawn(process.execPath, [ENTRY, "serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    await wait(1500);
  }
  if ((state().reporterStatus || {}).paused) return log("revisiones en pausa desde el tablero: no se arranca el reporte");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rep0 = state().reporterStatus;
    if (rep0 && rep0.watching) return log("la sesión de reporte ya vigila");
    if (!rep0 || !UUID.test(rep0.conversation || "")) return log("no hay sesión de reporte registrada: lanza /resumen-jira una vez a mano");
    const rep = await openAndWait(() => state().reporterStatus, "la sesión de reporte");
    if (!rep) {
      log("la sesión de reporte no se abre");
      continue;
    }
    const ok = await wakeSession(rep.session);
    log(`aviso de arranque a ${rep.session}: ${ok ? "enviado" : "falló"}`);
    for (let i = 0; i < 18; i++) {
      await wait(10000);
      if ((state().reporterStatus || {}).watching) return log("la sesión de reporte ya vigila");
    }
  }
  log("no se consiguió arrancar el reporte en tres intentos");
}

function launchStartup(child) {
  if (!child) {
    cp.spawn(process.execPath, [ENTRY, "startup", "--child"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log(`Arranque del reporte lanzado en segundo plano (registro en ${STARTUP_LOG.replace(/\\/g, "/")}).`);
    return;
  }
  startReporter()
    .catch((e) => log("error: " + (e.message || e)))
    .then(() => startFollowUp())
    .catch((e) => log("error en el seguimiento: " + (e.message || e)))
    .then(() => {
      try {
        fs.unlinkSync(STARTUP_LOCK);
      } catch (e) {}
      process.exit(0);
    });
}

async function wakeFollowUp() {
  const e0 = state().followUpStatus;
  if (!e0) return;
  const e = await openAndWait(() => state().followUpStatus, "la sesión de seguimiento");
  if (e) await wakeSession(e.session, FOLLOW_UP_NOTICE);
}

module.exports = { launchStartup, wakeFollowUp };
