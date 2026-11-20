import EN from "../i18n/en.js";

const KEY = "tower-lang";
export const LANGS = [
  { id: "es", label: "Español" },
  { id: "en", label: "English" },
];

export function currentLang() {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "es";
  } catch (e) {
    return "es";
  }
}

const LANG = currentLang();
export const LOCALE = LANG === "en" ? "en-GB" : "es-ES";

export function t(text, vars) {
  let out = LANG === "en" && EN[text] != null ? EN[text] : text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

export const tn = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n, ...vars });

export function setLang(id) {
  try {
    if (id === "es") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch (e) {}
  window.location.reload();
}
