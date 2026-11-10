const fs = require("fs");
const path = require("path");
const config = require("../core/config");
const { load, mutate, now } = require("../core/data");

const SECRETS = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN", "SENTRY_TOKEN"];
const OPEN = ["pending", "approved", "sent", "waiting", "partial"];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PREFIX = /^[A-Z]{2,10}$/;

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

const same = (a, b) => path.resolve(a).replace(/\\/g, "/").toLowerCase() === path.resolve(b).replace(/\\/g, "/").toLowerCase();

function writeLocal(id, root) {
  const all = config.localProjects();
  if (root) all[id] = { root: path.resolve(root) };
  else delete all[id];
  fs.writeFileSync(config.localProjectsFile(), JSON.stringify(all, null, 2) + "\n");
}

function openTasks(id) {
  const projects = require("../core/projects");
  return Object.values(load().tasks).filter((t) => OPEN.includes(t.status) && projects.projectOf(t) === id).length;
}

function list() {
  return config.projects.map((p) => ({
    id: p.id,
    name: p.name,
    main: p === config.mainProject,
    editable: p.source === "panel",
    taskPrefix: require("./manual-tasks").prefixOf(p),
    agent: p.agent,
    root: p.root ? p.root.replace(/\\/g, "/") : null,
    rootExists: !!p.root && fs.existsSync(p.root),
    jira: p.jira ? p.jira.projects : null,
    modules: { jira: !!p.jira, followUp: p.followUp.length > 0, sentry: !!(p.sentry && p.sentry.org), deploy: p.deployProjects.length > 0, devServers: p.devServers.length > 0, daily: !!p.daily, context: !!p.contextTidy },
    credentials: Object.fromEntries(SECRETS.map((k) => [k, !!p.secret(k)])),
    messages: p.messages || null,
    openTasks: openTasks(p.id),
  }));
}

function clean(text, max) {
  const t = String(text || "").trim();
  return t ? t.slice(0, max) : "";
}

function save(input) {
  const name = clean(input.name, 60);
  if (!name) return { error: "falta el nombre" };
  const id = input.id ? String(input.id) : slug(name);
  if (!ID.test(id)) return { error: "el id solo admite minúsculas, cifras y guiones" };
  const existing = config.project(id);
  if (existing && existing.source !== "panel") return { error: `${existing.name} se configura en board.config.json, no aquí` };
  if (!existing && input.id && input.create === false) return { error: "ese proyecto no existe" };
  const taskPrefix = clean(input.taskPrefix, 10).toUpperCase() || id.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
  if (!PREFIX.test(taskPrefix)) return { error: "el prefijo de tareas son de 2 a 10 letras" };
  const jiraKeys = config.projects.flatMap((p) => (p.jira ? p.jira.projects : []));
  if (jiraKeys.includes(taskPrefix)) return { error: `${taskPrefix} ya es un proyecto de Jira` };
  const manual = require("./manual-tasks");
  const clash = config.projects.find((p) => p.id !== id && manual.prefixOf(p) === taskPrefix);
  if (clash) return { error: `${clash.name} ya usa el prefijo ${taskPrefix}` };
  const root = clean(input.root, 400);
  if (root) {
    if (!path.isAbsolute(root)) return { error: "la carpeta tiene que ser una ruta completa" };
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { error: "esa carpeta no existe en este ordenador" };
    const taken = config.projects.find((p) => p.id !== id && p.root && same(p.root, root));
    if (taken) return { error: `esa carpeta ya es de ${taken.name}` };
  }
  const messages = {};
  for (const k of ["review", "cause", "reference"]) {
    const v = input.messages ? clean(input.messages[k], 1500) : "";
    if (v) messages[k] = v;
  }
  mutate((d) => {
    d.projectDefs = { ...(d.projectDefs || {}) };
    d.projectDefs[id] = { id, name, taskPrefix, agent: "claude", daily: !!input.daily, contextTidy: !!input.contextTidy, ...(Object.keys(messages).length ? { messages } : {}), updatedAt: now() };
  });
  if (input.root !== undefined) writeLocal(id, root || null);
  config.forgetProjects();
  const p = config.project(id);
  let commands = null;
  if (p && p.root) commands = require("./render-commands").renderProject(p);
  return { id, commands };
}

function remove(id) {
  const p = config.project(id);
  if (!p) return { error: "ese proyecto no existe" };
  if (p.source !== "panel") return { error: `${p.name} se configura en board.config.json, no aquí` };
  const n = openTasks(id);
  if (n) return { error: `${p.name} tiene ${n} tarea${n === 1 ? "" : "s"} abierta${n === 1 ? "" : "s"}: ciérralas o bórralas antes` };
  mutate((d) => {
    d.projectDefs = { ...(d.projectDefs || {}) };
    d.projectDefs[id] = { id, removed: true, updatedAt: now() };
  });
  writeLocal(id, null);
  config.forgetProjects();
  return { id };
}

function setCredentials(id, values) {
  const p = config.project(id);
  if (!p) return { error: "ese proyecto no existe" };
  if (p === config.mainProject) return { error: "las credenciales del proyecto principal están en el .env del tablero" };
  let lines = [];
  try {
    lines = fs.readFileSync(p.envFile, "utf8").split(/\r?\n/);
  } catch (e) {}
  for (const k of SECRETS) {
    if (!values || !(k in values)) continue;
    const v = String(values[k] || "").trim();
    if (/[\r\n]/.test(v)) return { error: `${k} no puede tener saltos de línea` };
    lines = lines.filter((l) => !new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (v) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(p.envFile, lines.filter((l, i) => l.trim() || i < lines.length - 1).join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  config.forgetProjects();
  return { id, credentials: Object.fromEntries(SECRETS.map((k) => [k, !!config.project(id).secret(k)])) };
}

module.exports = { list, save, remove, setCredentials, SECRETS };
