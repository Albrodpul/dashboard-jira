import { livePanel } from "./terminal.js";
import { state, h, button, when, minutesSince, toast, request, requestOrFail, post, whoSends, areaName, areaSelect, render, refresh, renderMd, empty, ticketUrl, reviewer, deployProjects, exampleKey } from "./base.js";

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


const DS_STATE = { success: "Desplegado", running: "En curso", failed: "Falló", cancelled: "Cancelado", unknown: "Sin datos" };
const DS_ENV = { develop: "Develop", production: "Producción" };
let dsBusy = false;

function ago(iso) {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "ahora mismo";
  if (m < 60) return `hace ${m} min`;
  return when(iso);
}

function lastRelease(id) {
  const item = state.deployStatus && state.deployStatus.items.find((x) => x.id === id);
  const ref = item && item.envs.production && item.envs.production.actions && item.envs.production.actions.ref;
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(ref || "");
  return m ? m.slice(1).map(Number) : null;
}

function nextVersion(id, level) {
  const v = lastRelease(id);
  if (!v) return "";
  const [x, y, z] = v;
  const next = level === "x" ? [x + 1, 0, 0] : level === "y" ? [x, y + 1, 0] : [x, y, z + 1];
  return `v${v.join(".")} → v${next.join(".")}`;
}

const ACTIONS_RUNNING = ["queued", "in_progress", "waiting", "requested", "pending"];
const CODEDEPLOY_RUNNING = ["Created", "Queued", "InProgress", "Baking", "Ready"];
const minutes = (from, to) => {
  const m = Math.round((new Date(to) - new Date(from)) / 60000);
  return m < 1 ? "menos de 1 min" : `${m} min`;
};

function actionsPhase(a) {
  if (!a) return null;
  if (ACTIONS_RUNNING.includes(a.status)) return { state: "running", text: a.progress ? `${a.progress.done} de ${a.progress.total} pasos` : "En curso", progress: a.progress };
  if (a.conclusion === "success") return { state: "success", text: `Hecho en ${minutes(a.startedAt, a.updatedAt)}` };
  return { state: a.conclusion === "cancelled" ? "cancelled" : "failed", text: a.conclusion === "cancelled" ? "Cancelado" : "Ha fallado" };
}

function codedeployPhase(e, first) {
  if (!e.hasCodedeploy) return null;
  const cd = e.codedeploy;
  if (!e.codedeployCurrent) {
    if (first && first.state === "running") return { state: "waiting", text: "Empieza cuando acaben las Actions" };
    if (first && first.state !== "success") return { state: "waiting", text: "No se lanza" };
    return { state: "running", text: "Esperando a que arranque" };
  }
  if (CODEDEPLOY_RUNNING.includes(cd.status)) {
    const machines = cd.total ? ` · ${cd.done} de ${cd.total} máquinas` : "";
    return { state: "running", text: (cd.progress ? `${cd.progress.done} de ${cd.progress.total} pasos` : "En curso") + machines, progress: cd.progress || (cd.total ? { done: cd.done, total: cd.total } : null) };
  }
  if (cd.status === "Succeeded") return { state: "success", text: `Hecho en ${minutes(cd.startedAt, cd.finishedAt)}` };
  return { state: cd.status === "Stopped" ? "cancelled" : "failed", text: `${cd.status}${cd.error ? ` · ${cd.error}` : ""}` };
}

function phaseRow(n, name, p) {
  const pct = p.progress && p.progress.total ? Math.round((p.progress.done / p.progress.total) * 100) : null;
  const bar = h("div", { class: `ds-bar ${p.state}${p.state === "running" && pct === null ? " indeterminate" : ""}`, role: "progressbar", "aria-label": name, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(p.state === "success" ? 100 : pct || 0) }, [h("i", { style: `width:${p.state === "success" ? 100 : p.state === "running" ? pct || 0 : p.state === "waiting" ? 0 : 100}%` })]);
  return h("div", { class: `ds-phase ${p.state}` }, [h("span", { class: "ds-phase-n", text: String(n) }), h("span", { class: "ds-phase-name", text: name }), h("span", { class: "ds-phase-text", text: p.text }), bar]);
}

