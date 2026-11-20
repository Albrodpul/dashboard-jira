import { state, h, button, toast, requestOrFail, render, refresh, empty, areaSelectFrom } from "../lib/base.js";
import { t, tn } from "../lib/i18n.js";
import { group, row, note } from "../components/settings-ui.js";

const base = () => (state.jiraSetup && state.jiraSetup.workspaceBase) || "";
function relative(root) {
  const b = base();
  const r = String(root || "").replace(/\\/g, "/");
  return b && r.toLowerCase().startsWith(b.toLowerCase() + "/") ? r.slice(b.length + 1) : r;
}

const MODULES = { jira: t("Jira y su reporte"), followUp: t("Seguimiento"), sentry: "Sentry", deploy: t("Despliegues"), devServers: t("Servidores locales"), daily: "Daily", context: t("Ordenar contexto") };
const OPTIONAL = { daily: ["Daily", t("Un resumen al final del día con las tareas y los commits de este proyecto.")], contextTidy: [t("Ordenar contexto"), t("Pasadas de orden sobre el contexto del proyecto, con sus propias reglas (su AGENTS.md).")] };
const SECRETS = { JIRA_SITE: t("Sitio de Jira"), JIRA_EMAIL: t("Correo de Jira"), JIRA_TOKEN: t("Token de Jira"), SENTRY_TOKEN: t("Token de Sentry") };
const GUIDE = {
  review: [t("Al dar una tarea por hecha"), t("Qué tiene que hacer la sesión antes de avisar «done». Sin texto: solo avisar al tablero.")],
  cause: [t("Al cerrar una devuelta"), t("Qué apunta la sesión cuando le devuelven una tarea. Sin texto: nada.")],
  reference: [t("Dónde están las reglas"), t("Fichero del proyecto que explica cómo trabajar las tareas, por ejemplo AGENTS.md.")],
};

let list = null;
let loading = false;
let failed = "";
let editing = null;
let secrets = {};
const openDetails = new Set();

function keptDetails(key, kids) {
  const d = h("details", { class: "ws-guide" }, kids);
  if (openDetails.has(key)) d.open = true;
  d.addEventListener("toggle", () => (d.open ? openDetails.add(key) : openDetails.delete(key)));
  return d;
}

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
  const box = h("textarea", { class: "reply-box", placeholder });
  box.value = draft[key] || "";
  box.addEventListener("input", () => (draft[key] = box.value));
  return box;
}

