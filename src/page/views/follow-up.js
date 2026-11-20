import { state, h, button, when, minutesSince, toast, request, requestOrFail, post, render, refresh, renderMd, empty } from "../lib/base.js";
import { t } from "../lib/i18n.js";

const ERROR_CHIP = { proposed: ["returned", t("Por decidir")], approved: ["approved", t("Enviándolo")], sent: ["sent", t("Enviado a la sesión de errores")], discarded: ["ignored", t("Descartado")] };
const olderOpen = new Set();
const OLDER_SHOWN = 10;
let olderAll = false;

function headlineOf(text) {
  const first = String(text || "").split("\n").find((l) => l.trim()) || "";
  const bold = /^\*\*(.+)\*\*\s*$/.exec(first.trim());
  const line = bold ? bold[1] : first.replace(/\*\*/g, "");
  const m = /^(.{3,80}?):\s+(.+)$/.exec(line);
  const s = (m ? m[2] : line).trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function olderRow(x) {
  const open = olderOpen.has(x.at);
  const toggle = () => {
    if (open) olderOpen.delete(x.at);
    else olderOpen.add(x.at);
    render();
  };
  const head = h("button", { type: "button", class: "issue-head", "aria-expanded": String(open), onclick: toggle }, [h("span", { class: "issue-when", text: when(x.at) }), h("span", { class: "issue-msg", text: headlineOf(x.text) }), h("span", { class: "issue-tag none" })]);
  return h("div", { class: `issue-row${open ? " open" : ""}` }, [head, open ? h("div", { class: "issue-body" }, [followUpText(x.text), summaryActions(x)]) : null]);
}

function summaryActions(r, latest) {
  if (!String(r.text || "").trim().includes("\n")) return null;
  const live = (r.errors || []).filter((x) => x.state !== "discarded");
  const whole = live.find((x) => x.wholeSummary);
  if (whole) return latest ? null : h("div", { class: "actions fu-latest-actions meta", text: t("Enviado entero a la sesión de errores a las {time}.", { time: when(whole.at) }) });
  if (live.length) return null;
  const sendAll = button(t("Enviar este resumen a la sesión de errores"), {
    cls: "subtle",
    title: t("Para cuando ves un fallo que la sesión no ha apuntado como posible error. Se manda el resumen entero."),
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/followup-error", { at: r.at, action: "summary" })
        .then(() => toast(t("Enviado: el tablero se lo pasa a la sesión de errores.")))
        .catch((x) => {
          b.disabled = false;
          toast(t("No se pudo enviar: {error}", { error: x.message }));
        })
        .then(() => refresh(true));
    },
  });
  return h("div", { class: "actions fu-latest-actions" }, [sendAll]);
}

function errorCard(e) {
  const [cls, label] = ERROR_CHIP[e.state];
  const kids = [h("div", { class: "top" }, [e.person ? h("strong", { text: e.person }) : null, h("span", { class: `chip ${cls}`, text: label }), h("span", { class: "time", text: when(e.at) })]), h("div", { class: "note", text: e.text })];
  if (e.result) {
    kids.push(h("div", { class: "reply" }, [h("b", { text: t("Resultado · {time}: ", { time: when(e.result.at) }) }), e.result.text]));
    kids[0].querySelector(".chip").textContent = t("Contestado por la sesión de errores");
  }
  if (e.state === "proposed") {
    const buttons = [];
    const act = (action, msg) => {
      buttons.forEach((b) => (b.disabled = true));
      requestOrFail("/api/followup-error", { id: e.id, action })
        .then(() => toast(msg))
        .catch(() => {
          buttons.forEach((b) => (b.disabled = false));
          toast(t("No se pudo guardar."));
        })
        .then(() => refresh(true));
    };
    buttons.push(button(t("Enviar a la sesión de errores"), { cls: "primary", onClick: () => act("send", t("Enviado: el tablero se lo pasa a la sesión de errores.")) }));
    buttons.push(button(t("Descartar"), { onClick: () => act("discard", t("Descartado.")) }));
    kids.push(h("div", { class: "actions" }, buttons));
  }
  return h("div", { class: "fu-error" }, kids);
}

