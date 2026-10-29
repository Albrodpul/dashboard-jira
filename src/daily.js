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

function nextDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
    const log = git(dir, ["log", "--all", "--no-merges", `--author=${email}`, `--since=${day} 00:00`, `--until=${nextDay(day)} 00:00`, "--format=%s"]);
    for (const line of log.split("\n").filter(Boolean)) out.push(`${name}: ${line}`);
  }
  return [...new Set(out)];
}

async function jiraOf(day) {
  const { jiraSearch } = require("./jira");
  const jql = `assignee = currentUser() AND status CHANGED DURING ("${day}", "${nextDay(day)}") ORDER BY updated DESC`;
  const issues = await jiraSearch(jql, 50).catch(() => []);
  return issues.map((i) => `${i.key} (${(i.fields.status || {}).name || "?"}): ${i.fields.summary}${i.fields.parent ? ` — epic ${i.fields.parent.fields ? i.fields.parent.fields.summary : i.fields.parent.key}` : ""}`);
}

function deploysOf(day) {
  return (load().deployments || []).filter((x) => x.at && dayOf(new Date(x.at)) === day && x.status !== "cancelled").map((x) => `${(x.projects || []).join(", ")} a ${x.environment}`);
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
  const [jira, commits] = await Promise.all([jiraOf(day), Promise.resolve(commitsOf(day))]);
  const deploys = deploysOf(day);
  if (!jira.length && !commits.length && !deploys.length) {
    mutate((d) => (d.daily = { day, text: "", empty: true, at: now() }));
    return;
  }
  const prompt = [
    `Escribe el mensaje que Alberto se manda a sí mismo en Slack para la daily, sobre lo que hizo el ${day}.`,
    "Empieza exactamente por «Cosas a comentar en la daily:» y sigue con guiones, en primera persona, en español de España, con su forma natural de escribir: frases cortas y llanas, como habla él, sin claves de Jira, sin nombres de ficheros ni jerga técnica innecesaria, sin emojis ni negritas.",
    "Agrupa lo relacionado en una sola línea (por ejemplo, back y front de la misma cosa) y no inventes nada que no salga de los datos. Como mucho 6 líneas. Devuelve solo el mensaje.",
    "Ejemplo de su estilo: «- He estado revisando la interfaz de los destacados de las membresías de backoffice y web, además de añadir algún validador en back»",
    "",
    "Tareas de Jira suyas que cambiaron de estado ese día:",
    ...(jira.length ? jira : ["(ninguna)"]),
    "",
    "Sus commits de ese día por proyecto:",
    ...(commits.length ? commits : ["(ninguno)"]),
    "",
    "Despliegues de ese día:",
    ...(deploys.length ? deploys : ["(ninguno)"]),
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
