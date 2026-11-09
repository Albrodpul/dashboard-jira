import { state, h, button, when, minutesSince, toast, request, requestOrFail, post, render, refresh, renderMd, empty } from "../lib/base.js";

const ERROR_CHIP = { proposed: ["returned", "Por decidir"], approved: ["approved", "Enviándolo"], sent: ["sent", "Enviado a la sesión de errores"], discarded: ["ignored", "Descartado"] };
const olderOpen = new Set();
const OLDER_SHOWN = 10;
let olderAll = false;

function headlineOf(text) {
  const first = String(text || "").split("\n").find((l) => l.trim()) || "";
  const bold = /^\*\*(.+)\*\*\s*$/.exec(first.trim());
  const line = bold ? bold[1] : first.replace(/\*\*/g, "");
  const m = /^(.{3,80}?):\s+(.+)$/.exec(line);
  const t = (m ? m[2] : line).trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function olderRow(x) {
  const open = olderOpen.has(x.at);
  const toggle = () => {
    if (open) olderOpen.delete(x.at);
    else olderOpen.add(x.at);
    render();
  };
  const head = h("button", { type: "button", class: "issue-head", "aria-expanded": String(open), onclick: toggle }, [h("span", { class: "issue-when", text: when(x.at) }), h("span", { class: "issue-msg", text: headlineOf(x.text) }), h("span", { class: "issue-tag none" })]);
  return h("div", { class: `issue-row${open ? " open" : ""}` }, [head, open ? h("div", { class: "issue-body" }, [followUpText(x.text)]) : null]);
}

function errorCard(e) {
  const [cls, label] = ERROR_CHIP[e.state];
  const kids = [h("div", { class: "top" }, [e.person ? h("strong", { text: e.person }) : null, h("span", { class: `chip ${cls}`, text: label }), h("span", { class: "time", text: when(e.at) })]), h("div", { class: "note", text: e.text })];
  if (e.result) {
    kids.push(h("div", { class: "reply" }, [h("b", { text: `Resultado · ${when(e.result.at)}: ` }), e.result.text]));
    kids[0].querySelector(".chip").textContent = "Contestado por la sesión de errores";
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
    buttons.push(button("Enviar a la sesión de errores", { cls: "primary", onClick: () => act("send", "Enviado: el tablero se lo pasa a la sesión de errores.") }));
    buttons.push(button("Descartar", { onClick: () => act("discard", "Descartado.") }));
    kids.push(h("div", { class: "actions" }, buttons));
  }
  return h("div", { class: "fu-error" }, kids);
}

const FOLLOW_UP_ENVIRONMENTS = [
  { id: "beta", name: "Beta", everyHours: 1 },
  { id: "production", name: "Producción", everyHours: 2 },
];
const environmentOf = (r) => r.environment || "beta";
const everyText = (n) => (n === 1 ? "cada hora" : `cada ${n} horas`);

let selectedEnvironment = "beta";
try {
  selectedEnvironment = localStorage.getItem("follow-up-environment") || "beta";
} catch (e) {}
let directoryOpen = false;

function pickEnvironment(id) {
  selectedEnvironment = id;
  try {
    localStorage.setItem("follow-up-environment", id);
  } catch (e) {}
  render();
}

function environmentPicker(root, envs, summaries) {
  const chips = h("div", { class: "people-chips", role: "group", "aria-label": "Entorno" });
  for (const env of envs) {
    const pending = summaries.filter((r) => environmentOf(r) === env.id).flatMap((r) => r.errors || []).filter((x) => x.state === "proposed").length;
    chips.appendChild(
      h("button", { type: "button", "aria-pressed": String(env.id === selectedEnvironment), onclick: () => pickEnvironment(env.id), title: `Resumen automático ${everyText(env.everyHours)}, de lunes a viernes` }, [
        env.name,
        h("span", { class: "meta", text: ` · ${everyText(env.everyHours)}` }),
        pending ? h("span", { class: "error-count", text: String(pending) }) : null,
      ])
    );
  }
  root.appendChild(chips);
}

function requestButton(env, req) {
  return button("Pedir resumen ahora", {
    cls: "primary",
    disabled: !!req,
    title: req ? "Hay otro resumen pedido: espera a que salga." : `La sesión de seguimiento mira lo que ha hecho cada uno en ${env.name.toLowerCase()} desde el último resumen y lo publica aquí.`,
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/followup-request", { environment: env.id })
        .then(() => toast(`Pedido: el resumen de ${env.name.toLowerCase()} sale en unos minutos.`))
        .catch(() => {
          b.disabled = false;
          toast("No se pudo pedir el resumen.");
        })
        .then(() => refresh(true));
    },
  });
}

