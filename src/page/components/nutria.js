
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
  magnifier: '<rect class="lens" x="11" y="6" width="3" height="3"/><rect class="metal" x="11" y="5" width="3" height="1"/><rect class="metal" x="10" y="6" width="1" height="3"/><rect class="metal" x="14" y="6" width="1" height="3"/><rect class="metal" x="11" y="9" width="3" height="1"/><rect class="handle" x="9" y="10" width="1" height="1"/><rect class="handle" x="8" y="11" width="1" height="1"/>',
  binoculars: '<rect class="metal" x="4" y="2" width="3" height="2"/><rect class="metal" x="9" y="2" width="3" height="2"/><rect class="metal" x="7" y="2" width="2" height="1"/><rect class="lens" x="5" y="2" width="1" height="1"/><rect class="lens" x="10" y="2" width="1" height="1"/>',
  newspaper: '<rect class="paper" x="2" y="7" width="12" height="6"/><rect class="ink" x="3" y="8" width="10" height="1"/><rect class="ink" x="3" y="10" width="4" height="1"/><rect class="ink" x="9" y="10" width="4" height="1"/><rect class="ink" x="3" y="11" width="4" height="1"/><rect class="ink" x="9" y="11" width="3" height="1"/>',
  helmet: '<rect class="helmet" x="3" y="-1" width="10" height="2"/><rect class="helmet" x="2" y="1" width="12" height="1"/><rect class="helmet-band" x="7" y="-1" width="2" height="2"/>',
  rocket: '<rect class="rocket-tip" x="14" y="1" width="1" height="1"/><rect class="rocket" x="13" y="2" width="3" height="5"/><rect class="lens" x="14" y="3" width="1" height="1"/><rect class="rocket-tip" x="12" y="6" width="1" height="2"/><rect class="rocket-tip" x="16" y="6" width="1" height="2"/><rect class="flame" x="14" y="7" width="1" height="2"/>',
  book: '<rect class="book" x="4" y="9" width="8" height="4"/><rect class="paper" x="4" y="9" width="8" height="1"/><rect class="book-spine" x="7" y="9" width="2" height="4"/>',
  box: '<rect class="box" x="3" y="9" width="10" height="5"/><rect class="tape" x="7" y="9" width="2" height="5"/>',
  laptop: '<rect class="laptop" x="3" y="10" width="10" height="3"/><rect class="screen" x="4" y="11" width="8" height="1"/>',
  paper: '<rect class="paper" x="4" y="9" width="8" height="5"/><rect class="ink" x="5" y="10" width="5" height="1"/><rect class="ink" x="5" y="12" width="4" height="1"/>',
};
const MOODS = {
  idle: { arms: "rest", eyes: "open" },
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

export function nutria(mood, size = "", prop = null) {
  const m = MOODS[mood] || MOODS.free;
  const el = document.createElement("span");
  el.className = `nutria ${mood} ${size}`.trim();
  el.setAttribute("aria-hidden", "true");
  const extra = prop || m.prop;
  el.innerHTML = `<svg viewBox="0 -1 17 15" shape-rendering="crispEdges">${BODY}${ARMS[m.arms]}${EYES[m.eyes]}${extra ? PROPS[extra] : ""}</svg>${m.bubble ? `<b class="bubble ${m.bubble[1]}">${m.bubble[0]}</b>` : ""}${m.zz ? '<i class="zz">z<span>z</span></i>' : ""}`;
  return el;
}

export const CLAYS = ["#d97757", "#e0a63b", "#5fa86b", "#4f9bd6", "#9b7fd6", "#d76f9c", "#3fb3a8", "#c4825a"];
const FURS = ["#8a5a3b", "#a0694a", "#6f4a33", "#b07d56", "#7d5a44", "#94704f"];
const hashOf = (name, mul, seed) => [...String(name || "")].reduce((n, ch) => (n * mul + ch.charCodeAt(0)) >>> 0, seed);

export function paint(el, name) {
  el.style.setProperty("--clay", CLAYS[hashOf(name, 31, 7) % CLAYS.length]);
  el.style.setProperty("--fur", FURS[hashOf(name, 17, 3) % FURS.length]);
  return el;
}

const DOT_MOOD = { busy: "working", wait: "blocked", bad: "blocked", on: "idle", off: "free", "": "free" };

export function sessionNutria(name, dot, size = "avatar") {
  return paint(nutria(DOT_MOOD[dot] || "idle", size), name);
}
