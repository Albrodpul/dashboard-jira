import { state, h, when, minutesSince, toast, request, post, refresh, renderMd, reviewer } from "./base.js";

let historyOpen = false;
let paintedReport = "";

export function renderReport() {
  const box = document.getElementById("report-body");
  const reports = state.reports || [];
  const last = state.lastReview || null;
  const req = state.refreshRequest && !state.refreshRequest.handled ? state.refreshRequest : null;
  if (!reports.length && !req && !last) {
    box.hidden = true;
    paintedReport = "";
    return;
  }
  const slow = req ? minutesSince(req.at) >= 3 : false;
  const fingerprint = JSON.stringify([reports, last, req, slow]);
  if (fingerprint === paintedReport) return;
  paintedReport = fingerprint;
  box.hidden = false;
  box.textContent = "";
  if (req) box.appendChild(h("div", { class: "pending-note", text: `Reporte pedido a las ${when(req.at)}. ${slow ? "Tarda más de lo normal: la sesión de reporte puede estar ocupada o cerrada." : "Se está preparando."}` }));
  if (!reports.length) return;
  const noChanges = last && last.empty && new Date(last.at) > new Date(reports[0].at);
  if (noChanges) box.appendChild(h("div", { class: "jira-head", text: "Lo último que pasó en Jira:" }));
  box.appendChild(renderMd(reports[0].text));
  const older = reports.slice(1);
  if (!older.length) return;
  const det = h("details", {}, [h("summary", { class: "meta", text: `Reportes anteriores (${older.length})` })]);
  det.open = historyOpen;
  det.addEventListener("toggle", () => (historyOpen = det.open));
  older.forEach((x) => det.appendChild(h("div", { class: "ev" }, [h("span", { class: "t", text: when(x.at) }), renderMd(x.text)])));
  box.appendChild(det);
}

const STOP_ICON = '<rect x="6" y="6" width="12" height="12" rx="1.5"/>';
const PLAY_ICON = '<path d="M8 5.5v13l10.5-6.5z"/>';

function paintPause() {
  const btn = document.getElementById("pause");
  if (!btn) return;
  const paused = !!(state.config && state.config.paused);
  btn.className = `btn bell${paused ? " active" : ""}`;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paused ? PLAY_ICON : STOP_ICON}</svg>`;
  const txt = paused ? `Revisiones en pausa desde las ${when(state.config.pausedAt)}. Pulsa para reanudarlas.` : `Pausar las revisiones automáticas y los resúmenes de ${reviewer()} para no gastar cuota. Refrescar, Hablar y «Pedir resumen ahora» siguen funcionando.`;
  btn.title = txt;
  btn.setAttribute("aria-label", txt);
  btn.setAttribute("aria-pressed", paused ? "true" : "false");
}

export function updateStamp() {
  paintPause();
  const el = document.getElementById("stamp");
  const first = state.reports && state.reports[0];
  const u = state.lastReview || (first ? { at: first.at, empty: false } : null);
  el.textContent = "";
  if (!u) {
    el.textContent = "Todavía no hay ninguna revisión.";
    return;
  }
  const mins = minutesSince(u.at);
  el.appendChild(h("strong", { text: `Última revisión: ${when(u.at)}` }));
  const paused = !!(state.config && state.config.paused);
  el.appendChild(document.createTextNode(` · ${mins < 1 ? "hace menos de 1 min" : `hace ${mins} min`} · ${u.empty ? "sin novedades" : "con novedades"}${paused ? " · revisiones en pausa" : ""}`));
  el.style.color = mins > 8 && !paused ? "var(--back)" : "";
  const o = state.orchestrator;
  const watching = o && o.open && o.watching;
  const title = watching ? "La orquestadora está abierta y vigila: los envíos salen solos." : o && o.open ? "La orquestadora está abierta pero no vigila: los envíos esperan." : "La orquestadora está cerrada: los envíos esperan.";
  if (watching || !o) {
    el.appendChild(h("span", { class: `orch${watching ? "" : " bad"}`, title }, [h("i"), "Orquestador"]));
    return;
  }
  const wake = h("button", { type: "button", class: "orch bad wake", title: `${title} Pulsa para despertarla.` }, [h("i"), "Orquestador · despertar"]);
  wake.addEventListener("click", () => {
    wake.disabled = true;
    request("/api/wake-orchestrator")
      .then(() => toast("Despertando a la orquestadora: en un minuto vuelve a vigilar."))
      .catch(() => toast("No se pudo despertar a la orquestadora."));
  });
  el.appendChild(wake);
}

const WINDOWS = [
  ["five_hour", "5 h"],
  ["seven_day", "Semana"],
];
const fmtReset = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit" });

function resets(iso) {
  if (!iso) return "";
  const d = new Date(Math.round(new Date(iso).getTime() / 60000) * 60000);
  return d - Date.now() < 20 * 3600000 ? `se renueva a las ${when(d.toISOString())}` : `se renueva el ${fmtReset.format(d)}`;
}

export function quotaBlock() {
  const c = state.quota;
  const windows = c ? WINDOWS.filter(([k]) => c[k] && !(c[k].resetsAt && new Date(c[k].resetsAt) < new Date())) : [];
  const box = h("div", { class: "quota" }, [h("span", { class: "quota-title", text: "Plan de Claude" })]);
  if (!windows.length) {
    box.appendChild(h("span", { class: "meta", text: c ? "Ventanas recién renovadas." : "Aún sin datos." }));
    return box;
  }
  const parts = windows.map(([k, name]) => {
    const used = Math.round(c[k].used);
    const level = used >= 90 ? " high" : used >= 70 ? " medium" : "";
    return h("span", { class: `quota-item${level}`, title: resets(c[k].resetsAt) }, [`${name} `, h("b", { text: `${used} %` })]);
  });
  box.appendChild(h("span", { class: "quota-items" }, parts.flatMap((p, i) => (i ? [" · ", p] : [p]))));
  box.title = windows.map(([k, name]) => `${name}: ${resets(c[k].resetsAt)}`).join(". ") + (minutesSince(c.at) > 30 ? `. Dato de las ${when(c.at)}` : "");
  return box;
}

const BELL = '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>';

function serverKey(b64) {
  const s = (b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function paintBell(btn, active) {
  btn.className = `btn bell ${active ? "on" : "off"}`;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BELL}${active ? "" : '<path d="M3 3l18 18"/>'}</svg>`;
  const txt = active ? "Avisos activados en este dispositivo. Pulsa para desactivarlos." : "Avisos desactivados en este dispositivo. Pulsa para activarlos.";
  btn.title = txt;
  btn.setAttribute("aria-label", txt);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
}

