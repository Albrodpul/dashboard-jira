import { state, drafts, h, button, when, minutesSince, toast, requestOrFail, post, whoSends, areaName, areaSelect, render, refresh, renderMd, empty, fmtDay, ticketUrl, reviewer, deployProjects, exampleKey } from "./base.js";

const search = { q: "", onlyAvailable: true, skipReview: true, results: null, busy: false, capped: false };

function runSearch() {
  search.busy = true;
  render();
  requestOrFail("/api/search", { q: search.q, onlyAvailable: search.onlyAvailable, skipReview: search.skipReview })
    .then((d) => {
      search.results = d.items;
      search.capped = d.capped;
    })
    .catch(() => toast("No se pudo consultar Jira."))
    .then(() => {
      search.busy = false;
      render();
    });
}

function importTasks(keys) {
  requestOrFail("/api/import", { keys })
    .then((d) => {
      toast(`${d.imported}${d.imported === 1 ? " tarea traída" : " tareas traídas"} a Pendientes${d.skipped.length ? `; ${d.skipped.length} sin traer.` : "."}`);
      return refresh(true);
    })
    .catch(() => toast("No se pudieron traer las tareas."))
    .then(runSearch);
}

function checkbox(id, label, field) {
  const c = h("input", { type: "checkbox", id });
  c.checked = search[field];
  c.addEventListener("change", () => (search[field] = c.checked));
  return h("label", { class: "checkbox", for: id }, [c, label]);
}

export function renderSearch(root) {
  root.appendChild(h("p", { class: "setup-note", text: "Busca en Jira tareas sin terminar que no hayan salido en ninguna revisión y tráelas a Pendientes para hacerlas desde aquí. Sin texto, lista todas las que cumplan los filtros." }));
  const q = h("input", { type: "search", id: "jira-q", placeholder: `Texto del título o clave (por ejemplo: login, ${exampleKey()})`, value: search.q, "aria-label": "Buscar en Jira" });
  q.addEventListener("input", () => (search.q = q.value));
  q.addEventListener("keydown", (e) => e.key === "Enter" && runSearch());
  const go = button(search.busy ? "Buscando…" : "Buscar", { cls: "primary", disabled: search.busy, onClick: runSearch });
  root.appendChild(h("div", { class: "toolbar search" }, [q, go, checkbox("jira-available", "Solo sin asignar o mías", "onlyAvailable"), checkbox("jira-skip-review", "Ocultar las que están en revisión", "skipReview")]));
  if (!search.results) return;
  if (!search.results.length) return root.appendChild(empty("Ninguna tarea coincide.", "Prueba con otro texto o quita algún filtro."));
  const eligible = search.results.filter((x) => x.available && !x.onBoard);
  const all = eligible.length > 1 ? h("span", { class: "group-actions" }, [button(`Traer las ${eligible.length}`, { onClick: (b) => ((b.disabled = true), importTasks(eligible.map((x) => x.key))) })]) : null;
  root.appendChild(h("div", { class: "group-head" }, [h("span", { class: "group-name", text: `${search.results.length}${search.results.length === 1 ? " tarea" : " tareas"}${search.capped ? " (hay más: afina la búsqueda)" : ""}` }), all]));
  const rows = search.results.map((x) => {
    const bring = button(x.onBoard ? "Ya en el tablero" : x.available ? "Traer al tablero" : `La lleva ${x.assignee}`, { disabled: !(x.available && !x.onBoard), onClick: (b) => ((b.disabled = true), importTasks([x.key])) });
    const meta = `Asignado: ${x.assignee || "sin asignar"} · Epic: ${x.epicKey ? `${x.epicKey} ${x.epicName || ""}` : "sin epic"} · Sesión: ${x.area ? areaName(x.area) : "sin sesión"}`;
    return h("div", { class: "row" }, [
      h("div", { class: "row-id" }, [h("a", { class: "key jira-link", href: ticketUrl(x.key), target: "_blank", rel: "noopener noreferrer", text: x.key }), h("span", { class: `chip ${x.rejected ? "returned" : "ignored"}`, text: x.status + (x.rejected ? " · rechazo" : "") })]),
      h("div", { class: "row-side" }, [h("span", { text: x.title }), h("span", { class: "meta", text: meta })]),
      bring,
    ]);
  });
  root.appendChild(h("div", { class: "rows" }, rows));
}