function form(draft) {
  const isNew = !draft.id;
  const save = button(isNew ? t("Crear proyecto") : t("Guardar"), {
    cls: "primary",
    onClick: async (b) => {
      b.disabled = true;
      try {
        const integrations = draft.fromFile
          ? {}
          : {
              jira: draft.jiraOn ? { projects: draft.jiraProjects || "" } : null,
              sentry: draft.sentryOn ? { org: draft.sentryOrg || "", projects: draft.sentryProjects || "", errorsArea: draft.errorsArea || "" } : null,
            };
        const body = { name: draft.name, taskPrefix: draft.taskPrefix, ...(draft.fromFile ? {} : { root: draft.root || "", devServers: draft.devServers || [] }), ...integrations, daily: !!draft.daily, contextTidy: !!draft.contextTidy, messages: { review: draft.review, cause: draft.cause, reference: draft.reference } };
        if (!isNew) Object.assign(body, { id: draft.id, create: false });
        const r = await requestOrFail("/api/projects-admin/save", body);
        editing = null;
        toast(isNew ? (r.commands ? t("Proyecto creado; comandos en {folder}.", { folder: r.commands.folder }) : t("Proyecto creado.")) : t("Proyecto guardado."));
        reload();
      } catch (e) {
        toast(t("No se pudo guardar: {error}", { error: e.message }));
        b.disabled = false;
      }
    },
  });
  const cancel = button(t("Cancelar"), { cls: "subtle", onClick: () => ((editing = null), render()) });
  return h("section", { class: "sg ws-form" }, [
    h("h3", { text: isNew ? t("Nuevo proyecto") : t("Editar {name}", { name: draft.name }) }),
    field(t("Nombre"), null, text(draft, "name", { placeholder: t("Cuentas personales") })),
    field(t("Prefijo de las tareas"), t("De 2 a 10 letras. Las tareas que crees a mano se llamarán así: PREFIJO-1, PREFIJO-2…"), text(draft, "taskPrefix", { placeholder: t("CUENTAS") })),
    draft.fromFile
      ? field(t("Carpeta en este ordenador"), t("Se cambia en board.config.json de cada ordenador."), h("input", { type: "text", value: draft.root || "", disabled: true }))
      : field(
          t("Carpeta dentro de workspace"),
          t("Va dentro de {base}; si no existe, se crea. Vacío: una carpeta con el nombre del proyecto. Las sesiones abiertas dentro de ella son de este proyecto.", { base: base() || "workspace" }),
          h("div", { class: "ws-folder" }, [h("span", { class: "ws-folder-base", title: base(), text: `${base().split("/").pop() || "workspace"}/` }), text(draft, "root", { placeholder: t("nombre-del-proyecto") })])
        ),
    h("div", { class: "ws-checks" }, Object.entries(OPTIONAL).map(([k, [label, hint]]) => {
      const box = h("input", { type: "checkbox" });
      box.checked = !!draft[k];
      box.addEventListener("change", () => (draft[k] = box.checked));
      return h("label", { class: "rule" }, [box, h("span", {}, [h("strong", { text: label }), ` · ${hint}`])]);
    })),
    draft.fromFile ? null : integration(draft, "jiraOn", "Jira", t("Las tareas de sus proyectos de Jira entran en el reporte y se mueven y comentan en su propio Jira. Después de guardar, pon sus credenciales y pulsa «Conectar con Jira»."), () => [
          field(t("Proyectos de Jira"), t("Sus claves, separadas por comas: OPS, WEB. Ninguna puede estar en otro proyecto del tablero."), text(draft, "jiraProjects", { placeholder: "OPS" })),
        ]),
    draft.fromFile ? null : integration(draft, "sentryOn", "Sentry", t("Sus errores salen en Errores, junto a los de los demás proyectos. El token va en las credenciales del proyecto."), () => [
          field(t("Organización"), t("Como aparece en la dirección de Sentry: sentry.io/organizations/<organización>."), text(draft, "sentryOrg", { placeholder: t("mi-empresa") })),
          field(t("Proyectos de Sentry"), t("Separados por comas."), text(draft, "sentryProjects", { placeholder: "web, api" })),
          field(t("Sesión que recibe sus errores"), t("La que sale elegida al mandar un error. Se puede cambiar en cada uno."), areaSelectFrom(state.areas.filter((a) => !a.unnamed && (!draft.id || a.project === draft.id)), `errors-${draft.id || "new"}`, draft.errorsArea || "", t("Ninguna"), (v) => (draft.errorsArea = v))),
        ]),
    draft.fromFile ? null : serversEditor(draft),
    keptDetails(`guide-${draft.id || "new"}`, [
      h("summary", { text: t("Guía para las sesiones (opcional)") }),
      ...Object.entries(GUIDE).map(([k, [label, hint]]) => field(label, hint, area(draft, k, draft.fromFile ? t("Sin texto: las frases de siempre") : ""))),
    ]),
    h("div", { class: "actions" }, [save, cancel]),
  ]);
}

function integration(draft, key, label, hint, body) {
  const box = h("input", { type: "checkbox" });
  box.checked = !!draft[key];
  const inner = h("div", { class: "ws-integration-body" });
  const paint = () => inner.replaceChildren(...(draft[key] ? body() : []));
  box.addEventListener("change", () => ((draft[key] = box.checked), paint()));
  paint();
  return h("div", { class: "ws-checks ws-integration" }, [h("label", { class: "rule" }, [box, h("span", {}, [h("strong", { text: label }), ` · ${hint}`])]), inner]);
}

