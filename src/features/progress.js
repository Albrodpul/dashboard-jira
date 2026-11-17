const fs = require("fs");
const path = require("path");

const TAIL_BYTES = 768 * 1024;
const PHASES = [
  { id: "queued", label: "Por enviar" },
  { id: "received", label: "Recibida" },
  { id: "working", label: "Trabajando" },
  { id: "review", label: "Revisando" },
  { id: "done", label: "Hecha" },
];
const RANK = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));
const cache = new Map();

const base = (p) => path.basename(String(p || "").replace(/\\/g, "/"));
const short = (s, n = 70) => {
  const x = String(s || "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

function describe(name, input = {}) {
  const cmd = String(input.command || "");
  if (/board\.js["']?\s+(done|partial|question)\b/.test(cmd)) return { text: "Avisando al tablero de cómo ha quedado", phase: "working" };
  if (/board\.js["']?\s+sent\b|board\.js["']?\s+reply\b/.test(cmd)) return { text: "Confirmando que la ha recibido", phase: "received" };
  switch (name) {
    case "Read":
      return { text: `Leyendo ${base(input.file_path)}`, phase: "working" };
    case "Edit":
    case "MultiEdit":
      return { text: `Editando ${base(input.file_path)}`, phase: "working" };
    case "Write":
      return { text: `Escribiendo ${base(input.file_path)}`, phase: "working" };
    case "NotebookEdit":
      return { text: `Editando ${base(input.notebook_path)}`, phase: "working" };
    case "Grep":
    case "Glob":
      return { text: "Buscando en el código", phase: "working" };
    case "Agent":
    case "Task": {
      const what = `${input.description || ""} ${input.subagent_type || ""} ${String(input.prompt || "").slice(0, 200)}`;
      return /revis|review/i.test(what) ? { text: `Revisando con un agente: ${short(input.description, 50)}`, phase: "review" } : { text: `Con un agente: ${short(input.description, 50)}`, phase: "working" };
    }
    case "SendMessage":
      return { text: "Hablando con un agente", phase: "working" };
    case "Skill":
      return { text: input.skill ? `Usando /${input.skill}` : "Usando un comando", phase: "working" };
    case "Monitor":
    case "TaskOutput":
      return { text: "Esperando a un proceso", phase: "working" };
    case "AskUserQuestion":
      return { text: "Preguntándote algo", phase: "working" };
    case "WebFetch":
    case "WebSearch":
      return { text: "Consultando la web", phase: "working" };
    case "Bash":
    case "PowerShell":
      return { text: input.description ? short(input.description) : "Ejecutando un comando", phase: "working" };
    default:
      if (/^mcp__.*browser|Browser/i.test(name)) return { text: "Probando en el navegador", phase: "working" };
      if (/update_plan|wrap_up|TodoWrite|ToolSearch|TaskStop|ListAgents|ScheduleWakeup/.test(name)) return null;
      return { text: `Usando ${name.replace(/^mcp__[^_]+__/, "")}`, phase: "working" };
  }
}

function readTail(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size) return hit.actions;
  const start = Math.max(0, st.size - TAIL_BYTES);
  const buf = Buffer.alloc(st.size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  const actions = [];
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (j.type !== "assistant" || j.isSidechain) continue;
    for (const c of (j.message && j.message.content) || []) {
      if (c.type !== "tool_use") continue;
      const d = describe(c.name, c.input || {});
      if (d) actions.push({ at: j.timestamp, ...d });
    }
  }
  cache.set(file, { size: st.size, actions });
  return actions;
}

function typical(tasks) {
  const mins = tasks
    .map((t) => {
      // The session's own working time: until it first said done or half done, not while it waited for you.
      const first = (t.history || []).filter((h) => ["done", "partial"].includes(h.type) && t.sentAt && h.at >= t.sentAt).map((h) => h.at).sort()[0];
      const end = first || (t.status === "done" && t.notice && t.notice.at);
      return t.sentAt && end ? (Date.parse(end) - Date.parse(t.sentAt)) / 60000 : NaN;
    })
    .filter((m) => m >= 0.5 && m <= 240)
    .sort((a, b) => a - b);
  if (mins.length < 3) return null;
  const at = (q) => mins[Math.min(mins.length - 1, Math.floor(q * mins.length))];
  return { low: Math.max(1, Math.round(at(0.25))), high: Math.max(2, Math.round(at(0.75))), samples: mins.length };
}

function forTasks(tasks, conversationOfArea, transcriptOf) {
  const band = typical(tasks);
  const out = {};
  for (const t of tasks) {
    if (!["approved", "sent", "waiting", "partial", "done"].includes(t.status)) continue;
    let phase = { approved: "queued", sent: "received", waiting: "working", partial: "working", done: "done" }[t.status];
    let action = null;
    const conversation = t.area ? conversationOfArea(t.area) : null;
    const file = conversation && t.sentAt && !["approved", "done"].includes(t.status) ? transcriptOf(conversation) : null;
    const actions = file ? readTail(file) || [] : [];
    const since = t.sentAt ? Date.parse(t.sentAt) : 0;
    const end = t.status === "done" ? Date.parse((t.notice && t.notice.at) || "") || Infinity : Infinity;
    const mine = actions.filter((a) => {
      const ms = Date.parse(a.at);
      return ms >= since && ms <= end + 5000;
    });
    if (t.status === "sent") {
      for (const a of mine) if (a.phase !== "received" && RANK[a.phase] > RANK[phase]) phase = a.phase;
      if (phase === "received" && mine.some((a) => a.phase === "working")) phase = "working";
    }
    if (mine.length && t.status !== "done") action = { text: mine[mine.length - 1].text, at: mine[mine.length - 1].at };
    out[t.key] = { phase, step: RANK[phase], of: PHASES.length - 1, action, since: t.sentAt || t.decidedAt || null, typical: band, paused: ["waiting", "partial"].includes(t.status) };
  }
  return out;
}

module.exports = { PHASES, describe, forTasks, typical, readTail };
