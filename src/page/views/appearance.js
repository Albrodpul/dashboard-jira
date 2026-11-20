import { h, render } from "../lib/base.js";
import { t, LANGS, currentLang, setLang } from "../lib/i18n.js";
import { HOME_LAYOUTS, homeLayout, setHomeLayout } from "./home.js";
import { group, row, segmented } from "../components/settings-ui.js";

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

function choices(options, current, onPick, preview, translate = true) {
  return h(
    "div",
    { class: "look-choices", role: "radiogroup" },
    options.map((o) =>
      h("button", { class: `look-choice${o.id === current ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(o.id === current), onclick: () => onPick(o.id) }, [preview ? preview(o.id) : null, h("span", { text: translate ? t(o.label) : o.label })])
    )
  );
}

function themePreview(id) {
  return h("span", { class: `look-theme ${id}` }, [h("i"), h("i"), h("i")]);
}

function homePreview(id) {
  return h("span", { class: `look-home ${id}` }, id === "office" ? [h("i"), h("i"), h("i"), h("i")] : [h("i"), h("i"), h("i")]);
}

export function renderAppearance(root) {
  root.appendChild(
    group(t("Tema"), [
      row(t("Colores del tablero"), t("Se guarda en este navegador: el móvil y el Mac pueden llevar uno distinto."), choices(THEMES, currentTheme(), (id) => {
        setTheme(id);
        render();
      }, themePreview), { stack: true }),
    ])
  );
  root.appendChild(
    group(t("Idioma"), [
      row(t("Textos del tablero"), t("Lo que escriben las sesiones y Jira sigue en su idioma."), segmented(LANGS, currentLang(), (id) => setLang(id), t("Idioma"))),
    ])
  );
  root.appendChild(
    group(t("Pantalla de inicio"), [
      row(t("Cómo se ve Inicio"), t("La oficina con las nutrias o la vista clásica: contadores, sesiones en columnas y tarjetas."), choices(HOME_LAYOUTS, homeLayout(), (id) => {
        setHomeLayout(id);
        render();
      }, homePreview), { stack: true }),
    ])
  );
}
