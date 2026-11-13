const fs = require("fs");
const { load, mutate, now } = require("../core/data");

const WAITING_MIN = 4;
const REPEAT_MIN = 15;
const TYPING_MIN = 4;
const RENOTIFY_MS = 2 * 3600000;
const TAIL = 256 * 1024;

const minutesSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : 0);

function tailLines(file) {
  try {
    const st = fs.statSync(file);
    const length = Math.min(st.size, TAIL);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, length, st.size - length);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString("utf8").split("\n").slice(length < st.size ? 1 : 0);
  } catch (e) {
    return [];
  }
}

function noticeOf(text) {
  const m = /(Aviso del (?:tablero|arranque):[^\n<]*)/.exec(String(text || ""));
  return m ? m[1].replace(/\s*\[envío E\d+\]\s*/g, " ").replace(/\s+/g, " ").trim() : null;
}

function repeatedNotices(lines, sinceMs) {
  const seen = new Map();
  const out = [];
  for (const line of lines) {
    if (!line.includes("Aviso del")) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (j.type !== "user" || !j.message || !j.timestamp) continue;
    const at = new Date(j.timestamp).getTime();
    if (at < sinceMs) continue;
    const content = typeof j.message.content === "string" ? j.message.content : (j.message.content || []).map((c) => c.text || "").join("\n");
    const notice = noticeOf(content);
    if (!notice) continue;
    const prev = seen.get(notice);
    if (prev && at - prev < REPEAT_MIN * 60000) out.push({ notice, at: j.timestamp });
    seen.set(notice, at);
  }
  return out;
}

function findings(s, d) {
  const out = [];
  const pending = new Set(((d.permissions || []).filter((p) => p.status === "pending")).map((p) => p.conversation));
  const stuck = new Set((s.stuckDialogs || []).map((x) => x.conversation));
  const registry = require("../sessions/registry");
  for (const x of (s.sessions && s.sessions.list) || []) {
    if (!x.conversation) continue;
    const name = x.title || x.name;
    if (x.status === "waiting" && minutesSince(x.statusSince) >= WAITING_MIN && !pending.has(x.conversation) && !stuck.has(x.conversation))
      out.push({ key: `waiting|${x.conversation}|${x.statusSince}`, kind: "waiting", conversation: x.conversation, name, title: `«${name}» lleva ${Math.round(minutesSince(x.statusSince))} min esperando y el tablero no muestra ninguna pregunta suya`, detail: "Ábrela en directo y contesta. El tablero no la ha detectado: hay que ver por qué." });
    const file = registry.transcriptOf(x.conversation);
    if (!file) continue;
    for (const r of repeatedNotices(tailLines(file), Date.now() - 3 * 3600000))
      out.push({ key: `repeat|${x.conversation}|${r.at}`, kind: "repeat", conversation: x.conversation, name, title: `«${name}» ha recibido dos veces el mismo aviso en menos de ${REPEAT_MIN} min`, detail: r.notice.slice(0, 300) });
  }
  for (const r of d.deliveries || [])
    if (r.status === "typing" && minutesSince(r.at) >= TYPING_MIN)
      out.push({ key: `typing|${r.id}`, kind: "typing", conversation: r.conversation, name: r.area || r.role, title: `El envío ${r.id} a «${r.area || r.role}» lleva ${Math.round(minutesSince(r.at))} min a medio escribir`, detail: `${r.kind}: ${(r.ids || []).join(", ")}` });
  return out;
}

function boardNotice(f) {
  return `Aviso del tablero: el vigilante ha visto un fallo del tablero. ${f.title}. ${f.detail} Revisa la causa en el código del tablero y arréglala; si no es un fallo del tablero, cuéntaselo a Alberto.`;
}

function apply(found) {
  const fresh = [];
  mutate((d) => {
    const prev = new Map(((d.watchdog && d.watchdog.alerts) || []).map((a) => [a.key, a]));
    const notified = { ...((d.watchdog && d.watchdog.notified) || {}) };
    for (const [k, at] of Object.entries(notified)) if (Date.now() - new Date(at).getTime() > RENOTIFY_MS) delete notified[k];
    const alerts = found.map((f) => {
      const old = prev.get(f.key);
      const kindKey = `${f.kind}|${f.conversation || ""}`;
      if (!old && !notified[kindKey]) {
        notified[kindKey] = now();
        fresh.push(f);
      }
      return { ...f, at: old ? old.at : now(), seenAt: now() };
    });
    d.watchdog = { alerts, notified, checkedAt: now() };
  });
  return fresh;
}

function tick() {
  if (!require("../cluster/cluster").isPrimary()) return;
  const s = require("../server/state").state();
  const fresh = apply(findings(s, load()));
  for (const f of fresh) {
    require("../server/push")
      .sendPush("watchdog", true, f.title)
      .catch(() => {});
    require("./mailman").notifyRole("board", boardNotice(f));
  }
}

function forPage(d) {
  return ((d.watchdog && d.watchdog.alerts) || []).map(({ kind, conversation, name, title, detail, at }) => ({ kind, conversation, name, title, detail, at }));
}

module.exports = { tick, forPage, findings, repeatedNotices, apply };