const VERSIONS = [
  { id: "z", label: "Parche", note: "x.y.Z, lo normal" },
  { id: "y", label: "Menor", note: "x.Y.0" },
  { id: "x", label: "Mayor", note: "X.0.0" },
];
const ENVIRONMENT_NAME = { develop: "develop (beta)", production: "producción", both: "develop y producción" };
const deploy = { picked: {}, environment: "both", version: "z", area: undefined, busy: false };
const touchesProd = (e) => e === "production" || e === "both";
const humanList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`);

function option(type, group, value, checked, title, note, onChange, extra) {
  const input = h("input", { type, name: group, value, id: `${group}-${value}` });
  input.checked = checked;
  input.addEventListener("change", () => {
    onChange(input.checked);
    render();
  });
  return h("label", { class: `option${extra ? " " + extra : ""}`, for: `${group}-${value}` }, [input, h("span", {}, [h("b", { text: title }), note ? h("small", { text: note }) : null])]);
}

function deployHistory(root) {
  const history = state.deployments || [];
  if (!history.length) return;
  root.appendChild(h("div", { class: "group-head" }, [h("span", { class: "group-name", text: "Últimos despliegues" })]));
  const rows = history.map((x) => {
    const situation = { approved: "Esperando envío", sent: "Enviado", cancelled: "Cancelado" }[x.status] || x.status;
    const target = areaName(x.area) || x.area;
    const line = x.status === "sent" ? `Enviado a ${target}${x.sentAt ? ` a las ${when(x.sentAt)}` : ""}.` : x.status === "approved" ? `${whoSends(true)} lo envía a ${target} en cuanto lo recoge.` : "No se llegó a enviar.";
    const side = [h("span", { class: "state-line", text: line })];
    if (x.reply) side.push(h("span", { class: "reply", text: x.reply }));
    if (x.status === "approved") side.push(button("Cancelar", { onClick: (b) => ((b.disabled = true), post("/api/deploy", { cancel: x.id }, "Despliegue cancelado.")) }));
    const envChip = touchesProd(x.environment) ? (x.environment === "both" ? "Develop + producción" : "Producción") + (x.version ? ` · ${x.version.toUpperCase()}` : "") : "Develop";
    return h("div", { class: `row${x.status === "cancelled" ? " off" : ""}` }, [
      h("div", { class: "row-id" }, [h("span", { class: "time", text: when(x.at) }), h("span", { class: `chip ${touchesProd(x.environment) ? "prod" : "new"}`, text: envChip }), h("span", { class: `chip ${x.status === "sent" ? "sent" : x.status === "approved" ? "returned" : "cancelled"}`, text: situation })]),
      h("span", { class: "key", text: x.projects.join(", ") }),
      h("div", { class: "row-side" }, side),
    ]);
  });
  root.appendChild(h("div", { class: "rows" }, rows));
}

export function renderDeploy(root) {
  const projects = deployProjects();
  const chosen = projects.filter((p) => deploy.picked[p]);
  const area = deploy.area !== undefined ? deploy.area : state.deployerArea || "";
  const waiting = (state.deployments || []).find((x) => x.status === "approved");
  const box = h("div", { class: "deploy" });
  const all = projects.length > 0 && chosen.length === projects.length;
  box.appendChild(
    h("fieldset", { class: "field" }, [
      h("legend", { text: "Qué subir" }),
      h("div", { class: "options" }, projects.map((p) => option("checkbox", "project", p, !!deploy.picked[p], p, "", (v) => (deploy.picked[p] = v)))),
      h("div", {}, [button(all ? "Quitar todos" : "Marcar todos", { onClick: () => (projects.forEach((p) => (deploy.picked[p] = !all)), render()) })]),
    ])
  );
  box.appendChild(
    h("fieldset", { class: "field" }, [
      h("legend", { text: "A dónde" }),
      h("div", { class: "options" }, [
        option("radio", "environment", "both", deploy.environment === "both", "Develop y producción", "Lo habitual: primero develop, luego master y tag", () => (deploy.environment = "both"), "prod"),
        option("radio", "environment", "develop", deploy.environment === "develop", "Solo develop", "Beta: commit y push a develop", () => (deploy.environment = "develop")),
        option("radio", "environment", "production", deploy.environment === "production", "Solo producción", "Merge de develop a master y tag nuevo", () => (deploy.environment = "production"), "prod"),
      ]),
    ])
  );
  if (touchesProd(deploy.environment)) {
    box.appendChild(h("fieldset", { class: "field" }, [h("legend", { text: "Versión del tag" }), h("div", { class: "options" }, VERSIONS.map((v) => option("radio", "version", v.id, deploy.version === v.id, v.label, v.note, () => (deploy.version = v.id))))]));
  }
  const sel = areaSelect("deploy-area", area, "Elige sesión…", (v) => {
    deploy.area = v;
    render();
  });
  sel.setAttribute("aria-label", "Sesión que despliega");
  const target = state.areas.find((a) => a.id === area);
  const targetNote = !target ? "Ponle nombre en Sesiones a la conversación que hace los despliegues y elígela aquí." : target.open ? "Está abierta: recibe la orden en unos segundos." : "Está cerrada: el tablero la abre en VS Code al desplegar.";
  box.appendChild(h("div", { class: "field" }, [h("label", { class: "field-label", for: "deploy-area", text: "Sesión que despliega" }), sel, h("span", { class: "meta", text: targetNote })]));

  const ready = chosen.length && deploy.environment && target && !waiting && !deploy.busy;
  const version = VERSIONS.find((v) => v.id === deploy.version);
  const summary = waiting
    ? "Hay un despliegue esperando envío. Cuando salga podrás ordenar otro."
    : !chosen.length
      ? "Elige al menos un proyecto."
      : `Vas a subir ${humanList(chosen)} a ${ENVIRONMENT_NAME[deploy.environment]}${touchesProd(deploy.environment) ? ` (tag de ${version.label.toLowerCase()})` : ""}.`;
  const label = deploy.environment === "both" ? "Desplegar a develop y producción" : deploy.environment === "production" ? "Desplegar a producción" : "Desplegar a develop";
  const go = button(label, {
    cls: touchesProd(deploy.environment) ? "danger" : "primary",
    disabled: !ready,
    onClick: () => {
      deploy.busy = true;
      render();
      requestOrFail("/api/deploy", { projects: chosen, environment: deploy.environment, version: deploy.version, area })
        .then(() => {
          Object.assign(deploy, { picked: {}, environment: "both", version: "z" });
          toast(`Despliegue ordenado: ${whoSends()} se lo pasa a «${target.name}» en unos segundos.`);
        })
        .catch((e) => toast(`No se pudo ordenar el despliegue: ${e.message}.`))
        .then(() => {
          deploy.busy = false;
          return refresh(true);
        });
    },
  });
  box.appendChild(h("div", { class: "deploy-footer" }, [h("span", { class: "deploy-summary", text: summary }), go]));
  root.appendChild(box);
  deployHistory(root);
}

let talkTo = "orchestrator";
const TALK_NAMES = { orchestrator: "Orquestadora", reporter: "Sesión de reporte" };
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const DICTATION_ERRORS = { "not-allowed": "El navegador no deja usar el micrófono: dale permiso en los ajustes del sitio.", "service-not-allowed": "El navegador no deja usar el micrófono: dale permiso en los ajustes del sitio.", network: "No hay conexión con el servicio de dictado del navegador.", "audio-capture": "No se encuentra ningún micrófono." };
let dictation = null;

function mergeHeard(results) {
  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const t = results[i][0].transcript.trim();
    const prev = parts[parts.length - 1];
    if (!t) continue;
    if (prev && t.toLowerCase().startsWith(prev.toLowerCase())) parts[parts.length - 1] = t;
    else if (!(prev && prev.toLowerCase().startsWith(t.toLowerCase()))) parts.push(t);
  }
  return parts.join(" ");
}

function toggleDictation() {
  if (dictation) return dictation.stop();
  const r = new Recognition();
  r.lang = "es-ES";
  r.continuous = true;
  r.interimResults = true;
  const before = (drafts.talk || "").trim();
  r.onresult = (e) => {
    drafts.talk = [before, mergeHeard(e.results)].filter(Boolean).join(" ");
    const box = document.getElementById("talk-text");
    if (box) box.value = drafts.talk;
  };
  r.onerror = (e) => {
    if (!["no-speech", "aborted"].includes(e.error)) toast(DICTATION_ERRORS[e.error] || `No se pudo dictar (${e.error}).`);
  };
  r.onend = () => {
    dictation = null;
    render();
  };
  dictation = r;
  r.start();
  render();
}

const MOBILE_CHAT = window.matchMedia("(max-width: 760px)");
const ICON = {
  send: '<path d="M4 12 20 4l-4 16-4-7z"/><path d="m12 13 8-9"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
};
let lastChatMark = "";
let chatFromBottom = 0;

function fitChat() {
  const chat = document.querySelector(".chat");
  if (!chat) return;
  if (!MOBILE_CHAT.matches) return (chat.style.height = "");
  const bar = document.querySelector(".bottom");
  const below = (bar ? bar.getBoundingClientRect().height : 0) + 12;
  const top = chat.getBoundingClientRect().top + window.scrollY;
  const viewport = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  chat.style.height = Math.max(240, Math.floor(viewport - top - below)) + "px";
  setTimeout(reportOverflow, 400);
}

let overflowReported = false;
function reportOverflow() {
  const extra = document.documentElement.scrollHeight - window.innerHeight;
  if (overflowReported || extra <= 1 || !MOBILE_CHAT.matches) return;
  overflowReported = true;
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  post("/api/layout-report", {
    ua: navigator.userAgent,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    inner: [window.innerWidth, window.innerHeight],
    visual: window.visualViewport ? [Math.round(window.visualViewport.width), Math.round(window.visualViewport.height)] : null,
    scrollHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
    extra,
    boxes: { app: box(".app"), nav: box(".nav"), main: box(".main"), chat: box(".chat"), bottom: box(".bottom"), report: box(".report") },
  }).catch(() => {});
}
window.addEventListener("resize", fitChat);
if (window.visualViewport) window.visualViewport.addEventListener("resize", fitChat);

function iconButton(kind, label, cls, onClick) {
  const b = h("button", { class: `chat-icon ${cls}`, type: "button", title: label, "aria-label": label });
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[kind]}</svg>`;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function sessionStatus(to) {
  const s = to === "orchestrator" ? state.orchestrator : state.reporterStatus;
  if (!s) return "sin registrar";
  if (s.watching) return "vigilando";
  return s.open ? "abierta" : "cerrada: se abre al escribirle";
}

