import { state, h, button, when, toast, requestOrFail, render, empty } from "../lib/base.js";
import { currentProject, mixedProjects, projectName } from "../components/project-filter.js";

const STATE_LABEL = { up: "Funcionando", starting: "Arrancando…", down: "Parado" };
const DOT = { up: "on", starting: "busy", down: "off" };
let data = null;
let tunnel = null;
let loading = false;
const busy = new Set();

function load() {
  if (loading) return;
  loading = true;
  const get = (u) => fetch(u, { cache: "no-store" }).then((r) => r.json());
  Promise.all([get("/api/devservers"), get("/api/tunnel").catch(() => null)])
    .then(([d, t]) => ((data = d), (tunnel = t)))
    .catch(() => (data = { servers: [], error: "No se pudo leer el estado de los proyectos." }))
    .finally(() => {
      loading = false;
      if (state.tab === "projects") render();
    });
}

setInterval(() => state.tab === "projects" && !document.hidden && load(), 4000);

function act(action, id, label, b) {
  const key = id || action;
  busy.add(key);
  if (b) b.disabled = true;
  requestOrFail("/api/devservers", { action, id, project: currentProject() || undefined })
    .then(() => toast(label))
    .catch((e) => toast(`No se pudo: ${e.message}`))
    .finally(() => {
      busy.delete(key);
      load();
    });
}

const ROLE = { mysql: "Base de datos", mariadb: "Base de datos", postgres: "Base de datos", redis: "Caché" };
const roleOf = (s) => s.role || ROLE[String(s.id).toLowerCase()] || ROLE[String(s.name).toLowerCase()] || "";

function tunnelAct(action, b) {
  busy.add("tunnel");
  if (b) b.disabled = true;
  requestOrFail("/api/tunnel", { action })
    .then(() => toast(action === "open" ? "Túnel abierto." : "Túnel cerrado."))
    .catch((e) => toast(`No se pudo: ${e.message}`))
    .finally(() => {
      busy.delete("tunnel");
      load();
    });
}

function tunnelPanel() {
  const t = tunnel || {};
  if (!t.remote && !t.open) return null;
  const who = (t.remote && t.remote.label) || "el otro ordenador";
  const working = busy.has("tunnel");
  if (t.open)
    return h("div", { class: "proj-tunnel open" }, [
      h("div", { class: "proj-tunnel-text" }, [
        h("strong", { text: `Viendo los proyectos del ${who}` }),
        h("span", { class: "meta", text: `Abre los enlaces en el navegador de este ordenador: van por un túnel comprimido al ${who}, con el login funcionando. Abierto ${when(t.since)}.` }),
      ]),
      button("Cerrar túnel", { cls: "subtle", disabled: working, onClick: (b) => tunnelAct("close", b) }),
    ]);
  return h("div", { class: "proj-tunnel" }, [
    h("div", { class: "proj-tunnel-text" }, [
      h("strong", { text: `Los proyectos corren en el ${who}` }),
      h("span", { class: "meta", text: `Para usar las webs del otro ordenador desde este, login incluido, ábrelos por un túnel.${t.error ? ` Último error: ${t.error}` : ""}` }),
    ]),
    button(working ? "Abriendo…" : `Ver proyectos del ${who}`, { cls: "primary", disabled: working, onClick: (b) => tunnelAct("open", b) }),
  ]);
}

function row(s) {
  const working = busy.has(s.id);
  const actions = [];
  const tunneled = tunnel && tunnel.open;
  if (s.url && s.state === "up" && (tunneled || !(tunnel && tunnel.remote))) actions.push(h("a", { class: "btn link", href: tunneled ? `http://localhost:${s.port}` : `${location.protocol}//${location.hostname}:${s.port}`, target: "_blank", rel: "noopener", text: "Abrir ↗" }));
  if (s.state === "down") actions.push(button("Arrancar", { cls: "primary", disabled: working, onClick: (b) => act("start", s.id, `Arrancando ${s.name}…`, b) }));
  else {
    actions.push(button("Reiniciar", { disabled: working, onClick: (b) => act("restart", s.id, `Reiniciando ${s.name}…`, b) }));
    actions.push(button("Parar", { cls: "subtle", disabled: working, onClick: (b) => window.confirm(`¿Parar ${s.name}? Si alguna sesión lo está usando, se queda sin él.`) && act("stop", s.id, `${s.name} parado.`, b) }));
  }
  const st = working ? "starting" : s.state;
  return h("div", { class: `proj-row ${st}` }, [
    h("span", { class: `dot ${DOT[st]}` }),
    h("div", { class: "proj-main" }, [
      h("div", { class: "proj-name" }, [h("strong", { text: s.name }), h("span", { class: "proj-port", text: `:${s.port}` })]),
      h("span", { class: "meta", text: [roleOf(s), s.autoStart ? "" : "lo arranca la sesión que lo necesita"].filter(Boolean).join(" · ") }),
    ]),
    h("span", { class: `proj-state ${st}`, text: working ? "Un momento…" : STATE_LABEL[s.state] }),
    h("div", { class: "proj-actions" }, actions),
  ]);
}

export function renderProjects(root) {
  if (!data) {
    load();
    return root.appendChild(empty("Mirando qué proyectos están en marcha…", ""));
  }
  if (data.error) root.appendChild(h("div", { class: "setup-note warn", text: data.error }));
  const picked = currentProject();
  const servers = data.servers.filter((s) => !picked || s.project === picked);
  if (!servers.length) return root.appendChild(empty(picked ? `${projectName(picked)} no tiene servidores locales.` : "No hay servidores locales configurados.", "Se añaden en devServers de cada proyecto."));
  const panel = tunnelPanel();
  if (panel) root.appendChild(panel);
  const up = servers.filter((s) => s.state === "up").length;
  const auto = data.autoStartedOn ? `Hoy arrancaron solos con el primer reporte (${data.autoStartedOn.split("-").reverse().slice(0, 2).join("/")}).` : "Arrancan solos con el primer reporte del día.";
  root.appendChild(
    h("div", { class: "proj-summary" }, [
      h("div", { class: "proj-count" }, [h("strong", { text: `${up} de ${servers.length}` }), h("span", { text: " funcionando" }), h("span", { class: "meta", text: ` · comprobado ${when(data.at)}` })]),
      h("div", { class: "proj-bulk" }, [
        button("Parar todos", { cls: "subtle", disabled: busy.has("stopAll") || !up, onClick: (b) => window.confirm(picked ? `¿Parar todos los servidores de ${projectName(picked)}?` : "¿Parar todos los servidores?") && act("stopAll", null, "Proyectos parados.", b) }),
        button("Arrancar todos", { cls: "primary", disabled: busy.has("startAll") || up === servers.length, onClick: (b) => act("startAll", null, "Arrancando los que estaban parados…", b) }),
      ]),
    ])
  );
  const groups = [...new Set(servers.map((s) => s.project))];
  if (mixedProjects() && groups.length > 1)
    for (const id of groups) {
      const mine = servers.filter((s) => s.project === id);
      root.appendChild(h("h3", { class: "project-title" }, [projectName(id), h("span", { class: "n", text: String(mine.length) })]));
      root.appendChild(h("div", { class: "proj-list" }, mine.map(row)));
    }
  else root.appendChild(h("div", { class: "proj-list" }, servers.map(row)));
  root.appendChild(h("p", { class: "meta proj-note", text: `${auto} Se paran solos a las ${(state.workSchedule || {}).end || "18:30"} de lunes a viernes, salvo con el modo fuera de horario; si los arrancas después, siguen hasta el día siguiente.` }));
}
