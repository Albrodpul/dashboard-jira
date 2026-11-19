import { h, render } from "../lib/base.js";

const THEME_KEY = "tower-theme";
const THEMES = [
  { id: "system", label: "Como el sistema" },
  { id: "light", label: "Claro" },
  { id: "dark", label: "Oscuro" },
];

export function currentTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch (e) {
    return "system";
  }
}

export function applyTheme(theme = currentTheme()) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function setTheme(id) {
  try {
    if (id === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, id);
  } catch (e) {}
  applyTheme(id);
}

function choices(name, options, current, onPick, preview) {
  return h(
    "div",
    { class: "look-choices", role: "radiogroup" },
    options.map((o) =>
      h("button", { class: `look-choice${o.id === current ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(o.id === current), onclick: () => onPick(o.id) }, [preview ? preview(o.id) : null, h("span", { text: o.label })])
    )
  );
}

function themePreview(id) {
  return h("span", { class: `look-theme ${id}` }, [h("i"), h("i"), h("i")]);
}

export function renderAppearance(root) {
  root.appendChild(
    h("section", { class: "card setting-card" }, [
      h("h3", { text: "Tema" }),
      h("p", { class: "meta", text: "Se guarda en este navegador: el móvil y el Mac pueden llevar uno distinto." }),
      choices("theme", THEMES, currentTheme(), (id) => {
        setTheme(id);
        render();
      }, themePreview),
    ])
  );
}
