import { livePanel } from "../components/terminal.js";
import { state, h, button, toast, requestOrFail, render, refresh, empty, switchView } from "../lib/base.js";
import { currentProject, mixedProjects as mixed, projectName } from "../components/project-filter.js";

let talkTo = "board";
try {
  talkTo = localStorage.getItem("talk-to") || "board";
} catch (e) {}
const setTalk = (k) => {
  talkTo = k;
  try {
    localStorage.setItem("talk-to", k);
  } catch (e) {}
};
const TALK_NAMES = {
  reporter: "Sesión de reporte",
  orchestrator: "Orquestadora",
  board: "Tablero",
  deploy: "Despliegue",
  errors: "Errores sentry",
  followUp: "Seguimiento",
};
const areaTalk = (id) => {
  const a = id && state.areas.find((x) => x.id === id);
  return a && a.conversation ? { conversation: a.conversation, session: a.sessionName || a.name } : null;
};
const talkSession = (to) => ({ reporter: state.reporterStatus, orchestrator: state.orchestrator, board: state.boardStatus, followUp: state.followUpStatus, deploy: areaTalk(state.deployerArea), errors: areaTalk(state.sentry && state.sentry.errorsArea) })[to] || null;
const FIXED_TALK = ["board", "reporter", "orchestrator", "followUp", "deploy", "errors"];
const pin = () => {
  const el = h("span", { class: "talk-pin", title: "Sesión fija del tablero", "aria-label": "fija" });
  el.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
  return el;
};
const SHARED_TALK = ["board"];
function shownFixed() {
  const picked = currentProject();
  const main = ((state.jiraSetup && state.jiraSetup.workspaces) || [])[0];
  return picked && main && picked !== main.id ? SHARED_TALK : FIXED_TALK;
}

export function openTalk(conversation) {
  setTalk(FIXED_TALK.find((k) => (talkSession(k) || {}).conversation === conversation) || conversation);
  switchView("talk", true);
}

function otherLiveSessions() {
  const fixed = new Set(FIXED_TALK.map((k) => (talkSession(k) || {}).conversation).filter(Boolean));
  const live = new Map(((state.sessions && state.sessions.list) || []).map((s) => [s.conversation, s]));
  const own = shownFixed() === SHARED_TALK ? new Set(state.areas.filter((a) => a.conversation && !a.unnamed).map((a) => a.conversation)) : new Set();
  return (state.hosted || []).filter((x) => !x.waitingForVsCode && !fixed.has(x.conversation) && (live.has(x.conversation) || own.has(x.conversation))).map((x) => ({ conversation: x.conversation, name: talkName(x.conversation), session: x.name }));
}

const workspaceList = () => (state.jiraSetup && state.jiraSetup.workspaces) || [];

function projectOfTalk(conversation) {
  const area = state.areas.find((a) => a.conversation === conversation && a.project);
  const live = ((state.sessions && state.sessions.list) || []).find((s) => s.conversation === conversation && s.project);
  return (area && area.project) || (live && live.project) || (workspaceList()[0] || {}).id;
}

function talkGroups(fixedShown, others) {
  const fixedRows = fixedShown.map((k) => [k, TALK_NAMES[k], (talkSession(k) || {}).conversation]);
  const openRows = others.map((o) => [o.conversation, o.name, o.conversation]);
  if (!mixed()) return [["Fijas", fixedRows], ["Abiertas", openRows]];
  const main = (workspaceList()[0] || {}).id;
  const groups = [["Común a todos", fixedRows.filter(([k]) => SHARED_TALK.includes(k))]];
  const byProject = new Map(workspaceList().map((p) => [p.id, { fixed: [], open: [] }]));
  byProject.get(main).fixed.push(...fixedRows.filter(([k]) => !SHARED_TALK.includes(k)));
  for (const row of openRows) {
    const id = projectOfTalk(row[2]);
    if (!byProject.has(id)) byProject.set(id, { fixed: [], open: [] });
    byProject.get(id).open.push(row);
  }
  for (const [id, { fixed, open }] of byProject) {
    const name = projectName(id);
    groups.push([name, [...fixed, ...open]]);
  }
  return groups;
}

