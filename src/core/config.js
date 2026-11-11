const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(process.env.TOWER_WORKSPACE || process.env.TORRE_ESPACIO || path.join(__dirname, "..", ".."));
const ENV_FILE = path.join(WORKSPACE, ".env");
const CONFIG_FILE = path.join(WORKSPACE, "board.config.json");
const LEGACY_CONFIG_FILE = path.join(WORKSPACE, "tablero.config.json");

function parseEnv(file) {
  const out = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function loadEnv(file) {
  for (const [k, v] of Object.entries(parseEnv(file))) if (process.env[k] === undefined) process.env[k] = v;
}

function fromLegacyConfig(c) {
  return {
    company: c.empresa || "",
    root: c.raiz,
    jira: {
      projects: c.jira.proyectos,
      me: { id: c.jira.yo.id, name: c.jira.yo.nombre },
      reviewer: { id: c.jira.revisor.id, name: c.jira.revisor.nombre, mentions: c.jira.revisor.mencion },
      transitions: c.jira.transiciones || {},
    },
    statuses: {
      review: c.estados.revision,
      returned: c.estados.devuelta,
      inProgress: c.estados.enCurso,
      closed: c.estados.cerrado,
      rejectLabel: c.estados.etiquetaRechazo,
    },
    followUp: (c.seguimiento || []).map((p) => ({ id: p.id, name: p.nombre, environment: p.entorno === "produccion" ? "production" : p.entorno, hourly: !!p.cadaHora })),
    errorsArea: c.areaErrores || null,
    deployProjects: c.proyectosDespliegue || [],
    sessionModel: c.modeloSesiones,
    contextDomains: c.contextoDominios,
  };
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG_FILE)) {
    const converted = fromLegacyConfig(JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, "utf8")));
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(converted, null, 2) + "\n");
    fs.renameSync(LEGACY_CONFIG_FILE, `${LEGACY_CONFIG_FILE}.migrated`);
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    throw new Error(`Missing or invalid ${CONFIG_FILE}: copy board.config.example.json and fill it in.`);
  }
}

const COMMON_KEYS = ["cluster", "trustedHosts", "voice", "sessionModel", "sessionProfiles", "launchdLabels", "dailyStyle"];

function normalize(c) {
  if (Array.isArray(c.projects) && c.projects.length && typeof c.projects[0] === "object") {
    const common = {};
    for (const k of COMMON_KEYS) if (k in c) common[k] = c[k];
    return { common, projects: c.projects };
  }
  const common = {};
  const project = { id: slug(c.company) || "main", name: c.company || "" };
  for (const [k, v] of Object.entries(c)) (COMMON_KEYS.includes(k) ? common : project)[k] = v;
  return { common, projects: [project], flat: true };
}

const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