function jiraConnect(p) {
  const j = p.jiraConfig;
  const draft = (secrets[`jira-${p.id}`] = secrets[`jira-${p.id}`] || { reviewer: j.reviewer || "" });
  const steps = j.transitions.length ? j.transitions.map((x) => ({ start: t("En curso"), todo: t("Por hacer"), block: t("Bloqueada") })[x] || x).join(", ") : t("ninguno");
  const status = j.connected ? t(j.reviewer ? "Conectado como {me}; revisa {reviewer}. Pasos de estado: {steps}." : "Conectado como {me}. Pasos de estado: {steps}.", { me: j.me, reviewer: j.reviewer, steps }) : t("Sin conectar: el reporte no lo lee hasta que pulses «Conectar con Jira».");
  const go = button(t("Conectar con Jira"), {
    onClick: async (b) => {
      b.disabled = true;
      try {
        const r = await requestOrFail("/api/projects-admin/connect-jira", { id: p.id, sample: draft.sample || "", reviewer: draft.reviewer || "" });
        toast(t("Conectado como {me}.", { me: r.me }) + (r.notes && r.notes.length ? ` ${t("Ojo: {notes}.", { notes: r.notes.join("; ") })}` : ""));
        reload();
      } catch (e) {
        toast(t("No se pudo conectar: {error}", { error: e.message }));
        b.disabled = false;
      }
    },
  });
  return keptDetails(`jira-${p.id}`, [
    h("summary", { text: t("Conexión con Jira") }),
    h("p", { class: "meta", text: status }),
    field(t("Un ticket tuyo"), t("Cualquiera de sus proyectos. De él se sacan los pasos a «En curso» y «Por hacer». Mejor uno que esté en «Por hacer»."), text(draft, "sample", { placeholder: `${j.projects[0]}-1` })),
    field(t("Quién revisa tu trabajo"), t("Su nombre en ese Jira. Vacío: nadie."), text(draft, "reviewer", { placeholder: t("Nombre Apellido") })),
    h("div", { class: "actions" }, [go]),
  ]);
}

function serversEditor(draft) {
  draft.devServers = draft.devServers || [];
  const rows = h("div", { class: "ws-servers" });
  const paint = () => {
    rows.replaceChildren(
      ...draft.devServers.map((x, i) => {
        const input = (key, attrs) => {
          const el = h("input", { type: key === "port" ? "number" : "text", value: x[key] == null ? "" : String(x[key]), ...attrs });
          el.addEventListener("input", () => (x[key] = el.value));
          return el;
        };
        return h("div", { class: "ws-server" }, [
          input("name", { placeholder: t("Nombre"), "aria-label": t("Nombre del servidor") }),
          input("port", { placeholder: t("Puerto"), min: "1024", max: "65535", "aria-label": t("Puerto") }),
          input("command", { placeholder: "npm run dev", "aria-label": t("Comando") }),
          button(t("Quitar"), { cls: "subtle", onClick: () => (draft.devServers.splice(i, 1), paint()) }),
        ]);
      })
    );
  };
  paint();
  return h("div", { class: "ws-field" }, [
    h("span", { class: "ws-label", text: t("Servidores locales") }),
    h("span", { class: "meta", text: t("Se arrancan desde la carpeta del proyecto y salen en Servidores. El puerto no puede repetirse con el de otro proyecto.") }),
    rows,
    h("div", { class: "actions" }, [button(t("Añadir servidor"), { onClick: () => (draft.devServers.push({ name: "", port: "", command: "npm run dev" }), paint()) })]),
  ]);
}

function credentials(p) {
  const draft = (secrets[p.id] = secrets[p.id] || {});
  const inputs = Object.entries(SECRETS).map(([k, label]) => {
    const input = h("input", { type: "password", autocomplete: "off", placeholder: p.credentials[k] ? t("Puesta: escribe para cambiarla") : t("Falta"), value: draft[k] || "" });
    input.addEventListener("input", () => (draft[k] = input.value));
    return field(label, null, input);
  });
  const save = button(t("Guardar credenciales"), {
    onClick: async (b) => {
      const values = Object.fromEntries(Object.entries(draft).filter(([, v]) => v));
      if (!Object.keys(values).length) return toast(t("No has escrito ninguna."));
      b.disabled = true;
      try {
        await requestOrFail("/api/projects-admin/credentials", { id: p.id, values });
        secrets[p.id] = {};
        toast(t("Credenciales guardadas en este ordenador."));
        reload();
      } catch (e) {
        toast(t("No se pudieron guardar: {error}", { error: e.message }));
        b.disabled = false;
      }
    },
  });
  return keptDetails(`cred-${p.id}`, [h("summary", { text: t("Credenciales de este ordenador") }), h("p", { class: "meta", text: t("Se guardan solo aquí, en su propio fichero. Nunca se enseñan: solo si están puestas o faltan.") }), ...inputs, h("div", { class: "actions" }, [save])]);
}

