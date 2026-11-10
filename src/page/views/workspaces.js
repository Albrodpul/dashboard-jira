import { h, button, toast, requestOrFail, render, refresh, empty } from "../lib/base.js";

const MODULES = { jira: "Jira y su reporte", followUp: "Seguimiento", sentry: "Sentry", deploy: "Despliegues", devServers: "Servidores locales", daily: "Daily", context: "Ordenar contexto" };
const OPTIONAL = { daily: ["Daily", "Un resumen al final del día con las tareas y los commits de este proyecto."], contextTidy: ["Ordenar contexto", "Pasadas de orden sobre el contexto del proyecto, con sus propias reglas (su AGENTS.md)."] };
const SECRETS = { JIRA_SITE: "Sitio de Jira", JIRA_EMAIL: "Correo de Jira", JIRA_TOKEN: "Token de Jira", SENTRY_TOKEN: "Token de Sentry" };
const GUIDE = {
  review: ["Al dar una tarea por hecha", "Qué tiene que hacer la sesión antes de avisar «done». Sin texto: solo avisar al tablero."],
  cause: ["Al cerrar una devuelta", "Qué apunta la sesión cuando le devuelven una tarea. Sin texto: nada."],
  reference: ["Dónde están las reglas", "Fichero del proyecto que explica cómo trabajar las tareas, por ejemplo AGENTS.md."],
};

let list = null;
let loading = false;
let failed = "";
let editing = null;
let secrets = {};

function load() {
  if (loading) return;
  loading = true;
  fetch("/api/projects-admin", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => {
      list = d;
      failed = "";
    })
    .catch((e) => (failed = String(e.message || e)))
    .finally(() => {
      loading = false;
      render();
    });
}

const reload = () => {
  list = null;
  load();
  refresh(true);
};

function field(label, hint, input) {
  return h("label", { class: "ws-field" }, [h("span", { class: "ws-label", text: label }), input, hint ? h("span", { class: "meta", text: hint }) : null]);
}

function text(draft, key, attrs = {}) {
  const input = h("input", { type: "text", value: draft[key] || "", ...attrs });
  input.addEventListener("input", () => (draft[key] = input.value));
  return input;
}

function area(draft, key, placeholder) {
  const t = h("textarea", { class: "reply-box", placeholder });
  t.value = draft[key] || "";
  t.addEventListener("input", () => (draft[key] = t.value));
  return t;
}

function form(draft) {
  const isNew = !draft.id;
  const save = button(isNew ? "Crear proyecto" : "Guardar", {
    cls: "primary",
    onClick: async (b) => {
      b.disabled = true;
      try {
        const body = { name: draft.name, taskPrefix: draft.taskPrefix, root: draft.root || "", daily: !!draft.daily, contextTidy: !!draft.contextTidy, messages: { review: draft.review, cause: draft.cause, reference: draft.reference } };
        if (!isNew) Object.assign(body, { id: draft.id, create: false });
        const r = await requestOrFail("/api/projects-admin/save", body);
        editing = null;
        toast(isNew ? `Proyecto creado${r.commands ? `; comandos en ${r.commands.folder}` : ""}.` : "Proyecto guardado.");
        reload();
      } catch (e) {
        toast(`No se pudo guardar: ${e.message}`);
        b.disabled = false;
      }
    },
  });
  const cancel = button("Cancelar", { cls: "subtle", onClick: () => ((editing = null), render()) });
  return h("section", { class: "card setting-card ws-form" }, [
    h("h3", { text: isNew ? "Nuevo proyecto" : `Editar ${draft.name}` }),
    field("Nombre", null, text(draft, "name", { placeholder: "Cuentas personales" })),
    field("Prefijo de las tareas", "De 2 a 10 letras. Las tareas que crees a mano se llamarán así: PREFIJO-1, PREFIJO-2…", text(draft, "taskPrefix", { placeholder: "CUENTAS" })),
    field("Carpeta en este ordenador", "Ruta completa. Cada ordenador guarda la suya; las sesiones abiertas dentro de ella son de este proyecto.", text(draft, "root", { placeholder: "/Users/…/proyecto" })),
    h("div", { class: "ws-checks" }, Object.entries(OPTIONAL).map(([k, [label, hint]]) => {
      const box = h("input", { type: "checkbox" });
      box.checked = !!draft[k];
      box.addEventListener("change", () => (draft[k] = box.checked));
      return h("label", { class: "rule" }, [box, h("span", {}, [h("strong", { text: label }), ` · ${hint}`])]);
    })),
    h("details", { class: "ws-guide" }, [
      h("summary", { text: "Guía para las sesiones (opcional)" }),
      ...Object.entries(GUIDE).map(([k, [label, hint]]) => field(label, hint, area(draft, k, ""))),
    ]),
    h("div", { class: "actions" }, [save, cancel]),
  ]);
}

