const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const config = require("../src/core/config");
const sites = require("../src/jira/sites");
const { SEEN_FILE, TO_COUNT_FILE, ROUTES_FILE } = require("../src/core/data");

function minutesSinceLastClose() {
  const now = Date.now();
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  for (let t = now - 6 * 3600 * 1000; t > now - 5 * 24 * 3600 * 1000; t -= 5 * 60 * 1000) {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (p.hour === "18" && Number(p.minute) >= 30 && Number(p.minute) < 35 && !["Sat", "Sun"].includes(p.weekday)) {
      return Math.ceil((now - t) / 60000) + 5;
    }
  }
  return 900;
}

function minutesSinceLastReport() {
  try {
    const d = require("../src/core/data").load();
    const ats = [d.lastReview && d.lastReview.at, d.reports && d.reports[0] && d.reports[0].at].filter(Boolean).map((x) => new Date(x).getTime());
    if (!ats.length) return minutesSinceLastClose();
    const m = Math.ceil((Date.now() - Math.max(...ats)) / 60000) + 10;
    return Math.min(Math.max(m, 15), 7 * 24 * 60);
  } catch (e) {
    return minutesSinceLastClose();
  }
}

const args = process.argv.slice(2);
const all = args.includes("--all") || args.includes("--todo");
const checkOnly = args.includes("--check");
const arg = args.find((x) => !x.startsWith("--")) || "auto";
const minutes = ["close", "cierre"].includes(arg) ? minutesSinceLastClose() : arg === "auto" ? minutesSinceLastReport() : Number(arg);
const KEEP_FIELDS = new Set(["status", "assignee", "summary", "description", "labels", "Attachment", "Sprint"]);

// One reading context per Jira site: its credentials, its account and its statuses.
function siteContext(p) {
  const { base, auth } = sites.auth(p);
  const st = sites.statuses(p);
  return {
    project: p,
    BASE: base,
    AUTH: auth,
    ME: sites.me(p).id,
    RETURNED: {
      test: (text) => {
        const m = /status: .* -> (.*)$/.exec(text);
        return !!m && st.returnedRegex.test(m[1].trim());
      },
    },
    CLOSED: st.closedRegex,
    REJECTED: new RegExp(`\\b${st.rejectLabel}\\b`, "i"),
  };
}

function sprintText(from, to) {
  const list = (s) =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  const a = list(from);
  const b = list(to);
  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  if (!a.length && b.length) return `BACKLOG -> sprint (${added.join(", ")})`;
  if (a.length && !b.length) return `sprint (${removed.join(", ")}) -> BACKLOG`;
  const parts = [];
  if (added.length) parts.push(`añadido a ${added.join(", ")}`);
  if (removed.length) parts.push(`quitado de ${removed.join(", ")}`);
  return `sprint: ${parts.join("; ") || "sin cambios de sprint"}`;
}

const cutoff = Date.now() - minutes * 60 * 1000;
const fmt = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fmtDate = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const today = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit" });
const madrid = (iso) => (today.format(new Date(iso)) === today.format(new Date()) ? fmt : fmtDate).format(new Date(iso));
const hhmm = (iso) => fmt.format(new Date(iso)).slice(0, 5);

async function api(url, ctx) {
  const r = await fetch(url, { headers: { Authorization: ctx.AUTH, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function adfText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.text) return node.text;
  if (node.type === "mention") return (node.attrs && node.attrs.text) || "@alguien";
  return (node.content || []).map(adfText).join(node.type === "paragraph" ? "\n" : " ");
}

function readJson(f, empty) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return empty;
  }
}

