import { state, h, button, when, toast, requestOrFail, post, whoSends, areaName, areaSelect, render, refresh, empty, deployProjects } from "../lib/base.js";

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

function statusRow(env, e, earlier) {
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
        earlier ? h("span", { class: "meta", text: "· el anterior, aún en marcha" }) : null,
        ref ? h("code", { class: "ds-ref", text: ref, title: a.ref }) : null,
        e.state === "success" ? h("span", { class: "visually-hidden", text: DS_STATE.success }) : h("span", { class: `chip ds-${e.state}`, text: DS_STATE[e.state] || e.state }),
        a ? h("span", { class: "meta ds-ago", text: ago(e.state === "running" ? a.startedAt : (e.codedeployCurrent && cd && cd.finishedAt) || a.updatedAt) }) : null,
      ]),
      ...details,
    ]),
  ];
  if (a && a.url) kids.push(h("a", { class: "ds-link", href: a.url, target: "_blank", rel: "noopener", title: "Ver en GitHub Actions", "aria-label": `Ver ${DS_ENV[env].toLowerCase()} en GitHub Actions`, text: "↗" }));
  return h("div", { class: `ds-row ${e.state}${earlier ? " ds-parallel" : ""}` }, kids);
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
    const card = h("article", { class: "ds-card" }, [h("div", { class: "ds-head" }, [h("strong", { text: item.id }), item.envs.develop && item.envs.develop.hasCodedeploy ? h("span", { class: "meta", text: "GitHub Actions + CodeDeploy" }) : h("span", { class: "meta", text: "GitHub Actions" })])]);
    if (item.error) card.appendChild(h("div", { class: "meta", text: `No se pudo leer: ${item.error}` }));
    for (const env of ["develop", "production"]) {
      const e = item.envs[env];
      if (!e) continue;
      card.appendChild(statusRow(env, e));
      for (const p of e.parallel || []) card.appendChild(statusRow(env, p, true));
    }
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