function bubble(mine, text, at, foot) {
  const kids = [h("div", { class: "chat-text", text })];
  kids.push(h("div", { class: "chat-foot" }, [h("span", { text: when(at) }), foot || null]));
  return h("div", { class: `chat-bubble ${mine ? "mine" : "theirs"}` }, kids);
}

function ticks(m) {
  if (m.readAt) return h("span", { class: "chat-ticks read", title: `Leído a las ${when(m.readAt)}`, text: "✓✓" });
  if (m.wokenUp) return h("span", { class: "chat-ticks", title: "Despertando la sesión", text: "✓ ⏳" });
  return h("span", { class: "chat-ticks", title: "Enviado, sin leer", text: "✓" });
}

function sendTalk(box, b) {
  const txt = box.value.trim();
  if (!txt) return box.focus();
  if (dictation) dictation.stop();
  b.disabled = true;
  requestOrFail("/api/message", { to: talkTo, text: txt })
    .then(() => {
      delete drafts.talk;
      box.value = "";
    })
    .catch(() => {
      b.disabled = false;
      toast("No se pudo enviar el mensaje.");
    })
    .then(() => refresh(true));
}

export function renderTalk(root) {
  const picker = h("div", { class: "people-chips chat-picker", role: "group", "aria-label": "Con quién hablar" });
  for (const k of ["orchestrator", "reporter"]) {
    const b = h("button", { type: "button", "aria-pressed": k === talkTo ? "true" : "false", text: TALK_NAMES[k] });
    b.addEventListener("click", () => {
      talkTo = k;
      lastChatMark = "";
      render();
    });
    picker.appendChild(b);
  }

  const chat = h("section", { class: "chat", "aria-label": `Conversación con la ${TALK_NAMES[talkTo].toLowerCase()}` });
  chat.appendChild(h("header", { class: "chat-head" }, [h("strong", { text: TALK_NAMES[talkTo] }), h("span", { class: "meta", text: sessionStatus(talkTo) })]));

  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" });
  const list = (state.messages || []).filter((x) => x.to === talkTo).slice().reverse();
  if (!list.length) log.appendChild(h("div", { class: "chat-empty", text: "Aún no le has escrito. Lo que le mandes vale como si lo escribieras en su pestaña de VS Code." }));
  let day = "";
  for (const m of list) {
    const d = fmtDay.format(new Date(m.at));
    if (d !== day) {
      day = d;
      const today = fmtDay.format(new Date()) === d;
      log.appendChild(h("div", { class: "chat-day", text: today ? "Hoy" : d }));
    }
    log.appendChild(bubble(true, m.text, m.at, ticks(m)));
    for (const r of m.replies || (m.reply ? [{ at: m.readAt, text: m.reply }] : [])) log.appendChild(bubble(false, r.text, r.at));
  }
  const lastMine = list[list.length - 1];
  const pending = lastMine && !(lastMine.replies || []).length && !lastMine.reply && Date.now() - new Date(lastMine.readAt || lastMine.at).getTime() < 15 * 60000;
  if (pending) {
    const label = lastMine.readAt ? "Escribiendo…" : lastMine.wokenUp ? "Despertando la sesión…" : "Esperando a que lo lea…";
    log.appendChild(h("div", { class: "chat-bubble theirs chat-typing", role: "status", "aria-label": label }, [h("span", { class: "chat-dots", "aria-hidden": "true" }, [h("i"), h("i"), h("i")]), h("span", { class: "chat-typing-label", text: label })]));
  }
  log.addEventListener("scroll", () => (chatFromBottom = log.scrollHeight - log.scrollTop - log.clientHeight));
  chat.appendChild(log);

  const box = h("textarea", { class: "chat-input", id: "talk-text", rows: "1", placeholder: dictation ? "Escuchando…" : "Escribe un mensaje", "aria-label": "Mensaje" });
  box.value = drafts.talk || "";
  const grow = () => {
    box.style.height = "auto";
    box.style.height = Math.min(box.scrollHeight + 2, 160) + "px";
    box.style.overflowY = box.scrollHeight > 158 ? "auto" : "hidden";
  };
  box.addEventListener("input", () => {
    drafts.talk = box.value;
    grow();
  });
  const send = iconButton("send", "Enviar", "send", (b) => sendTalk(box, b));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !MOBILE_CHAT.matches) {
      e.preventDefault();
      sendTalk(box, send);
    }
  });
  const compose = [box];
  const mic = iconButton(dictation ? "stop" : "mic", dictation ? "Parar de dictar" : "Dictar", dictation ? "mic listening" : "mic", () => {
    if (Recognition) return toggleDictation();
    box.focus();
    toast("Este navegador no trae dictado (Chrome, Edge y Safari sí). En Windows, con el cursor en la caja, pulsa Win+H: el dictado de Windows escribe en cualquier sitio.");
  });
  mic.setAttribute("aria-pressed", dictation ? "true" : "false");
  compose.push(mic);
  compose.push(send);
  chat.appendChild(h("div", { class: "chat-compose" }, compose));

  root.appendChild(picker);
  root.appendChild(chat);
  requestAnimationFrame(() => {
    fitChat();
    grow();
    const mark = `${talkTo}:${list.length}:${list.map((m) => (m.replies || []).length).join(",")}:${pending ? (lastMine.readAt ? "r" : "w") : ""}`;
    if (mark !== lastChatMark) chatFromBottom = 0;
    lastChatMark = mark;
    log.scrollTop = log.scrollHeight - log.clientHeight - chatFromBottom;
  });
}

