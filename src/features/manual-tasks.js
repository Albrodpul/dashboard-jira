const config = require("../core/config");
const { now } = require("../core/data");

const isManual = (t) => !!t && t.source === "manual";

function prefixOf(project) {
  const base = String(project.taskPrefix || project.id).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10) || "TAREA";
  const jiraKeys = config.projects.flatMap((p) => (p.jira ? p.jira.projects : []));
  return jiraKeys.includes(base) ? `${base}L` : base;
}

function nextKey(d, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let n = 0;
  for (const k of [...Object.keys(d.tasks || {}), ...Object.keys(d.deleted || {})]) {
    const m = re.exec(k);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}-${n + 1}`;
}

function createTask(d, { project, title, description }) {
  const p = config.project(project || config.mainProject.id);
  if (!p) return { error: `proyecto desconocido: ${project}` };
  const clean = String(title || "").trim().slice(0, 200);
  if (!clean) return { error: "falta el título" };
  const key = nextKey(d, prefixOf(p));
  d.tasks[key] = { key, title: clean, description: String(description || "").trim().slice(0, 6000), project: p.id, source: "manual", kind: "new", status: "pending", at: now(), events: [] };
  return { key };
}

module.exports = { isManual, prefixOf, nextKey, createTask };
