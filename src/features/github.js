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

const COMMITS_QUERY = `query($owner:String!,$name:String!,$since:GitTimestamp!){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:15,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){nodes{name target{... on Commit{history(first:40,since:$since){nodes{oid message committedDate author{name user{login}}}}}}}}}}`;
const PUSH_GAP = 45 * 60 * 1000;

async function branchCommits(repo, since) {
  const [owner, name] = repo.split("/");
  const r = await gh(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `since=${new Date(since).toISOString()}`, "-f", `query=${COMMITS_QUERY}`]);
  const refs = (r && r.data && r.data.repository && r.data.repository.refs && r.data.repository.refs.nodes) || null;
  if (!refs) return null;
  const last = (b) => (/^(master|main|production|prod)$/.test(b.name) ? 1 : 0);
  return [...refs].sort((a, b) => last(a) - last(b)).map((ref) => ({ branch: ref.name, commits: (ref.target && ref.target.history && ref.target.history.nodes) || [] }));
}

function commitEvents(repo, branches, { login, seen }) {
  const groups = [];
  for (const { branch, commits } of branches) {
    const mine = {};
    for (const c of commits) {
      const who = c.author && c.author.user && c.author.user.login;
      if (!who || who.toLowerCase() === login.toLowerCase() || isBot(who) || seen.has(c.oid)) continue;
      seen.add(c.oid);
      if (/^Merge (pull request|branch|remote-tracking)/.test(c.message || "")) continue;
      (mine[who] = mine[who] || []).push(c);
    }
    for (const [who, list] of Object.entries(mine)) {
      list.sort((a, b) => a.committedDate.localeCompare(b.committedDate));
      let cur = null;
      for (const c of list) {
        const t = Date.parse(c.committedDate);
        if (!cur || t - cur.last > PUSH_GAP) groups.push((cur = { branch, who, name: c.author.name, commits: [], last: t }));
        cur.commits.push(c);
        cur.last = t;
      }
    }
  }
  return groups.map((g) => ({
    id: `c:${g.commits[0].oid}`,
    at: new Date(g.last).toISOString().replace(".000", ""),
    repo: repo.split("/")[1],
    who: g.who,
    authors: { [g.who]: g.name },
    kind: "push",
    text: `sube ${g.commits.length === 1 ? "un commit" : `${g.commits.length} commits`} a ${g.branch}`,
    items: g.commits.slice(-MAX_COMMITS).map((c) => firstLine(c.message)),
    more: Math.max(0, g.commits.length - MAX_COMMITS),
    v: 2,
    oids: g.commits.map((c) => c.oid),
    url: `https://github.com/${repo}/commits/${g.branch}`,
  }));
}

const REVIEW = { approved: "la aprueba", changes_requested: "pide cambios", commented: "la comenta" };

async function describe(repo, e) {
  const p = e.payload || {};
  const pr = p.pull_request || (p.issue && p.issue.pull_request ? p.issue : null);
  const prRef = pr ? `la PR #${pr.number} «${firstLine(pr.title)}»` : "";
  const url = pr ? pr.html_url : null;
  switch (e.type) {
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
    const stored = (load().github.events || []).filter((x) => x.kind !== "push" || x.v === 2);
    const known = new Set(stored.map((x) => x.id));
    const seen = new Set(stored.flatMap((x) => x.oids || []));
    const fresh = [];
    const names = {};
    const since = Date.now() - KEEP_DAYS * 86400000;
    for (const { repo, project } of repos()) {
      const branches = await branchCommits(repo, since);
      for (const e of branches ? commitEvents(repo, branches, { login, seen }) : []) {
        Object.assign(names, e.authors);
        delete e.authors;
        fresh.push({ ...e, project });
      }
      const events = await gh(["api", `repos/${repo}/events?per_page=100`]);
      if (!Array.isArray(events)) continue;
      for (const e of events) {
        const who = e.actor && e.actor.login;
        if (!who || e.type === "PushEvent" || who.toLowerCase() === login.toLowerCase() || isBot(who) || known.has(e.id) || Date.parse(e.created_at) < since) continue;
        known.add(e.id);
        const d = await describe(repo, e).catch(() => null);
        if (!d) continue;
        fresh.push({ id: e.id, at: e.created_at, repo: repo.split("/")[1], project, who, ...d });
      }
    }
    mutate((data) => {
      const g = data.github;
      g.names = { ...(g.names || {}), ...names };
      const keep = (g.events || []).filter((x) => x.kind !== "push" || x.v === 2);
      g.events = [...fresh, ...keep].filter((x) => Date.parse(x.at) >= since).sort((a, b) => b.at.localeCompare(a.at)).slice(0, KEEP_MAX);
      g.at = new Date().toISOString();
    });
  } finally {
    running = false;
  }
}

function forPage(d = load()) {
  const g = d.github || {};
  const names = g.names || {};
  return { at: g.at || null, events: (g.events || []).slice(0, 60).map(({ oids, ...x }) => ({ ...x, name: names[x.who] || x.who })) };
}

module.exports = { poll, forPage, describe, reposOf, commitEvents };