export function renderContext(root) {
  const o = state.contextTidy;
  const blockers = state.tidyBlockers || [];
  if (state.lastContextPass) {
    const days = Math.floor((Date.now() - new Date(state.lastContextPass + "T12:00:00").getTime()) / 86400000);
    root.appendChild(h("div", { class: "meta", text: `Última pasada: ${state.lastContextPass} (hace ${days}${days === 1 ? " día" : " días"}).` }));
  }
  if (o && (o.status === "approved" || o.status === "in-progress")) {
    root.appendChild(h("div", { class: "state-line", text: o.status === "approved" ? `Pedida a las ${when(o.at)}: la orquestadora la empieza en cuanto la recoge.` : `En curso desde las ${when(o.startedAt)}. No envíes tareas hasta que termine.` }));
    return;
  }
  if (blockers.length) root.appendChild(h("div", { class: "state-line", text: `No se puede todavía: ${blockers.join(", ")}. Cuando todo esté hecho o limpio, se activa.` }));
  const tidy = button("Ordenar contexto", { cls: "primary", disabled: blockers.length > 0, onClick: (b) => ((b.disabled = true), post("/api/tidy", {}, "Ordenación pedida: la orquestadora la empieza en unos segundos.")) });
  root.appendChild(h("div", { class: "actions" }, [tidy]));
  if (o && o.status === "done") {
    root.appendChild(h("div", { class: "jira-head", text: `Última ordenación, terminada a las ${when(o.finishedAt)}` }));
    root.appendChild(renderMd(o.summary || ""));
  }
}

