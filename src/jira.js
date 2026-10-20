const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ROOT, load, mutate } = require("./data");
const config = require("./config");

const ME = config.jira.me.id;
const REVIEWER = config.jira.reviewer;
const ATTACHMENTS_DIR = path.join(ROOT, ".attachments");

function jiraAuth() {
  const k = config.credentials();
  return { base: `https://${k.site}/rest/api/3`, auth: "Basic " + Buffer.from(`${k.email}:${k.token}`).toString("base64") };
}

async function jiraGet(route) {
  const { base, auth } = jiraAuth();
  const r = await fetch(base + route, { headers: { Authorization: auth, Accept: "application/json" } });
  if (!r.ok) throw new Error("Jira " + r.status);
  return r.json();
}

async function jiraRequest(method, route, body) {
  const { base, auth } = jiraAuth();
  const r = await fetch(base + route, { method, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Jira respondió ${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function syncJiraEpics() {
  const jql = encodeURIComponent(`${config.jira.projectsJql} AND issuetype = Epic ORDER BY key`);
  const all = [];
  let token = "";
  do {
    const body = await jiraGet(`/search/jql?jql=${jql}&fields=summary,status&maxResults=100${token ? "&nextPageToken=" + encodeURIComponent(token) : ""}`);
    all.push(...body.issues);
    token = body.isLast ? "" : body.nextPageToken || "";
  } while (token);
  return mutate((d) => {
    d.jiraEpics = all.map((e) => ({ key: e.key, name: e.fields.summary, status: e.fields.status.name }));
    d.jiraEpicsAt = new Date().toISOString();
    return d.jiraEpics.length;
  });
}

async function jiraSearch(jql, max) {
  const body = await jiraGet(`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status,assignee,parent,created,labels&maxResults=${max}`);
  return body.issues || [];
}

async function jiraAttachments(keys) {
  const out = {};
  if (!keys.length) return out;
  const body = await jiraGet(`/search/jql?jql=${encodeURIComponent(`key in (${keys.join(",")})`)}&fields=attachment&maxResults=100`);
  for (const i of body.issues || []) out[i.key] = (i.fields.attachment || []).map((a) => ({ id: a.id, name: a.filename, size: a.size, url: a.content }));
  return out;
}

async function refreshAttachments() {
  const keys = Object.values(load().tasks)
    .filter((t) => ["pending", "approved", "ignored"].includes(t.status))
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
  const { auth } = jiraAuth();
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
          cp.execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", target, "-C", extracted], { windowsHide: true, stdio: "ignore", timeout: 60000 });
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
  const epicKey = f.parent ? f.parent.key : null;
  const epicName = f.parent && f.parent.fields ? f.parent.fields.summary : null;
  const area = epicKey ? Object.keys(routes.areas).find((k) => routes.areas[k].epics && routes.areas[k].epics[epicKey]) || null : null;
  return {
    key: i.key,
    title: f.summary,
    status: f.status.name,
    assignee: f.assignee ? f.assignee.displayName : null,
    available: !f.assignee || f.assignee.accountId === ME,
    epicKey,
    epicName,
    area,
    created: f.created,
    rejected: (f.labels || []).includes(config.statuses.rejectLabel),
    onBoard: !!d.tasks[i.key],
  };
}

const MENTION = new RegExp(`(${[...REVIEWER.mentions].sort((a, b) => b.length - a.length).map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);

function adfFromText(text) {
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

module.exports = { ME, jiraAuth, jiraGet, jiraRequest, syncJiraEpics, jiraSearch, refreshAttachments, downloadAttachments, summarizeIssue, adfFromText };
