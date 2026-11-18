import { h } from "../lib/base.js";

const ARMS = {
  rest: '<rect class="arm left" x="3" y="8" width="1" height="3"/><rect class="arm right" x="12" y="8" width="1" height="3"/>',
  hand: '<rect class="arm" x="3" y="8" width="1" height="3"/><rect class="arm raised" x="12" y="2" width="1" height="6"/><rect class="paw" x="12" y="1" width="2" height="1"/>',
  up: '<rect class="arm up left" x="3" y="2" width="1" height="6"/><rect class="paw" x="2" y="1" width="2" height="1"/><rect class="arm up right" x="12" y="2" width="1" height="6"/><rect class="paw" x="12" y="1" width="2" height="1"/>',
};
const EYES = {
  open: '<rect class="eye" x="5" y="2" width="1" height="2"/><rect class="eye" x="10" y="2" width="1" height="2"/>',
  shut: '<rect class="eye" x="4" y="3" width="2" height="1"/><rect class="eye" x="10" y="3" width="2" height="1"/>',
  happy: '<rect class="eye" x="4" y="3" width="1" height="1"/><rect class="eye" x="5" y="2" width="1" height="1"/><rect class="eye" x="6" y="3" width="1" height="1"/><rect class="eye" x="9" y="3" width="1" height="1"/><rect class="eye" x="10" y="2" width="1" height="1"/><rect class="eye" x="11" y="3" width="1" height="1"/>',
};
const PROPS = {
  laptop: '<rect class="laptop" x="3" y="10" width="10" height="3"/><rect class="screen" x="4" y="11" width="8" height="1"/>',
  paper: '<rect class="paper" x="4" y="9" width="8" height="5"/><rect class="ink" x="5" y="10" width="5" height="1"/><rect class="ink" x="5" y="12" width="4" height="1"/>',
};
const MOODS = {
  working: { arms: "rest", eyes: "open", prop: "laptop" },
  blocked: { arms: "hand", eyes: "open", bubble: ["?", "bad"] },
  waiting: { arms: "up", eyes: "open" },
  free: { arms: "rest", eyes: "shut", zz: true },
  closed: { arms: "rest", eyes: "shut" },
  pending: { arms: "rest", eyes: "open", prop: "paper" },
  done: { arms: "up", eyes: "happy", bubble: ["✓", "ok"] },
  alert: { arms: "up", eyes: "open", bubble: ["!", "warn"] },
};

const BODY =
  '<rect class="tail" x="12" y="10" width="3" height="2"/><rect class="tail" x="14" y="9" width="1" height="1"/>' +
  '<rect class="ear" x="2" y="0" width="2" height="2"/><rect class="ear" x="12" y="0" width="2" height="2"/>' +
  '<rect class="fur" x="4" y="0" width="8" height="1"/><rect class="fur" x="3" y="1" width="10" height="6"/>' +
  '<rect class="cream" x="5" y="4" width="6" height="3"/><rect class="nose" x="7" y="4" width="2" height="1"/>' +
  '<rect class="whisker" x="1" y="5" width="2" height="1"/><rect class="whisker" x="13" y="5" width="2" height="1"/>' +
  '<rect class="fur" x="4" y="7" width="8" height="5"/><rect class="cream" x="6" y="8" width="4" height="4"/>' +
  '<rect class="scarf" x="4" y="7" width="8" height="1"/><rect class="scarf" x="9" y="8" width="2" height="2"/>' +
  '<rect class="ear" x="4" y="12" width="3" height="1"/><rect class="ear" x="9" y="12" width="3" height="1"/>';

export function nutria(mood, size = "") {
  const m = MOODS[mood] || MOODS.free;
  const el = h("span", { class: `nutria ${mood} ${size}`.trim(), "aria-hidden": "true" });
  el.innerHTML = `<svg viewBox="0 0 16 14" shape-rendering="crispEdges">${BODY}${ARMS[m.arms]}${EYES[m.eyes]}${m.prop ? PROPS[m.prop] : ""}</svg>${m.bubble ? `<b class="bubble ${m.bubble[1]}">${m.bubble[0]}</b>` : ""}${m.zz ? '<i class="zz">z<span>z</span></i>' : ""}`;
  return el;
}
