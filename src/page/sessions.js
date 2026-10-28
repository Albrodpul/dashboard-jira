import { state, h, button, when, toast, requestOrFail, post, areaName, areaSelect, areaSelectFrom, render, refresh, empty, ticketUrl, exampleKey } from "./base.js";

let showClosed = true;
try {
  showClosed = localStorage.getItem("board-show-closed") !== "0";
} catch (e) {}

export function createSession(name, epic, btn) {
  const clean = String(name || "").trim();
  if (!clean) {
    toast("Escribe un nombre para la sesión.");
    return Promise.resolve(null);
  }
  const label = btn ? btn.textContent : "";
  let created = null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Abriendo en VS Code…";
  }
  return requestOrFail("/api/new-session", { title: clean, epicKey: epic ? epic.key : undefined, epicName: epic ? epic.name : undefined })
    .then((d) => {
      created = d.area;
      toast(d.open ? `Sesión «${clean}» creada y abierta en VS Code${d.named ? ", con ese nombre en la pestaña." : ". No se le pudo poner el nombre a la pestaña."}` : `Sesión «${clean}» creada, pero VS Code no abrió la conversación. Ábrela a mano.`);
    })
    .catch(() => toast("No se pudo crear la sesión."))
    .then(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      return refresh(true);
    })
    .then(() => created);
}

const freeEpics = () => state.epics.filter((e) => !e.area).sort((a, b) => a.key.localeCompare(b.key, "es", { numeric: true }));

function nameField(r) {
  const input = h("input", { class: "session-name", type: "text", id: `name-${r.id}`, maxlength: "60", placeholder: r.vsCodeTitle || "Ponle un nombre", value: r.unnamed ? "" : r.name, "aria-label": `Nombre de la sesión ${r.sessionName || r.name}` });
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!v) {
      toast("El nombre no puede quedar vacío.");
      return refresh(true);
    }
    const body = { name: r.sessionName || r.name, ref: r.ref || "", title: v, conversation: r.conversation };
    if (!r.unnamed) body.areaId = r.id;
    post("/api/session", body, "Nombre guardado.");
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  input.addEventListener("blur", () => setTimeout(() => refresh(true), 50));
  return input;
}

function roleChip(r) {
  if (r.isOrchestrator) {
    const watching = r.open && state.orchestrator.watching;
    return h("span", { class: `chip ${watching ? "sent" : "returned"}`, text: !r.open ? "Orquesta · cerrada" : watching ? "Orquesta" : "Orquesta · sin vigilar" });
  }
  if (r.isBoard) return h("span", { class: `chip ${r.open && state.boardStatus.watching ? "sent" : "returned"}`, text: !r.open ? "Tablero · cerrada" : state.boardStatus.watching ? "Tablero" : "Tablero · sin vigilar" });
  if (r.isSystem) return h("span", { class: "chip new", text: "Reporte" });
  if (r.id === state.deployerArea) return h("span", { class: "chip prod", text: "Despliega" });
  return null;
}

