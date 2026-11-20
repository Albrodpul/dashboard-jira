import { state, h, when, minutesSince, toast, request, post, refresh, renderMd, fmtDay, switchView } from "../lib/base.js";
import { t, tn, LOCALE } from "../lib/i18n.js";

const weekday = new Intl.DateTimeFormat(LOCALE, { timeZone: "Europe/Madrid", weekday: "long" });

function dayLabel(iso) {
  const day = fmtDay.format(new Date(iso));
  if (day === fmtDay.format(new Date())) return "";
  if (day === fmtDay.format(new Date(Date.now() - 86400000))) return t("ayer, {day}", { day });
  return `${weekday.format(new Date(iso))} ${day}`;
}

let historyOpen = false;
let paintedReport = "";

let paintedGithub = "";
let githubMoreOpen = false;
const GH_SHOWN = 12;
const clock = new Intl.DateTimeFormat(LOCALE, { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });

function githubRow(e) {
  const kids = [
    h("span", { class: "t", text: clock.format(new Date(e.at)) }),
    h("div", { class: "gh-body" }, [
      h("div", { class: "gh-line" }, [h("b", { text: e.name }), ` ${e.text} `, h("span", { class: "gh-repo", text: e.repo })]),
      e.items && e.items.length ? h("ul", { class: "gh-items" }, [...e.items.map((x) => h("li", { text: x })), e.more ? h("li", { class: "meta", text: t("y {n} más", { n: e.more }) }) : null]) : null,
    ]),
  ];
  return e.url ? h("a", { class: "ev gh-ev", href: e.url, target: "_blank", rel: "noopener" }, kids) : h("div", { class: "ev gh-ev" }, kids);
}

function githubDays(list) {
  const out = [];
  let last = null;
  for (const e of list) {
    const day = dayLabel(e.at) || t("hoy");
    if (day !== last) out.push(h("div", { class: "jira-head", text: day.charAt(0).toUpperCase() + day.slice(1) }));
    last = day;
    out.push(githubRow(e));
  }
  return out;
}

let actTab = "jira";
let ghSeenAt = "";
try {
  ghSeenAt = localStorage.getItem("gh-seen-at") || "";
} catch (e) {}

function paintActTabs() {
  const bar = document.getElementById("act-tabs");
  if (!bar) return;
  document.getElementById("report").setAttribute("data-act", actTab);
  const events = (state.github && state.github.events) || [];
  const newest = events.reduce((m, e) => (e.at > m ? e.at : m), "");
  if (actTab === "github" && newest > ghSeenAt) {
    ghSeenAt = newest;
    try {
      localStorage.setItem("gh-seen-at", newest);
    } catch (e) {}
  }
  const today = fmtDay.format(new Date());
  const fresh = events.filter((e) => e.at > ghSeenAt && fmtDay.format(new Date(e.at)) === today).length;
  const fingerprint = actTab + fresh;
  if (bar.dataset.painted === fingerprint) return;
  bar.dataset.painted = fingerprint;
  bar.textContent = "";
  const tab = (id, label, n) =>
    h("button", { type: "button", role: "tab", class: `act-tab${actTab === id ? " on" : ""}`, "aria-selected": String(actTab === id), onclick: () => ((actTab = id), paintActTabs()) }, [label, n ? h("span", { class: "n", text: String(n), title: t("Nuevo desde la última vez que miraste") }) : null]);
  bar.append(tab("jira", "Jira"), tab("github", "GitHub", fresh));
}

function renderGithub() {
  paintActTabs();
  const box = document.getElementById("github-body");
  if (!box) return;
  const g = state.github || {};
  const events = g.events || [];
  const fingerprint = JSON.stringify([events.map((e) => e.id), g.at && minutesSince(g.at), fmtDay.format(new Date())]);
  if (fingerprint === paintedGithub) return;
  paintedGithub = fingerprint;
  box.textContent = "";
  const stamp = document.getElementById("gh-stamp");
  if (stamp) {
    stamp.textContent = "";
    stamp.append(h("strong", { text: g.at ? (minutesSince(g.at) < 1 ? t("Mirado hace un momento") : t("Mirado hace {n} min", { n: minutesSince(g.at) })) : t("Aún sin mirar") }), ` · ${t("lo de los demás")}`);
    stamp.title = t("Commits, PR y revisiones de los demás en los repos de despliegue de cada proyecto. Lo tuyo no sale.");
  }
  if (!events.length) {
    box.appendChild(h("div", { class: "meta", text: g.at ? t("Nadie más ha movido nada en la última semana.") : t("Aún no se ha mirado GitHub.") }));
    return;
  }
  box.append(...githubDays(events.slice(0, GH_SHOWN)));
  const rest = events.slice(GH_SHOWN);
  if (!rest.length) return;
  const det = h("details", {}, [h("summary", { class: "meta", text: t("Más actividad en GitHub ({n})", { n: rest.length }) }), ...githubDays(rest)]);
  det.open = githubMoreOpen;
  det.addEventListener("toggle", () => (githubMoreOpen = det.open));
  box.appendChild(det);
}

