const fs = require("fs");
const path = require("path");

const SCHEMA = 2;

const TASK_STATUS = { pendiente: "pending", aprobada: "approved", enviada: "sent", duda: "waiting", "a-medias": "partial", hecha: "done", ignorada: "ignored" };
const TASK_KIND = { nueva: "new", devuelta: "returned", comentario: "comment", reenvio: "resend" };
const APPROVED_VIA = { tablero: "board", chat: "chat", regla: "rule", manual: "manual" };
const NOTICE_TYPE = { hecha: "done", "a-medias": "partial", pregunta: "question", comentario: "comment", respuesta: "answer" };
const DEPLOY_ENV = { develop: "develop", produccion: "production", ambos: "both" };
const DEPLOY_STATUS = { aprobada: "approved", enviada: "sent", cancelada: "cancelled" };
const ERROR_STATE = { propuesto: "proposed", aprobado: "approved", enviado: "sent", descartado: "discarded" };
const TIDY_STATUS = { aprobada: "approved", "en-curso": "in-progress", hecha: "done" };
const MESSAGE_TO = { reporte: "reporter", orquestador: "orchestrator" };
const CAUSE = { escrita: "written", nueva: "new" };
const PERSON_ENV = { beta: "beta", produccion: "production" };

const tr = (map, v) => (v != null && map[v] !== undefined ? map[v] : v);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function rename(o, keys) {
  if (!o || typeof o !== "object") return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) out[keys[k] || k] = v;
  return out;
}

function task(t) {
  const x = rename(t, {
    replyAnterior: "previousReply",
    vueltas: "rounds",
    eventos: "events",
    cambios: "changes",
    adjuntos: "attachments",
    aviso: "notice",
    historial: "history",
    respuesta: "answer",
    retirada: "withdrawn",
    jiraListo: "jiraClosedAt",
    revisada: "reviewedAt",
    comentarioPublicado: "publishedComment",
  });
  x.status = tr(TASK_STATUS, x.status);
  x.kind = tr(TASK_KIND, x.kind);
  x.approvedVia = tr(APPROVED_VIA, x.approvedVia);
  if (x.notice) x.notice = clean({ type: tr(NOTICE_TYPE, x.notice.tipo || x.notice.type), text: x.notice.text, at: x.notice.at });
  if (x.history) x.history = x.history.map((h) => clean({ type: tr(NOTICE_TYPE, h.tipo || h.type), text: h.text, at: h.at }));
  if (x.answer) x.answer = clean({ text: x.answer.text, at: x.answer.at, delivered: x.answer.entregada ?? x.answer.delivered, deliveredAt: x.answer.entregadaAt ?? x.answer.deliveredAt });
  if (x.withdrawn) x.withdrawn = clean({ by: x.withdrawn.por ?? x.withdrawn.by, at: x.withdrawn.at });
  if (x.publishedComment) x.publishedComment = clean({ at: x.publishedComment.at, text: x.publishedComment.texto ?? x.publishedComment.text });
  return clean(x);
}

function migrateDocument(d) {
  if (d.schema === SCHEMA) return false;
  const n = {};
  n.schema = SCHEMA;
  n.tasks = Object.fromEntries(Object.entries(d.tasks || {}).map(([k, t]) => [k, task(t)]));
  n.aliases = d.aliases || {};
  n.refs = d.refs || {};
  n.sessions = d.sessions ? { list: (d.sessions.list || []).map((s) => clean(rename(s, { conversacion: "conversation", statusDesde: "statusSince", titulo: "title" }))), syncedAt: d.sessions.syncedAt || null } : undefined;
  n.seenEpics = d.epicsVistas || d.seenEpics;
  n.reports = (d.informes || d.reports || []).map((r) => clean(rename(r, { peticion: "request" })));
  n.refreshRequest = d.peticion ? clean(rename(d.peticion, { atendida: "handled" })) : d.refreshRequest || null;
  n.jiraEpics = d.epicsJira || d.jiraEpics;
  n.jiraEpicsAt = d.epicsJiraAt || d.jiraEpicsAt;
  n.deployments = (d.despliegues || d.deployments || []).map((x) => {
    const y = rename(x, { proyectos: "projects", entorno: "environment", canceladaAt: "cancelledAt" });
    y.environment = tr(DEPLOY_ENV, y.environment);
    y.status = tr(DEPLOY_STATUS, y.status);
    y.approvedVia = tr(APPROVED_VIA, y.approvedVia);
    return clean(y);
  });
  n.followUps = (d.enric || d.followUps || []).map((r) => {
    const y = rename(r, { persona: "person", errores: "errors" });
    if (y.errors) {
      y.errors = y.errors.map((e) => {
        const z = rename(e, { texto: "text", estado: "state", resumen: "wholeSummary", resumenAt: "summaryAt" });
        z.state = tr(ERROR_STATE, z.state);
        z.approvedVia = tr(APPROVED_VIA, z.approvedVia);
        return clean(z);
      });
    }
    return clean(y);
  });
  n.followUpRequest = d.enricPeticion ? clean(rename(d.enricPeticion, { atendida: "handled", atendidaAt: "handledAt", persona: "person", despertada: "wokenUp" })) : d.followUpRequest || null;
  n.messages = (d.mensajes || d.messages || []).map((m) => {
    const y = rename(m, { para: "to", texto: "text", leido: "readAt", respuesta: "reply", respuestas: "replies", despertada: "wokenUp" });
    y.to = tr(MESSAGE_TO, y.to);
    if (y.replies) y.replies = y.replies.map((r) => clean(rename(r, { texto: "text" })));
    return clean(y);
  });
  n.lastReview = d.ultimaRevision ? clean(rename(d.ultimaRevision, { vacio: "empty", peticion: "request" })) : d.lastReview;
  n.config = d.config ? clean(rename(d.config, { autoDevueltas: "autoReturned", pausa: "paused", pausaDesde: "pausedAt" })) : undefined;
  n.deleted = d.borradas || d.deleted;
  if (d.ordenar || d.contextTidy) {
    const y = rename(d.ordenar || d.contextTidy, { empezada: "startedAt", terminada: "finishedAt", resumen: "summary" });
    y.status = tr(TIDY_STATUS, y.status);
    y.approvedVia = tr(APPROVED_VIA, y.approvedVia);
    n.contextTidy = clean(y);
  }
  n.causes = (d.causas || d.causes || []).map((c) => {
    const y = rename(c, { clave: "key", causa: "cause", nota: "note" });
    y.cause = tr(CAUSE, y.cause);
    return clean(y);
  });
  if (d.seguimiento || d.followUp) {
    const people = (d.seguimiento ? d.seguimiento.personas : d.followUp.people) || [];
    n.followUp = {
      people: people.map((p) => {
        const y = rename(p, { nombre: "name", entorno: "environment", cadaHora: "hourly", cuentas: "accounts", cuentasAt: "accountsAt" });
        y.environment = tr(PERSON_ENV, y.environment);
        return clean(y);
      }),
    };
  }
  n.learningRead = d.aprendizajeLeido ? clean(rename(d.aprendizajeLeido, { fallos: "failures" })) : d.learningRead;
  for (const k of Object.keys(d)) delete d[k];
  Object.assign(d, clean(n));
  return true;
}