const FOLLOW_UP_ENVIRONMENTS = [
  { id: "beta", name: "Beta", everyHours: 1 },
  { id: "production", name: t("Producción"), everyHours: 2 },
];
const environmentOf = (r) => r.environment || "beta";
const everyText = (n) => (n === 1 ? t("cada hora") : t("cada {n} horas", { n }));
const envName = (id) => (id === "production" ? t("Producción") : "Beta");
const envLower = (id) => (id === "production" ? t("producción") : "beta");

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
  const chips = h("div", { class: "people-chips", role: "group", "aria-label": t("Entorno") });
  for (const env of envs) {
    const pending = summaries.filter((r) => environmentOf(r) === env.id).flatMap((r) => r.errors || []).filter((x) => x.state === "proposed").length;
    chips.appendChild(
      h("button", { type: "button", "aria-pressed": String(env.id === selectedEnvironment), onclick: () => pickEnvironment(env.id), title: t("Resumen automático {every}, de lunes a viernes", { every: everyText(env.everyHours) }) }, [
        env.name,
        h("span", { class: "meta", text: ` · ${everyText(env.everyHours)}` }),
        pending ? h("span", { class: "error-count", text: String(pending) }) : null,
      ])
    );
  }
  root.appendChild(chips);
}

function requestButton(env, req) {
  return button(t("Pedir resumen ahora"), {
    cls: "primary",
    disabled: !!req,
    title: req ? t("Hay otro resumen pedido: espera a que salga.") : t("La sesión de seguimiento mira lo que ha hecho cada uno en {env} desde el último resumen y lo publica aquí.", { env: envLower(env.id) }),
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/followup-request", { environment: env.id })
        .then(() => toast(t("Pedido: el resumen de {env} sale en unos minutos.", { env: envLower(env.id) })))
        .catch(() => {
          b.disabled = false;
          toast(t("No se pudo pedir el resumen."));
        })
        .then(() => refresh(true));
    },
  });
}

const GROUP_SECTIONS = /^(clientes?|cuentas? desconocidas?|bater[ií]as? de pruebas|sin sesi[oó]n|an[oó]nim[oa]s?)$/i;

function statChips(rest) {
  const parts = String(rest || "").replace(/^\s*[·:—-]\s*/, "").split(/\s+·\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => h("span", { class: `fu-stat${/^[1-9]\d*\s+errore?s?\b/i.test(p) ? " bad" : ""}${p.length > 40 ? " long" : ""}`, text: p.replace(/\*\*/g, "") }));
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
  return t(n.day === 0 ? "el siguiente sale a las {time}" : n.day === 1 ? "el siguiente sale mañana a las {time}" : "el siguiente sale el próximo día laborable a las {time}", { time: n.time });
}

