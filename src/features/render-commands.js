const fs = require("fs");
const path = require("path");
const config = require("../core/config");

const REPO = path.join(__dirname, "..", "..");
const slashes = (p) => String(p).replace(/\\/g, "/");

function valuesFor(p) {
  return {
    ROOT: slashes(p.root),
    WORKSPACE: slashes(config.workspace),
    REPO: slashes(REPO),
    ME: config.jira.me.name,
    REVIEWER: p.jira ? p.jira.reviewer.name : config.jira.me.name,
    COMPANY: p.company,
    PROJECTS: p.jira ? p.jira.projects.join("/") : "",
    JQLPROJECTS: p.jira ? p.jira.projectsJql : "",
    REJECTLABEL: p.statuses ? p.statuses.rejectLabel : "",
    RETURNED: p.statuses ? p.statuses.returned.join("»/«") : "",
  };
}

const wanted = (p, f) => p === config.mainProject || f === "soy.md" || (f === "resumen-jira.md" && p.jira) || (f === "seguimiento.md" && p.followUp.length);

function renderProject(p, warn = () => {}) {
  const templates = path.join(REPO, "templates", "commands");
  const values = valuesFor(p);
  const render = (text) => text.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
  const out = path.join(p.root, ".claude", "commands");
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  for (const f of fs.readdirSync(templates).filter((x) => x.endsWith(".md") && wanted(p, x))) {
    const basic = path.join(REPO, "templates", "basic", f);
    const text = render(fs.readFileSync(!p.jira && fs.existsSync(basic) ? basic : path.join(templates, f), "utf8"));
    const missing = text.match(/\{\{[A-Z]+\}\}/g);
    if (missing) warn(`warning: ${f} has placeholders without a value: ${[...new Set(missing)].join(", ")}`);
    fs.writeFileSync(path.join(out, f), text);
    written.push(f);
  }
  return { folder: slashes(out), files: written };
}

function renderAll(log = console.log) {
  for (const p of config.projects) {
    if (p !== config.mainProject && (!p.root || !fs.existsSync(p.root))) {
      log(`skipped ${p.id}: ${p.root ? slashes(p.root) + " does not exist" : "no folder on this machine"}`);
      continue;
    }
    const r = renderProject(p, log);
    log(`commands (${p.id}) → ${r.folder}`);
  }
}

module.exports = { renderProject, renderAll };