function board(cmd, data) {
  try {
    return cp.execFileSync(process.execPath, [path.join(config.workspace, "board.js"), cmd], { input: JSON.stringify(data), windowsHide: true, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch (err) {
    return "";
  }
}

// Search hands at most the newest 40 histories; when the window goes further back, the rest comes page by page from the end.
async function fullChangelog(ctx, it) {
  const c = it.changelog || { histories: [] };
  const oldest = (list) => Math.min(...list.map((h) => new Date(h.created).getTime()));
  if (!(c.total > c.histories.length) || oldest(c.histories) < cutoff) return c;
  const histories = [];
  for (let end = c.total; end > 0; end -= 100) {
    const start = Math.max(0, end - 100);
    const page = await api(`${ctx.BASE}/issue/${it.key}/changelog?startAt=${start}&maxResults=${end - start}`, ctx);
    histories.push(...(page.values || []));
    if (!page.values || !page.values.length || oldest(page.values) < cutoff) break;
  }
  return { histories };
}

// The events of one Jira site in the window, each tagged with its site context.
async function readSite(ctx) {
  const { BASE, ME, REJECTED } = ctx;
  const jql = `${ctx.project.jira.projectsJql} AND updated >= -${minutes}m`;
  const FIELDS = "summary,comment,created,reporter,status,issuetype,assignee,parent";
  const issues = [];
  let token = "";
  do {
    const s = await api(`${BASE}/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&expand=changelog&maxResults=100${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`, ctx);
    issues.push(...s.issues);
    token = s.isLast ? "" : s.nextPageToken || "";
  } while (token);
  const out = [];
  for (const it of issues) {
    const m = it.fields && it.fields.comment;
    const d = m && m.total > (m.comments || []).length ? await api(`${BASE}/issue/${it.key}?fields=${FIELDS}`, ctx) : it;
    d.changelog = await fullChangelog(ctx, it);
    const f = d.fields;
    const isEpic = f.issuetype && f.issuetype.name === "Epic";
    const block = isEpic ? { key: it.key, name: f.summary } : f.parent ? { key: f.parent.key, name: (f.parent.fields && f.parent.fields.summary) || f.parent.key } : null;
    const events = [];
    if (new Date(f.created).getTime() >= cutoff) {
      const kind = isEpic ? "EPIC NUEVA" : "TICKET NUEVO";
      const who = f.assignee ? ` (asignado a ${f.assignee.displayName})` : " (sin asignar)";
      events.push({ t: f.created, who: f.reporter.displayName, text: `${kind}: ${f.summary}${who}`, type: isEpic ? "epic" : "new" });
    }
    for (const h of d.changelog.histories) {
      if (new Date(h.created).getTime() < cutoff || h.author.accountId === ME) continue;
      for (const i of h.items) {
        if (!KEEP_FIELDS.has(i.field) || (i.fromString || "") === (i.toString || "")) continue;
        let text;
        if (i.field === "description") text = "editó la descripción";
        else if (i.field === "summary") text = `cambió el título: "${i.fromString}" -> "${i.toString}"`;
        else if (i.field === "labels") text = `etiqueta ${i.toString || "(quitada)"}`;
        else if (i.field === "Attachment") text = `adjunto ${i.toString || i.fromString}`;
        else if (i.field === "Sprint") text = sprintText(i.fromString, i.toString);
        else text = `${i.field}: ${i.fromString || "-"} -> ${i.toString || "-"}`;
        const rejected = i.field === "labels" && REJECTED.test(i.toString || "") && !REJECTED.test(i.fromString || "");
        events.push({ t: h.created, who: h.author.displayName, text, type: rejected ? "rejected" : i.field });
      }
    }
    for (const c of (f.comment && f.comment.comments) || []) {
      if (new Date(c.created).getTime() < cutoff || c.author.accountId === ME) continue;
      const body = typeof c.body === "string" ? c.body : adfText(c.body);
      events.push({ t: c.created, who: c.author.displayName, text: `COMENTARIO: ${body.replace(/\s+/g, " ").slice(0, 1500)}`, type: "comment" });
    }
    const assignee = f.assignee ? f.assignee.displayName : "sin asignar";
    const assigneeId = f.assignee ? f.assignee.accountId : null;
    const status = (f.status && f.status.name) || "";
    for (const e of events) out.push({ key: it.key, title: f.summary, block, assignee, assigneeId, status, ...e, ctx, id: `${it.key}|${e.t}|${["new", "epic"].includes(e.type) ? { new: "nuevo", epic: "epic" }[e.type] : e.text.slice(0, 120)}` });
  }
  return out;
}

(async () => {
  // Every project with Jira and credentials on this machine. A site that fails is
  // reported and skipped; only when every one fails does the whole read fail.
  const out = [];
  const failed = [];
  for (const p of sites.jiraProjects()) {
    try {
      out.push(...(await readSite(siteContext(p))));
    } catch (e) {
      failed.push({ project: p, error: e.message });
    }
  }
  if (failed.length && failed.length === sites.jiraProjects().length) throw new Error(failed.map((f) => `${f.project.name}: ${f.error}`).join("; "));
  for (const f of failed) console.error(`AVISO: no se pudo leer el Jira de ${f.project.name} (${f.error}); el resto sí.`);
  out.sort((a, b) => new Date(a.t) - new Date(b.t));

  const seen = readJson(SEEN_FILE, { ids: {} }).ids || {};
  const fresh = all ? out : out.filter((e) => !seen[e.id]);
  const repeated = out.length - fresh.length;
  if (checkOnly) return console.log(JSON.stringify({ fresh: fresh.length }));
  const toCount = new Set(readJson(TO_COUNT_FILE, { ids: [] }).ids || []);
  for (const e of fresh) toCount.add(e.id);
  try {
    fs.writeFileSync(TO_COUNT_FILE, JSON.stringify({ ids: [...toCount] }));
  } catch (err) {}

  const blockLabel = (b) => (b ? `${b.key} ${b.name}` : "sin epic");
  console.log(`Ventana: ${minutes} min (hora Madrid ahora: ${fmtDate.format(new Date())})${repeated ? ` · ${repeated} evento(s) ya contados en revisiones anteriores no se repiten (--all para verlos)` : ""}`);
  const attachments = {};
  for (const e of fresh) if (e.type === "Attachment") (attachments[e.who] = attachments[e.who] || []).push(e);
  const bulk = new Set(Object.keys(attachments).filter((who) => attachments[who].length > 20));
  for (const e of fresh) if (!(e.type === "Attachment" && bulk.has(e.who))) console.log(`${madrid(e.t)} | ${e.key} | ${e.who} | ${e.text} | asignado: ${e.assignee} | epic: ${blockLabel(e.block)}`);
  for (const who of bulk) {
    const list = attachments[who];
    const keys = [...new Set(list.map((e) => e.key))];
    console.log(`${madrid(list[0].t)}–${hhmm(list[list.length - 1].t)} | ${keys.length} tickets | ${who} | ${list.length} adjuntos en bloque (${keys.slice(0, 15).join(", ")}${keys.length > 15 ? ", …" : ""}) | resumido: no se listan uno a uno`);
  }
  if (!fresh.length) console.log("(nada nuevo)");

  const routes = readJson(ROUTES_FILE, { areas: {} });
  const areaOf = (key) => {
    const x = Object.entries(routes.areas || {}).find(([, a]) => a.epics && a.epics[key]);
    return x ? x[0] : "";
  };

  const changes = out.filter((e) => !["new", "epic"].includes(e.type)).map((e) => ({ key: e.key, at: new Date(e.t).toISOString(), who: e.who, assignee: e.assignee, text: `${e.who.split(" ")[0]}: ${e.text.replace(/\s+/g, " ").slice(0, 220)}` }));
  const changesResult = changes.length ? board("changes", changes).trim() : "";
  if (/retirada/.test(changesResult)) console.log(`Tablero: ${changesResult}`);

  const cards = [];
  const base = (e) => ({ key: e.key, title: e.title, epicKey: e.block ? e.block.key : "", epicName: e.block ? e.block.name : "", assignee: e.assignee, at: new Date(e.t).toISOString(), proposedArea: e.block ? areaOf(e.block.key) : "", event: e.id });
  const byTicket = new Map();
  for (const e of fresh) byTicket.set(e.key, (byTicket.get(e.key) || []).concat(e));
  for (const [, evs] of byTicket) {
    const e0 = evs[0];
    const { ME, CLOSED, RETURNED } = e0.ctx;
    const availableOrMine = !e0.assigneeId || e0.assigneeId === ME;
    const created = evs.find((e) => e.type === "new");
    if (created && availableOrMine && !CLOSED.test(e0.status)) {
      cards.push({ ...base(created), kind: "new", note: `La crea a las ${hhmm(created.t)}, ${e0.assigneeId ? "asignada a ti" : "sin asignar"}.`, noteBy: created.who });
      continue;
    }
    if (created || e0.assigneeId !== ME || CLOSED.test(e0.status)) continue;
    const returned = evs.filter((e) => e.type === "rejected" || (e.type === "status" && RETURNED.test(e.text))).pop();
    const comment = evs.filter((e) => e.type === "comment").pop();
    if (returned) {
      const note = comment ? comment.text.replace(/^COMENTARIO: /, "") : returned.text;
      cards.push({ ...base(returned), kind: "returned", note: note.slice(0, 900), noteBy: (comment || returned).who });
    } else if (comment) {
      cards.push({ ...base(comment), kind: "comment", note: comment.text.replace(/^COMENTARIO: /, "").slice(0, 900), noteBy: comment.who });
    }
  }
  if (cards.length) {
    const res = board("add", cards).trim();
    console.log("--- Tarjetas del tablero ---");
    for (const t of cards) console.log(`${t.key}: ${t.kind}${t.proposedArea ? ` -> ${t.proposedArea}` : " (epic sin sesión)"}`);
    if (res) console.log(res);
  }

  const epics = new Map();
  for (const e of fresh) if (e.block) epics.set(e.block.key, e.block.name);
  if (epics.size) {
    board(
      "epics",
      [...epics].map(([key, name]) => ({ key, name }))
    );
    console.log("--- Sesión que lleva cada epic de esta ventana ---");
    for (const [key, name] of epics) {
      const area = Object.values(routes.areas || {}).find((a) => a.epics && a.epics[key]);
      const target = area ? `${area.title} (sesión: ${area.session || "sin registrar"})` : "SIN SESIÓN";
      console.log(`${key} ${name} -> ${target}`);
    }
  }
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