function talkName(conversation) {
  const area = state.areas.find((a) => a.conversation === conversation && a.name);
  if (area) return area.name;
  const live = ((state.sessions && state.sessions.list) || []).find((s) => s.conversation === conversation);
  const hosted = (state.hosted || []).find((x) => x.conversation === conversation);
  return (live && (live.title || live.name)) || (hosted && hosted.name) || "Sesión";
}

function newTalkSession(b) {
  const project = currentProject();
  const where = mixed() ? ` (en ${projectName((workspaceList()[0] || {}).id)}; para otro proyecto, elígelo arriba)` : "";
  const name = window.prompt(`Nombre de la sesión nueva${where}`, "");
  if (!name || !name.trim()) return;
  b.disabled = true;
  b.textContent = "Creando…";
  requestOrFail("/api/new-session", { title: name.trim(), project: project || undefined })
    .then((d) => {
      if (d.conversation) {
        justCreated.add(d.conversation);
        setTalk(d.conversation);
      }
      toast(d.open ? `Sesión «${name.trim()}» creada.` : `Sesión «${name.trim()}» creada; está arrancando.`);
      return refresh(true);
    })
    .catch(() => toast("No se pudo crear la sesión."))
    .then(() => render());
}

const TALK_STATES = { busy: ["busy", "Trabajando"], idle: ["on", "Esperando"], waiting: ["bad", "Espera tu respuesta"] };

function talkActivity(conversation) {
  if (!conversation) return ["", "Sin registrar"];
  const live = ((state.sessions && state.sessions.list) || []).find((x) => x.conversation === conversation);
  if (live && live.status === "idle" && live.background) return ["on", "Esperando · con proceso de fondo"];
  if (live) return TALK_STATES[live.status] || ["bad", live.status ? `Estado «${live.status}»` : "Abierta"];
  const hosted = (state.hosted || []).some((x) => x.conversation === conversation && !x.waitingForVsCode);
  return ["", hosted ? "Dormida" : "Fuera del tablero"];
}

export function renderTalk(root) {
  const others = otherLiveSessions();
  const fixedShown = shownFixed();
  const list = h("nav", { class: "talk-list", "aria-label": "Qué sesión ver" });
  const group = (title, rows) => {
    if (!rows.length) return;
    list.appendChild(h("div", { class: "talk-list-title", text: title }));
    for (const [k, label, conversation] of rows) {
      const [dot, what] = talkActivity(conversation);
      list.appendChild(
        h("button", { type: "button", class: "talk-item", "aria-current": k === talkTo ? "true" : "false", onclick: () => { setTalk(k); render(); } }, [
          h("span", { class: `dot ${dot}`, "aria-hidden": "true" }),
          h("span", { class: "talk-item-text" }, [h("span", { class: "talk-item-name" }, [label, mixed() && FIXED_TALK.includes(k) ? pin() : null]), h("span", { class: "talk-item-state", text: what })]),
        ])
      );
    }
  };
  for (const [title, rows] of talkGroups(fixedShown, others)) group(title, rows);
  list.appendChild(h("button", { type: "button", class: "talk-new", title: "Abre una sesión nueva en el tablero para hablar con ella", text: "+ Sesión nueva", onclick: (e) => newTalkSession(e.currentTarget) }));
  const main = h("div", { class: "talk-main" });
  root.appendChild(h("div", { class: "talk-layout" }, [list, main]));
  renderTalkMain(main, others);
}

