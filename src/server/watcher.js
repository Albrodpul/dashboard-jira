const path = require("path");
const fs = require("fs");
const { BOARD_HEARTBEAT, load } = require("../core/data");
const { messageNotice } = require("./state");
const config = require("../core/config");

const ME = config.jira.me.name;
const ORCHESTRA = `${config.commandsDir}/orquesta.md`;

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
  console.log(`RETIRED: el servidor del tablero mira Jira cada minuto y te escribe «Tablero: hay novedades en Jira…» cuando hay algo (o «${ME} ha pulsado Refrescar»). Este Monitor no dará más eventos: páralo, no lo vuelvas a armar y relee ${config.commandsDir}/resumen-jira.md.`);
  setInterval(() => {}, 1 << 30);
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