const ERROR_CHIP = { proposed: ["returned", "Por decidir"], approved: ["approved", "Enviándolo"], sent: ["sent", "Enviado a la sesión de errores"], discarded: ["ignored", "Descartado"] };
let olderOpen = false;

function errorCard(e) {
  const [cls, label] = ERROR_CHIP[e.state];
  const kids = [h("div", { class: "top" }, [h("span", { class: "time", text: when(e.at) }), h("span", { class: `chip ${cls}`, text: label })]), h("div", { class: "note", text: e.text })];
  if (e.state === "proposed") {
    const buttons = [];
    const act = (action, msg) => {
      buttons.forEach((b) => (b.disabled = true));
      requestOrFail("/api/followup-error", { id: e.id, action })
        .then(() => toast(msg))
        .catch(() => {
          buttons.forEach((b) => (b.disabled = false));
          toast("No se pudo guardar.");
        })
        .then(() => refresh(true));
    };
    buttons.push(button("Enviar a la sesión de errores", { cls: "primary", onClick: () => act("send", "Enviado: la orquestadora se lo pasa a la sesión de errores.") }));
    buttons.push(button("Descartar", { onClick: () => act("discard", "Descartado.") }));
    kids.push(h("div", { class: "actions" }, buttons));
  }
  return h("article", { class: "card" }, kids);
}