function sessionBody(r, keys) {
  if (r.isSystem) return h("p", { class: "session-note", text: r.isOrchestrator ? "Envía a cada sesión las tareas y los despliegues que apruebas, y guarda lo que contestan." : r.isBoard ? "Atiende lo que le pides en Hablar sobre el propio tablero: mejoras, fallos y rediseños. No recibe tareas de Jira." : "Lee Jira cada 5 minutos, publica el reporte y deja las tarjetas." });
  if (r.unnamed) {
    const note = h("p", { class: "session-note", text: r.vsCodeTitle ? `En VS Code se llama «${r.vsCodeTitle}». Escribe un nombre arriba para poder darle epics.` : "Escribe un nombre arriba para poder darle epics." });
    if (!r.vsCodeTitle) return note;
    const use = button(`Usar «${r.vsCodeTitle}»`, {
      onClick: (b) => {
        b.disabled = true;
        post("/api/session", { name: r.sessionName, ref: r.ref || "", title: r.vsCodeTitle, conversation: r.conversation }, "Nombre guardado.");
      },
    });
    return h("div", { class: "session-body" }, [note, h("div", {}, [use])]);
  }
  const chips = keys.map((k) => {
    const x = h("button", { class: "epic-x", type: "button", title: `Quitar ${k} de esta sesión`, "aria-label": `Quitar ${k} ${r.epics[k]} de ${r.name}`, text: "×" });
    x.addEventListener("click", () => {
      x.disabled = true;
      post("/api/epic", { key: k, name: r.epics[k], area: "" }, `${k} ya no tiene sesión.`);
    });
    return h("span", { class: "epic-chip", title: r.epics[k] }, [h("b", { text: k }), h("span", { class: "epic-name", text: r.epics[k] }), x]);
  });
  const free = freeEpics();
  if (free.length) {
    const add = h("select", { class: "epic-add", id: `add-${r.id}`, "aria-label": `Añadir un epic a ${r.name}` }, [h("option", { value: "", text: "+ Epic…" })]);
    free.forEach((e) => add.appendChild(h("option", { value: e.key, text: `${e.key} ${e.name}` })));
    add.addEventListener("change", () => {
      const e = free.find((y) => y.key === add.value);
      if (e) post("/api/epic", { key: e.key, name: e.name, area: r.id }, `${e.key} va a la sesión «${r.name}».`);
    });
    chips.push(add);
  }
  return h("div", { class: "session-body" }, [
    chips.length ? h("div", { class: "epic-chips" }, chips) : null,
    keys.length ? null : h("p", { class: "session-note", text: r.id === state.deployerArea ? "Recibe los despliegues de la pestaña Desplegar." : "Sin epics todavía: no recibe tareas." }),
  ]);
}

function sessionCard(r, byConversation, openUnnamed) {
  const s = byConversation[r.conversation || r.sessionName];
  const busy = r.open && s && s.status === "busy";
  const keys = Object.keys(r.epics || {});
  const system = !!r.isSystem;
  const situation = !r.open ? "Cerrada" : busy ? "Trabajando" : "Abierta";
  const head = [
    h("span", { class: `dot ${!r.open ? "off" : busy ? "busy" : "on"}`, title: situation }),
    system ? h("span", { class: "session-title", text: r.isOrchestrator || r.isBoard ? r.name : "Reporte de Jira" }) : nameField(r),
    roleChip(r),
  ];
  const since = s ? `desde ${when(s.started)}` : r.since && r.open ? `desde ${when(r.since)}` : null;
  const actions = [];
  if (!system && !r.open && keys.length && openUnnamed.length) {
    const options = openUnnamed.map((o) => {
      const live = byConversation[o.conversation || o.sessionName];
      return { id: o.id, name: (o.vsCodeTitle || o.sessionName) + (live ? ` (desde ${when(live.started)})` : ""), open: true, ref: o.ref, sessionName: o.sessionName };
    });
    actions.push(
      areaSelectFrom(options, `mv-${r.id}`, "", "Pasar sus epics a…", (v) => {
        if (!v) return;
        const target = openUnnamed.find((a) => a.id === v);
        post("/api/session", { name: target.sessionName, ref: target.ref || "", area: r.id, conversation: target.conversation }, `Los epics de «${r.name}» pasan a la sesión ${target.sessionName}.`);
      })
    );
  }
  if (!system && !r.unnamed && !keys.length && r.id !== state.deployerArea) {
    actions.push(
      button("Quitar", {
        cls: "subtle",
        title: "La quita del tablero. La conversación de VS Code no se toca.",
        onClick: (b) => {
          if (!window.confirm(`¿Quitar «${r.name}» del tablero?\n\nLa conversación de VS Code no se borra; solo deja de salir aquí con ese nombre.`)) return;
          b.disabled = true;
          post("/api/session", { name: r.sessionName || r.name, areaId: r.id, remove: true }, `«${r.name}» quitada del tablero.`);
        },
      })
    );
  }
  if (r.conversation && (!system || r.isOrchestrator || r.isBoard)) actions.push(h("a", { class: "btn link", href: `vscode://anthropic.claude-code/open?session=${encodeURIComponent(r.conversation)}`, text: r.open ? "Ir a su pestaña" : "Abrir en VS Code" }));
  const footer = [h("span", { class: "meta session-auto", text: [r.sessionName || null, since, situation].filter(Boolean).join(" · ") }), h("span", { class: "session-actions" }, actions)];
  return h("article", { class: `session${r.open ? "" : " off"}${r.unnamed ? " anon" : ""}` }, [h("div", { class: "session-top" }, head), sessionBody(r, keys), h("div", { class: "session-footer" }, footer)]);
}

