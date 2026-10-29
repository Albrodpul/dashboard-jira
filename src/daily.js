const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const config = require("./config");
const { mutate, load, now } = require("./data");

const ROOT = config.root;
const ZONE = "Europe/Madrid";
const dayOf = (date) => date.toLocaleDateString("sv-SE", { timeZone: ZONE });

function lastWorkday(from = new Date()) {
  const weekday = (d) => new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short" }).format(d);
  const d = new Date(from);
  do d.setDate(d.getDate() - 1);
  while (["Sat", "Sun"].includes(weekday(d)));
  return dayOf(d);
}


function git(dir, args) {
  try {
    return cp.execFileSync("git", ["-C", dir, ...args], { windowsHide: true, timeout: 20000, encoding: "utf8" }).trim();
  } catch (e) {
    return "";
  }
}

function commitsOf(day) {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    const email = git(dir, ["config", "user.email"]);
    if (!email) continue;
    const log = git(dir, ["log", "--all", "--no-merges", `--author=${email}`, `--since=${day} 00:00`, "--date=short", "--format=%ad|%s"]);
    for (const line of log.split("\n").filter((l) => l.startsWith(`${day}|`))) out.push(`${name}: ${line.slice(day.length + 1)}`);
  }
  return [...new Set(out)];
}

function errorsOf(day) {
  const d = load();
  const on = (iso) => iso && dayOf(new Date(iso)) === day;
  const sentry = Object.values(d.sentry || {})
    .filter((x) => on(x.sentAt) || on(x.closedAt))
    .map((x) => `Sentry: ${String(x.title || "").slice(0, 160)}${x.result ? ` — ${String(x.result).slice(0, 200)}` : ""}`);
  const followUp = (d.followUps || [])
    .flatMap((r) => r.errors || [])
    .filter((e) => on(e.sentAt))
    .map((e) => `Seguimiento: ${String(e.text || "").replace(/\s+/g, " ").slice(0, 200)}`);
  return [...sentry, ...followUp];
}

function write(prompt) {
  return new Promise((resolve) => {
    const sessions = require("./sessions");
    const exe = require("./platform").claudeCli();
    const args = ["-p", prompt, "--no-session-persistence", "--model", config.sessionModel, "--allowedTools="];
    const child = cp.execFile(exe, args, { cwd: ROOT, env: sessions.cleanEnv(), timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out).trim()));
    if (child.stdin) child.stdin.end();
  });
}

let running = null;

async function makeDaily(day) {
  const commits = commitsOf(day);
  const errors = errorsOf(day);
  if (!commits.length && !errors.length) {
    mutate((d) => (d.daily = { day, text: "", empty: true, at: now() }));
    return;
  }
  const prompt = [
    `Escribe el mensaje que Alberto se manda a sí mismo en Slack para la daily, sobre lo que hizo el ${day}.`,
    "Empieza exactamente por «Cosas a comentar en la daily:» y sigue con guiones, en primera persona, en español de España, con su forma natural de escribir: frases cortas y llanas, como habla él, sin claves de Jira, sin nombres de ficheros ni jerga técnica innecesaria, sin emojis ni negritas.",
    "Corto y general: una idea por línea, como mucho 5 líneas, sin enumerar detalles. Agrupa lo relacionado (back y front de la misma cosa, varias tareas de la misma área) y no inventes nada que no salga de los datos. Devuelve solo el mensaje.",
    "Lo que ahora hace el producto va en impersonal («Ahora en invitaciones se respeta…, se permite…»), no como «he respetado».",
    "Los cambios de textos son «copies»: no cuentes qué dicen.",
    "Si hay errores de Sentry en los datos, resúmelos como «he corregido errores de Sentry»; si hay del seguimiento, como «he corregido lo que vio el seguimiento». Sin detallarlos y sin mencionar el que no aparezca en los datos.",
    "No menciones despliegues: van implícitos en lo hecho.",
    "Ejemplos de su estilo: «- He estado revisando la interfaz de los destacados de las membresías de backoffice y web, además de añadir algún validador en back» y «- He revisado membresías de F1 en web y he corregido errores de Sentry»",
    "",
    "Sus commits de ese día por proyecto (es lo que hizo ese día; están en inglés y son técnicos, cuéntalo como lo contaría él):",
    ...(commits.length ? commits : ["(ninguno)"]),
    "",
    "Errores de Sentry o del seguimiento que mandó arreglar ese día:",
    ...(errors.length ? errors : ["(ninguno)"]),
  ].join("\n");
  const text = await write(prompt);
  if (text) mutate((d) => (d.daily = { day, text, at: now() }));
}

function dailyFor(day) {
  if (!running) running = makeDaily(day || lastWorkday()).finally(() => (running = null));
  return running;
}

async function dailyIfMissing() {
  if (!require("./cluster").isPrimary()) return;
  const day = lastWorkday();
  const cur = load().daily;
  if (cur && cur.day === day) return;
  await dailyFor(day);
}

module.exports = { dailyFor, dailyIfMissing, lastWorkday };
