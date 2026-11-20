import { h } from "../lib/base.js";

export function group(title, rows, { foot, actions, cls = "" } = {}) {
  const head = title || actions ? h("div", { class: "sg-head" }, [title ? h("h4", { class: "sg-title" }, [title]) : null, actions ? h("div", { class: "sg-actions" }, [].concat(actions)) : null]) : null;
  const list = h("div", { class: "sg-list" }, [].concat(rows).filter(Boolean));
  return h("section", { class: `sg ${cls}`.trim() }, [head, list, foot ? h("div", { class: "sg-foot" }, [].concat(foot)) : null]);
}

export function row(label, desc, control, { stack = false, cls = "", lead = null } = {}) {
  const text = h("div", { class: "sg-text" }, [typeof label === "string" ? h("strong", { text: label }) : label, desc ? (typeof desc === "string" ? h("span", { class: "sg-desc", text: desc }) : desc) : null]);
  return h("div", { class: `sg-row${stack ? " stack" : ""} ${cls}`.trim() }, [lead, text, control ? h("div", { class: "sg-control" }, [].concat(control).filter(Boolean)) : null]);
}

export function toggle(checked, onChange, label, { disabled = false } = {}) {
  const input = h("input", { type: "checkbox", role: "switch", class: "sg-switch", "aria-label": label });
  input.checked = !!checked;
  input.disabled = disabled;
  input.addEventListener("change", () => onChange(input.checked, input));
  return input;
}

export function segmented(options, current, onPick, label) {
  return h(
    "div",
    { class: "sg-seg", role: "radiogroup", "aria-label": label },
    options.map((o) => h("button", { type: "button", role: "radio", "aria-checked": String(o.id === current), class: o.id === current ? "on" : "", onclick: () => o.id !== current && onPick(o.id) }, [o.label]))
  );
}

export const note = (text, warn) => h("div", { class: `sg-note${warn ? " warn" : ""}` }, [].concat(text).map((x) => (typeof x === "string" ? h("p", { text: x }) : x)));