function upgradeFlat(read) {
  if (!read.flat) return read;
  try {
    fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.flat.bak`);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...read.common, projects: read.projects }, null, 2) + "\n");
  } catch (e) {}
  return read;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (xs) => xs.map(escape).join("|");
const slashes = (p) => p.replace(/\\/g, "/");

function buildProject(p, index) {
  if (!p.id || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error(`${CONFIG_FILE}: every project needs an id in lowercase letters, digits and dashes`);
  const root = p.root ? path.resolve(p.root) : index === 0 ? path.resolve(WORKSPACE, "..") : null;
  const envFile = path.resolve(WORKSPACE, p.env || (index === 0 ? ".env" : `.env.${p.id}`));
  let env = null;
  const secret = (name) => {
    if (!env) env = parseEnv(envFile);
    if (env[name] !== undefined) return env[name];
    return index === 0 ? process.env[name] : undefined;
  };
  const credentials = () => {
    const site = secret("JIRA_SITE");
    const email = secret("JIRA_EMAIL");
    const token = secret("JIRA_TOKEN");
    if (site && email && token) return { site, email, token };
    throw new Error(`Missing JIRA_SITE, JIRA_EMAIL or JIRA_TOKEN in ${envFile} (copy .env.example).`);
  };
  const keys = p.jira ? p.jira.projects : [];
  const deployTargets = (p.deployProjects || []).map((t) => (typeof t === "string" ? { id: t } : t));
  const st = p.statuses;
  return {
    id: p.id,
    name: p.name || p.company || p.id,
    agent: p.agent || "claude",
    taskPrefix: p.taskPrefix || null,
    messages: p.messages || null,
    daily: p.daily !== undefined ? !!p.daily : index === 0,
    contextTidy: p.contextTidy !== undefined ? !!p.contextTidy : index === 0,
    root,
    company: p.company || p.name || "",
    envFile,
    secret,
    credentials,
    commandsDir: root ? slashes(path.join(root, ".claude", "commands")) : null,
    source: p.source || "file",
    jira: p.jira
      ? {
          projects: keys,
          projectsJql: `project in (${keys.join(", ")})`,
          keyRegex: new RegExp(`\\b(?:${alternatives(keys)})-\\d+\\b`),
          keyRegexGlobal: () => new RegExp(`\\b(?:${alternatives(keys)})-\\d+\\b`, "g"),
          me: p.jira.me,
          reviewer: p.jira.reviewer,
          transitions: p.jira.transitions || {},
          defaultIssueType: p.jira.defaultIssueType || null,
        }
      : null,
    statuses: st
      ? {
          review: st.review,
          returned: st.returned,
          reviewRegex: new RegExp(escape(st.review), "i"),
          returnedRegex: new RegExp(`^(${alternatives(st.returned)})$`, "i"),
          backFromReviewRegex: new RegExp(`^(${alternatives([...st.returned, ...st.inProgress])})$`, "i"),
          closedRegex: new RegExp(`^(${alternatives(st.closed)})$`, "i"),
          rejectLabel: st.rejectLabel,
        }
      : null,
    followUp: p.followUp || [],
    errorsArea: p.errorsArea || null,
    sentry: p.sentry || null,
    devServers: p.devServers || [],
    deployProjects: deployTargets.map((t) => t.id),
    deployTargets,
    contextDomains: root ? path.join(root, p.contextDomains || "context/dominios") : null,
  };
}

const { common, projects: rawProjects } = upgradeFlat(normalize(readConfig()));
const fileProjects = rawProjects.map(buildProject);
if (new Set(fileProjects.map((p) => p.id)).size !== fileProjects.length) throw new Error(`${CONFIG_FILE}: project ids must be unique`);
const main = fileProjects[0];
const workspaceBase = main.root ? path.dirname(main.root) : null;
const folderRoot = (folder) => {
  if (!folder || !workspaceBase) return null;
  const r = path.resolve(workspaceBase, folder);
  return fs.existsSync(r) ? r : null;
};

const LOCAL_FILE = () => path.join(require("./data").DATA_DIR, "projects-local.json");
function localProjects() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE(), "utf8"));
  } catch (e) {
    return {};
  }
}

let cache = { at: 0, list: null };
function allProjects() {
  if (cache.list && Date.now() - cache.at < 3000) return cache.list;
  let defs = {};
  try {
    defs = require("./data").readKey("projectDefs") || {};
  } catch (e) {}
  const local = localProjects();
  for (const p of fileProjects) {
    if (!p.fileValues) p.fileValues = { name: p.name, taskPrefix: p.taskPrefix, messages: p.messages, daily: p.daily, contextTidy: p.contextTidy };
    const def = defs[p.id];
    const over = def && def.override && !def.removed ? Object.fromEntries(Object.keys(p.fileValues).filter((k) => def[k] !== undefined).map((k) => [k, def[k]])) : {};
    Object.assign(p, p.fileValues, over);
  }
  const extra = [];
  for (const def of Object.values(defs)) {
    if (!def || def.removed || !def.id || fileProjects.some((p) => p.id === def.id)) continue;
    try {
      extra.push(buildProject({ ...def, root: (local[def.id] && local[def.id].root) || folderRoot(def.folder), source: "panel" }, fileProjects.length + extra.length));
    } catch (e) {}
  }
  cache = { at: Date.now(), list: [...fileProjects, ...extra] };
  return cache.list;
}
const forgetProjects = () => (cache = { at: 0, list: null });
if (!main.jira || !main.statuses) throw new Error(`${CONFIG_FILE}: the first project still needs jira and statuses`);
if (path.resolve(main.envFile) === path.resolve(ENV_FILE)) loadEnv(ENV_FILE);

module.exports = {
  workspace: WORKSPACE,
  root: main.root,
  company: main.company,
  cli: `node ${slashes(path.join(WORKSPACE, "board.js"))}`,
  commandsDir: main.commandsDir,
  credentials: main.credentials,
  secret: main.secret,
  jira: main.jira,
  statuses: main.statuses,
  followUp: main.followUp,
  errorsArea: main.errorsArea,
  sentry: main.sentry,
  devServers: main.devServers,
  trustedHosts: common.trustedHosts || [],
  cluster: common.cluster || null,
  voice: common.voice || {},
  deployProjects: main.deployProjects,
  deployTargets: main.deployTargets,
  sessionModel: common.sessionModel || "claude-opus-5-5",
  sessionProfiles: common.sessionProfiles || null,
  launchdLabels: ["com.nutria.", ...(common.launchdLabels || [])],
  dailyStyle: common.dailyStyle ? path.resolve(WORKSPACE, common.dailyStyle) : null,
  contextDomains: main.contextDomains,
  get projects() {
    return allProjects();
  },
  fileProjects,
  forgetProjects,
  localProjectsFile: LOCAL_FILE,
  localProjects,
  buildProject,
  mainProject: main,
  workspaceBase,
  project: (id) => allProjects().find((p) => p.id === id) || null,
  forPage: () => ({
    jiraUrl: `https://${main.secret("JIRA_SITE") || ""}/browse/`,
    projects: main.jira.projects,
    me: { name: main.jira.me.name },
    reviewer: { name: main.jira.reviewer.name },
    reviewStatus: main.statuses.review,
    deployProjects: main.deployProjects,
    workspaceBase: workspaceBase ? slashes(workspaceBase) : null,
    workspaces: allProjects().map((p) => ({
      id: p.id,
      name: p.name,
      jira: !!p.jira,
      modules: { jira: !!p.jira, followUp: p.followUp.length > 0, sentry: !!(p.sentry && p.sentry.org), deploy: p.deployProjects.length > 0, devServers: p.devServers.length > 0, context: !!p.contextTidy && !!p.root && fs.existsSync(p.root), daily: !!p.daily },
      source: p.source,
    })),
  }),
};
