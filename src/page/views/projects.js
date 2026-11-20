import { state, h, button, when, toast, requestOrFail, render, empty } from "../lib/base.js";
import { currentProject, mixedProjects, projectName, inProjectOrder } from "../components/project-filter.js";
import { t } from "../lib/i18n.js";

const STATE_LABEL = { up: t("Funcionando"), starting: t("Arrancando…"), down: t("Parado") };
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
    .catch(() => (data = { servers: [], error: t("No se pudo leer el estado de los proyectos.") }))
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
    .catch((e) => toast(t("No se pudo: {error}", { error: e.message })))
    .finally(() => {
      busy.delete(key);
      load();
    });
}

const ROLE = { mysql: t("Base de datos"), mariadb: t("Base de datos"), postgres: t("Base de datos"), redis: t("Caché") };
const roleOf = (s) => s.role || ROLE[String(s.id).toLowerCase()] || ROLE[String(s.name).toLowerCase()] || "";

function tunnelAct(action, b) {
  busy.add("tunnel");
  if (b) b.disabled = true;
  requestOrFail("/api/tunnel", { action })
    .then(() => toast(action === "open" ? t("Túnel abierto.") : t("Túnel cerrado.")))
    .catch((e) => toast(t("No se pudo: {error}", { error: e.message })))
    .finally(() => {
      busy.delete("tunnel");
      load();
    });
}

function tunnelPanel() {
  const tun = tunnel || {};
  if (!tun.remote && !tun.open) return null;
  const remote = tun.remote && tun.remote.label;
  const working = busy.has("tunnel");
  if (tun.open)
    return h("div", { class: "proj-tunnel open" }, [
      h("div", { class: "proj-tunnel-text" }, [
        h("strong", { text: remote ? t("Viendo los proyectos del {who}", { who: remote }) : t("Viendo los proyectos del otro ordenador") }),
        h("span", { class: "meta", text: t(remote ? "Abre los enlaces en el navegador de este ordenador: van por un túnel comprimido al {who}, con el login funcionando. Abierto {time}." : "Abre los enlaces en el navegador de este ordenador: van por un túnel comprimido al otro ordenador, con el login funcionando. Abierto {time}.", { who: remote, time: when(tun.since) }) }),
      ]),
      button(t("Cerrar túnel"), { cls: "subtle", disabled: working, onClick: (b) => tunnelAct("close", b) }),
    ]);
  return h("div", { class: "proj-tunnel" }, [
    h("div", { class: "proj-tunnel-text" }, [
      h("strong", { text: remote ? t("Los proyectos corren en el {who}", { who: remote }) : t("Los proyectos corren en el otro ordenador") }),
      h("span", { class: "meta", text: t("Para usar las webs del otro ordenador desde este, login incluido, ábrelos por un túnel.") + (tun.error ? ` ${t("Último error: {error}", { error: tun.error })}` : "") }),
    ]),
    button(working ? t("Abriendo…") : remote ? t("Ver proyectos del {who}", { who: remote }) : t("Ver proyectos del otro ordenador"), { cls: "primary", disabled: working, onClick: (b) => tunnelAct("open", b) }),
  ]);
}

function row(s) {
  const working = busy.has(s.id);
  const actions = [];
  const tunneled = tunnel && tunnel.open;
  if (s.url && s.state === "up" && (tunneled || !(tunnel && tunnel.remote))) actions.push(h("a", { class: "btn link", href: tunneled ? `http://localhost:${s.port}` : `${location.protocol}//${location.hostname}:${s.port}`, target: "_blank", rel: "noopener", text: t("Abrir ↗") }));
  if (s.state === "down") actions.push(button(t("Arrancar"), { cls: "primary", disabled: working, onClick: (b) => act("start", s.id, t("Arrancando {name}…", { name: s.name }), b) }));
  else {
    actions.push(button(t("Reiniciar"), { disabled: working, onClick: (b) => act("restart", s.id, t("Reiniciando {name}…", { name: s.name }), b) }));
    actions.push(button(t("Parar"), { cls: "subtle", disabled: working, onClick: (b) => window.confirm(t("¿Parar {name}? Si alguna sesión lo está usando, se queda sin él.", { name: s.name })) && act("stop", s.id, t("{name} parado.", { name: s.name }), b) }));
  }
  const st = working ? "starting" : s.state;
  return h("div", { class: `proj-row ${st}` }, [
    h("span", { class: `dot ${DOT[st]}` }),
    h("div", { class: "proj-main" }, [
      h("div", { class: "proj-name" }, [h("strong", { text: s.name }), h("span", { class: "proj-port", text: `:${s.port}` })]),
      h("span", { class: "meta", text: [roleOf(s), s.autoStart ? "" : t("lo arranca la sesión que lo necesita")].filter(Boolean).join(" · ") }),
    ]),
    h("span", { class: `proj-state ${st}`, text: working ? t("Un momento…") : STATE_LABEL[s.state] }),
    h("div", { class: "proj-actions" }, actions),
  ]);
}