function section(root, title, note, cards) {
  if (!cards.length) return;
  const head = h("div", { class: "group-head" }, [h("span", { class: "group-name", text: title }), h("span", { class: "group-key", text: String(cards.length) }), note ? h("span", { class: "meta", text: note }) : null]);
  root.appendChild(h("section", {}, [head, h("div", { class: "session-grid" }, cards)]));
}

function newSessionBar(root, openCount, total) {
  const name = h("input", { type: "text", id: "new-session", maxlength: "60", placeholder: "Nombre de la sesión nueva", "aria-label": "Nombre de la sesión nueva" });
  const create = button("Crear y abrir en VS Code", { cls: "primary", onClick: (b) => createSession(name.value, null, b) });
  name.addEventListener("keydown", (e) => e.key === "Enter" && create.click());
  const toggle = h("input", { type: "checkbox", id: "show-closed" });
  toggle.checked = showClosed;
  toggle.addEventListener("change", () => {
    showClosed = toggle.checked;
    try {
      localStorage.setItem("board-show-closed", showClosed ? "1" : "0");
    } catch (e) {}
    render();
  });
  root.appendChild(h("div", { class: "toolbar new-session" }, [name, create, h("span", { class: "meta session-count", text: `${openCount} de ${total} abiertas` }), h("label", { class: "checkbox", for: "show-closed" }, [toggle, "Ver las cerradas"])]));
}

export function renderSessions(root) {
  const byConversation = {};
  for (const s of state.sessions.list || []) byConversation[s.conversation || s.name] = s;
  const openUnnamed = state.areas.filter((a) => a.open && a.unnamed);
  const named = state.areas.filter((a) => !a.unnamed);
  newSessionBar(root, named.filter((a) => a.open).length, named.length);

  const sync = state.sessions.syncedAt;
  if (!sync || Date.now() - new Date(sync).getTime() > 12 * 60 * 1000) {
    root.appendChild(h("p", { class: "setup-note warn", text: sync ? `La lista de sesiones abiertas es de las ${when(sync)} y puede estar desfasada.` : "Todavía no se ha leído la lista de sesiones abiertas." }));
  }
  const closedWithEpics = named.filter((a) => !a.open && Object.keys(a.epics || {}).length);
  if (closedWithEpics.length) {
    root.appendChild(h("p", { class: "setup-note", text: closedWithEpics.length === 1 ? `«${closedWithEpics[0].name}» está cerrada y tiene epics: el tablero la abre sola cuando le apruebas una tarea.` : `${closedWithEpics.length} sesiones con epics están cerradas: el tablero abre cada una cuando le apruebas una tarea.` }));
  }

  const toCard = (r) => sessionCard(r, byConversation, openUnnamed);
  const order = (a, b) => b.open - a.open || a.name.localeCompare(b.name, "es");
  const visible = (a) => a.open || showClosed;
  const hasEpics = (a) => Object.keys(a.epics || {}).length > 0;
  const withEpics = named.filter((a) => hasEpics(a) && visible(a)).sort(order);
  const withoutEpics = named.filter((a) => !hasEpics(a) && visible(a)).sort(order);
  section(root, "Abiertas sin nombre", "Ponles nombre para poder darles epics.", openUnnamed.map(toCard));
  section(root, "Con epics", "Reciben las tareas de sus epics.", withEpics.map(toCard));
  section(root, "Sin epics", null, withoutEpics.map(toCard));

  const system = [];
  const rep = state.reporterRoute;
  if (rep && rep.session) system.push({ id: "reporter", name: rep.session, sessionName: rep.session, ref: rep.ref, open: true, epics: {}, isSystem: true, since: rep.since, conversation: rep.conversation });
  const o = state.orchestrator;
  if (o) system.push({ id: "orchestrator", name: o.title, sessionName: o.session, ref: o.ref, open: o.open, epics: {}, isSystem: true, isOrchestrator: true, since: o.since, conversation: o.conversation });
  const b = state.boardStatus;
  if (b) system.push({ id: "board", name: b.title, sessionName: b.session, open: b.open, epics: {}, isSystem: true, isBoard: true, conversation: b.conversation });
  section(root, "Del tablero", "Las sesiones que lo hacen funcionar.", system.map(toCard));

  if (!openUnnamed.length && !withEpics.length && !withoutEpics.length && !system.length) root.appendChild(empty("Sin sesiones.", "Crea una arriba o abre una conversación en VS Code."));
}