const PHASE_SHORT = { "GitHub Actions": "Actions", CodeDeploy: "CodeDeploy" };

function statusRow(env, e) {
  const a = e.actions;
  const cd = e.codedeploy;
  const first = actionsPhase(a);
  const second = codedeployPhase(e, first);
  const named = [first && ["GitHub Actions", first], second && ["CodeDeploy", second]].filter(Boolean);
  const allDone = named.length && named.every(([, p]) => p.state === "success");
  const ref = a && a.ref && a.ref !== env ? a.ref.replace(/-release$/, "") : null;
  const details = !named.length
    ? [h("div", { class: "meta", text: e.step })]
    : allDone
      ? [h("div", { class: "meta ds-summary", text: named.map(([n, p]) => `${PHASE_SHORT[n]} ${p.text.replace(/^Hecho en /, "").replace("menos de 1 min", "<1 min")}`).join(" · ") })]
      : [h("div", { class: "ds-phases" }, named.map(([n, p], i) => phaseRow(i + 1, n, p)))];
  const kids = [
    h("span", { class: `ds-dot ${e.state}`, title: DS_STATE[e.state] || e.state, "aria-hidden": "true" }),
    h("div", { class: "ds-main" }, [
      h("div", { class: "ds-line" }, [
        h("strong", { text: DS_ENV[env] }),
        ref ? h("code", { class: "ds-ref", text: ref, title: a.ref }) : null,
        e.state === "success" ? h("span", { class: "visually-hidden", text: DS_STATE.success }) : h("span", { class: `chip ds-${e.state}`, text: DS_STATE[e.state] || e.state }),
        a ? h("span", { class: "meta ds-ago", text: ago(e.state === "running" ? a.startedAt : (e.codedeployCurrent && cd && cd.finishedAt) || a.updatedAt) }) : null,
      ]),
      ...details,
    ]),
  ];
  if (a && a.url) kids.push(h("a", { class: "ds-link", href: a.url, target: "_blank", rel: "noopener", title: "Ver en GitHub Actions", "aria-label": `Ver ${DS_ENV[env].toLowerCase()} en GitHub Actions`, text: "↗" }));
  return h("div", { class: `ds-row ${e.state}` }, kids);
}

