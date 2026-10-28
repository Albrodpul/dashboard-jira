import { state, h, button, when, toast, requestOrFail, render, empty } from "./base.js";

const STATE_LABEL = { up: "Funcionando", starting: "Arrancando…", down: "Parado" };
const DOT = { up: "on", starting: "busy", down: "off" };
let data = null;
let loading = false;
const busy = new Set();

function load() {
  if (loading) return;
  loading = true;
  fetch("/api/devservers", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => (data = d))
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
  requestOrFail("/api/devservers", { action, id })
    .then(() => toast(label))
    .catch((e) => toast(`No se pudo: ${e.message}`))
    .finally(() => {
      busy.delete(key);
      load();
    });
}

function row(s) {
  const working = busy.has(s.id);
  const actions = [];
  if (s.state === "down") actions.push(button("Arrancar", { cls: "primary", disabled: working, onClick: (b) => act("start", s.id, `Arrancando ${s.name}…`, b) }));
  else {
    actions.push(button("Reiniciar", { disabled: working, onClick: (b) => act("restart", s.id, `Reiniciando ${s.name}…`, b) }));
    actions.push(button("Parar", { cls: "subtle", disabled: working, onClick: (b) => window.confirm(`¿Parar ${s.name}? Si alguna sesión lo está usando, se queda sin él.`) && act("stop", s.id, `${s.name} parado.`, b) }));
  }
  if (s.url && s.state === "up") actions.push(h("a", { class: "btn link", href: `${location.protocol}//${location.hostname}:${s.port}`, target: "_blank", rel: "noopener", text: "Abrir" }));
  const kids = [
    h("div", { class: "top" }, [h("span", { class: `dot ${DOT[s.state]}` }), h("strong", { text: s.name }), h("span", { class: "meta", text: `:${s.port}${s.autoStart ? "" : " · lo arranca la sesión que lo necesita"}` }), h("span", { class: "meta dev-state", text: working ? "…" : STATE_LABEL[s.state] })]),
  ];
  kids.push(h("div", { class: "actions" }, actions));
  return h("article", { class: "card dev-server" }, kids);
}

export function renderProjects(root) {
  if (!data) {
    load();
    return root.appendChild(empty("Mirando qué proyectos están en marcha…", ""));
  }
  if (data.error) root.appendChild(h("div", { class: "setup-note warn", text: data.error }));
  if (!data.servers.length) return root.appendChild(empty("No hay proyectos configurados.", "Añádelos en devServers de board.config.json."));
  const up = data.servers.filter((s) => s.state === "up").length;
  const auto = data.autoStartedOn ? `Hoy arrancaron solos con el primer reporte (${data.autoStartedOn.split("-").reverse().slice(0, 2).join("/")}).` : "Arrancan solos con el primer reporte del día.";
  root.appendChild(h("p", { class: "setup-note", text: `${auto} Se paran solos a las 18:30, de lunes a viernes. Si los arrancas después, ya no se paran hasta el día siguiente.` }));
  root.appendChild(
    h("div", { class: "toolbar" }, [
      h("span", { class: "meta", text: `${up} de ${data.servers.length} funcionando · comprobado ${when(data.at)}` }),
      button("Arrancar todos", { cls: "primary", disabled: busy.has("startAll") || up === data.servers.length, onClick: (b) => act("startAll", null, "Arrancando los que estaban parados…", b) }),
      button("Parar todos", { cls: "subtle", disabled: busy.has("stopAll") || !up, onClick: (b) => window.confirm("¿Parar todos los proyectos?") && act("stopAll", null, "Proyectos parados.", b) }),
    ])
  );
  root.appendChild(h("div", { class: "cards" }, data.servers.map(row)));
}