function card(p) {
  const active = Object.entries(p.modules).filter(([, on]) => on).map(([k]) => MODULES[k]);
  const facts = [
    [t("Prefijo de las tareas"), p.taskPrefix],
    [t("Carpeta en este ordenador"), p.root || t("sin carpeta")],
    [t("Agente"), p.agent === "claude" ? "Claude Code" : p.agent],
    [t("Módulos"), active.length ? active.join(", ") : t("ninguno")],
    [t("Servidores"), p.devServers.length ? p.devServers.map((x) => `${x.name} (${x.port})`).join(", ") : t("ninguno")],
    [t("Tareas abiertas"), String(p.openTasks)],
  ];
  if (p.jira) facts.splice(4, 0, [t("Proyectos de Jira"), p.jira.join(", ")]);
  if (p.sentryConfig) facts.splice(4, 0, ["Sentry", `${p.sentryConfig.org}: ${p.sentryConfig.projects.join(", ")}`]);
  const rows = facts.map(([k, v]) => row(k, null, h("span", { class: "ws-value", text: v }), { cls: "ws-fact" }));
  const foot = [];
  if (!p.root || !p.rootExists) foot.push(note(p.root ? t("Esa carpeta no existe en este ordenador: sus sesiones no se reconocerán aquí.") : t("Este ordenador no tiene carpeta para el proyecto: pon la suya en Editar."), true));
  if (p.fromFile) foot.push(h("p", { class: "meta", text: t("Su Jira, su Sentry, sus servidores, sus credenciales y su carpeta van en board.config.json y el .env de cada ordenador; el nombre, el prefijo, la daily, Ordenar contexto y la guía se editan aquí y valen para los dos.") }));
  if (p.messages) foot.push(h("p", { class: "meta", text: t("Tiene guía propia para las sesiones.") }));
  if (!p.main) foot.push(credentials(p));
  if (!p.fromFile && p.jiraConfig) foot.push(jiraConnect(p));
  const actions = [
    button(t("Editar"), { onClick: () => ((editing = { id: p.id, fromFile: p.fromFile, name: p.name, taskPrefix: p.taskPrefix, root: p.fromFile ? p.root || "" : relative(p.root), daily: p.modules.daily, contextTidy: p.modules.context, devServers: p.devServers.map((x) => ({ ...x })), jiraOn: !!p.jiraConfig, jiraProjects: p.jiraConfig ? p.jiraConfig.projects.join(", ") : "", sentryOn: !!p.sentryConfig, sentryOrg: p.sentryConfig ? p.sentryConfig.org : "", sentryProjects: p.sentryConfig ? p.sentryConfig.projects.join(", ") : "", errorsArea: p.sentryConfig ? p.sentryConfig.errorsArea : "", ...(p.messages || {}) }), render()) }),
  ];
  if (!p.main)
    actions.push(
      button(t("Borrar"), {
        cls: "subtle",
        onClick: async (b) => {
          if (!window.confirm(t("¿Borrar el proyecto «{name}» del tablero? Su carpeta y su repo no se tocan.", { name: p.name }))) return;
          b.disabled = true;
          try {
            await requestOrFail("/api/projects-admin/remove", { id: p.id });
            toast(t("{name} borrado del tablero.", { name: p.name }));
            reload();
          } catch (e) {
            toast(t("No se pudo borrar: {error}", { error: e.message }));
            b.disabled = false;
          }
        },
      })
    );
  const title = h("span", { class: "ws-title" }, [p.name, h("span", { class: "chip", text: p.main ? t("Principal") : p.fromFile ? t("En board.config.json") : t("Desde el panel") })]);
  return group(title, rows, { actions, foot: foot.length ? foot : null, cls: "ws-group" });
}

export function renderWorkspaces(root) {
  if (!list) {
    load();
    return root.appendChild(failed ? empty(t("No se pudieron leer los proyectos."), failed) : empty(t("Cargando proyectos…"), ""));
  }
  root.appendChild(h("div", { class: "sg-bar" }, [h("span", { class: "meta", text: tn(list.length, "{n} proyecto en el tablero", "{n} proyectos en el tablero") }), button(t("Nuevo proyecto"), { cls: "primary", onClick: () => ((editing = { name: "", taskPrefix: "", root: "" }), render()) })]));
  if (editing && !editing.id) root.appendChild(form(editing));
  for (const p of list) root.appendChild(editing && editing.id === p.id ? form(editing) : card(p));
}