let epicQuery = "";

function epicRow(e) {
  const sel = areaSelect(`epic-${e.key}`, e.area || "", "Sin sesión", (v) => post("/api/epic", { key: e.key, name: e.name, area: v }, v ? `${e.key} va a la sesión «${areaName(v)}».` : `${e.key} ya no tiene sesión.`));
  sel.setAttribute("aria-label", `Sesión de ${e.key} ${e.name}`);
  const create = e.area
    ? null
    : button("Sesión nueva…", {
        onClick: (b) => {
          const n = window.prompt(`Nombre de la sesión nueva para ${e.key} ${e.name}`, e.name);
          if (n) createSession(n, e, b);
        },
      });
  return h("div", { class: "epic-row" }, [h("a", { class: "key jira-link", href: ticketUrl(e.key), target: "_blank", rel: "noopener noreferrer", text: e.key }), h("span", { class: "epic-row-name", text: e.name }), h("span", { class: "epic-row-actions" }, [sel, create])]);
}

function epicBlock(box, head, list) {
  if (!list.length) return;
  box.appendChild(h("section", { class: "epic-block" }, [h("div", { class: "group-head" }, head), h("div", { class: "epic-list" }, list.map(epicRow))]));
}

function renderEpicList(box) {
  box.textContent = "";
  const q = epicQuery.trim().toLowerCase();
  const byKey = {};
  if (q) for (const e of state.allEpics || []) byKey[e.key] = e;
  for (const e of state.epics) byKey[e.key] = e;
  let list = Object.values(byKey);
  if (q) list = list.filter((e) => `${e.key} ${e.name}`.toLowerCase().includes(q));
  list.sort((a, b) => a.key.localeCompare(b.key, "es", { numeric: true }));
  if (!list.length) return box.appendChild(empty(q ? "Ningún epic coincide." : "Aún no hay epics.", q ? `Prueba con otra palabra o con la clave (por ejemplo ${exampleKey()}).` : "Se anotan en cada revisión; también puedes buscar uno."));
  const capped = list.length > 80;
  list = list.slice(0, 80);
  const free = list.filter((e) => !e.area);
  epicBlock(box, [h("span", { class: "group-name", text: "Sin sesión" }), h("span", { class: "group-key", text: String(free.length) }), h("span", { class: "meta", text: "Sus tareas nuevas llegan a Pendientes sin sesión propuesta." })], free);
  state.areas
    .filter((a) => !a.unnamed)
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
    .forEach((a) => {
      const own = list.filter((e) => e.area === a.id);
      epicBlock(box, [h("span", { class: `dot ${a.open ? "on" : "off"}`, title: a.open ? "Abierta" : "Cerrada" }), h("span", { class: "group-name", text: a.name }), h("span", { class: "group-key", text: String(own.length) }), a.open ? null : h("span", { class: "meta", text: "cerrada" })], own);
    });
  if (capped) box.appendChild(h("p", { class: "setup-note", text: "Hay más de 80 resultados. Afina la búsqueda." }));
}

export function renderEpics(root) {
  const total = (state.allEpics || []).length;
  const listBox = h("div", { class: "epic-blocks" });
  const search = h("input", { type: "search", id: "epic-search", placeholder: `Buscar entre los ${total} epics abiertos de Jira (nombre o clave)`, value: epicQuery, "aria-label": "Buscar epic" });
  search.addEventListener("input", () => {
    epicQuery = search.value;
    renderEpicList(listBox);
  });
  root.appendChild(h("div", { class: "toolbar" }, [search, h("span", { class: "meta", text: "Sin buscar salen los que ya tienen sesión o han aparecido en una revisión." })]));
  root.appendChild(listBox);
  renderEpicList(listBox);
}
