import { state, h, button, toast, requestOrFail, post, areaName, taskAreaSelect, refresh, empty, ticketUrl } from "./base.js";
import { createSession, hostedOf } from "./sessions.js";
import { openTalk } from "./operations.js";

let epicQuery = "";
const freeEpics = () => state.epics.filter((e) => !e.area).sort((a, b) => a.key.localeCompare(b.key, "es", { numeric: true }));
const liveOf = (conversation) => ((state.sessions && state.sessions.list) || []).find((s) => s.conversation === conversation) || null;

function statusOf(conversation) {
  const live = liveOf(conversation);
  if (!live) return { dot: "off", text: "Dormida" };
  if (live.status === "busy") return { dot: "busy", text: "Trabajando" };
  return { dot: "on", text: "Abierta" };
}

function hostAction(action, conversation, name, b, okText) {
  if (b) b.disabled = true;
  return requestOrFail("/api/host/action", { action, conversation, name })
    .then(() => {
      toast(okText);
      return refresh(true);
    })
    .catch((e) => {
      if (b) b.disabled = false;
      toast(`No se pudo: ${e.message}`);
    });
}

function nameInput(a) {
  const input = h("input", { class: "srow-name", type: "text", maxlength: "60", value: a.name, "aria-label": `Nombre de ${a.name}` });
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!v) {
      toast("El nombre no puede quedar vacío.");
      return refresh(true);
    }
    post("/api/session", { name: a.sessionName || a.name, ref: a.ref || "", title: v, conversation: a.conversation, areaId: a.id }, "Nombre guardado.");
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  return input;
}

function epicChips(a) {
  const keys = Object.keys(a.epics || {}).sort();
  const chips = keys.map((k) => {
    const x = h("button", { class: "epic-x", type: "button", title: `Quitar ${k} de esta sesión`, "aria-label": `Quitar ${k} de ${a.name}`, text: "×" });
    x.addEventListener("click", () => {
      x.disabled = true;
      post("/api/epic", { key: k, name: a.epics[k], area: "" }, `${k} ya no tiene sesión.`);
    });
    return h("span", { class: "epic-chip", title: a.epics[k] }, [h("b", { text: k }), h("span", { class: "epic-name", text: a.epics[k] }), x]);
  });
  const free = freeEpics();
  if (free.length) {
    const add = h("select", { class: "srow-add", "aria-label": `Añadir un epic a ${a.name}` }, [h("option", { value: "", text: "+" })]);
    free.forEach((e) => add.appendChild(h("option", { value: e.key, text: `${e.key} ${e.name}` })));
    add.addEventListener("change", () => {
      const e = free.find((y) => y.key === add.value);
      if (e) post("/api/epic", { key: e.key, name: e.name, area: a.id }, `${e.key} va a la sesión «${a.name}».`);
    });
    chips.push(add);
  }
  if (!keys.length) chips.unshift(h("span", { class: "meta", text: "Sin epics" }));
  return h("div", { class: "srow-epics" }, chips);
}

function actions(a, fixed) {
  const out = [];
  const conv = a.conversation;
  const hosted = conv && hostedOf(conv);
  const live = conv && liveOf(conv);
  if (hosted) out.push(button("Hablar", { onClick: () => openTalk(conv) }));
  if (hosted && !live) out.push(button("Abrir", { cls: "subtle", onClick: (b) => hostAction("open", conv, a.sessionName || a.name, b, `Abriendo «${a.name}»…`) }));
  if (hosted && live && !fixed) out.push(button("Dormir", { cls: "subtle", title: "La cierra; se despierta sola cuando le llegue algo", onClick: (b) => hostAction("sleep", conv, a.sessionName || a.name, b, `«${a.name}» dormida.`) }));
  if (!fixed && !Object.keys(a.epics || {}).length)
    out.push(
      button("Quitar", {
        cls: "subtle",
        title: "La quita del tablero; su conversación no se borra",
        onClick: (b) => {
          if (!window.confirm(`¿Quitar «${a.name}» del tablero? Su conversación no se borra.`)) return;
          b.disabled = true;
          post("/api/session", { name: a.sessionName || a.name, areaId: a.id, remove: true }, `«${a.name}» quitada del tablero.`);
        },
      })
    );
  return h("div", { class: "srow-actions" }, out);
}

function row(a) {
  const st = a.conversation ? statusOf(a.conversation) : { dot: "off", text: "Sin conversación" };
  return h("div", { class: "srow" }, [h("span", { class: `dot ${st.dot}`, title: st.text }), nameInput(a), epicChips(a), actions(a, false)]);
}

function fixedRow(name, role, conversation, note) {
  const st = conversation ? statusOf(conversation) : { dot: "off", text: "Sin registrar" };
  const a = { name, conversation, epics: {} };
  return h("div", { class: "srow fixed" }, [h("span", { class: `dot ${st.dot}`, title: st.text }), h("strong", { class: "srow-title", text: name }), h("span", { class: "meta srow-note", text: `${role} · ${st.text.toLowerCase()}${note ? ` · ${note}` : ""}` }), actions(a, true)]);
}