function autoToggle(id, label) {
  const on = !!(data.autoProjects || {})[id];
  const box = h("input", { type: "checkbox", disabled: busy.has(`auto-${id}`) });
  box.checked = on;
  box.addEventListener("change", () => {
    busy.add(`auto-${id}`);
    requestOrFail("/api/devservers", { action: "autoProject", project: id, on: box.checked })
      .then(() => toast(t(box.checked ? "{name} arrancará solo con el primer reporte del día." : "{name} ya no arranca solo.", { name: projectName(id) })))
      .catch((e) => {
        box.checked = on;
        toast(t("No se pudo: {error}", { error: e.message }));
      })
      .finally(() => {
        busy.delete(`auto-${id}`);
        load();
      });
  });
  return h("label", { class: "proj-auto", title: t("Con el primer reporte del día, de lunes a viernes") }, [box, h("span", { text: label })]);
}

export function renderProjects(root) {
  if (!data) {
    load();
    return root.appendChild(empty(t("Mirando qué proyectos están en marcha…"), ""));
  }
  if (data.error) root.appendChild(h("div", { class: "setup-note warn", text: data.error }));
  const picked = currentProject();
  const servers = data.servers.filter((s) => !picked || s.project === picked);
  if (!servers.length) return root.appendChild(empty(picked ? t("{name} no tiene servidores locales.", { name: projectName(picked) }) : t("No hay servidores locales configurados."), t("Se añaden en devServers de cada proyecto.")));
  const panel = tunnelPanel();
  if (panel) root.appendChild(panel);
  const up = servers.filter((s) => s.state === "up").length;
  const auto = data.autoStartedOn ? t("Hoy arrancaron solos con el primer reporte ({date}).", { date: data.autoStartedOn.split("-").reverse().slice(0, 2).join("/") }) : t("Los proyectos marcados arrancan solos con el primer reporte del día.");
  root.appendChild(
    h("div", { class: "proj-summary" }, [
      h("div", { class: "proj-count" }, [h("strong", { text: t("{up} de {total}", { up, total: servers.length }) }), h("span", { text: ` ${t("funcionando")}` }), h("span", { class: "meta", text: ` · ${t("comprobado {time}", { time: when(data.at) })}` })]),
      h("div", { class: "proj-bulk" }, [
        button(t("Parar todos"), { cls: "subtle", disabled: busy.has("stopAll") || !up, onClick: (b) => window.confirm(picked ? t("¿Parar todos los servidores de {name}?", { name: projectName(picked) }) : t("¿Parar todos los servidores?")) && act("stopAll", null, t("Proyectos parados."), b) }),
        button(t("Arrancar todos"), { cls: "primary", disabled: busy.has("startAll") || up === servers.length, onClick: (b) => act("startAll", null, t("Arrancando los que estaban parados…"), b) }),
      ]),
    ])
  );
  const groups = inProjectOrder(servers.map((s) => s.project));
  if (mixedProjects())
    for (const id of groups) {
      const mine = servers.filter((s) => s.project === id);
      root.appendChild(h("div", { class: "proj-group-head" }, [h("h3", { class: "project-title" }, [projectName(id), h("span", { class: "n", text: String(mine.length) })]), autoToggle(id, t("Arranca solo"))]));
      root.appendChild(h("div", { class: "proj-list" }, mine.map(row)));
    }
  else {
    if (groups.length === 1) root.appendChild(h("div", { class: "proj-group-head single" }, [autoToggle(groups[0], t("Arrancar {name} solo con el primer reporte del día", { name: projectName(groups[0]) }))]));
    root.appendChild(h("div", { class: "proj-list" }, servers.map(row)));
  }
  root.appendChild(h("p", { class: "meta proj-note", text: `${auto} ${t("Se paran solos a las {end} de lunes a viernes, salvo con el modo fuera de horario; si los arrancas después, siguen hasta el día siguiente.", { end: (state.workSchedule || {}).end || "18:30" })}` }));
}
