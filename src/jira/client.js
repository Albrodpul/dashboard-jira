const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ROOT, load, mutate } = require("../core/data");
const config = require("../core/config");
const sites = require("./sites");

const ME = config.jira.me.id;
const ATTACHMENTS_DIR = path.join(ROOT, ".attachments");

// `p` is the project (or its id) whose Jira is asked; without it, the main one.
const jiraAuth = (p) => sites.auth(p);

async function jiraGet(route, p) {
  const { base, auth } = jiraAuth(p);
  const r = await fetch(base + route, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!r.ok) throw new Error("Jira " + r.status);
  return r.json();
}

async function jiraRequest(method, route, body, p) {
  const { base, auth } = jiraAuth(p);
  const r = await fetch(base + route, { method, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Jira respondió ${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function epicsOf(p) {
  const jql = encodeURIComponent(`${p.jira.projectsJql} AND issuetype = Epic ORDER BY key`);
  const all = [];
  let token = "";
  do {
    const body = await jiraGet(`/search/jql?jql=${jql}&fields=summary,status&maxResults=100${token ? "&nextPageToken=" + encodeURIComponent(token) : ""}`, p);
    all.push(...body.issues);
    token = body.isLast ? "" : body.nextPageToken || "";
  } while (token);
  return all.map((e) => ({ key: e.key, name: e.fields.summary, status: e.fields.status.name, project: p.id }));
}

// Epics of every Jira. A site that fails keeps the epics it had last time.
async function syncJiraEpics() {
  const list = sites.jiraProjects();
  const results = await Promise.allSettled(list.map(epicsOf));
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  const failed = new Set(list.filter((p, i) => results[i].status === "rejected").map((p) => p.id));
  const fresh = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return mutate((d) => {
    const kept = (d.jiraEpics || []).filter((e) => failed.has(e.project || sites.forKey(e.key).id));
    d.jiraEpics = [...fresh, ...kept];
    d.jiraEpicsAt = new Date().toISOString();
    return d.jiraEpics.length;
  });
}

async function jiraSearch(jql, max, p) {
  const body = await jiraGet(`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status,assignee,parent,created,labels&maxResults=${max}`, p);
  return body.issues || [];
}

// The same search on every Jira, with `jqlOf(project)` building each one's JQL.
async function jiraSearchAll(jqlOf, max) {
  const results = await Promise.allSettled(sites.jiraProjects().map((p) => jiraSearch(jqlOf(p), max, p)));
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

// Tickets by key, each group asked to its own Jira.
async function jiraIssues(keys, max) {
  const groups = sites.byProject(keys);
  const results = await Promise.allSettled(groups.map(([p, list]) => jiraSearch(`key in (${list.join(",")})`, max, p)));
  if (results.length && results.every((r) => r.status === "rejected")) throw results[0].reason;
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

async function jiraAttachments(keys) {
  const out = {};
  const groups = sites.byProject(keys);
  for (const [p, list] of groups) {
    let body;
    try {
      body = await jiraGet(`/search/jql?jql=${encodeURIComponent(`key in (${list.join(",")})`)}&fields=attachment&maxResults=100`, p);
    } catch (e) {
      if (groups.length === 1) throw e;
      continue;
    }
    for (const i of body.issues || []) out[i.key] = (i.fields.attachment || []).map((a) => ({ id: a.id, name: a.filename, size: a.size, url: a.content }));
  }
  return out;
}

async function refreshAttachments() {
  const keys = Object.values(load().tasks)
    .filter((t) => ["pending", "approved", "ignored"].includes(t.status) && t.source !== "manual")
    .sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")))
    .map((t) => t.key)
    .filter((k) => /^[A-Z]+-\d+$/.test(k))
    .slice(0, 100);
  if (!keys.length) return;
  const found = await jiraAttachments(keys);
  const summary = (list) => list.map((a) => ({ name: a.name, size: a.size }));
  const differs = (t, list) => JSON.stringify(t.attachments || null) !== JSON.stringify(list);
  const d0 = load();
  if (!keys.some((k) => found[k] && d0.tasks[k] && differs(d0.tasks[k], summary(found[k])))) return;
  mutate((d) => {
    for (const k of keys) if (found[k] && d.tasks[k]) d.tasks[k].attachments = summary(found[k]);
  });
}

async function downloadAttachments(key) {
  if (!/^[A-Z]+-\d+$/.test(key)) throw new Error("clave no válida");
  const list = (await jiraAttachments([key]))[key] || [];
  if (!list.length) return { folder: null, files: [] };
  const { auth } = jiraAuth(sites.forKey(key));
  const folder = path.join(ATTACHMENTS_DIR, key);
  fs.mkdirSync(folder, { recursive: true });
  const files = [];
  const used = new Set();
  for (const a of list) {
    let name = path.basename(String(a.name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "attachment-" + a.id;
    if (used.has(name.toLowerCase())) name = a.id + "-" + name;
    used.add(name.toLowerCase());
    const target = path.join(folder, name);
    if (!(fs.existsSync(target) && fs.statSync(target).size === a.size)) {
      const r = await fetch(a.url, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`no se pudo bajar ${a.name} (${r.status})`);
      fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    }
    const item = { file: target.replace(/\\/g, "/") };
    if (/\.zip$/i.test(name)) {
      const extracted = path.join(folder, name.replace(/\.zip$/i, "") + "-extracted");
      if (!fs.existsSync(extracted)) {
        fs.mkdirSync(extracted, { recursive: true });
        try {
          cp.execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", target, "-C", extracted], { windowsHide: true, stdio: "ignore", timeout: 60000 });
        } catch (e) {
          fs.rmSync(extracted, { recursive: true, force: true });
        }
      }
      if (fs.existsSync(extracted)) item.extracted = extracted.replace(/\\/g, "/");
    }
    files.push(item);
  }
  return { folder: folder.replace(/\\/g, "/"), files };
}

function summarizeIssue(i, d, routes) {
  const f = i.fields;
  const p = sites.forKey(i.key);
  const epicKey = f.parent ? f.parent.key : null;
  const epicName = f.parent && f.parent.fields ? f.parent.fields.summary : null;
  const area = epicKey ? Object.keys(routes.areas).find((k) => routes.areas[k].epics && routes.areas[k].epics[epicKey]) || null : null;
  return {
    key: i.key,
    title: f.summary,
    status: f.status.name,
    assignee: f.assignee ? f.assignee.displayName : null,
    available: !f.assignee || f.assignee.accountId === sites.me(p).id,
    epicKey,
    epicName,
    area,
    created: f.created,
    rejected: (f.labels || []).includes(sites.statuses(p).rejectLabel),
    onBoard: !!d.tasks[i.key],
  };
}

// `p`: the project whose reviewer gets mentioned (the ticket's own); without it, the main one.
function adfFromText(text, p) {
  const REVIEWER = sites.reviewer(p);
  const MENTION = REVIEWER.mentions.length ? new RegExp(`(${[...REVIEWER.mentions].sort((a, b) => b.length - a.length).map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`) : /(?!)/;
  const paragraph = (block) => {
    const content = [];
    block.split("\n").forEach((line, i) => {
      if (i) content.push({ type: "hardBreak" });
      line.split(MENTION).forEach((piece) => {
        if (!piece) return;
        if (REVIEWER.mentions.includes(piece)) content.push({ type: "mention", attrs: { id: REVIEWER.id, text: REVIEWER.mentions[0] } });
        else content.push({ type: "text", text: piece });
      });
    });
    return { type: "paragraph", content };
  };
  return { type: "doc", version: 1, content: String(text).trim().split(/\n\s*\n/).map(paragraph) };
}

module.exports = { ME, jiraAuth, jiraGet, jiraRequest, syncJiraEpics, jiraSearch, jiraSearchAll, jiraIssues, refreshAttachments, downloadAttachments, summarizeIssue, adfFromText };
