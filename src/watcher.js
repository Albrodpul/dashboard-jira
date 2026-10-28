const path = require("path");
const fs = require("fs");
const { ORCHESTRATOR_HEARTBEAT, REPORTER_HEARTBEAT, BOARD_HEARTBEAT, HUMAN_APPROVALS, load } = require("./data");
const { followUpErrors, messageNotice } = require("./state");
const { sentryIssues } = require("./sentry");
const { ENVIRONMENT_NAME } = require("./api-operations");
const config = require("./config");

const ME = config.jira.me.name;
const ORCHESTRA = `${config.commandsDir}/orquesta.md`;
const CYCLE = `Haz «Cada revisión» de ${config.commandsDir}/resumen-jira.md (léelo ahora).`;
const madrid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function every(fn, ms) {
  fn();
  setInterval(fn, ms);
}

function heartbeat(file) {
  every(() => {
    try {
      fs.writeFileSync(file, new Date().toISOString());
    } catch (e) {}
  }, 15000);
}

function announceNew(list, keyOf, line) {
  const seen = new Set();
  return () => {
    const fresh = list().filter((x) => !seen.has(keyOf(x)));
    if (!fresh.length) return;
    fresh.forEach((x) => seen.add(keyOf(x)));
    console.log(line(fresh));
  };
}

function watchMessages(to) {
  const seen = new Set();
  return () => {
    const fresh = load().messages.filter((m) => m.to === to && !m.readAt && !seen.has(m.id));
    for (const m of fresh.reverse()) {
      seen.add(m.id);
      console.log(`MESSAGE ${m.id}: ${messageNotice(m.id)}`);
    }
  };
}

