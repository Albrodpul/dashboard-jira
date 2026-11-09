const path = require("path");
const fs = require("fs");
const { REPORTER_HEARTBEAT, BOARD_HEARTBEAT, load } = require("../core/data");
const { messageNotice } = require("./state");
const config = require("../core/config");

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

function freshInJira() {
  return new Promise((resolve) => {
    require("child_process").execFile(process.execPath, [path.join(__dirname, "..", "..", "bin", "jira-window.js"), "--check"], { windowsHide: true, timeout: 90000, env: { ...process.env, TOWER_WORKSPACE: config.workspace } }, (err, out) => {
      if (err) return resolve(null);
      try {
        const line = String(out).trim().split(/\r?\n/).pop();
        const n = JSON.parse(line).fresh;
        resolve(Number.isInteger(n) ? n : null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function quietReview(p, last) {
  const hhmm = (iso) => new Date(iso).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
  const since = last ? ` desde las ${hhmm(last)}` : "";
  try {
    require("child_process").execFileSync(process.execPath, [path.join(__dirname, "..", "cli.js"), "report", `**Revisión de las ${p.hour}:${p.minute}: sin novedades${since}.**`], { windowsHide: true, timeout: 30000, stdio: "ignore", env: { ...process.env, TOWER_WORKSPACE: config.workspace } });
    return true;
  } catch (e) {
    return false;
  }
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
  let waiting = null;
  setInterval(() => {
    const p = Object.fromEntries(madrid.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const hour = Number(p.hour);
    const min = Number(p.minute);
    const outside = ["Sat", "Sun"].includes(p.weekday) || hour < 8 || hour > 18 || (hour === 18 && min > 30);
    if (outside && !require("../core/hours").overtime()) return;
    const mark = p.weekday + p.hour + p.minute;
    if (mark === lastCycle) return;
    lastCycle = mark;
    const d = load();
    if (d.config && d.config.paused) return;
    const last = (d.lastReview && d.lastReview.at) || (d.reports[0] && d.reports[0].at);
    if (last && Date.now() - new Date(last).getTime() < 50000) return;
    if (waiting && waiting.last === last && Date.now() - waiting.at < 5 * 60000) return;
    waiting = null;
    freshInJira().then((n) => {
      if (n === 0 && quietReview(p, last)) return;
      waiting = { last, at: Date.now() };
      console.log(`CYCLE ${p.hour}:${p.minute}: revisión periódica de Jira. ${CYCLE}`);
    });
  }, 10000);
}

function watchDispatches() {
  console.log(`RETIRED: el tablero ya entrega él mismo lo que ${ME} aprueba (tareas, respuestas, despliegues, errores y Ordenar contexto). Este Monitor no dará más eventos: páralo, no lo vuelvas a armar y relee ${ORCHESTRA}.`);
  setInterval(() => {}, 1 << 30);
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

const REPO = path.join(__dirname, "..", "..");

function head() {
  try {
    return require("child_process").execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    return null;
  }
}

function exitWhenCodeChanges() {
  const start = head();
  if (!start) return;
  setInterval(() => {
    const now = head();
    if (!now || now === start) return;
    console.log(`RESTART: hay código nuevo del tablero (commit ${now.slice(0, 7)}). Vuelve a armar este Monitor con el mismo comando y relee tu comando de .claude/commands por si ha cambiado.`);
    process.exit(0);
  }, 15000);
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
  if (m === "dispatches") return watchDispatches();
  watchReports();
}

module.exports = { watch };
