const fs = require("fs");
const path = require("path");
const config = require("../core/config");
const { now, mutate } = require("../core/data");

const API = "https://sentry.io/api/0";
const CACHE_MS = 60 * 1000;
let cache = null;

function mcpToken(root) {
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    const server = Object.values(mcp.mcpServers || {}).find((s) => (s.args || []).some((a) => String(a).includes("sentry")));
    const args = (server && server.args) || [];
    const i = args.findIndex((a) => String(a).startsWith("--access-token"));
    if (i < 0) return (server && server.env && server.env.SENTRY_ACCESS_TOKEN) || null;
    return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1] || null;
  } catch (e) {
    return null;
  }
}

function tokenOf(p) {
  let t = null;
  try {
    t = p.secret("SENTRY_TOKEN");
  } catch (e) {}
  return t || (p === config.mainProject && p.root ? mcpToken(p.root) : null);
}

const sources = () => config.projects.filter((p) => p.sentry && p.sentry.org && (p.sentry.projects || []).length && tokenOf(p));
const sentryAvailable = () => sources().length > 0;
const ownerOf = (id) => config.project(id) || config.mainProject;
const errorsAreas = () => Object.fromEntries(config.projects.filter((p) => p.errorsArea).map((p) => [p.id, p.errorsArea]));

async function projectIssues(p, slug, auth) {
  const q = new URLSearchParams({ query: p.sentry.query || "is:unresolved level:error", statsPeriod: p.sentry.period || "14d", sort: "date", limit: "25" });
  const r = await fetch(`${API}/projects/${p.sentry.org}/${slug}/issues/?${q}`, { headers: { authorization: `Bearer ${auth}` } });
  if (!r.ok) throw new Error(`Sentry respondió ${r.status} para ${slug}${config.projects.length > 1 ? ` (${p.name})` : ""}`);
  return (await r.json()).map((x) => ({
    id: x.shortId,
    issueId: x.id,
    title: x.title,
    culprit: x.culprit || "",
    project: slug,
    owner: p.id,
    level: x.level,
    count: Number(x.count) || 0,
    users: x.userCount || 0,
    firstSeen: x.firstSeen,
    lastSeen: x.lastSeen,
    url: x.permalink,
  }));
}

async function listIssues(force) {
  const from = sources();
  if (!from.length) return { available: false, issues: [] };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const jobs = from.flatMap((p) => p.sentry.projects.map((slug) => ({ p, slug, auth: tokenOf(p) })));
  const results = await Promise.allSettled(jobs.map((j) => projectIssues(j.p, j.slug, j.auth)));
  const issues = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason.message || r.reason));
  issues.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  const labels = Object.assign({}, ...from.map((p) => p.sentry.labels || {}));
  const value = { available: true, projects: [...new Set(jobs.map((j) => j.slug))], labels, owners: Object.fromEntries(from.map((p) => [p.id, p.name])), issues, errors, at: now() };
  cache = { at: Date.now(), value };
  return value;
}

const STATUSES = ["resolved", "ignored"];

async function setStatus(issueId, id, status, owner) {
  if (!STATUSES.includes(status) || !/^\d+$/.test(String(issueId))) throw new Error("estado o error no válido");
  const p = ownerOf(owner);
  if (!p.sentry || !p.sentry.org) throw new Error(`${p.name} no tiene Sentry`);
  const r = await fetch(`${API}/organizations/${p.sentry.org}/issues/${issueId}/`, { method: "PUT", headers: { authorization: `Bearer ${tokenOf(p)}`, "content-type": "application/json" }, body: JSON.stringify({ status }) });
  if (!r.ok) throw new Error(`Sentry respondió ${r.status}`);
  if (cache) cache.value.issues = cache.value.issues.filter((x) => String(x.issueId) !== String(issueId));
  mutate((d) => {
    const x = (d.sentry || {})[id];
    if (x) Object.assign(x, { closedAs: status, closedAt: now() });
  });
}

function sentryIssues(d) {
  return Object.values(d.sentry || {});
}

function sendIssues(list, area) {
  return mutate((d) => {
    d.sentry = d.sentry || {};
    let n = 0;
    for (const x of list) {
      const prev = d.sentry[x.id];
      if (prev && prev.state === "approved") continue;
      d.sentry[x.id] = { id: x.id, title: String(x.title || "").slice(0, 300), culprit: String(x.culprit || "").slice(0, 300), project: x.project, ...(x.owner ? { owner: String(x.owner) } : {}), url: x.url, count: x.count, users: x.users, lastSeen: x.lastSeen, area, state: "approved", approvedVia: "board", at: now(), rounds: ((prev && prev.rounds) || 0) + 1 };
      n++;
    }
    const limit = Date.now() - 30 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(d.sentry)) if (v.state !== "approved" && new Date(v.at).getTime() < limit) delete d.sentry[k];
    return n;
  });
}

function markSent(ids) {
  return mutate((d) => {
    let k = 0;
    for (const id of ids) {
      const x = (d.sentry || {})[id];
      if (!x || x.state !== "approved" || x.approvedVia !== "board") continue;
      const held = require("./holds").checkArea(d, `El error ${id}`, x.area);
      if (held) {
        console.error(held);
        continue;
      }
      Object.assign(x, { state: "sent", sentAt: now() });
      k++;
    }
    return k;
  });
}

function saveResult(ids, text) {
  return mutate((d) => {
    let k = 0;
    for (const id of ids) {
      const x = (d.sentry || {})[id];
      if (!x || !["approved", "sent"].includes(x.state)) continue;
      x.result = { text, at: now() };
      if (x.state === "approved") Object.assign(x, { state: "sent", sentAt: now() });
      k++;
    }
    return k;
  });
}

function discard(id) {
  return mutate((d) => {
    const x = (d.sentry || {})[id];
    if (!x || x.state === "approved") return false;
    delete d.sentry[id];
    return true;
  });
}

module.exports = { errorsAreas, sources, sentryAvailable, listIssues, sentryIssues, sendIssues, markSent, saveResult, discard, setStatus };
