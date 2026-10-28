const fs = require("fs");
const path = require("path");
const config = require("./config");
const { now, mutate } = require("./data");

const API = "https://sentry.io/api/0";
const CACHE_MS = 60 * 1000;
let cache = null;

function token() {
  if (process.env.SENTRY_TOKEN) return process.env.SENTRY_TOKEN;
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(config.root, ".mcp.json"), "utf8"));
    const server = Object.values(mcp.mcpServers || {}).find((s) => (s.args || []).some((a) => String(a).includes("sentry")));
    const args = (server && server.args) || [];
    const i = args.findIndex((a) => String(a).startsWith("--access-token"));
    if (i < 0) return (server && server.env && server.env.SENTRY_ACCESS_TOKEN) || null;
    return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1] || null;
  } catch (e) {
    return null;
  }
}

const sentryAvailable = () => !!(config.sentry && config.sentry.org && (config.sentry.projects || []).length && token());

async function projectIssues(slug, auth) {
  const q = new URLSearchParams({ query: config.sentry.query || "is:unresolved level:error", statsPeriod: config.sentry.period || "14d", sort: "date", limit: "25" });
  const r = await fetch(`${API}/projects/${config.sentry.org}/${slug}/issues/?${q}`, { headers: { authorization: `Bearer ${auth}` } });
  if (!r.ok) throw new Error(`Sentry respondió ${r.status} para ${slug}`);
  return (await r.json()).map((x) => ({
    id: x.shortId,
    title: x.title,
    culprit: x.culprit || "",
    project: slug,
    level: x.level,
    count: Number(x.count) || 0,
    users: x.userCount || 0,
    firstSeen: x.firstSeen,
    lastSeen: x.lastSeen,
    url: x.permalink,
  }));
}

async function listIssues(force) {
  if (!sentryAvailable()) return { available: false, issues: [] };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const auth = token();
  const results = await Promise.allSettled(config.sentry.projects.map((p) => projectIssues(p, auth)));
  const issues = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason.message || r.reason));
  issues.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  const value = { available: true, projects: config.sentry.projects, issues, errors, at: now() };
  cache = { at: Date.now(), value };
  return value;
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
      d.sentry[x.id] = { id: x.id, title: String(x.title || "").slice(0, 300), culprit: String(x.culprit || "").slice(0, 300), project: x.project, url: x.url, count: x.count, users: x.users, lastSeen: x.lastSeen, area, state: "approved", approvedVia: "board", at: now(), rounds: ((prev && prev.rounds) || 0) + 1 };
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

module.exports = { sentryAvailable, listIssues, sentryIssues, sendIssues, markSent, saveResult, discard };