export function renderReport() {
  renderGithub();
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
  const fingerprint = JSON.stringify([reports, last, req, slow, fmtDay.format(new Date())]);
  if (fingerprint === paintedReport) return;
  paintedReport = fingerprint;
  box.hidden = false;
  box.textContent = "";
  if (req) box.appendChild(h("div", { class: "pending-note", text: `${t("Revisión pedida a las {time}.", { time: when(req.at) })} ${slow ? t("Tarda más de lo normal: la sesión de reporte puede estar ocupada o cerrada.") : t("Se está preparando.")}` }));
  if (!reports.length) return;
  const noChanges = last && last.empty && new Date(last.at) > new Date(reports[0].at);
  const day = dayLabel(reports[0].at);
  if (noChanges || day) box.appendChild(h("div", { class: "jira-head", text: day ? t("Última novedad, de {day}:", { day }) : t("Última novedad:") }));
  box.appendChild(renderMd(reports[0].text));
  const older = reports.slice(1);
  if (!older.length) return;
  const det = h("details", {}, [h("summary", { class: "meta", text: t("Reportes anteriores ({n})", { n: older.length }) })]);
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
  const txt = paused ? t("Revisiones en pausa desde las {time}. Pulsa para reanudarlas.", { time: when(state.config.pausedAt) }) : t("Pausar las revisiones automáticas y los seguimientos para no gastar cuota. Revisar ahora, Chats y «Pedir resumen ahora» siguen funcionando.");
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
  const paused = !!(state.config && state.config.paused);
  const line = h("span", { class: "stamp-line" });
  el.appendChild(line);
  if (!u) line.textContent = t("Aún no se ha revisado nada.");
  else {
    const mins = minutesSince(u.at);
    const ago = mins < 1 ? t("Revisado hace un momento") : mins < 60 ? t("Revisado hace {n} min", { n: mins }) : t("Revisado a las {time}", { time: when(u.at) });
    line.appendChild(h("strong", { text: ago }));
    line.appendChild(document.createTextNode(` · ${paused ? t("en pausa") : u.empty ? t("sin novedades") : t("con novedades")}`));
    line.title = t("Última revisión: {time}", { time: when(u.at) });
    line.classList.toggle("late", mins > 3 && !paused);
  }
  const m = state.mailman || { failing: [], delivering: [] };
  const failing = m.failing || [];
  if (!failing.length) return;
  const list = failing.map((f) => `${f.id}: ${f.error}`).join("\n");
  const bad = h("button", { type: "button", class: "orch bad wake", title: `${list}\n${t("Pulsa para verlas en Por enviar.")}` }, [h("i"), tn(failing.length, "{n} envío sin entregar", "{n} envíos sin entregar")]);
  bad.addEventListener("click", () => switchView("approved"));
  el.appendChild(bad);
}

const WINDOWS = [
  ["five_hour", "5 h"],
  ["seven_day", t("Semana")],
];
const fmtWeekday = new Intl.DateTimeFormat(LOCALE, { timeZone: "Europe/Madrid", weekday: "long" });
const fmtHour = new Intl.DateTimeFormat(LOCALE, { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });

function resets(iso) {
  if (!iso) return "";
  const d = new Date(Math.round(new Date(iso).getTime() / 60000) * 60000);
  return d - Date.now() < 20 * 3600000 ? t("se renueva a las {time}", { time: when(d.toISOString()) }) : t("se renueva el {weekday} a las {time}", { weekday: fmtWeekday.format(d), time: fmtHour.format(d) });
}