function directory(root, people) {
  const det = h("details", { class: "dev-help people-directory" }, [h("summary", { text: t("Personas conocidas ({n}): con sus cuentas se separa lo que hace cada uno", { n: people.length }) })]);
  det.open = directoryOpen;
  det.addEventListener("toggle", () => (directoryOpen = det.open));
  const rows = [];
  for (const p of people) {
    const remove = button(t("Quitar"), {
      cls: "subtle",
      title: t("Quitar a {name}: su actividad saldrá como cuenta desconocida", { name: p.name }),
      onClick: () => {
        if (!window.confirm(t("¿Quitar a {name} de las personas conocidas? Su actividad saldrá como cuenta desconocida.", { name: p.name }))) return;
        post("/api/people", { action: "remove", id: p.id }, t("{name} quitada.", { name: p.name }));
      },
    });
    rows.push(h("div", { class: "person-row" }, [h("strong", { text: p.name }), h("span", { class: "person-accounts", text: (p.accounts || []).join(", ") || t("cuentas sin buscar todavía") }), remove]));
  }
  if (rows.length) det.appendChild(h("div", { class: "fu-people" }, rows));
  const name = h("input", { type: "text", maxlength: "80", placeholder: t("Nombre"), "aria-label": t("Nombre") });
  const accounts = h("input", { type: "text", maxlength: "400", placeholder: t("Correos, separados por comas (opcional)"), "aria-label": t("Correos de sus cuentas") });
  const add = button(t("Añadir"), {
    cls: "primary",
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/people", { action: "add", name: name.value, accounts: accounts.value })
        .then(() => toast(t("Añadida. Sale con su nombre en el próximo resumen.")))
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
  env.name = envName(env.id);
  const list = all.filter((r) => environmentOf(r) === env.id);
  environmentPicker(root, envs.map((x) => ({ ...x, name: envName(x.id) })), all);
  const session = !e ? t("La sesión de seguimiento no está registrada.") : e.open ? "" : t("La sesión «{title}» está cerrada.", { title: e.title });
  const req = e && e.request;
  const asked = req && (req.environment || "beta") === env.id;
  const line = asked
    ? `${t("Resumen pedido a las {time}.", { time: when(req.at) })} ${minutesSince(req.at) >= 6 ? t("Tarda más de lo normal: la sesión de seguimiento puede estar ocupada o cerrada.") : t("Se está preparando.")}`
    : [list.length ? t("Último resumen a las {time}", { time: when(list[0].at) }) : "", nextText(env)].filter(Boolean).join("; ") + "." + (session ? ` ${session}` : "");
  root.appendChild(h("div", { class: "issues-bar follow-up-bar" }, [h("span", { class: "meta", text: line.replace(/^\./, "") }), !asked && e ? requestButton(env, req) : null]));
  if (!list.length) {
    root.appendChild(empty(t("Todavía no hay resúmenes de {env}.", { env: envLower(env.id) }), t("Sale uno {every} en horario de trabajo, de lunes a viernes, o cuando lo pidas.", { every: everyText(env.everyHours) })));
    return directory(root, state.people || []);
  }
  const latest = h("section", { class: "card fu-latest" }, [h("div", { class: "fu-latest-head meta", text: t(list[0].manual ? "Resumen de las {time} (pedido a mano)" : "Resumen de las {time}", { time: when(list[0].at) }) }), followUpText(list[0].text)]);
  const actions = summaryActions(list[0], true);
  if (actions) latest.appendChild(actions);
  root.appendChild(latest);
  const errors = list.flatMap((r) => (r.errors || []).filter((x) => x.state === "proposed" || r === list[0]));
  if (errors.length) {
    root.appendChild(
      h("section", { class: "list-section" }, [
        h("div", { class: "group-head" }, [h("span", { class: "group-name", text: t("Posibles errores vistos en {env}", { env: envLower(env.id) }) }), h("span", { class: "group-key", text: String(errors.length) })]),
        h("div", { class: "issue-list" }, errors.map(errorCard)),
      ])
    );
  }
  if (list.length > 1)
    root.appendChild(
      h("section", { class: "list-section" }, [
        h("div", { class: "group-head" }, [h("span", { class: "group-name", text: t("Resúmenes anteriores") }), h("span", { class: "group-key", text: String(list.length - 1) })]),
        h("div", { class: "issue-list fu-older" }, list.slice(1, olderAll ? undefined : OLDER_SHOWN + 1).map(olderRow)),
        list.length - 1 > OLDER_SHOWN ? h("div", { class: "fu-more" }, [button(olderAll ? t("Ver menos") : t("Ver todos ({n})", { n: list.length - 1 }), { cls: "subtle", onClick: () => ((olderAll = !olderAll), render()) })]) : null,
      ])
    );
  directory(root, state.people || []);
}
