const MODES = ["hold", "note"];
const IN_SESSION_OPEN = ["sent", "waiting", "partial"];
const KEEP_MS = 30 * 24 * 3600 * 1000;
const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const weekday = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "short" });

function madridParts(ms) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
}

function madridToMs(y, m, d, h, mi) {
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = madridParts(guess);
    guess += wanted - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  }
  return guess;
}

function parseUntil(text, nowMs = Date.now()) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw || /^(null|none|never|nunca|ninguna|sin fecha|indefinida|-)$/i.test(raw)) return { until: null };
  let ms = null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) ms = Date.parse(raw);
  else {
    let y, mo, d, h, mi, yearGiven;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw);
    if (m) [y, mo, d, h, mi, yearGiven] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4], m[5], true];
    else {
      m = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2}|\d{4}))?(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw);
      if (!m) return { error: `no entiendo la fecha «${raw}»: usa 9-11, 9-11 18:00, 2026-11-09 o 2026-11-09 18:00 (hora de Madrid)` };
      [d, mo, h, mi] = [Number(m[1]), Number(m[2]), m[4], m[5]];
      yearGiven = !!m[3];
      y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : madridParts(nowMs).y;
    }
    h = h === undefined ? 0 : Number(h);
    mi = mi === undefined ? 0 : Number(mi);
    const valid = (yy) => {
      const t = new Date(Date.UTC(yy, mo - 1, d));
      return mo >= 1 && mo <= 12 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60;
    };
    if (!valid(y)) return { error: `la fecha «${raw}» no existe` };
    ms = madridToMs(y, mo, d, h, mi);
    if (!yearGiven && ms <= nowMs && valid(y + 1)) ms = madridToMs(y + 1, mo, d, h, mi);
  }
  if (!Number.isFinite(ms)) return { error: `no entiendo la fecha «${raw}»` };
  if (ms <= nowMs) return { error: `la fecha «${raw}» ya ha pasado` };
  return { until: new Date(ms).toISOString() };
}

function shortUntil(iso) {
  if (!iso) return "";
  const p = madridParts(Date.parse(iso));
  return `${p.d}-${p.m}${p.h || p.mi ? ` ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}` : ""}`;
}

function longUntil(iso) {
  if (!iso) return `hasta que se levante a mano`;
  const ms = Date.parse(iso);
  const p = madridParts(ms);
  return `hasta el ${weekday.format(new Date(ms)).replace(".", "")} ${p.d}-${p.m}-${p.y} a las ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")} (hora de Madrid)`;
}

const list = (d) => (Array.isArray(d.restrictions) ? d.restrictions : []);
const isActive = (r, nowMs = Date.now()) => !!r && !r.releasedAt && (!r.until || nowMs < Date.parse(r.until));
const scopeOf = (r) => ({ tasks: (r.scope && r.scope.tasks) || [], epics: (r.scope && r.scope.epics) || [], areas: (r.scope && r.scope.areas) || [] });

function matches(r, target) {
  const s = scopeOf(r);
  return (!!target.key && s.tasks.includes(target.key)) || (!!target.epicKey && s.epics.includes(target.epicKey)) || (!!target.area && s.areas.includes(target.area));
}

const taskTarget = (t, area) => ({ key: t.key, epicKey: t.epicKey || null, area: area || t.area || t.proposedArea || null });

function restrictionsFor(d, target, nowMs = Date.now()) {
  return list(d).filter((r) => isActive(r, nowMs) && matches(r, target));
}

const holdsFor = (d, target, nowMs) => restrictionsFor(d, target, nowMs).filter((r) => r.mode === "hold");
const notesFor = (d, target, nowMs) => restrictionsFor(d, target, nowMs).filter((r) => r.mode === "note");

function scopeText(r, areaName = (x) => x) {
  const s = scopeOf(r);
  const out = [];
  if (s.tasks.length) out.push(s.tasks.join(", "));
  if (s.epics.length) out.push(`epic ${s.epics.join(", ")}`);
  if (s.areas.length) out.push(`sesión ${s.areas.map(areaName).join(", ")}`);
  return out.join("; ");
}

function holdError(what, holds) {
  const r = holds[0];
  return `${what} está retenida por la restricción ${r.id} («${r.reason}»), ${longUntil(r.until)}. No se puede aprobar ni enviar hasta que caduque o se levante (board.js hold release ${r.id}, o en Tareas → Restricciones).`;
}

function checkTask(d, t, area, nowMs) {
  const cross = require("../core/projects").crossProject(t, area);
  if (cross) return cross;
  const holds = holdsFor(d, taskTarget(t, area), nowMs);
  return holds.length ? holdError(t.key, holds) : "";
}

function checkArea(d, what, area, nowMs) {
  const holds = holdsFor(d, { area }, nowMs);
  return holds.length ? holdError(what, holds) : "";
}