function tokenWarning() {
  if (!state.claudeTokenExpires) return null;
  const days = Math.ceil((new Date(state.claudeTokenExpires + "T00:00:00") - Date.now()) / 86400000);
  if (days > 30) return null;
  const text = days <= 0 ? t("Token de Claude caducado") : tn(days, "Token de Claude: caduca en {n} día", "Token de Claude: caduca en {n} días");
  return h("span", { class: `token-warn${days <= 7 ? " high" : ""}`, title: t("Las sesiones del tablero usan un token de larga duración que caduca el {date}. Renuévalo con el botón de la pestaña Ordenadores.", { date: state.claudeTokenExpires }), text });
}

export function overtimeBanner() {
  const ot = state.config && state.config.overtime;
  if (!ot && state.workHours !== false) return null;
  const btn = h("button", { type: "button", class: `btn${ot ? "" : " primary"}`, text: ot ? t("Terminar y dormir todo") : t("Activarlo todo") });
  btn.onclick = () => {
    if (ot && !window.confirm(t("¿Terminar? Se paran los servidores de desarrollo, se duermen las sesiones sin trabajo pendiente y el Mac vuelve a poder dormirse."))) return;
    btn.disabled = true;
    post("/api/overtime", { on: !ot }, ot ? t("Fuera de horario terminado: todo vuelve a dormirse.") : t("Arrancando todo: el reporte, el seguimiento y los servidores, en un par de minutos.")).then(() => (btn.disabled = false));
  };
  const head = ot ? t("Fuera de horario activado desde las {time}", { time: when(ot.since) }) : t("Fuera de horario: el tablero está en reposo");
  const text = ot ? t("El Mac no se duerme, las sesiones no se duermen solas y el reporte sigue revisando Jira. Termínalo cuando acabes; si se te olvida, se apaga solo al empezar la jornada.") : t("Si necesitas trabajar ahora, actívalo todo: arranca el reporte, el seguimiento y los servidores, y nada se duerme hasta que lo termines.");
  return h("div", { class: `token-banner overtime-banner${ot ? " on" : ""}`, role: "status" }, [h("div", {}, [h("strong", { text: head }), h("span", { text })]), btn]);
}

export function yoloBanner() {
  const y = state.config && state.config.yolo;
  if (!y) return null;
  const btn = h("button", { type: "button", class: "btn", text: t("Apagar") });
  btn.onclick = () => {
    btn.disabled = true;
    post("/api/config", { yolo: false }, t("Modo YOLO apagado: las tareas nuevas esperan a que pulses Hacer."));
  };
  const from = Date.parse(state.config.yoloAt || "") || 0;
  const sent = (state.tasks || []).filter((x) => x.approvedVia === "yolo" && (Date.parse(x.decidedAt || "") || 0) >= from).length;
  const power = h("span", { class: "power", title: t("Tareas enviadas solas desde que lo encendiste: {n}", { n: sent }) }, [h("small", { text: t("Nivel de poder") }), h("b", { text: ((sent + 1) * 1000).toLocaleString(LOCALE) })]);
  const since = state.config.yoloAt ? t("Modo YOLO activo desde las {time}", { time: when(state.config.yoloAt) }) : t("Modo YOLO activo");
  return h("div", { class: "token-banner overtime-banner on yolo-banner", role: "status" }, [h("div", {}, [h("strong", { text: since }), h("span", { text: t("Las tareas pendientes van solas a su sesión, y si no tienen, el tablero crea una con el nombre del epic.") })]), power, btn]);
}

export function tokenBanner(goTo) {
  if (!state.claudeTokenExpires) return null;
  const days = Math.ceil((new Date(state.claudeTokenExpires + "T00:00:00") - Date.now()) / 86400000);
  if (days > 30) return null;
  const head = days <= 0 ? t("El token de Claude ha caducado") : tn(days, "El token de Claude caduca en {n} día", "El token de Claude caduca en {n} días");
  const text = days <= 0 ? t("Las sesiones del tablero y VS Code dejan de funcionar hasta que lo renueves.") : t("Renuévalo ahora, mientras tu navegador siga dentro de claude.ai con la cuenta de empresa: así lo autorizas tú solo, sin pedir nada a nadie.");
  const go = h("button", { type: "button", class: "btn primary", text: t("Renovar en Ordenadores"), onclick: goTo });
  return h("div", { class: `token-banner${days <= 7 ? " high" : ""}`, role: "status" }, [h("div", {}, [h("strong", { text: head }), h("span", { text })]), go]);
}