const GROUP_SECTIONS = /^(clientes?|cuentas? desconocidas?|bater[ií]as? de pruebas|sin sesi[oó]n|an[oó]nim[oa]s?)$/i;

function statChips(rest) {
  const parts = String(rest || "").replace(/^\s*[·:—-]\s*/, "").split(/\s+·\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => h("span", { class: `fu-stat${/^[1-9]\d*\s+errore?s?\b/i.test(p) ? " bad" : ""}`, text: p }));
}

function followUpText(text) {
  const box = h("div", { class: "fu-text" });
  const lines = String(text || "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  const head = /^\*\*(.+)\*\*\s*$/.exec((lines[0] || "").trim());
  if (head) {
    lines.shift();
    const m = /^(.{3,80}?):\s+(.+)$/.exec(head[1]);
    if (m) box.appendChild(h("div", { class: "fu-eyebrow", text: m[1] }));
    const sentence = (m ? m[2] : head[1]).replace(/\.$/, "");
    box.appendChild(h("p", { class: "fu-headline", text: sentence.charAt(0).toUpperCase() + sentence.slice(1) + "." }));
  }
  let section = null;
  let body = [];
  const flush = () => {
    const md = body.join("\n").trim();
    if (section) {
      if (md) section.appendChild(renderMd(md));
      box.appendChild(section);
    } else if (md) box.appendChild(renderMd(md));
    section = null;
    body = [];
  };
  for (const line of lines) {
    const m = /^\*\*([^*]{1,60})\*\*(.*)$/.exec(line.trim());
    if (m && !/^\s*[-*] /.test(line)) {
      flush();
      const title = m[1].trim().replace(/:$/, "");
      const kind = /^lectura$/i.test(title) ? "reading" : GROUP_SECTIONS.test(title) ? "group" : "person";
      section = h("section", { class: `fu-block ${kind}` }, [h("div", { class: "fu-block-head" }, [h("h4", { text: title }), ...statChips(m[2])])]);
      continue;
    }
    body.push(line);
  }
  flush();
  return box;
}

function nextRun(cron, from = new Date()) {
  const m = /^(\d+) (\d+)-(\d+)(?:\/(\d+))? /.exec(cron || "");
  if (!m) return null;
  const [minute, first, last, step] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 1)];
  const madrid = (d) => new Date(d.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
  const local = madrid(from);
  for (let day = 0; day < 8; day++) {
    const d = new Date(local);
    d.setDate(d.getDate() + day);
    if ([0, 6].includes(d.getDay())) continue;
    for (let hour = first; hour <= last; hour += step) {
      d.setHours(hour, minute, 0, 0);
      if (d > local) return { day, time: `${hour}:${String(minute).padStart(2, "0")}` };
    }
  }
  return null;
}

function nextText(env) {
  const n = nextRun(env.cron);
  if (!n) return "";
  return n.day === 0 ? `el siguiente sale a las ${n.time}` : n.day === 1 ? `el siguiente sale mañana a las ${n.time}` : `el siguiente sale el próximo día laborable a las ${n.time}`;
}

function directory(root, people) {
  const det = h("details", { class: "dev-help people-directory" }, [h("summary", { text: `Personas conocidas (${people.length}): con sus cuentas se separa lo que hace cada uno` })]);
  det.open = directoryOpen;
  det.addEventListener("toggle", () => (directoryOpen = det.open));
  const rows = [];
  for (const p of people) {
    const remove = button("Quitar", {
      cls: "subtle",
      title: `Quitar a ${p.name}: su actividad saldrá como cuenta desconocida`,
      onClick: () => {
        if (!window.confirm(`¿Quitar a ${p.name} de las personas conocidas? Su actividad saldrá como cuenta desconocida.`)) return;
        post("/api/people", { action: "remove", id: p.id }, `${p.name} quitada.`);
      },
    });
    rows.push(h("div", { class: "person-row" }, [h("strong", { text: p.name }), h("span", { class: "person-accounts", text: (p.accounts || []).join(", ") || "cuentas sin buscar todavía" }), remove]));
  }
  if (rows.length) det.appendChild(h("div", { class: "fu-people" }, rows));
  const name = h("input", { type: "text", maxlength: "80", placeholder: "Nombre", "aria-label": "Nombre" });
  const accounts = h("input", { type: "text", maxlength: "400", placeholder: "Correos, separados por comas (opcional)", "aria-label": "Correos de sus cuentas" });
  const add = button("Añadir", {
    cls: "primary",
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/people", { action: "add", name: name.value, accounts: accounts.value })
        .then(() => toast("Añadida. Sale con su nombre en el próximo resumen."))
        .catch((e) => {
          b.disabled = false;
          toast(e.message);
        })
        .then(() => refresh(true));
    },
  });
  det.appendChild(h("div", { class: "toolbar person-form" }, [name, accounts, add]));
  root.appendChild(det);
}