async function toggleNotifications(btn) {
  const reg = await navigator.serviceWorker.ready;
  const current = await reg.pushManager.getSubscription();
  if (current && Notification.permission === "granted") {
    const endpoint = current.endpoint;
    await current.unsubscribe();
    await request("/api/push/unsubscribe", { endpoint });
    paintBell(btn, false);
    toast("Avisos desactivados en este dispositivo.");
    return;
  }
  if ((await Notification.requestPermission()) !== "granted") throw new Error("permission");
  const { key } = await (await fetch("/api/push/key")).json();
  const created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey(key) });
  await request("/api/push/subscribe", { subscription: created.toJSON(), device: navigator.userAgent });
  paintBell(btn, true);
  toast("Avisos activados en este dispositivo. Te llega uno de prueba.");
  await request("/api/push/test");
}

export function mountHeader() {
  document.getElementById("pause").addEventListener("click", (e) => {
    const paused = !(state.config && state.config.paused);
    e.currentTarget.disabled = true;
    post("/api/config", { paused }, paused ? "Revisiones en pausa: no se gasta cuota hasta que las reanudes." : "Revisiones reanudadas: la sesión de reporte vuelve a vigilar en un par de minutos.").then(() => (document.getElementById("pause").disabled = false));
  });
  document.getElementById("refresh").addEventListener("click", () => {
    request("/api/refresh")
      .then((r) => {
        if (!r.ok) throw new Error(r.status);
        return refresh(true);
      })
      .catch(() => toast("No se pudo pedir el reporte."));
  });
  setInterval(updateStamp, 30000);

  const btn = document.getElementById("notifications");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  btn.hidden = false;
  paintBell(btn, false);
  navigator.serviceWorker.ready
    .then((reg) => reg.pushManager.getSubscription())
    .then((s) => {
      const active = !!s && Notification.permission === "granted";
      paintBell(btn, active);
      if (active) request("/api/push/subscribe", { subscription: s.toJSON(), device: navigator.userAgent });
    });
  btn.addEventListener("click", () => {
    btn.disabled = true;
    toggleNotifications(btn)
      .catch((e) => toast(String(e && e.message) === "permission" ? "El navegador no ha dado permiso para avisos: actívalo en los ajustes del sitio." : "No se pudieron activar los avisos en este dispositivo."))
      .then(() => (btn.disabled = false));
  });
}
