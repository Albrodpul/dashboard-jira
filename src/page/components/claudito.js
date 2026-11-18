import { h } from "../lib/base.js";

const ARMS = {
  rest: '<rect class="arm left" x="0" y="5" width="2" height="2"/><rect class="arm right" x="14" y="5" width="2" height="2"/>',
  hand: '<rect class="arm" x="0" y="5" width="2" height="2"/><rect class="arm raised" x="14" y="0" width="2" height="5"/>',
  up: '<rect class="arm up left" x="0" y="0" width="2" height="5"/><rect class="arm up right" x="14" y="0" width="2" height="5"/>',
};
const EYES = {
  open: '<rect class="eye" x="5" y="5" width="1" height="2"/><rect class="eye" x="10" y="5" width="1" height="2"/>',
  shut: '<rect class="eye" x="4" y="6" width="2" height="1"/><rect class="eye" x="10" y="6" width="2" height="1"/>',
  happy: '<rect class="eye" x="4" y="5" width="1" height="1"/><rect class="eye" x="5" y="4" width="1" height="1"/><rect class="eye" x="6" y="5" width="1" height="1"/><rect class="eye" x="9" y="5" width="1" height="1"/><rect class="eye" x="10" y="4" width="1" height="1"/><rect class="eye" x="11" y="5" width="1" height="1"/>',
};
const PROPS = {
  laptop: '<rect class="laptop" x="3" y="9" width="10" height="3"/><rect class="screen" x="4" y="10" width="8" height="1"/>',
  paper: '<rect class="paper" x="4" y="8" width="8" height="5"/><rect class="ink" x="5" y="9" width="5" height="1"/><rect class="ink" x="5" y="11" width="4" height="1"/>',
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

export function claudito(mood, size = "") {
  const m = MOODS[mood] || MOODS.free;
  const el = h("span", { class: `claudito ${mood} ${size}`.trim(), "aria-hidden": "true" });
  const legs = [3, 5, 10, 12].map((x) => `<rect class="leg" x="${x}" y="10" width="1" height="2"/>`).join("");
  el.innerHTML = `<svg viewBox="0 0 16 14" shape-rendering="crispEdges"><rect class="body" x="2" y="3" width="12" height="7"/>${ARMS[m.arms]}${legs}${EYES[m.eyes]}${m.prop ? PROPS[m.prop] : ""}</svg>${m.bubble ? `<b class="bubble ${m.bubble[1]}">${m.bubble[0]}</b>` : ""}${m.zz ? '<i class="zz">z<span>z</span></i>' : ""}`;
  return el;
}