export function renderFollowUp(root) {
  const all = state.followUps || [];
  const e = state.followUpStatus;
  const envs = (e && e.environments) || FOLLOW_UP_ENVIRONMENTS;
  if (!envs.some((x) => x.id === selectedEnvironment)) selectedEnvironment = envs[0].id;
  const env = Object.assign({}, FOLLOW_UP_ENVIRONMENTS.find((x) => x.id === selectedEnvironment), envs.find((x) => x.id === selectedEnvironment));
  env.name = env.id === "production" ? "Producción" : "Beta";
  const list = all.filter((r) => environmentOf(r) === env.id);
  environmentPicker(root, envs.map((x) => ({ ...x, name: x.id === "production" ? "Producción" : "Beta" })), all);
  const session = !e ? "La sesión de seguimiento no está registrada." : e.open ? "" : `La sesión «${e.title}» está cerrada.`;
  const req = e && e.request;
  const asked = req && (req.environment || "beta") === env.id;
  const line = asked
    ? `Resumen pedido a las ${when(req.at)}. ${minutesSince(req.at) >= 6 ? "Tarda más de lo normal: la sesión de seguimiento puede estar ocupada o cerrada." : "Se está preparando."}`
    : [list.length ? `Último resumen a las ${when(list[0].at)}` : "", nextText(env)].filter(Boolean).join("; ") + "." + (session ? ` ${session}` : "");
  root.appendChild(h("div", { class: "issues-bar follow-up-bar" }, [h("span", { class: "meta", text: line.replace(/^\./, "") }), !asked && e ? requestButton(env, req) : null]));
  if (!list.length) {
    root.appendChild(empty(`Todavía no hay resúmenes de ${env.name.toLowerCase()}.`, `Sale uno ${everyText(env.everyHours)} en horario de trabajo, de lunes a viernes, o cuando lo pidas.`));
    return directory(root, state.people || []);
  }
  const latest = h("section", { class: "card fu-latest" }, [h("div", { class: "fu-latest-head meta", text: `Resumen de las ${when(list[0].at)}${list[0].manual ? " (pedido a mano)" : ""}` }), followUpText(list[0].text)]);
  const quiet = !list[0].text.trim().includes("\n");
  if (!quiet && !(list[0].errors || []).some((x) => x.state !== "discarded")) {
    const sendAll = button("Enviar este resumen a la sesión de errores", {
      cls: "subtle",
      title: "Para cuando ves un fallo que la sesión no ha apuntado como posible error. Se manda el resumen entero.",
      onClick: (b) => {
        b.disabled = true;
        requestOrFail("/api/followup-error", { at: list[0].at, action: "summary" })
          .then(() => toast("Enviado: el tablero se lo pasa a la sesión de errores."))
          .catch((x) => {
            b.disabled = false;
            toast(`No se pudo enviar: ${x.message}`);
          })
          .then(() => refresh(true));
      },
    });
    latest.appendChild(h("div", { class: "actions fu-latest-actions" }, [sendAll]));
  }
  root.appendChild(latest);
  const errors = list.flatMap((r) => (r.errors || []).filter((x) => x.state === "proposed" || r === list[0]));
  if (errors.length) {
    root.appendChild(
      h("section", { class: "list-section" }, [
        h("div", { class: "group-head" }, [h("span", { class: "group-name", text: `Posibles errores vistos en ${env.name.toLowerCase()}` }), h("span", { class: "group-key", text: String(errors.length) })]),
        h("div", { class: "issue-list" }, errors.map(errorCard)),
      ])
    );
  }
  if (list.length > 1)
    root.appendChild(
      h("section", { class: "list-section" }, [
        h("div", { class: "group-head" }, [h("span", { class: "group-name", text: "Resúmenes anteriores" }), h("span", { class: "group-key", text: String(list.length - 1) })]),
        h("div", { class: "issue-list fu-older" }, list.slice(1, olderAll ? undefined : OLDER_SHOWN + 1).map(olderRow)),
        list.length - 1 > OLDER_SHOWN ? h("div", { class: "fu-more" }, [button(olderAll ? "Ver menos" : `Ver todos (${list.length - 1})`, { cls: "subtle", onClick: () => ((olderAll = !olderAll), render()) })]) : null,
      ])
    );
  directory(root, state.people || []);
}
