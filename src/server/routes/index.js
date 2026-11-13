const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../../core/data");
const { pushReason, pushKeys, handlePush } = require("../push");
const { state, openIfClosed } = require("../state");
const mailman = require("../../features/mailman");
const tasks = require("./tasks");
const sessions = require("./sessions");
const operations = require("./operations");
const { handlePeople } = require("../../features/follow-up");
const learning = require("../../jira/learning");
const voice = require("../../features/voice");
const speech = require("../../features/speech");
const deployStatus = require("../../features/deploy-status");
const sentry = require("../../features/sentry");
const devservers = require("../../features/devservers");
const permissions = require("../../sessions/permissions");
const host = require("../../sessions/host");
const cluster = require("../../cluster/cluster");
const { serveBody } = require("../http");

const POST_ROUTES = {
  "/api/claude-token/setup": (res, input, send) =>
    require("../../features/claude-token")
      .handleSetup(input)
      .then((r) => send(res, 200, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) })),
  "/api/cluster/claude-token": (res, { token }, send) => {
    try {
      const expires = require("../../features/claude-token").importToken(token);
      send(res, 200, { expires });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  },
  "/api/task": (res, input, send) => tasks.handleTask(res, input, send),
  "/api/task/new": (res, input, send) => tasks.handleNewTask(res, input, send),
  "/api/projects-admin/save": (res, input, send) => {
    const r = require("../../features/projects-admin").save(input || {});
    send(res, r.error ? 400 : 200, r);
  },
  "/api/projects-admin/remove": (res, { id }, send) => {
    const r = require("../../features/projects-admin").remove(String(id || ""));
    send(res, r.error ? 400 : 200, r);
  },
  "/api/projects-admin/credentials": (res, { id, values }, send) => {
    const r = require("../../features/projects-admin").setCredentials(String(id || ""), values || {});
    send(res, r.error ? 400 : 200, r);
  },
  "/api/batch": (res, input, send) => tasks.handleBatch(res, input, send),
  "/api/delete": (res, input, send) => tasks.handleDelete(res, input, send),
  "/api/answer": (res, input, send) => tasks.handleAnswer(res, input, send),
  "/api/reviewed": (res, input, send) => tasks.handleReviewed(res, input, send),
  "/api/reviewed-all": (res, input, send) => tasks.handleReviewedAll(res, input, send),
  "/api/comment": (res, input, send) => tasks.handleComment(res, input, send),
  "/api/config": (res, input, send) => tasks.handleConfig(res, input, send),
  "/api/refresh": (res, input, send) => tasks.handleRefresh(res, send),
  "/api/search": (res, input, send) => tasks.handleSearch(res, input, send),
  "/api/import": (res, input, send) => tasks.handleImport(res, input, send),
  "/api/ticket": (res, input, send) => tasks.handleTicket(res, input, send),
  "/api/session": (res, input, send) => sessions.handleSession(res, input, send),
  "/api/reminder": (res, input, send) => {
    const reminders = require("../../features/reminders");
    if (input && input.remove) {
      const error = reminders.remove(input.remove);
      return error ? send(res, 400, { error }) : send(res, 200);
    }
    const r = reminders.add(input || {});
    return r.error ? send(res, 400, { error: r.error }) : send(res, 200, r);
  },
  "/api/new-session": (res, input, send) => sessions.handleNewSession(res, input, send),
  "/api/epic": (res, input, send) => sessions.handleEpic(res, input, send),
  "/api/deploy": (res, input, send) => operations.handleDeploy(res, input, send),
  "/api/deploy-status/refresh": (res, input, send) => deployStatus.handleDeployStatusRefresh(res, send),
  "/api/tidy": (res, input, send) => operations.handleTidy(res, send, input || {}),
  "/api/message": (res, input, send) => operations.handleMessage(res, input, send),
  "/api/followup-error": (res, input, send) => operations.handleFollowUpError(res, input, send),
  "/api/followup-request": (res, input, send) => operations.handleFollowUpRequest(res, input, send),
  "/api/restriction": (res, input, send) => tasks.handleRestriction(res, input, send),
  "/api/delivery/retry": (res, input, send) => send(res, mailman.retry(input || {}) ? 200 : 409, {}),
  "/api/people": (res, input, send) => handlePeople(res, input, send),
  "/api/layout-report": (res, input, send) => {
    fs.writeFileSync(path.join(DATA_DIR, "layout-report.json"), JSON.stringify({ at: new Date().toISOString(), ...input }, null, 1).slice(0, 8000));
    send(res, 200);
  },
  "/api/term-claim": (res, input, send) => {
    require("../../core/logfile").appendLog(path.join(DATA_DIR, "term-claims.log"), `${new Date().toISOString()} ${String(input.conversation || "").slice(0, 8)} ${input.why} ${input.from} -> ${input.cols}x${input.rows} ${String(input.device || "").slice(0, 120)}
`);
    send(res, 200);
  },
  "/api/page-errors": (res, input, send) => {
    fs.writeFileSync(path.join(DATA_DIR, "page-errors.json"), JSON.stringify({ at: new Date().toISOString(), ...input }, null, 1).slice(0, 20000));
    send(res, 200);
  },
  "/api/audio-report": (res, input, send) => {
    fs.writeFileSync(path.join(DATA_DIR, "audio-report.json"), JSON.stringify({ at: new Date().toISOString(), ...input }, null, 1).slice(0, 20000));
    send(res, 200);
  },
  "/api/sentry/send": (res, { issues, area }, send) => {
    if (!Array.isArray(issues) || !issues.length || !area) return send(res, 400, { error: "faltan los errores o la sesión" });
    const held = require("../../features/holds").checkArea(require("../../core/data").load(), "Esa sesión", String(area));
    if (held) return send(res, 409, { error: held });
    const n = sentry.sendIssues(issues.slice(0, 50), String(area));
    if (n) {
      openIfClosed(String(area));
      mailman.kick();
    }
    send(res, 200, { sent: n });
  },
  "/api/cluster/yield": (res, input, send) => {
    cluster
      .handleYield(input)
      .catch(() => {})
      .then(() => send(res, 200));
  },
  "/api/cluster/take": (res, input, send) =>
    cluster
      .takeHere()
      .then((r) => send(res, r.ok ? 200 : 409, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) })),
  "/api/cluster/auto": (res, input, send) => send(res, 200, cluster.backToAuto()),
  "/api/cluster/command": (res, { target, action }, send) =>
    cluster
      .command(target, action)
      .then((r) => send(res, r.ok ? 200 : 409, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) })),
  "/api/host/respawned": (res, { conversation }, send) => {
    send(res, 200);
    if (!require("../../cluster/cluster").isPrimary()) return;
    const r = require("../../sessions/registry").loadRoutes();
    const s = state();
    const is = (role) => r[role] && r[role].conversation === conversation;
    const { wakeSession, STARTUP_NOTICE } = require("../../sessions/registry");
    if (is("orchestrator") && s.orchestrator) return mailman.notifyRole("orchestrator", require("../state").ORCHESTRATOR_NOTICE);
    if (is("reporter") && s.reporterStatus) return wakeSession(s.reporterStatus.session, STARTUP_NOTICE).catch(() => {});
    if (is("board") && s.boardStatus) return wakeSession(s.boardStatus.session, "Aviso del tablero: arranca la sesión del tablero. Eres la sesión del tablero registrada: ejecuta ahora .claude/commands/tablero.md (regla de AGENTS.md).").catch(() => {});
    if (is("followUp")) return require("../startup").wakeFollowUp().catch(() => {});
  },
  "/api/session-profile": (res, { conversation, name, model, effort }, send) => {
    if (!/^[0-9a-f-]{36}$/.test(String(conversation || ""))) return send(res, 400, { error: "conversación no válida" });
    let profile;
    try {
      profile = require("../../sessions/profiles").setOverride(conversation, { model, effort });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    (async () => {
      const list = await host.hostRequest("GET", "/sessions").catch(() => []);
      const live = (list || []).find((x) => x.conversation === conversation && x.running);
      if (!live) return { profile, restarted: false };
      await host.hostRequest("POST", "/stop", { conversation });
      await host.hostRequest("POST", "/start", { conversation, name: live.name || name });
      return { profile, restarted: true };
    })()
      .then((r) => send(res, 200, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/host/action": (res, { action, conversation, name }, send) => {
    if (!/^[0-9a-f-]{36}$/.test(String(conversation || ""))) return send(res, 400, { error: "conversación no válida" });
    const go = async () => {
      await host.ensureHost();
      if (action === "move") {
        if (host.vsCodeHas(conversation)) {
          host.markWaiting(conversation, name);
          return { waiting: true };
        }
        const isRole = ["reporter", "orchestrator", "followUp", "board"].some((k) => { const r = require("../../sessions/registry").loadRoutes()[k]; return r && r.conversation === conversation; });
        if (!isRole) {
          host.adopt(conversation, name);
          return { adopted: true };
        }
        return host.hostRequest("POST", "/start", { conversation, name });
      }
      if (action === "back") {
        await host.hostRequest("POST", "/release", { conversation });
        require("../../sessions/registry").openInVsCode(conversation);
        return { ok: true };
      }
      if (action === "open") return host.hostRequest("POST", "/start", { conversation, name });
      if (action === "sleep") {
        await host.hostRequest("POST", "/stop", { conversation });
        host.adopt(conversation, name);
        host.markOnDemand(conversation);
        return { ok: true };
      }
      if (action === "restart") {
        await host.hostRequest("POST", "/stop", { conversation });
        await new Promise((r) => setTimeout(r, 1500));
        return host.hostRequest("POST", "/start", { conversation, name });
      }
      throw new Error("acción desconocida");
    };
    go()
      .then((r) => send(res, 200, r))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/permission/check": (res, input, send) => send(res, 200, permissions.check(input)),
  "/api/permission/decide": (res, { id, decision, reason }, send) => {
    const ok = permissions.decide(String(id), decision, reason);
    if (!ok) return send(res, 409);
    const p = (require("../../core/data").load().permissions || []).find((x) => x.id === String(id));
    if (p && p.native) host.hostRequest("POST", "/input", { conversation: p.conversation, data: decision === "deny" ? "\x1b" : "1" }).catch(() => {});
    send(res, 200);
  },
  "/api/host/prompt": (res, input, send) => {
    const id = permissions.nativePrompt(input || {});
    if (id) require("../push").sendPush("permission", true, `${input.name || "Una sesión"} pide permiso: ${String(input.question || "").slice(0, 80)}`).catch(() => {});
    send(res, 200);
  },
  "/api/host/stuck": (res, input, send) => {
    if (require("../../features/stuck").report(input || {})) require("../push").sendPush("permission", true, `${input.name || "Una sesión"} está parada en una pregunta al arrancar: ábrela para contestarla.`).catch(() => {});
    send(res, 200);
  },
  "/api/permission/rule-remove": (res, { key }, send) => send(res, permissions.removeRule(String(key)) ? 200 : 404),
  "/api/mac-power": (res, { wake, sleep, weeklyOff }, send) => {
    const ok = (t) => !t || /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    if (!ok(wake) || !ok(sleep)) return send(res, 400, { error: "hora no válida (HH:MM)" });
    send(res, 200, { schedule: require("../../features/mac-power").setSchedule({ wake, sleep, weeklyOff: typeof weeklyOff === "boolean" ? weeklyOff : undefined }) });
  },
  "/api/work-hours": (res, { start, end, daily }, send) => {
    const r = require("../../core/hours").setSchedule({ start, end, daily });
    if (r.error) return send(res, 400, { error: r.error });
    send(res, 200, r);
  },
  "/api/overtime": (res, { on }, send) => {
    require("../startup")
      .setOvertime(!!on)
      .then((overtime) => send(res, 200, { overtime }))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/devservers": (res, { action, id, project, on }, send) => {
    const run = { autoProject: async () => devservers.setAutoProject(project, on), start: () => devservers.start(id), stop: () => devservers.stop(id), restart: () => devservers.restart(id), startAll: () => devservers.startAll(false, project || null), stopAll: () => devservers.stopAll(project || null) }[action];
    if (!run) return send(res, 400, { error: "acción desconocida" });
    run()
      .then((r) => send(res, 200, { result: r }))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/tunnel": (res, { action }, send) => {
    const tunnel = require("../../features/tunnel");
    const run = { open: tunnel.open, close: async () => tunnel.close() }[action];
    if (!run) return send(res, 400, { error: "acción desconocida" });
    run()
      .then((t) => send(res, 200, t))
      .catch((e) => send(res, 500, { error: String(e.message || e) }));
  },
  "/api/sentry/status": (res, { issueId, id, status }, send) => {
    sentry
      .setStatus(issueId, String(id || ""), status)
      .then(() => send(res, 200))
      .catch((e) => send(res, 502, { error: String(e.message || e) }));
  },
  "/api/sentry/discard": (res, { id }, send) => send(res, sentry.discard(String(id)) ? 200 : 409),
  "/api/learning-read": (res, input, send) => send(res, 200, { started: learning.startReading() }),
  "/api/push/subscribe": (res, input, send) => handlePush(res, "/api/push/subscribe", input, send),
  "/api/push/unsubscribe": (res, input, send) => handlePush(res, "/api/push/unsubscribe", input, send),
  "/api/push/test": (res, input, send) => handlePush(res, "/api/push/test", input, send),
};

function handleGet(req, res, url) {
  if (url === "/api/claude-token/setup") return serveBody(res, "application/json", JSON.stringify(require("../../features/claude-token").jobStatus()));
  if (url === "/api/push/reason") return serveBody(res, "application/json", JSON.stringify(pushReason()));
  if (url === "/api/push/key") return serveBody(res, "application/json", JSON.stringify({ key: pushKeys().publicKey }));
  if (url.startsWith("/api/permission/perm-")) return serveBody(res, "application/json", JSON.stringify(permissions.poll(url.slice("/api/permission/".length))));
  if (url === "/api/cluster/quota") return serveBody(res, "application/json", JSON.stringify(require("../../features/quota").readQuota()));
  if (url === "/api/cluster/memory") return serveBody(res, "application/json", JSON.stringify(require("../../features/memory-sync").snapshot()));
  if (url.startsWith("/api/cluster/memory/")) {
    const snap = require("../../features/memory-sync").projectSnapshot(decodeURIComponent(url.slice("/api/cluster/memory/".length)));
    if (!snap) return res.writeHead(404).end();
    return serveBody(res, "application/json", JSON.stringify(snap));
  }
  if (url === "/api/projects-admin") return serveBody(res, "application/json", JSON.stringify(require("../../features/projects-admin").list()));
  if (url === "/api/cluster") return serveBody(res, "application/json", JSON.stringify(require("../../cluster/cluster").info()));
  if (url === "/api/cluster/snapshot") return serveBody(res, "application/json", JSON.stringify(require("../../cluster/cluster").snapshot()));
  if (url === "/api/cluster/machines") {
    cluster
      .machines()
      .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
      .catch((e) => serveBody(res, "application/json", JSON.stringify({ error: String(e.message || e) })));
    return true;
  }
  if (url === "/api/cluster/transcripts") return serveBody(res, "application/json", JSON.stringify(cluster.transcripts()));
  if (url.startsWith("/api/cluster/transcript/")) {
    const part = cluster.serveTranscript(url.slice("/api/cluster/transcript/".length), Number(new URLSearchParams(req.url.split("?")[1] || "").get("from")) || 0);
    if (!part) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-tail-hash": part.tail });
    return res.end(part.body);
  }
  if (url === "/api/host/sessions") {
    host
      .hostRequest("GET", "/sessions")
      .then((v) => serveBody(res, "application/json", JSON.stringify({ up: true, sessions: v, hosted: host.readConfig() })))
      .catch(() => serveBody(res, "application/json", JSON.stringify({ up: false, sessions: [], hosted: host.readConfig() })));
    return true;
  }
  if (url === "/api/tunnel") {
    const tunnel = require("../../features/tunnel");
    tunnel
      .remote()
      .then((remote) => serveBody(res, "application/json", JSON.stringify({ ...tunnel.status(), remote })))
      .catch((e) => serveBody(res, "application/json", JSON.stringify({ ...tunnel.status(), remote: null, error: String(e.message || e) })));
    return true;
  }
  if (url === "/api/devservers") {
    devservers
      .status()
      .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
      .catch((e) => serveBody(res, "application/json", JSON.stringify({ servers: [], error: String(e.message || e) })));
    return true;
  }
  if (url === "/api/sentry" || url === "/api/sentry?force=1") {
    sentry
      .listIssues(url.endsWith("force=1"))
      .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
      .catch((e) => serveBody(res, "application/json", JSON.stringify({ available: true, issues: [], errors: [String(e.message || e)] })));
    return true;
  }
  if (url === "/api/files") {
    require("../../features/files")
      .searchFiles(new URLSearchParams(req.url.split("?")[1] || "").get("q"))
      .then((v) => serveBody(res, "application/json", JSON.stringify(v)))
      .catch(() => serveBody(res, "application/json", "[]"));
    return true;
  }
  if (url === "/api/learning") return serveBody(res, "application/json", JSON.stringify(learning.learningSummary()));
  if (url === "/api/state") {
    const body = JSON.stringify({ ...state(), voice: voice.voiceAvailable(), speech: speech.speechAvailable(), deployStatus: deployStatus.readStatus(), reviewJob: tasks.reviewJobState() });
    const hash = require("crypto").createHash("sha1").update(body.replace(/"syncedAt":"[^"]*"/g, "")).digest("hex");
    if (req.headers["x-state-hash"] === hash) return res.writeHead(204, { "x-state-hash": hash, "cache-control": "no-store" }).end();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-state-hash": hash });
    return res.end(body);
  }
  if (url.startsWith("/api/voice/")) {
    voice.serveVoice(res, url);
    return true;
  }
  if (url.startsWith("/api/speech/")) {
    speech.serveSpeech(res, url);
    return true;
  }
  return false;
}

module.exports = { POST_ROUTES, handleGet };