export function quotaBlock() {
  const warn = tokenWarning();
  const box = quotaBlockInner();
  if (warn) box.appendChild(warn);
  return box;
}

function quotaMeter(c, k, name, main) {
  const used = Math.round(c[k].used);
  const level = used >= 90 ? " high" : used >= 70 ? " medium" : "";
  return h("span", { class: `quota-meter${level}${main ? "" : " minor"}`, title: t("{window}: {used} % usado, {resets}", { window: main ? t("Semana") : name, used, resets: resets(c[k].resetsAt) }) }, [main ? null : h("span", { class: "quota-name", text: name }), h("b", { text: `${used}%` })]);
}

const CLAUDE_LOGO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14.2 12.3L22.4 13.5M13.7 13.4L18.7 17.2M12.8 14.0L15.7 21.3M11.7 14.2L10.7 20.9M10.6 13.7L5.4 20.5M10.0 12.8L4.4 15.1M9.8 11.7L1.9 10.6M10.3 10.6L4.8 6.3M11.2 10.0L8.0 2.2M12.3 9.8L13.2 3.5M13.4 10.3L18.0 4.3M14.0 11.2L20.7 8.5" fill="none" stroke="#D97757" stroke-width="2.3" stroke-linecap="round"/></svg>';

function quotaBlockInner() {
  const c = state.quota;
  const live = (k) => c && c[k] && !(c[k].resetsAt && new Date(c[k].resetsAt) < new Date());
  const logo = h("span", { class: "quota-title claude-logo", title: t("Cuota de Claude"), role: "img", "aria-label": "Claude" });
  logo.innerHTML = CLAUDE_LOGO;
  const box = h("div", { class: "quota" }, [logo]);
  if (!live("seven_day") && !live("five_hour")) {
    box.appendChild(h("span", { class: "meta", text: c ? t("Semana recién renovada") : t("Aún sin datos") }));
    return box;
  }
  const items = [];
  if (live("seven_day")) items.push(quotaMeter(c, "seven_day", t("Semana"), true));
  if (live("five_hour") && c.five_hour.used >= 50) items.push(quotaMeter(c, "five_hour", "5 h", false));
  box.appendChild(h("span", { class: "quota-items" }, items));
  if (live("seven_day")) box.appendChild(h("span", { class: "quota-reset", text: resets(c.seven_day.resetsAt) }));
  if (minutesSince(c.at) > 30) {
    box.classList.add("stale");
    box.appendChild(h("span", { class: "quota-stale", text: t("dato de {time}", { time: when(c.at) }) }));
  }
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
  const txt = active ? t("Avisos activados en este dispositivo. Pulsa para desactivarlos.") : t("Avisos desactivados en este dispositivo. Pulsa para activarlos.");
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
    toast(t("Avisos desactivados en este dispositivo."));
    return;
  }
  if ((await Notification.requestPermission()) !== "granted") throw new Error("permission");
  const { key } = await (await fetch("/api/push/key")).json();
  const created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey(key) });
  await request("/api/push/subscribe", { subscription: created.toJSON(), device: navigator.userAgent });
  paintBell(btn, true);
  toast(t("Avisos activados en este dispositivo. Te llega uno de prueba."));
  await request("/api/push/test");
}

export function mountHeader() {
  document.getElementById("pause").addEventListener("click", (e) => {
    const paused = !(state.config && state.config.paused);
    e.currentTarget.disabled = true;
    post("/api/config", { paused }, paused ? t("Revisiones en pausa: no se gasta cuota hasta que las reanudes.") : t("Revisiones reanudadas: la sesión de reporte vuelve a vigilar en un par de minutos.")).then(() => (document.getElementById("pause").disabled = false));
  });
  document.getElementById("refresh").addEventListener("click", () => {
    request("/api/refresh")
      .then((r) => {
        if (!r.ok) throw new Error(r.status);
        toast(t("Revisión de Jira pedida: el reporte llega en un par de minutos."));
        return refresh(true);
      })
      .catch(() => toast(t("No se pudo pedir la revisión.")));
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
      .catch((e) => toast(String(e && e.message) === "permission" ? t("El navegador no ha dado permiso para avisos: actívalo en los ajustes del sitio.") : t("No se pudieron activar los avisos en este dispositivo.")))
      .then(() => (btn.disabled = false));
  });
}
