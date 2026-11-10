const fs = require("fs");
const path = require("path");
const config = require("./config");

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const mainId = () => config.mainProject.id;

function projectOfPath(dir) {
  if (!dir) return config.mainProject;
  const d = norm(path.resolve(dir));
  let best = null;
  for (const p of config.projects) {
    const r = norm(p.root);
    if ((d === r || d.startsWith(r + "/")) && (!best || r.length > norm(best.root).length)) best = p;
  }
  return best;
}

function projectOfKey(key) {
  const prefix = String(key || "").split("-")[0];
  const p = prefix && config.projects.find((x) => x.jira && x.jira.projects.includes(prefix));
  return p ? p.id : null;
}

const projectOf = (record) => (record && (record.project || projectOfKey(record.key))) || mainId();

function areaProject(area, routes) {
  if (!area) return null;
  let r = routes;
  if (!r) {
    try {
      r = JSON.parse(fs.readFileSync(require("./data").ROUTES_FILE, "utf8"));
    } catch (e) {
      r = {};
    }
  }
  const a = (r.areas || {})[area];
  return (a && a.project) || mainId();
}

function crossProject(record, area, routes) {
  if (!area) return "";
  const from = projectOf(record);
  const to = areaProject(area, routes);
  if (from === to) return "";
  const name = (id) => (config.project(id) || { name: id }).name;
  return `${record.key || record.id || "esto"} es de ${name(from)} y la sesión ${area} es de ${name(to)}: entre proyectos no se envía nada.`;
}

module.exports = { mainId, projectOfPath, projectOfKey, projectOf, areaProject, crossProject };