function renderTalkMain(root, others) {
  const groups = talkGroups(shownFixed(), others).filter(([, rows]) => rows.length);
  const choices = groups.flatMap(([, rows]) => rows);
  if (/^[0-9a-f-]{36}$/.test(talkTo) && !choices.some(([k]) => k === talkTo)) groups.push(["Otras", [[talkTo, "Sesión abierta"]]]);
  const option = ([k, label]) => h("option", { value: k, text: label });
  const select = h("select", { class: "chat-select", "aria-label": "Qué sesión ver" }, mixed() ? groups.map(([title, rows]) => h("optgroup", { label: title }, rows.map(option))) : groups.flatMap(([, rows]) => rows).map(option));
  select.value = talkTo;
  select.addEventListener("change", () => {
    setTalk(select.value);
    render();
  });
  const newButton = h("button", { type: "button", class: "btn chat-new", text: "+ Nueva", onclick: (e) => newTalkSession(e.currentTarget) });
  root.appendChild(h("div", { class: "chat-select-row" }, [select, newButton]));
  const other = others.find((o) => o.conversation === talkTo) || (/^[0-9a-f-]{36}$/.test(talkTo) ? { conversation: talkTo, name: "Sesión nueva" } : null);
  const awake = other && ((state.sessions && state.sessions.list) || []).some((x) => x.conversation === other.conversation);
  const sleeping = other && !awake && !justCreated.has(other.conversation) && (!others.includes(other) || shownFixed() === SHARED_TALK);
  if (sleeping) {
    const name = talkName(other.conversation);
    return sleepingTalk(root, other.conversation, name, `«${name}» está dormida.`);
  }
  if (other) {
    const close = button("Cerrar sesión", {
      cls: "subtle",
      title: "La cierra y la quita de Hablar. Su conversación sigue en el historial y se puede volver a abrir desde Sesiones.",
      onClick: (b) => {
        if (!window.confirm(`¿Cerrar «${other.name}»? Si está a mitad de algo, se corta. La conversación no se borra.`)) return;
        b.disabled = true;
        requestOrFail("/api/host/action", { action: "sleep", conversation: other.conversation, name: other.session || other.name })
          .then(() => {
            setTalk("board");
            toast(`«${other.name}» cerrada. Está en Sesiones si la quieres volver a abrir.`);
            return refresh(true);
          })
          .catch((e) => {
            b.disabled = false;
            toast(`No se pudo cerrar: ${e.message}`);
          });
      },
    });
    const panel = livePanel(other.conversation, other.name);
    const head = panel.querySelector(".term-head");
    const old = head.querySelector(".talk-close");
    if (old) old.remove();
    close.classList.add("talk-close");
    head.appendChild(close);
    return root.appendChild(panel);
  }
  const target = talkSession(talkTo);
  if (!target || !target.conversation) return root.appendChild(empty(`${TALK_NAMES[talkTo]} no está registrada.`, "Regístrala con su comando para poder verla aquí."));
  const hosted = (state.hosted || []).some((x) => x.conversation === target.conversation && !x.waitingForVsCode);
  if (!hosted) return root.appendChild(empty(`${TALK_NAMES[talkTo]} no vive en el tablero.`, "Llévala al tablero desde Sesiones para verla aquí en directo."));
  const running = ((state.sessions && state.sessions.list) || []).some((x) => x.conversation === target.conversation);
  if (!running) return sleepingTalk(root, target.conversation, target.session || TALK_NAMES[talkTo], `${TALK_NAMES[talkTo]} está dormida.`);
  root.appendChild(livePanel(target.conversation, target.session || TALK_NAMES[talkTo]));
}

const justCreated = new Set();

function sleepingTalk(root, conversation, name, title) {
  root.appendChild(empty(title, "Se abre sola cuando le llega algo. Si quieres hablar con ella ahora, ábrela."));
  root.appendChild(
    h("div", { class: "talk-actions" }, [
      button("Abrir", {
        cls: "primary",
        onClick: (b) => {
          b.disabled = true;
          requestOrFail("/api/host/action", { action: "open", conversation, name })
            .then(() => {
              toast(`Abriendo «${name}»…`);
              return refresh(true);
            })
            .catch((e) => {
              b.disabled = false;
              toast(`No se pudo abrir: ${e.message}`);
            });
        },
      }),
    ])
  );
}