function epicRow(e) {
  const sel = taskAreaSelect(`ep2-${e.key}`, e.area || "", "Sin sesión", (v) => post("/api/epic", { key: e.key, name: e.name, area: v }, v ? `${e.key} va a la sesión «${areaName(v)}».` : `${e.key} ya no tiene sesión.`));
  const create = e.area ? null : button("Sesión nueva", { cls: "subtle", onClick: (b) => { const n = window.prompt(`Nombre de la sesión nueva para ${e.key} ${e.name}`, e.name); if (n) createSession(n, e, b); } });
  return h("div", { class: "erow" }, [h("a", { class: "key jira-link", href: ticketUrl(e.key), target: "_blank", rel: "noopener noreferrer", text: e.key }), h("span", { class: "erow-name", text: e.name }), sel, create]);
}

function head(title, n, note) {
  return h("div", { class: "group-head" }, [h("span", { class: "group-name", text: title }), n === null ? null : h("span", { class: "group-key", text: String(n) }), note ? h("span", { class: "meta", text: note }) : null]);
}

function epicSearch(root) {
  const box = h("div", { class: "erows" });
  const paint = () => {
    box.textContent = "";
    const q = epicQuery.trim().toLowerCase();
    if (!q) return;
    const byKey = {};
    for (const e of state.allEpics || []) byKey[e.key] = e;
    for (const e of state.epics) byKey[e.key] = e;
    const list = Object.values(byKey).filter((e) => `${e.key} ${e.name}`.toLowerCase().includes(q)).slice(0, 20);
    if (!list.length) return box.appendChild(h("p", { class: "meta", text: "Ningún epic coincide." }));
    list.forEach((e) => box.appendChild(epicRow(e)));
  };
  const input = h("input", { type: "search", class: "find-input", placeholder: `Buscar un epic de Jira para darle sesión (${(state.allEpics || []).length} abiertos)`, value: epicQuery, "aria-label": "Buscar epic" });
  input.addEventListener("input", () => {
    epicQuery = input.value;
    paint();
  });
  root.appendChild(input);
  root.appendChild(box);
  paint();
}

export function renderSessionsNew(root) {
  const nameBox = h("input", { type: "text", class: "find-input", maxlength: "60", placeholder: "Nombre de una sesión nueva", "aria-label": "Nombre de la sesión nueva" });
  const create = button("Crear sesión", { cls: "primary", onClick: (b) => nameBox.value.trim() && createSession(nameBox.value.trim(), null, b) });
  nameBox.addEventListener("keydown", (e) => e.key === "Enter" && create.click());
  root.appendChild(h("div", { class: "s2-toolbar" }, [nameBox, create]));

  const free = freeEpics();
  if (free.length) {
    const sec = h("section", { class: "s2-section warn" }, [head("Epics sin sesión", free.length, "Sus tareas llegan a Pendientes sin sesión propuesta.")]);
    const list = h("div", { class: "erows" });
    free.forEach((e) => list.appendChild(epicRow(e)));
    sec.appendChild(list);
    root.appendChild(sec);
  }

  const fixedIds = new Set([state.deployerArea, state.sentry && state.sentry.errorsArea].filter(Boolean));
  const followUp = state.followUpStatus && state.followUpStatus.conversation;
  const areas = state.areas.filter((a) => !a.unnamed && !fixedIds.has(a.id) && a.conversation !== followUp);
  const rank = (a) => (liveOf(a.conversation) ? (statusOf(a.conversation).dot === "busy" ? 0 : 1) : 2);
  areas.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "es"));
  const sec = h("section", { class: "s2-section" }, [head("Sesiones", areas.length, "Reciben las tareas de sus epics. Las dormidas se despiertan solas cuando les llega algo.")]);
  sec.appendChild(areas.length ? h("div", { class: "srows" }, areas.map(row)) : empty("Sin sesiones.", "Crea una arriba."));
  root.appendChild(sec);

  const fixed = [];
  const area = (id) => state.areas.find((a) => a.id === id);
  if (state.reporterRoute) fixed.push(fixedRow("Reporte de Jira", "Lee Jira y publica el reporte", state.reporterRoute.conversation));
  if (state.orchestrator) fixed.push(fixedRow("Orquestadora", "Envía tareas y despliegues", state.orchestrator.conversation, state.orchestrator.open && !state.orchestrator.watching ? "sin vigilar" : ""));
  if (state.boardStatus) fixed.push(fixedRow("Tablero", "Mejoras del propio tablero", state.boardStatus.conversation));
  if (state.followUpStatus) fixed.push(fixedRow("Seguimiento", "Lo que hace Enric en beta", state.followUpStatus.conversation));
  if (area(state.deployerArea)) fixed.push(fixedRow("Despliegue", "Despliegues de la pestaña Desplegar", area(state.deployerArea).conversation));
  const err = state.sentry && area(state.sentry.errorsArea);
  if (err) fixed.push(fixedRow("Errores sentry", "Errores de Sentry y del seguimiento", err.conversation));
  root.appendChild(h("section", { class: "s2-section" }, [head("Fijas", fixed.length, "Las que hacen funcionar el tablero."), h("div", { class: "srows" }, fixed)]));

  const search = h("section", { class: "s2-section" }, [head("Buscar epics", null, null)]);
  epicSearch(search);
  root.appendChild(search);
}