const defaultPerson = () => {
  const list = state.people || [];
  return (list.find((p) => p.hourly) || list[0] || { id: "reviewer" }).id;
};
const personOf = (r) => r.person || defaultPerson();

let selectedPerson = null;
try {
  selectedPerson = localStorage.getItem("follow-up-person");
} catch (e) {}
let adding = false;

function pickPerson(id) {
  selectedPerson = id;
  try {
    localStorage.setItem("follow-up-person", id);
  } catch (e) {}
  render();
}

function peoplePicker(root, people, summaries) {
  const chips = h("div", { class: "people-chips", role: "group", "aria-label": "Persona a seguir" });
  for (const p of people) {
    const pending = summaries.filter((r) => personOf(r) === p.id).flatMap((r) => r.errors || []).filter((x) => x.state === "proposed").length;
    chips.appendChild(
      h("button", { type: "button", "aria-pressed": String(p.id === selectedPerson), onclick: () => pickPerson(p.id), title: p.hourly ? "Resumen automático cada hora" : "Solo cuando lo pides" }, [
        p.hourly ? h("span", { class: "dot on" }) : null,
        p.name,
        p.environment === "production" ? h("span", { class: "meta", text: " · prod" }) : null,
        pending ? h("span", { class: "error-count", text: String(pending) }) : null,
      ])
    );
  }
  chips.appendChild(h("button", { type: "button", class: "other", onclick: () => ((adding = !adding), render()), text: "+ Otra persona" }));
  root.appendChild(chips);
  if (!adding) return;
  const name = h("input", { type: "text", id: "person-name", maxlength: "80", placeholder: "Nombre o correo de su cuenta", "aria-label": "Nombre o correo" });
  const environment = h("select", { id: "person-environment", "aria-label": "Entorno" }, [h("option", { value: "beta", text: "Beta" }), h("option", { value: "production", text: "Producción" })]);
  const add = button("Añadir", {
    cls: "primary",
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/people", { action: "add", name: name.value, environment: environment.value })
        .then(() => {
          adding = false;
          toast("Añadida. Pide su primer resumen cuando quieras.");
        })
        .catch((e) => {
          b.disabled = false;
          toast(e.message);
        })
        .then(() => refresh(true));
    },
  });
  root.appendChild(h("div", { class: "toolbar" }, [name, environment, add]));
}

