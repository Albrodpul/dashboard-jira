const cp = require("child_process");
const config = require("../core/config");
const { load, mutate } = require("../core/data");

const KEEP_DAYS = 7;
const KEEP_MAX = 150;
const MAX_COMMITS = 6;

function gh(args) {
  return new Promise((resolve) => {
    cp.execFile("gh", args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, out) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

let me = null;
async function myLogin() {
  if (me) return me;
  const u = await gh(["api", "user"]);
  if (u && u.login) me = u.login;
  return me;
}

function reposOf(p) {
  if (Array.isArray(p.github)) return p.github;
  return (p.deployTargets || []).map((t) => t.repo).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(String(r || "")));
}

function repos() {
  const out = [];
  for (const p of config.projects) for (const repo of reposOf(p)) if (!out.some((x) => x.repo === repo)) out.push({ repo, project: p.id });
  return out;
}

const branchOf = (ref) => String(ref || "").replace(/^refs\/(heads|tags)\//, "");
const firstLine = (s) => String(s || "").split("\n")[0].trim().slice(0, 160);
const isBot = (login) => /\[bot\]$/i.test(String(login || ""));

async function pushCommits(repo, payload) {
  const zero = /^0+$/.test(String(payload.before || ""));
  if (!payload.head) return [];
  if (zero) {
    const c = await gh(["api", `repos/${repo}/commits/${payload.head}`]);
    return c ? [c] : [];
  }
  const cmp = await gh(["api", `repos/${repo}/compare/${payload.before}...${payload.head}`]);
  return (cmp && cmp.commits) || [];
}

const REVIEW = { approved: "la aprueba", changes_requested: "pide cambios", commented: "la comenta" };

async function describe(repo, e) {
  const p = e.payload || {};
  const pr = p.pull_request || (p.issue && p.issue.pull_request ? p.issue : null);
  const prRef = pr ? `la PR #${pr.number} «${firstLine(pr.title)}»` : "";
  const url = pr ? pr.html_url : null;
  switch (e.type) {
    case "PushEvent": {
      const branch = branchOf(p.ref);
      const commits = (await pushCommits(repo, p)).filter((c) => !/^Merge (pull request|branch|remote-tracking)/.test((c.commit && c.commit.message) || ""));
      if (!commits.length) return null;
      const authors = {};
      for (const c of commits) if (c.author && c.author.login && c.commit && c.commit.author) authors[c.author.login] = c.commit.author.name;
      return {
        kind: "push",
        text: `sube ${commits.length === 1 ? "un commit" : `${commits.length} commits`} a ${branch}`,
        items: commits.slice(-MAX_COMMITS).map((c) => firstLine(c.commit && c.commit.message)),
        more: Math.max(0, commits.length - MAX_COMMITS),
        url: `https://github.com/${repo}/commits/${branch}`,
        authors,
      };
    }
    case "PullRequestEvent":
      if (p.action === "opened" || p.action === "reopened") return { kind: "pr", text: `${p.action === "opened" ? "abre" : "reabre"} ${prRef} (${pr.head && pr.head.ref} → ${pr.base && pr.base.ref})`, url };
      if (p.action === "closed") return { kind: "pr", text: pr.merged ? `fusiona ${prRef} en ${pr.base && pr.base.ref}` : `cierra sin fusionar ${prRef}`, url };
      return null;
    case "PullRequestReviewEvent": {
      const what = REVIEW[String(p.review && p.review.state).toLowerCase()];
      return what ? { kind: "review", text: `revisa ${prRef}: ${what}`, url: (p.review && p.review.html_url) || url } : null;
    }
    case "PullRequestReviewCommentEvent":
    case "IssueCommentEvent":
      if (!pr) return null;
      return { kind: "comment", text: `comenta en ${prRef}`, items: [firstLine(p.comment && p.comment.body)].filter(Boolean), url: (p.comment && p.comment.html_url) || url };
    case "CreateEvent":
      if (p.ref_type === "branch") return { kind: "branch", text: `crea la rama ${p.ref}`, url: `https://github.com/${repo}/tree/${p.ref}` };
      if (p.ref_type === "tag") return { kind: "tag", text: `crea la etiqueta ${p.ref}`, url: `https://github.com/${repo}/releases/tag/${p.ref}` };
      return null;
    case "ReleaseEvent":
      return p.action === "published" ? { kind: "release", text: `publica la versión ${(p.release && (p.release.name || p.release.tag_name)) || ""}`.trim(), url: p.release && p.release.html_url } : null;
    default:
      return null;
  }
}

let running = false;
async function poll() {
  if (running || !require("../cluster/cluster").isPrimary()) return;
  running = true;
  try {
    const login = await myLogin();
    if (!login) return;
    const known = new Set((load().github.events || []).map((x) => x.id));
    const fresh = [];
    const names = {};
    const since = Date.now() - KEEP_DAYS * 86400000;
    for (const { repo, project } of repos()) {
      const events = await gh(["api", `repos/${repo}/events?per_page=60`]);
      if (!Array.isArray(events)) continue;
      for (const e of events) {
        const who = e.actor && e.actor.login;
        if (!who || who.toLowerCase() === login.toLowerCase() || isBot(who) || known.has(e.id) || Date.parse(e.created_at) < since) continue;
        known.add(e.id);
        const d = await describe(repo, e).catch(() => null);
        if (!d) continue;
        Object.assign(names, d.authors || {});
        delete d.authors;
        fresh.push({ id: e.id, at: e.created_at, repo: repo.split("/")[1], project, who, ...d });
      }
    }
    mutate((data) => {
      const g = data.github;
      g.names = { ...(g.names || {}), ...names };
      g.events = [...fresh, ...(g.events || [])].filter((x) => Date.parse(x.at) >= since).sort((a, b) => b.at.localeCompare(a.at)).slice(0, KEEP_MAX);
      g.at = new Date().toISOString();
    });
  } finally {
    running = false;
  }
}

function forPage(d = load()) {
  const g = d.github || {};
  const names = g.names || {};
  return { at: g.at || null, events: (g.events || []).slice(0, 60).map((x) => ({ ...x, name: names[x.who] || x.who })) };
}

module.exports = { poll, forPage, describe, reposOf };