function migrateRoutes(r) {
  const role = (x) => (x ? clean(rename(x, { sesion: "session", desde: "since", conversacion: "conversation", titulo: "title" })) : undefined);
  const areas = {};
  for (const [id, a] of Object.entries(r.areas || {})) areas[id] = clean(rename(a, { titulo: "title", epicas: "epics", sesion: "session", desde: "since", conversacion: "conversation" }));
  return clean({ reporter: role(r.reporte || r.reporter), orchestrator: role(r.orquestador || r.orchestrator), followUp: role(r.enric || r.followUp), deployer: r.despliegue || r.deployer, areas });
}

const LEGACY_FILES = {
  "tablero.db": "board.db",
  "tablero.db-wal": "board.db-wal",
  "tablero.db-shm": "board.db-shm",
  "jira-vistos.json": "jira-seen.json",
  "jira-por-contar.json": "jira-to-count.json",
  "push-ultimo": "push-last.json",
  "arranque.log": "startup.log",
  "tablero-hosts.txt": "board-hosts.txt",
  "cuota.json": "quota.json",
  "tablero-data.json.migrado": "legacy-board-data.json",
};

function migrateDataDir(workspace) {
  const dataDir = path.join(workspace, "data");
  const legacyDir = path.join(workspace, "datos");
  if (!fs.existsSync(dataDir) && fs.existsSync(legacyDir)) fs.renameSync(legacyDir, dataDir);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  for (const [from, to] of Object.entries(LEGACY_FILES)) {
    const a = path.join(dataDir, from);
    const b = path.join(dataDir, to);
    if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b);
  }
  for (const stale of ["latido-orquestador", "latido-reporte", "arranque.lock"]) {
    try {
      fs.unlinkSync(path.join(dataDir, stale));
    } catch (e) {}
  }
  const oldRoutes = path.join(dataDir, "sesiones.json");
  const newRoutes = path.join(dataDir, "sessions.json");
  if (fs.existsSync(oldRoutes) && !fs.existsSync(newRoutes)) {
    fs.writeFileSync(newRoutes, JSON.stringify(migrateRoutes(JSON.parse(fs.readFileSync(oldRoutes, "utf8"))), null, 2) + "\n");
    fs.renameSync(oldRoutes, `${oldRoutes}.migrated`);
  }
  return dataDir;
}

function migrateLearningTable(db) {
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'aprendizaje_tickets'").get();
  if (!old) return;
  db.exec("CREATE TABLE IF NOT EXISTS learning_tickets (key TEXT PRIMARY KEY, epic TEXT, epic_name TEXT, events TEXT NOT NULL)");
  const put = db.prepare("INSERT OR REPLACE INTO learning_tickets VALUES (?, ?, ?, ?)");
  for (const r of db.prepare("SELECT clave, epic, epic_nombre, eventos FROM aprendizaje_tickets").all()) {
    const e = JSON.parse(r.eventos);
    put.run(r.clave, r.epic, r.epic_nombre, JSON.stringify({ deliveries: e.entregas || [], returns: e.devoluciones || [], reviewerComments: e.comentariosEnric || [] }));
  }
  db.exec("DROP TABLE aprendizaje_tickets");
  db.exec("DROP TABLE IF EXISTS consumo");
  db.exec("DROP TABLE IF EXISTS consumo_ficheros");
}

module.exports = { SCHEMA, migrateDocument, migrateRoutes, migrateDataDir, migrateLearningTable, TASK_STATUS, NOTICE_TYPE, CAUSE, DEPLOY_ENV, TASK_KIND, APPROVED_VIA };
