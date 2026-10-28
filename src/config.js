const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(process.env.TOWER_WORKSPACE || process.env.TORRE_ESPACIO || path.join(__dirname, ".."));
const ENV_FILE = path.join(WORKSPACE, ".env");
const CONFIG_FILE = path.join(WORKSPACE, "board.config.json");
const LEGACY_CONFIG_FILE = path.join(WORKSPACE, "tablero.config.json");

function loadEnv(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
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

loadEnv(ENV_FILE);
const c = readConfig();
const root = path.resolve(c.root || path.join(WORKSPACE, ".."));
const projects = c.jira.projects;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (xs) => xs.map(escape).join("|");
const slashes = (p) => p.replace(/\\/g, "/");

const deployTargets = (c.deployProjects || []).map((p) => (typeof p === "string" ? { id: p } : p));

function credentials() {
  const { JIRA_SITE, JIRA_EMAIL, JIRA_TOKEN } = process.env;
  if (JIRA_SITE && JIRA_EMAIL && JIRA_TOKEN) return { site: JIRA_SITE, email: JIRA_EMAIL, token: JIRA_TOKEN };
  throw new Error(`Missing JIRA_SITE, JIRA_EMAIL or JIRA_TOKEN in ${ENV_FILE} (copy .env.example).`);
}

module.exports = {
  workspace: WORKSPACE,
  root,
  company: c.company || "",
  cli: `node ${slashes(path.join(WORKSPACE, "board.js"))}`,
  commandsDir: slashes(path.join(root, ".claude", "commands")),
  credentials,
  jira: {
    projects,
    projectsJql: `project in (${projects.join(", ")})`,
    keyRegex: new RegExp(`\\b(?:${alternatives(projects)})-\\d+\\b`),
    keyRegexGlobal: () => new RegExp(`\\b(?:${alternatives(projects)})-\\d+\\b`, "g"),
    me: c.jira.me,
    reviewer: c.jira.reviewer,
    transitions: c.jira.transitions || {},
    defaultIssueType: c.jira.defaultIssueType || null,
  },
  statuses: {
    review: c.statuses.review,
    returned: c.statuses.returned,
    reviewRegex: new RegExp(escape(c.statuses.review), "i"),
    returnedRegex: new RegExp(`^(${alternatives(c.statuses.returned)})$`, "i"),
    backFromReviewRegex: new RegExp(`^(${alternatives([...c.statuses.returned, ...c.statuses.inProgress])})$`, "i"),
    closedRegex: new RegExp(`^(${alternatives(c.statuses.closed)})$`, "i"),
    rejectLabel: c.statuses.rejectLabel,
  },
  followUp: c.followUp || [],
  errorsArea: c.errorsArea || null,
  sentry: c.sentry || null,
  devServers: c.devServers || [],
  trustedHosts: c.trustedHosts || [],
  cluster: c.cluster || null,
  voice: c.voice || {},
  deployProjects: deployTargets.map((t) => t.id),
  deployTargets,
  sessionModel: c.sessionModel || "claude-opus-5-5",
  contextDomains: path.join(root, c.contextDomains || "context/dominios"),
  forPage: () => ({
    jiraUrl: `https://${process.env.JIRA_SITE || ""}/browse/`,
    projects,
    me: { name: c.jira.me.name },
    reviewer: { name: c.jira.reviewer.name },
    reviewStatus: c.statuses.review,
    deployProjects: deployTargets.map((t) => t.id),
  }),
};