function requestButton(p, req, environment) {
  return button("Pedir resumen ahora", {
    cls: "primary",
    disabled: !!req,
    title: req ? "Hay otro resumen pedido: espera a que salga." : `La sesión de seguimiento mira la actividad de ${p.name} en ${environment} desde su último resumen y lo publica aquí.`,
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/followup-request", { person: p.id })
        .then(() => toast(`Pedido: el resumen de ${p.name} sale en un par de minutos.`))
        .catch(() => {
          b.disabled = false;
          toast("No se pudo pedir el resumen.");
        })
        .then(() => refresh(true));
    },
  });
}

export function renderFollowUp(root) {
  const all = state.followUps || [];
  const people = state.people || [];
  if (!people.some((p) => p.id === selectedPerson)) selectedPerson = defaultPerson();
  const p = people.find((x) => x.id === selectedPerson) || people[0] || { id: defaultPerson(), name: reviewer(), environment: "beta", accounts: [] };
  const list = all.filter((r) => personOf(r) === p.id);
  const e = state.followUpStatus;
  peoplePicker(root, people, all);
  const environment = p.environment === "production" ? "producción" : "beta";
  const accounts = p.accounts && p.accounts.length ? p.accounts.join(", ") : "se buscan por su nombre en el primer resumen";
  const session = !e ? " · la sesión de seguimiento no está registrada" : ` · sesión «${e.title}» ${e.open ? "abierta" : "cerrada"}`;
  root.appendChild(h("div", { class: "meta", text: `${p.name} · actividad en ${environment} · cuentas: ${accounts}${session}` }));
  const actions = [];
  const req = e && e.request;
  if (req && personOf(req) === p.id) {
    const slow = minutesSince(req.at) >= 4;
    root.appendChild(h("div", { class: "state-line", text: `Resumen pedido a las ${when(req.at)}. ${slow ? "Tarda más de lo normal: la sesión de seguimiento puede estar ocupada o cerrada." : "Se está preparando."}` }));
  } else if (e) actions.unshift(requestButton(p, req, environment));
  if (p.id !== defaultPerson()) {
    actions.push(
      button("Quitar de la lista", {
        cls: "subtle",
        onClick: () => {
          if (!window.confirm(`¿Quitar a ${p.name} del seguimiento? Sus resúmenes ya publicados se quedan.`)) return;
          post("/api/people", { action: "remove", id: p.id }, `${p.name} ya no está en la lista.`);
        },
      })
    );
  }
  root.appendChild(h("div", { class: "actions" }, actions));
  if (!list.length) return root.appendChild(empty(`Todavía no hay resúmenes de ${p.name}.`, p.hourly ? "Sale uno cada hora en horario de trabajo, de lunes a viernes." : "Pídelo con el botón cuando quieras."));
  root.appendChild(h("section", { class: "jira follow-up" }, [h("div", { class: "jira-head", text: `Resumen de las ${when(list[0].at)}` }), renderMd(list[0].text)]));
  if (!(list[0].errors || []).some((x) => x.wholeSummary && x.state !== "discarded")) {
    const sendAll = button("Enviar este resumen a la sesión de errores", {
      title: "Para cuando ves un fallo que la sesión no ha apuntado como posible error. Se manda el resumen entero.",
      onClick: (b) => {
        b.disabled = true;
        requestOrFail("/api/followup-error", { at: list[0].at, action: "summary" })
          .then(() => toast("Enviado: la orquestadora se lo pasa a la sesión de errores."))
          .catch((x) => {
            b.disabled = false;
            toast(`No se pudo enviar: ${x.message}`);
          })
          .then(() => refresh(true));
      },
    });
    root.appendChild(h("div", { class: "actions" }, [sendAll]));
  }
  const errors = list.flatMap((r) => (r.errors || []).filter((x) => x.state === "proposed" || r === list[0]));
  if (errors.length) {
    root.appendChild(h("div", { class: "jira-head", text: "Posibles errores vistos en su actividad" }));
    errors.forEach((x) => root.appendChild(errorCard(x)));
  }
  if (list.length > 1) {
    const det = h("details", {}, [h("summary", { class: "meta", text: `Resúmenes anteriores (${list.length - 1})` })]);
    det.open = olderOpen;
    det.addEventListener("toggle", () => (olderOpen = det.open));
    list.slice(1).forEach((x) => det.appendChild(h("div", { class: "ev" }, [h("span", { class: "t", text: when(x.at) }), renderMd(x.text)])));
    root.appendChild(det);
  }
}
