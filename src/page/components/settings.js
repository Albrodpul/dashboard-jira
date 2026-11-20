import { state, h, closeSettings, openSettings } from "../lib/base.js";
import { t } from "../lib/i18n.js";
import { nutria, paint as paintOtter } from "./nutria.js";
import { tabVisible } from "./project-filter.js";
import { renderWorkspaces } from "../views/workspaces.js";
import { renderMachines } from "../views/machines.js";
import { renderAppearance } from "../views/appearance.js";
import { renderProjects } from "../views/projects.js";

const icon = (paths, cls = "settings-icon") => {
  const s = h("span", { class: cls, "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return s;
};

export const GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';

const SECTIONS = [
  { id: "workspaces", label: t("Proyectos"), sub: t("Cada proyecto que lleva el tablero: su carpeta en este ordenador, sus módulos y sus credenciales."), icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', draw: renderWorkspaces, otter: ["idle", "box", t("Cada proyecto en su caja")] },
  { id: "machines", label: t("Ordenadores"), sub: t("Quién manda, el horario del Mac y el token de Claude."), icon: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', draw: renderMachines, otter: ["working", null, t("Vigilando quién manda")] },
  { id: "appearance", label: t("Apariencia"), sub: t("Tema, idioma y pantalla de inicio del tablero."), icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>', draw: renderAppearance, otter: ["idle", null, t("¿Qué tal estoy?")] },
  { id: "projects", label: t("Servidores"), sub: t("Los servidores locales que usan las sesiones: base de datos, API y webs de cada proyecto."), icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2-3 2M13 15h4"/>', draw: renderProjects, otter: ["working", "helmet", t("Manteniendo los servidores en marcha")] },
];

export const lastSection = () => {
  try {
    return localStorage.getItem("settings-section") || SECTIONS[0].id;
  } catch (e) {
    return SECTIONS[0].id;
  }
};

let layer = null;
let painted = null;
let returnFocus = null;

function build() {
  const nav = h("nav", { class: "settings-nav", "aria-label": t("Secciones de ajustes") });
  const title = h("div", { class: "settings-pane-title" }, [h("h3", { id: "settings-section-title" }), h("p", { class: "sub", id: "settings-section-sub" })]);
  const close = h("button", { class: "settings-close", type: "button", title: t("Cerrar ajustes"), "aria-label": t("Cerrar ajustes"), onclick: closeSettings });
  close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const modal = h("section", { class: "settings-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "settings-title", tabindex: "-1" }, [
    h("aside", { class: "settings-side" }, [h("h2", { id: "settings-title", text: t("Ajustes") }), nav, h("div", { class: "settings-otter" })]),
    h("div", { class: "settings-pane" }, [h("header", { class: "settings-head" }, [title, close]), h("div", { class: "settings-body", id: "settings-body" })]),
  ]);
  const el = h("div", { class: "settings-layer", id: "settings" }, [h("div", { class: "settings-backdrop", onclick: closeSettings }), modal]);
  document.body.appendChild(el);
  return el;
}

export function paintSettings() {
  const sections = SECTIONS.filter((x) => tabVisible(x.id));
  if (state.settings && !sections.some((x) => x.id === state.settings)) state.settings = sections[0] ? sections[0].id : null;
  if (!state.settings) {
    if (layer) {
      layer.remove();
      layer = null;
      painted = null;
      document.body.classList.remove("settings-open");
      if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
    return;
  }
  const fresh = !layer;
  if (fresh) {
    returnFocus = document.activeElement;
    layer = build();
    document.body.classList.add("settings-open");
  }
  const sec = SECTIONS.find((x) => x.id === state.settings);
  const nav = layer.querySelector(".settings-nav");
  nav.textContent = "";
  for (const x of sections) nav.appendChild(h("button", { type: "button", class: "settings-item", "aria-current": x.id === sec.id ? "page" : "false", onclick: () => x.id !== state.settings && openSettings(x.id) }, [icon(x.icon), h("span", { text: x.label })]));
  layer.querySelector("#settings-section-title").textContent = sec.label;
  layer.querySelector("#settings-section-sub").textContent = sec.sub;
  const otter = layer.querySelector(".settings-otter");
  if (otter.dataset.section !== sec.id) {
    otter.dataset.section = sec.id;
    otter.textContent = "";
    const [mood, prop, say] = sec.otter;
    otter.appendChild(h("div", { class: "page-otter", title: say }, [h("span", { class: "page-otter-say", text: say }), paintOtter(nutria(mood, "page", prop), sec.id)]));
  }
  if (painted !== sec.id) {
    const current = nav.querySelector('[aria-current="page"]');
    if (current && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
  }
  const body = layer.querySelector("#settings-body");
  const keep = painted === sec.id ? body.scrollTop : 0;
  body.textContent = "";
  sec.draw(body);
  painted = sec.id;
  if (body.scrollTop !== keep) body.scrollTop = keep;
  if (fresh) layer.querySelector(".settings-modal").focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.settings || state.ticket) return;
  const a = document.activeElement;
  if (a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && a.value) return;
  closeSettings();
});

export function settingsButton(cls) {
  return h("button", { type: "button", class: cls, title: t("Ajustes: proyectos, ordenadores, apariencia y servidores"), "aria-haspopup": "dialog", "aria-expanded": String(!!state.settings), onclick: () => openSettings(lastSection()) }, [icon(GEAR, "tab-icon"), h("span", { class: "tab-text" }, [h("span", { class: "tab-long", text: t("Ajustes") }), h("span", { class: "tab-short", text: t("Ajustes") })])]);
}
