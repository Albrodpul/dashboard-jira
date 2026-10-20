const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ENTRY, database, load, mutate, now } = require("./data");
const { ME, jiraGet } = require("./jira");
const config = require("./config");
const { loadRoutes } = require("./sessions");

const DOMAINS_DIR = config.contextDomains;
const REVIEW = config.statuses.reviewRegex;
const BACK_FROM_REVIEW = config.statuses.backFromReviewRegex;
const WEEKS = 16;
const DAY = 86400000;

function table() {
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS learning_tickets (key TEXT PRIMARY KEY, epic TEXT, epic_name TEXT, events TEXT NOT NULL)");
  return db;
}

async function eventsOf(key) {
  const histories = [];
  for (let start = 0; ; ) {
    const c = await jiraGet(`/issue/${key}/changelog?startAt=${start}&maxResults=100`);
    histories.push(...c.values);
    if (c.isLast !== false || !c.values.length) break;
    start += c.values.length;
  }
  const ev = { deliveries: [], returns: [], reviewerComments: [] };
  let inReview = false;
  for (const h of histories.sort((a, b) => a.created.localeCompare(b.created))) {
    for (const it of h.items) {
      if (it.field !== "status") continue;
      if (REVIEW.test(it.toString || "")) {
        ev.deliveries.push(h.created);
        inReview = true;
      } else {
        const bySomeoneElse = !(h.author && h.author.accountId === ME);
        if (inReview && REVIEW.test(it.fromString || "") && BACK_FROM_REVIEW.test(it.toString || "") && bySomeoneElse) ev.returns.push(h.created);
        inReview = false;
      }
    }
  }
  const comments = await jiraGet(`/issue/${key}/comment?maxResults=100`);
  for (const c of comments.comments || []) if (c.author && c.author.accountId === config.jira.reviewer.id) ev.reviewerComments.push(c.created);
  return ev;
}

async function readJira() {
  const db = table();
  const previous = load().learningRead;
  const days = previous ? Math.max(2, Math.ceil((Date.now() - new Date(previous.at).getTime()) / DAY) + 1) : 300;
  const jql = encodeURIComponent(`${config.jira.projectsJql} AND assignee was "${ME}" AND updated >= -${days}d ORDER BY updated DESC`);
  const issues = [];
  let token = "";
  do {
    const b = await jiraGet(`/search/jql?jql=${jql}&fields=parent&maxResults=100${token ? "&nextPageToken=" + encodeURIComponent(token) : ""}`);
    issues.push(...b.issues);
    token = b.isLast ? "" : b.nextPageToken || "";
  } while (token);
  const put = db.prepare("INSERT OR REPLACE INTO learning_tickets VALUES (?, ?, ?, ?)");
  let failures = 0;
  for (const i of issues) {
    const p = i.fields && i.fields.parent;
    try {
      put.run(i.key, p ? p.key : null, p && p.fields ? p.fields.summary : null, JSON.stringify(await eventsOf(i.key)));
    } catch (e) {
      failures++;
    }
  }
  mutate((d) => {
    d.learningRead = { at: now(), tickets: issues.length, failures };
  });
  return issues.length;
}

let reading = false;

function startReading() {
  if (reading) return false;
  reading = true;
  const child = cp.spawn(process.execPath, [ENTRY, "learning-read"], { stdio: "ignore", windowsHide: true, detached: true });
  child.unref();
  const done = () => (reading = false);
  child.on("exit", done);
  child.on("error", done);
  return true;
}

const madrid = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" });

function mondayOf(iso) {
  const d = new Date(madrid.format(new Date(iso)) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function domains() {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(DOMAINS_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  } catch (e) {
    return out;
  }
  for (const f of files) {
    const text = fs.readFileSync(path.join(DOMAINS_DIR, f), "utf8");
    const title = ((/^# (.+)$/m.exec(text) || [])[1] || f).trim();
    const history = text.split(/^## (?:Historial|History)\s*$/m)[1] || "";
    const dates = history.match(/20\d\d-\d\d-\d\d/g) || [];
    const keys = [...new Set(history.match(config.jira.keyRegexGlobal()) || [])];
    if (dates.length) out.push({ file: f, title, since: dates.sort()[0], keys });
  }
  return out;
}

function learningSummary() {
  const rows = table()
    .prepare("SELECT key, epic, epic_name, events FROM learning_tickets")
    .all()
    .map((r) => ({ ...r, ev: JSON.parse(r.events) }));
  const since = new Date(Date.now() - WEEKS * 7 * DAY).toISOString();
  const weeks = {};
  const week = (k) => (weeks[k] = weeks[k] || { deliveries: 0, returns: 0, repeated: 0, reviewerComments: 0, written: 0, new: 0 });
  for (const r of rows) {
    for (const at of r.ev.deliveries) if (at >= since) week(mondayOf(at)).deliveries++;
    r.ev.returns.forEach((at, i) => {
      if (at < since) return;
      week(mondayOf(at)).returns++;
      if (i >= 1) week(mondayOf(at)).repeated++;
    });
    for (const at of r.ev.reviewerComments) if (at >= since) week(mondayOf(at)).reviewerComments++;
  }
  const causes = load().causes || [];
  for (const c of causes) if (c.at >= since && ["written", "new"].includes(c.cause)) week(mondayOf(c.at))[c.cause]++;

  const allDomains = domains();
  const cut1 = new Date(Date.now() - 28 * DAY).toISOString();
  const cut2 = new Date(Date.now() - 56 * DAY).toISOString();
  const span = () => ({ deliveries: 0, returns: 0 });
  const areas = Object.entries(loadRoutes().areas)
    .filter(([, a]) => Object.keys(a.epics || {}).length)
    .map(([id, a]) => {
      const epics = new Set(Object.keys(a.epics));
      const own = rows.filter((r) => r.epic && epics.has(r.epic));
      const keys = new Set(own.map((r) => r.key));
      const ownDomains = allDomains.filter((dm) => dm.keys.some((k) => keys.has(k)));
      const contextSince = ownDomains.length ? ownDomains.map((dm) => dm.since).sort()[0] : null;
      const recent = span();
      const previous = span();
      const before = span();
      for (const r of own) {
        for (const [list, field] of [
          [r.ev.deliveries, "deliveries"],
          [r.ev.returns, "returns"],
        ]) {
          for (const at of list) {
            if (at >= cut1) recent[field]++;
            else if (at >= cut2) previous[field]++;
            if (contextSince && at.slice(0, 10) < contextSince) before[field]++;
          }
        }
      }
      return { id, name: a.title || id, domains: ownDomains.map((dm) => dm.title), contextSince, before, previous, recent };
    })
    .filter((a) => a.recent.deliveries + a.previous.deliveries + a.before.deliveries > 0)
    .sort((a, b) => b.recent.deliveries + b.previous.deliveries - (a.recent.deliveries + a.previous.deliveries));

  return {
    read: load().learningRead || null,
    reading,
    weeks: Object.entries(weeks)
      .map(([monday, x]) => ({ monday, ...x }))
      .sort((a, b) => b.monday.localeCompare(a.monday)),
    areas,
    recentCauses: causes.slice(0, 12),
  };
}

function saveCause(key, cause, note) {
  return mutate((d) => {
    const t = d.tasks[key];
    d.causes = [{ key, cause, note, area: t ? t.area || null : null, at: now() }].concat(d.causes || []).slice(0, 500);
    return !!t;
  });
}

module.exports = { readJira, startReading, learningSummary, saveCause };