function cleanList(values, re) {
  return [...new Set([].concat(values || []).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean))].filter((x) => !re || re.test(x));
}

function addRestriction(d, input, { areas = null, nowMs = Date.now() } = {}) {
  const mode = input.mode || "hold";
  if (!MODES.includes(mode)) return { error: `modo desconocido: ${mode} (hold o note)` };
  const tasks = cleanList(input.tasks).map((x) => x.toUpperCase());
  const badKeys = tasks.filter((k) => !KEY.test(k));
  if (badKeys.length) return { error: `claves no válidas: ${badKeys.join(", ")}` };
  const epics = cleanList(input.epics).map((x) => x.toUpperCase());
  const badEpics = epics.filter((k) => !KEY.test(k));
  if (badEpics.length) return { error: `epics no válidos: ${badEpics.join(", ")}` };
  const areaIds = cleanList(input.areas);
  if (areas) {
    const unknown = areaIds.filter((a) => !areas.includes(a));
    if (unknown.length) return { error: `sesiones desconocidas: ${unknown.join(", ")}. Las que hay: ${areas.join(", ")}` };
  }
  if (!tasks.length && !epics.length && !areaIds.length) return { error: "di a qué se aplica: tareas, epics o sesiones" };
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!reason) return { error: mode === "note" ? "falta el texto de la indicación" : "falta el motivo" };
  let until = null;
  if (input.until !== undefined && input.until !== null && input.until !== "") {
    const u = parseUntil(input.until, nowMs);
    if (u.error) return { error: u.error };
    until = u.until;
  }
  const at = new Date(nowMs).toISOString();
  d.restrictions = list(d).filter((r) => isActive(r, nowMs) || nowMs - Date.parse(r.releasedAt || r.until || r.createdAt) < KEEP_MS);
  const base = "R" + at.replace(/\D/g, "").slice(0, 17);
  let id = base;
  for (let n = 2; d.restrictions.some((r) => r.id === id); n++) id = `${base}-${n}`;
  const r = { id, scope: { tasks, epics, areas: areaIds }, mode, reason, until, createdAt: at, createdBy: input.createdBy === "board" ? "board" : "chat", releasedAt: null };
  d.restrictions.unshift(r);
  const reverted = [];
  const inSession = [];
  for (const t of Object.values(d.tasks || {})) {
    if (mode !== "hold" || !matches(r, taskTarget(t))) continue;
    if (t.status === "approved") {
      Object.assign(t, { status: "pending", proposedArea: t.area || t.proposedArea || "", decidedAt: null, heldBack: { restriction: id, at } });
      for (const k of ["approvedVia", "delivery"]) delete t[k];
      reverted.push(t.key);
    } else if (IN_SESSION_OPEN.includes(t.status) && !t.manual) inSession.push(t.key);
  }
  return { restriction: r, reverted, inSession };
}

function releaseRestriction(d, id, { by = "chat", nowMs = Date.now() } = {}) {
  const r = list(d).find((x) => x.id === id);
  if (!r) return { error: `no existe la restricción ${id}` };
  if (r.releasedAt) return { error: `la restricción ${id} ya se levantó` };
  if (!isActive(r, nowMs)) return { error: `la restricción ${id} ya caducó` };
  Object.assign(r, { releasedAt: new Date(nowMs).toISOString(), releasedBy: by === "board" ? "board" : "chat" });
  return { restriction: r };
}

function pendingStopNotices(d, nowMs = Date.now()) {
  const out = [];
  for (const t of Object.values(d.tasks || {})) {
    if (!IN_SESSION_OPEN.includes(t.status) || t.manual || !t.area) continue;
    for (const r of holdsFor(d, taskTarget(t), nowMs)) if (!(t.stopNotices || {})[r.id]) out.push({ task: t, restriction: r });
  }
  return out;
}

function chip(r) {
  if (r.mode === "note") return { text: "Con indicación", title: `Indicación obligatoria (${r.id}): ${r.reason}` };
  return { text: `Retenida${r.until ? ` hasta ${shortUntil(r.until)}` : ""} · ${r.reason.length > 24 ? r.reason.slice(0, 23) + "…" : r.reason}`, title: `Retenida por ${r.id}: ${r.reason}, ${longUntil(r.until)}.` };
}

function forPage(d, nowMs = Date.now()) {
  return list(d)
    .filter((r) => isActive(r, nowMs))
    .map((r) => ({ ...r, chip: chip(r), untilText: longUntil(r.until), short: shortUntil(r.until) }));
}

module.exports = { MODES, parseUntil, shortUntil, longUntil, isActive, matches, taskTarget, restrictionsFor, holdsFor, notesFor, scopeText, holdError, checkTask, checkArea, addRestriction, releaseRestriction, pendingStopNotices, forPage, madridToMs };
