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
    editable: true,
    fromFile: p.source !== "panel",
    taskPrefix: require("./manual-tasks").prefixOf(p),
    agent: p.agent,
    root: p.root ? p.root.replace(/\\/g, "/") : null,
    rootExists: !!p.root && fs.existsSync(p.root),
    jira: p.jira ? p.jira.projects : null,
    modules: { jira: !!p.jira, followUp: p.followUp.length > 0, sentry: !!(p.sentry && p.sentry.org), deploy: p.deployProjects.length > 0, devServers: p.devServers.length > 0, daily: !!p.daily, context: !!p.contextTidy },
    credentials: Object.fromEntries(SECRETS.map((k) => [k, !!p.secret(k)])),
    messages: p.messages || null,
    devServers: p.devServers.map((x) => ({ id: x.id, name: x.name, port: x.port, command: [x.command, ...(x.args || [])].join(" ") })),
    openTasks: openTasks(p.id),
  }));
}

function clean(text, max) {
  const t = String(text || "").trim();
  return t ? t.slice(0, max) : "";
}

function devServersOf(input, id) {
  if (!Array.isArray(input.devServers)) return { keep: true };
  const out = [];
  const taken = new Map(config.projects.filter((p) => p.id !== id).flatMap((p) => p.devServers.map((x) => [Number(x.port), p.name])));
  for (const raw of input.devServers) {
    const name = clean(raw && raw.name, 40);
    const port = Number(raw && raw.port);
    const words = clean(raw && raw.command, 200).split(/\s+/).filter(Boolean);
    if (!name && !raw.port && !words.length) continue;
    if (!name) return { error: "cada servidor necesita un nombre" };
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: `el puerto de ${name} va de 1024 a 65535` };
    if (taken.has(port)) return { error: `el puerto ${port} ya lo usa ${taken.get(port)}` };
    if (out.some((x) => x.port === port)) return { error: `el puerto ${port} está repetido` };
    if (!words.length) return { error: `falta el comando de ${name}, por ejemplo «npm run dev»` };
    let sid = slug(name) || `web-${port}`;
    while (out.some((x) => x.id === sid)) sid += "-2";
    out.push({ id: sid, name, role: "Web", port, url: `http://localhost:${port}`, command: words[0], args: words.slice(1) });
  }
  return { list: out };
}

function save(input) {
  const name = clean(input.name, 60);
  if (!name) return { error: "falta el nombre" };
  const id = input.id ? String(input.id) : slug(name);
  if (!ID.test(id)) return { error: "el id solo admite minúsculas, cifras y guiones" };
  const existing = config.project(id);
  const fromFile = !!existing && existing.source !== "panel";
  if (!existing && input.id && input.create === false) return { error: "ese proyecto no existe" };
  const taskPrefix = clean(input.taskPrefix, 10).toUpperCase() || id.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
  if (!PREFIX.test(taskPrefix)) return { error: "el prefijo de tareas son de 2 a 10 letras" };
  const jiraKeys = config.projects.flatMap((p) => (p.jira ? p.jira.projects : []));
  if (jiraKeys.includes(taskPrefix)) return { error: `${taskPrefix} ya es un proyecto de Jira` };
  const manual = require("./manual-tasks");
  const clash = config.projects.find((p) => p.id !== id && manual.prefixOf(p) === taskPrefix);
  if (clash) return { error: `${clash.name} ya usa el prefijo ${taskPrefix}` };
  const base = config.workspaceBase;
  const typed = clean(input.root, 400);
  if (fromFile && typed && (!existing.root || !same(existing.root, path.resolve(base || "", typed)))) return { error: `la carpeta de ${existing.name} se cambia en board.config.json de cada ordenador` };
  let root = "";
  let folder = null;
  if (!fromFile && (typed || !existing)) {
    if (!base) return { error: "no se sabe dónde está workspace en este ordenador" };
    root = path.resolve(base, typed || id);
    folder = path.relative(base, root);
    if (!folder || folder.startsWith("..") || path.isAbsolute(folder)) return { error: `la carpeta tiene que estar dentro de ${base.replace(/\\/g, "/")}` };
    folder = folder.replace(/\\/g, "/");
    if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) return { error: "ahí hay un fichero, no una carpeta" };
    const taken = config.projects.find((p) => p.id !== id && p.root && same(p.root, root));
    if (taken) return { error: `esa carpeta ya es de ${taken.name}` };
  }
  if (!fromFile && !typed && existing) folder = (load().projectDefs || {})[id] ? load().projectDefs[id].folder || null : null;
  const servers = devServersOf(input, id);
  if (servers.error) return { error: servers.error };
  if (fromFile && !servers.keep) return { error: `los servidores de ${existing.name} se cambian en board.config.json de cada ordenador` };
  const keptServers = servers.keep ? ((load().projectDefs || {})[id] || {}).devServers : servers.list;
  const messages = {};
  for (const k of ["review", "cause", "reference"]) {
    const v = input.messages ? clean(input.messages[k], 1500) : "";
    if (v) messages[k] = v;
  }
  mutate((d) => {
    d.projectDefs = { ...(d.projectDefs || {}) };
    d.projectDefs[id] = fromFile
      ? { id, override: true, name, taskPrefix, daily: !!input.daily, contextTidy: !!input.contextTidy, messages: Object.keys(messages).length ? messages : existing.fileValues ? existing.fileValues.messages : null, updatedAt: now() }
      : { id, name, taskPrefix, agent: "claude", daily: !!input.daily, contextTidy: !!input.contextTidy, ...(folder ? { folder } : {}), ...(Object.keys(messages).length ? { messages } : {}), ...(keptServers && keptServers.length ? { devServers: keptServers } : {}), updatedAt: now() };
  });
  if (!servers.keep && existing) {
    const gone = existing.devServers.filter((x) => !servers.list.some((y) => y.id === x.id && y.port === x.port && y.command === x.command && (y.args || []).join(" ") === (x.args || []).join(" ")));
    const devservers = require("./devservers");
    for (const x of gone) Promise.resolve(devservers.stop(existing === config.mainProject ? x.id : `${id}-${x.id}`)).catch(() => {});
  }
  if (root) {
    fs.mkdirSync(root, { recursive: true });
    writeLocal(id, root);
  }
  config.forgetProjects();
  const p = config.project(id);
  let commands = null;
  if (p && p.root) commands = require("./render-commands").renderProject(p);
  return { id, commands };
}

function remove(id) {
  const p = config.project(id);
  if (!p) return { error: "ese proyecto no existe" };
  if (p === config.mainProject) return { error: `${p.name} es el proyecto principal: la vigilancia de Jira, el reporte, el seguimiento, los despliegues y Sentry funcionan sobre él` };
  if (p.source !== "panel") return { error: `${p.name} se quita de board.config.json de cada ordenador` };
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