function credentials(p) {
  const draft = (secrets[p.id] = secrets[p.id] || {});
  const inputs = Object.entries(SECRETS).map(([k, label]) => {
    const input = h("input", { type: "password", autocomplete: "off", placeholder: p.credentials[k] ? "Puesta: escribe para cambiarla" : "Falta", value: draft[k] || "" });
    input.addEventListener("input", () => (draft[k] = input.value));
    return field(label, null, input);
  });
  const save = button("Guardar credenciales", {
    onClick: async (b) => {
      const values = Object.fromEntries(Object.entries(draft).filter(([, v]) => v));
      if (!Object.keys(values).length) return toast("No has escrito ninguna.");
      b.disabled = true;
      try {
        await requestOrFail("/api/projects-admin/credentials", { id: p.id, values });
        secrets[p.id] = {};
        toast("Credenciales guardadas en este ordenador.");
        reload();
      } catch (e) {
        toast(`No se pudieron guardar: ${e.message}`);
        b.disabled = false;
      }
    },
  });
  return h("details", { class: "ws-guide" }, [h("summary", { text: "Credenciales de este ordenador" }), h("p", { class: "meta", text: "Se guardan solo aquí, en su propio fichero. Nunca se enseñan: solo si están puestas o faltan." }), ...inputs, h("div", { class: "actions" }, [save])]);
}

function card(p) {
  const active = Object.entries(p.modules).filter(([, on]) => on).map(([k]) => MODULES[k]);
  const facts = [
    ["Prefijo de las tareas", p.taskPrefix],
    ["Carpeta en este ordenador", p.root || "sin carpeta"],
    ["Agente", p.agent === "claude" ? "Claude Code" : p.agent],
    ["Módulos", active.length ? active.join(", ") : "ninguno"],
    ["Tareas abiertas", String(p.openTasks)],
  ];
  if (p.jira) facts.splice(4, 0, ["Proyectos de Jira", p.jira.join(", ")]);
  const kids = [
    h("div", { class: "ws-head" }, [h("h3", { text: p.name }), h("span", { class: "chip", text: p.main ? "Principal" : p.editable ? "Desde el panel" : "En board.config.json" })]),
    h("dl", { class: "ws-facts" }, facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
  ];
  if (!p.root || !p.rootExists) kids.push(h("div", { class: "setup-note warn" }, [h("p", { text: p.root ? "Esa carpeta no existe en este ordenador: sus sesiones no se reconocerán aquí." : "Este ordenador no tiene carpeta para el proyecto: pon la suya en Editar." })]));
  if (!p.editable) {
    kids.push(h("p", { class: "meta", text: "Se configura en board.config.json de cada ordenador, con todos sus módulos." }));
    return h("section", { class: "card setting-card" }, kids);
  }
  if (p.messages) kids.push(h("p", { class: "meta", text: "Tiene guía propia para las sesiones." }));
  kids.push(credentials(p));
  kids.push(
    h("div", { class: "actions" }, [
      button("Editar", { onClick: () => ((editing = { id: p.id, name: p.name, taskPrefix: p.taskPrefix, root: p.root || "", daily: p.modules.daily, contextTidy: p.modules.context, ...(p.messages || {}) }), render()) }),
      button("Borrar", {
        cls: "subtle",
        onClick: async (b) => {
          if (!window.confirm(`¿Borrar el proyecto «${p.name}» del tablero? Su carpeta y su repo no se tocan.`)) return;
          b.disabled = true;
          try {
            await requestOrFail("/api/projects-admin/remove", { id: p.id });
            toast(`${p.name} borrado del tablero.`);
            reload();
          } catch (e) {
            toast(`No se pudo borrar: ${e.message}`);
            b.disabled = false;
          }
        },
      }),
    ])
  );
  return h("section", { class: "card setting-card" }, kids);
}

export function renderWorkspaces(root) {
  if (!list) {
    load();
    return root.appendChild(failed ? empty("No se pudieron leer los proyectos.", failed) : empty("Cargando proyectos…", ""));
  }
  root.appendChild(h("div", { class: "actions ws-top" }, [button("Nuevo proyecto", { cls: "primary", onClick: () => ((editing = { name: "", taskPrefix: "", root: "" }), render()) })]));
  if (editing && !editing.id) root.appendChild(form(editing));
  for (const p of list) root.appendChild(editing && editing.id === p.id ? form(editing) : card(p));
}
