const { now, mutate } = require("./data");
const { titleKey, liveSessions, loadRoutes, changeRoutes, renameArea, sessionsCli, realArea, openInVsCode, createConversation } = require("./sessions");

const areaKey = (r, name) => Object.keys(r.areas).find((k) => titleKey(r.areas[k].title) === titleKey(name)) || titleKey(name) || "session-" + Date.now();

function handleSession(res, { name, ref, alias, area, title, areaId, conversation, remove }, send) {
  if (!name || typeof name !== "string") return send(res, 400, { error: "falta la sesión" });
  if (remove) {
    const error = changeRoutes((r) => {
      const x = r.areas[areaId];
      if (!x) return "sesión desconocida";
      if (Object.keys(x.epics || {}).length) return "quítale antes sus epics";
      if (r.deployer === areaId) return "es la sesión que despliega";
      delete r.areas[areaId];
      return "";
    });
    return error ? send(res, 400, { error }) : send(res, 200);
  }
  const release = (r) => {
    for (const a of Object.values(r.areas)) {
      if (conversation ? a.conversation === conversation : a.session === name) Object.assign(a, { session: null, ref: null, since: null, conversation: null });
    }
  };
  const link = { session: name, ref: ref || null, since: now(), conversation: conversation || null };
  if (title !== undefined) {
    const clean = String(title).trim().slice(0, 60);
    if (!clean) return send(res, 400, { error: "el nombre no puede quedar vacío" });
    if (areaId) {
      if (!renameArea(areaId, clean)) return send(res, 400, { error: "sesión desconocida" });
    } else {
      changeRoutes((r) => {
        const k = areaKey(r, clean);
        release(r);
        r.areas[k] = Object.assign({ title: clean, epics: {} }, r.areas[k], link);
      });
    }
    return send(res, 200);
  }
  if (alias !== undefined) {
    mutate((d) => {
      const id = ref || name;
      if (alias) d.aliases[id] = String(alias).slice(0, 60);
      else delete d.aliases[id];
    });
  }
  if (area !== undefined) {
    if (area === "") {
      changeRoutes(release);
    } else {
      const ok = changeRoutes((r) => {
        if (!r.areas[area]) return false;
        release(r);
        Object.assign(r.areas[area], link);
        return true;
      });
      if (!ok) return send(res, 400, { error: "sesión desconocida" });
    }
  }
  send(res, 200);
}

function linkNew(res, { clean, epicKey, epicName, created }, send) {
  const before = new Set((liveSessions() || []).map((s) => s.conversation));
  openInVsCode(created);
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    const found = (liveSessions() || []).find((s) => (created ? s.conversation === created : !before.has(s.conversation)));
    if (!found && attempts < 10) return;
    clearInterval(timer);
    const area = changeRoutes((r) => {
      const k = areaKey(r, clean);
      const link = found ? { session: found.name, ref: null, since: now(), conversation: found.conversation } : created ? { conversation: created } : {};
      r.areas[k] = Object.assign({ title: clean, epics: {} }, r.areas[k], link);
      r.areas[k].epics = r.areas[k].epics || {};
      if (epicKey) {
        for (const a of Object.values(r.areas)) if (a.epics) delete a.epics[epicKey];
        r.areas[k].epics[epicKey] = epicName || epicKey;
      }
      return k;
    });
    send(res, 200, { area, open: !!found, window: found ? found.name : null, named: !!created });
  }, 2000);
}

function handleNewSession(res, { title, epicKey, epicName }, send) {
  const clean = String(title || "").trim().slice(0, 60);
  if (!clean) return send(res, 400, { error: "falta el nombre" });
  createConversation(clean).then((created) => linkNew(res, { clean, epicKey, epicName, created }, send));
}

function handleEpic(res, { key, name, area }, send) {
  if (!key || typeof key !== "string") return send(res, 400, { error: "falta la épica" });
  if (area === "") sessionsCli("unroute", key);
  else {
    const id = realArea(area);
    if (!id || !loadRoutes().areas[id]) return send(res, 400, { error: "sesión desconocida" });
    sessionsCli("route", key, id, name || key);
  }
  send(res, 200);
}

module.exports = { handleSession, handleNewSession, handleEpic };