function watchReports() {
  every(watchMessages("reporter"), 1000);
  heartbeat(REPORTER_HEARTBEAT);
  let seenRequest = "";
  every(() => {
    const p = load().refreshRequest;
    if (!p || p.handled || p.id === seenRequest) return;
    seenRequest = p.id;
    console.log(`REFRESH ${p.id}: ${ME} ha pulsado Refrescar en el tablero. Haz ahora el ciclo completo y entrega el reporte con «${config.cli} report». ${CYCLE}`);
  }, 1000);
  let paused = null;
  every(() => {
    const nowPaused = !!(load().config || {}).paused;
    if (paused === false && nowPaused) console.log(`PAUSE: ${ME} ha pausado las revisiones en el tablero. Sigue «Pausa» de ${config.commandsDir}/resumen-jira.md.`);
    paused = nowPaused;
  }, 1000);
  let lastCycle = "";
  setInterval(() => {
    const p = Object.fromEntries(madrid.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const hour = Number(p.hour);
    const min = Number(p.minute);
    if (["Sat", "Sun"].includes(p.weekday) || hour < 8 || hour > 18 || (hour === 18 && min > 30) || min % 5 !== 0) return;
    const mark = p.weekday + p.hour + p.minute;
    if (mark === lastCycle) return;
    lastCycle = mark;
    const d = load();
    if (d.config && d.config.paused) return;
    const last = (d.lastReview && d.lastReview.at) || (d.reports[0] && d.reports[0].at);
    if (last && Date.now() - new Date(last).getTime() < 2 * 60000) return;
    console.log(`CYCLE ${p.hour}:${p.minute}: revisión periódica de Jira. ${CYCLE}`);
  }, 10000);
}

function watchDispatches() {
  heartbeat(ORCHESTRATOR_HEARTBEAT);
  every(watchMessages("orchestrator"), 1000);
  every(
    announceNew(
      () => followUpErrors(load()).filter((e) => e.state === "approved" && e.approvedVia === "board"),
      (e) => e.id,
      (xs) => `ERRORS ${xs.map((e) => e.id).join(",")}: ${ME} ha pulsado «Enviar a Errores sentry» en la pestaña Seguimiento. Envíalos ya con los pasos de «Errores para Errores sentry» de ${ORCHESTRA}.`
    ),
    1000
  );
  every(
    announceNew(
      () => sentryIssues(load()).filter((x) => x.state === "approved" && x.approvedVia === "board"),
      (x) => `${x.id}@${x.at}`,
      (xs) => `SENTRY ${xs.map((x) => x.id).join(",")}: ${ME} ha pulsado Enviar en la pestaña Sentry. Envíalos ya con los pasos de «Errores de Sentry» de ${ORCHESTRA}.`
    ),
    1000
  );
  every(
    announceNew(
      () => Object.values(load().tasks).filter((t) => t.status === "approved" && HUMAN_APPROVALS.includes(t.approvedVia)),
      (t) => `${t.key}@${t.decidedAt || ""}`,
      (xs) => `APPROVED ${xs.map((t) => t.key).join(",")}: ${ME} ha pulsado Hacer en estas tareas. Envíalas ya con los pasos de «Enviar» de ${ORCHESTRA}.`
    ),
    1000
  );
  const seenDeploys = new Set();
  every(() => {
    for (const x of load().deployments.filter((y) => y.status === "approved" && y.approvedVia === "board" && !seenDeploys.has(y.id))) {
      seenDeploys.add(x.id);
      console.log(`DEPLOY ${x.id}: ${ME} ha pulsado Desplegar (${x.projects.join(", ")} a ${ENVIRONMENT_NAME[x.environment]}). Envíalo ya con los pasos de «Desplegar» de ${ORCHESTRA}.`);
    }
  }, 1000);
  every(
    announceNew(
      () => [load().contextTidy].filter((o) => o && o.status === "approved" && o.approvedVia === "board"),
      (o) => o.id,
      (xs) => `TIDY ${xs[0].id}: ${ME} ha pulsado Ordenar contexto. Hazlo ya con los pasos de «Ordenar contexto» de ${ORCHESTRA}.`
    ),
    1000
  );
  every(
    announceNew(
      () => Object.values(load().tasks).filter((t) => t.answer && !t.answer.delivered),
      (t) => `${t.key}@${t.answer.at}`,
      (xs) => `ANSWER ${xs.map((t) => t.key).join(",")}: ${ME} ha contestado en el tablero a lo que preguntaba una sesión. Entrégaselo ya con los pasos de «Respuestas» de ${ORCHESTRA}.`
    ),
    1000
  );
}

function watchBoard() {
  every(watchMessages("board"), 1000);
  heartbeat(BOARD_HEARTBEAT);
}

const MODES = { reports: "reports", reportes: "reports", dispatches: "dispatches", envios: "dispatches", board: "board", tablero: "board" };

function exitWhenOrphaned() {
  process.stdout.on("error", () => process.exit(0));
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (e) {
      if (e.code !== "EPERM") process.exit(0);
    }
  }, 15000);
}

const REPO = path.join(__dirname, "..");
const CODE_DIRS = [__dirname, path.join(REPO, "templates", "commands")];

function codeStamps() {
  const out = {};
  for (const dir of CODE_DIRS) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|md)$/.test(f)) continue;
      try {
        out[path.join(dir, f)] = fs.statSync(path.join(dir, f)).mtimeMs;
      } catch (e) {}
    }
  }
  return out;
}

function exitWhenCodeChanges() {
  const start = codeStamps();
  setInterval(() => {
    const now = codeStamps();
    const changed = Object.keys({ ...start, ...now }).filter((f) => start[f] !== now[f]);
    if (!changed.length) return;
    console.log(`RESTART: ha cambiado el código del tablero (${changed.map((f) => path.basename(f)).join(", ")}). Vuelve a armar este Monitor con el mismo comando y relee tu comando de .claude/commands por si ha cambiado.`);
    process.exit(0);
  }, 10000);
}

function watch(mode) {
  exitWhenOrphaned();
  exitWhenCodeChanges();
  const m = mode ? MODES[mode] : null;
  if (mode && !m) {
    console.error("Uso: board.js watch [reports|dispatches|board]");
    process.exit(1);
  }
  if (m === "board") return watchBoard();
  if (m !== "dispatches") watchReports();
  if (m !== "reports") watchDispatches();
}

module.exports = { watch };
