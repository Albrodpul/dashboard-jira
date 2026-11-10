import { livePanel } from "../components/terminal.js";
import { state, h, button, toast, requestOrFail, render, refresh, empty, switchView } from "../lib/base.js";
import { currentProject } from "../components/project-filter.js";

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
  return (state.hosted || []).filter((x) => !x.waitingForVsCode && !fixed.has(x.conversation) && live.has(x.conversation)).map((x) => ({ conversation: x.conversation, name: talkName(x.conversation), session: x.name }));
}

function talkName(conversation) {
  const area = state.areas.find((a) => a.conversation === conversation && a.name);
  if (area) return area.name;
  const live = ((state.sessions && state.sessions.list) || []).find((s) => s.conversation === conversation);
  const hosted = (state.hosted || []).find((x) => x.conversation === conversation);
  return (live && (live.title || live.name)) || (hosted && hosted.name) || "Sesión";
}

function newTalkSession(b) {
  const name = window.prompt("Nombre de la sesión nueva", "");
  if (!name || !name.trim()) return;
  b.disabled = true;
  b.textContent = "Creando…";
  requestOrFail("/api/new-session", { title: name.trim() })
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

const TALK_STATES = { busy: ["busy", "Trabajando"], idle: ["on", "Esperando"] };

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
  const entries = [...fixedShown.map((k) => [k, TALK_NAMES[k], (talkSession(k) || {}).conversation]), ...others.map((o) => [o.conversation, o.name, o.conversation])];
  const list = h("nav", { class: "talk-list", "aria-label": "Qué sesión ver" });
  const group = (title, rows) => {
    if (!rows.length) return;
    list.appendChild(h("div", { class: "talk-list-title", text: title }));
    for (const [k, label, conversation] of rows) {
      const [dot, what] = talkActivity(conversation);
      list.appendChild(
        h("button", { type: "button", class: "talk-item", "aria-current": k === talkTo ? "true" : "false", onclick: () => { setTalk(k); render(); } }, [
          h("span", { class: `dot ${dot}`, "aria-hidden": "true" }),
          h("span", { class: "talk-item-text" }, [h("span", { class: "talk-item-name", text: label }), h("span", { class: "talk-item-state", text: what })]),
        ])
      );
    }
  };
  group("Fijas", entries.slice(0, fixedShown.length));
  group("Abiertas", entries.slice(fixedShown.length));
  list.appendChild(h("button", { type: "button", class: "talk-new", title: "Abre una sesión nueva en el tablero para hablar con ella", text: "+ Sesión nueva", onclick: (e) => newTalkSession(e.currentTarget) }));
  const main = h("div", { class: "talk-main" });
  root.appendChild(h("div", { class: "talk-layout" }, [list, main]));
  renderTalkMain(main, others);
}

function renderTalkMain(root, others) {
  const choices = [...shownFixed().map((k) => [k, TALK_NAMES[k]]), ...others.map((o) => [o.conversation, o.name])];
  if (/^[0-9a-f-]{36}$/.test(talkTo) && !choices.some(([k]) => k === talkTo)) choices.push([talkTo, "Sesión abierta"]);
  const select = h("select", { class: "chat-select", "aria-label": "Qué sesión ver" }, choices.map(([k, label]) => h("option", { value: k, text: label })));
  select.value = talkTo;
  select.addEventListener("change", () => {
    setTalk(select.value);
    render();
  });
  const newButton = h("button", { type: "button", class: "btn chat-new", text: "+ Nueva", onclick: (e) => newTalkSession(e.currentTarget) });
  root.appendChild(h("div", { class: "chat-select-row" }, [select, newButton]));
  const other = others.find((o) => o.conversation === talkTo) || (/^[0-9a-f-]{36}$/.test(talkTo) ? { conversation: talkTo, name: "Sesión nueva" } : null);
  const sleeping = other && !others.includes(other) && !justCreated.has(other.conversation);
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
