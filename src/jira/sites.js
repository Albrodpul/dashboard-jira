// Several Jira sites: each project with `jira` is read and written with its own
// credentials (.env for the first project, .env.<id> for the others), account,
// reviewer and statuses. A ticket belongs to the project whose jira.projects
// holds its key prefix; anything else falls back to the main project.
const config = require("../core/config");

const NO_REVIEWER = { id: null, name: "", mentions: [] };

function usable(p) {
  if (!p || !p.jira) return false;
  try {
    p.credentials();
    return true;
  } catch (e) {
    return false;
  }
}

// Projects with Jira whose credentials are present on this machine, main first.
const jiraProjects = () => config.projects.filter((p) => p === config.mainProject || usable(p));

function forKey(key) {
  const prefix = String(key || "").split("-")[0].toUpperCase();
  return (prefix && config.projects.find((p) => p.jira && p.jira.projects.includes(prefix))) || config.mainProject;
}

const projectOf = (p) => (!p ? config.mainProject : typeof p === "string" ? config.project(p) || config.mainProject : p);

function auth(p) {
  const k = projectOf(p).credentials();
  return { site: k.site, base: `https://${k.site}/rest/api/3`, auth: "Basic " + Buffer.from(`${k.email}:${k.token}`).toString("base64") };
}

const me = (p) => projectOf(p).jira.me || config.jira.me;
const reviewer = (p) => projectOf(p).jira.reviewer || NO_REVIEWER;
const statuses = (p) => projectOf(p).statuses || config.statuses;

function siteOf(p) {
  try {
    return projectOf(p).secret("JIRA_SITE") || "";
  } catch (e) {
    return "";
  }
}

// Groups keys by the project they belong to: [[project, [keys]], …].
function byProject(keys) {
  const groups = new Map();
  for (const k of keys) {
    const p = forKey(k);
    groups.set(p, (groups.get(p) || []).concat(k));
  }
  return [...groups];
}

module.exports = { jiraProjects, forKey, projectOf, auth, me, reviewer, statuses, siteOf, byProject };