function deployStatusPanel(root) {
  const st = state.deployStatus;
  const refreshBtn = button(dsBusy ? "Comprobando…" : "Comprobar ahora", {
    cls: "ds-refresh",
    disabled: dsBusy,
    onClick: () => {
      dsBusy = true;
      render();
      requestOrFail("/api/deploy-status/refresh", {})
        .catch(() => toast("No se pudo comprobar el estado de los despliegues."))
        .then(() => {
          dsBusy = false;
          return refresh(true);
        });
    },
  });
  root.appendChild(h("div", { class: "group-head" }, [h("span", { class: "group-name", text: "Estado ahora" }), h("span", { class: "meta", text: st ? `Comprobado ${ago(st.at)}` : "Sin comprobar todavía" }), refreshBtn]));
  if (!st) return root.appendChild(empty("Todavía no hay estado.", "Añade el repo de cada proyecto en deployProjects de board.config.json para seguir sus despliegues."));
  const grid = h("div", { class: "ds-grid" });
  for (const item of st.items) {
    const card = h("article", { class: "ds-card" }, [h("div", { class: "ds-head" }, [h("strong", { text: item.id }), item.envs.develop && item.envs.develop.codedeploy ? h("span", { class: "meta", text: "GitHub Actions + CodeDeploy" }) : h("span", { class: "meta", text: "GitHub Actions" })])]);
    if (item.error) card.appendChild(h("div", { class: "meta", text: `No se pudo leer: ${item.error}` }));
    for (const env of ["develop", "production"]) if (item.envs[env]) card.appendChild(statusRow(env, item.envs[env]));
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

function pill(label, note, pressed, onClick, extra) {
  return h("button", { type: "button", class: `pill${extra ? " " + extra : ""}`, "aria-pressed": String(pressed), onclick: () => (onClick(), render()) }, [h("b", { text: label }), note ? h("small", { text: note }) : null]);
}

function orderRow(label, kids, note) {
  return h("div", { class: "do-row" }, [h("span", { class: "do-label", text: label }), h("div", { class: "do-controls" }, [...kids, note ? h("span", { class: "meta do-note", text: note }) : null])]);
}

function waitingOrder(x) {
  const target = areaName(x.area) || x.area;
  const where = x.environment === "both" ? "develop y producción" : x.environment === "production" ? "producción" : "develop";
  return h("div", { class: "notice waiting do-waiting" }, [
    h("b", { text: `Esperando envío · ${when(x.at)}` }),
    h("div", { text: `${humanList(x.projects)} a ${where}${x.version && touchesProd(x.environment) ? ` (tag ${x.version.toUpperCase()})` : ""}. ${whoSends(true)} la envía a ${target} en cuanto la recoge.` }),
    h("div", { class: "actions" }, [button("Cancelar", { onClick: (b) => ((b.disabled = true), post("/api/deploy", { cancel: x.id }, "Despliegue cancelado.")) })]),
  ]);
}

function deployOrder(root) {
  const projects = deployProjects();
  const chosen = projects.filter((p) => deploy.picked[p]);
  const area = deploy.area !== undefined ? deploy.area : state.deployerArea || "";
  const waiting = (state.deployments || []).find((x) => x.status === "approved");
  const box = h("section", { class: "deploy-order" }, [h("div", { class: "do-head" }, [h("strong", { text: "Nueva orden" })])]);
  if (waiting) box.appendChild(waitingOrder(waiting));
  const all = projects.length > 0 && chosen.length === projects.length;
  const prod = touchesProd(deploy.environment);
  box.appendChild(orderRow("Qué", [...projects.map((p) => pill(p, prod ? nextVersion(p, deploy.version) : "", !!deploy.picked[p], () => (deploy.picked[p] = !deploy.picked[p]))), button(all ? "Ninguno" : "Todos", { cls: "subtle", onClick: () => (projects.forEach((p) => (deploy.picked[p] = !all)), render()) })]));
  box.appendChild(
    orderRow(
      "A dónde",
      [
        pill("Develop y producción", "", deploy.environment === "both", () => (deploy.environment = "both"), "prod"),
        pill("Solo develop", "", deploy.environment === "develop", () => (deploy.environment = "develop")),
        pill("Solo producción", "", deploy.environment === "production", () => (deploy.environment = "production"), "prod"),
      ],
      deploy.environment === "both" ? "Primero develop; luego merge a master y tag." : deploy.environment === "production" ? "Merge de develop a master y tag nuevo." : "Commit y push a develop (beta)."
    )
  );
  if (prod) box.appendChild(orderRow("Versión", VERSIONS.map((v) => pill(v.label, v.note, deploy.version === v.id, () => (deploy.version = v.id)))));
  const sel = areaSelect("deploy-area", area, "Elige sesión…", (v) => {
    deploy.area = v;
    render();
  });
  sel.setAttribute("aria-label", "Sesión que despliega");
  const target = state.areas.find((a) => a.id === area);
  const targetNote = !target ? "Ponle nombre en Sesiones a la conversación que despliega y elígela aquí." : target.open ? "Abierta: la recibe en unos segundos." : "Cerrada: el tablero la abre al desplegar.";
  box.appendChild(orderRow("Quién", [sel], targetNote));

  const ready = chosen.length && deploy.environment && target && !waiting && !deploy.busy;
  const version = VERSIONS.find((v) => v.id === deploy.version);
  const summary = waiting ? "Hay una orden esperando envío: cuando salga podrás dar otra." : !chosen.length ? "Elige al menos un proyecto." : `${humanList(chosen)} a ${ENVIRONMENT_NAME[deploy.environment]}${prod ? ` (tag de ${version.label.toLowerCase()})` : ""}.`;
  const label = deploy.environment === "both" ? "Desplegar a develop y producción" : deploy.environment === "production" ? "Desplegar a producción" : "Desplegar a develop";
  const go = button(label, {
    cls: prod ? "danger" : "primary",
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
}

export function renderDeploy(root) {
  deployOrder(root);
  deployStatusPanel(root);
}

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
  get followUp() {
    return `Seguimiento de ${reviewer()}`;
  },
};
const talkSession = (to) => ({ reporter: state.reporterStatus, orchestrator: state.orchestrator, board: state.boardStatus, followUp: state.followUpStatus })[to] || null;
const FIXED_TALK = ["board", "reporter", "orchestrator", "followUp"];

function otherLiveSessions() {
  const fixed = new Set(FIXED_TALK.map((k) => (talkSession(k) || {}).conversation).filter(Boolean));
  const live = new Map(((state.sessions && state.sessions.list) || []).map((s) => [s.conversation, s]));
  return (state.hosted || []).filter((x) => !x.waitingForVsCode && !fixed.has(x.conversation) && live.has(x.conversation)).map((x) => ({ conversation: x.conversation, name: (live.get(x.conversation).title || live.get(x.conversation).name || x.name) }));
}

function newTalkSession(b) {
  const name = window.prompt("Nombre de la sesión nueva", "");
  if (!name || !name.trim()) return;
  b.disabled = true;
  b.textContent = "Creando…";
  requestOrFail("/api/new-session", { title: name.trim() })
    .then((d) => {
      if (d.conversation) setTalk(d.conversation);
      toast(d.open ? `Sesión «${name.trim()}» creada.` : `Sesión «${name.trim()}» creada; está arrancando.`);
      return refresh(true);
    })
    .catch(() => toast("No se pudo crear la sesión."))
    .then(() => render());
}

export function renderTalk(root) {
  const picker = h("div", { class: "people-chips chat-picker", role: "group", "aria-label": "Qué sesión ver" });
  const pick = (k, label) =>
    picker.appendChild(
      h("button", {
        type: "button",
        "aria-pressed": k === talkTo ? "true" : "false",
        text: label,
        onclick: () => {
          setTalk(k);
          render();
        },
      })
    );
  for (const k of FIXED_TALK) pick(k, TALK_NAMES[k]);
  const others = otherLiveSessions();
  for (const o of others) pick(o.conversation, o.name);
  picker.appendChild(h("button", { type: "button", class: "chat-new", title: "Abre una sesión nueva en el tablero para hablar con ella", text: "+ Nueva", onclick: (e) => newTalkSession(e.currentTarget) }));
  root.appendChild(picker);
  const other = others.find((o) => o.conversation === talkTo) || (/^[0-9a-f-]{36}$/.test(talkTo) ? { conversation: talkTo, name: "Sesión nueva" } : null);
  if (other) {
    const close = button("Cerrar sesión", {
      cls: "subtle",
      title: "La cierra y la quita de Hablar. Su conversación sigue en el historial y se puede volver a abrir desde Sesiones.",
      onClick: (b) => {
        if (!window.confirm(`¿Cerrar «${other.name}»? Si está a mitad de algo, se corta. La conversación no se borra.`)) return;
        b.disabled = true;
        requestOrFail("/api/host/action", { action: "sleep", conversation: other.conversation, name: other.name })
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
    root.appendChild(h("div", { class: "talk-actions" }, [close]));
    return root.appendChild(livePanel(other.conversation, other.name));
  }
  const target = talkSession(talkTo);
  if (!target || !target.conversation) return root.appendChild(empty(`${TALK_NAMES[talkTo]} no está registrada.`, "Regístrala con su comando para poder verla aquí."));
  const hosted = (state.hosted || []).some((x) => x.conversation === target.conversation && !x.waitingForVsCode);
  if (!hosted) return root.appendChild(empty(`${TALK_NAMES[talkTo]} no vive en el tablero.`, "Llévala al tablero desde Sesiones para verla aquí en directo."));
  root.appendChild(livePanel(target.conversation, target.session || TALK_NAMES[talkTo]));
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
  if (e.result) {
    kids.push(h("div", { class: "reply" }, [h("b", { text: `Resultado · ${when(e.result.at)}: ` }), e.result.text]));
    kids[0].lastChild.textContent = "Contestado por la sesión de errores";
  }
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
  if (!(list[0].errors || []).some((x) => x.state !== "discarded")) {
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
