import { characterFor, currentCast } from "./cast.js";
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
  mug: '<rect class="mug" x="11" y="8" width="3" height="3"/><rect class="coffee" x="11" y="8" width="3" height="1"/><rect class="mug" x="14" y="9" width="1" height="1"/>',
  controller: '<rect class="pad" x="5" y="9" width="6" height="2"/><rect class="pad" x="4" y="10" width="1" height="2"/><rect class="pad" x="11" y="10" width="1" height="2"/><rect class="btn-a" x="9" y="9" width="1" height="1"/><rect class="btn-b" x="6" y="9" width="1" height="1"/>',
  paddle: '<rect class="paddle" x="13" y="5" width="3" height="3"/><rect class="handle" x="13" y="8" width="1" height="2"/>',
  marker: '<rect class="metal" x="13" y="-1" width="1" height="2"/>',
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
  relax: { arms: "rest", eyes: "shut" },
  typing: { arms: "rest", eyes: "open" },
  drawing: { arms: "hand", eyes: "open", prop: "marker" },
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

const OUTFITS = {
  scarf: '<rect class="scarf" x="4" y="7" width="8" height="1"/><rect class="scarf" x="9" y="8" width="2" height="2"/>',
  tie: '<rect class="collar" x="5" y="7" width="2" height="1"/><rect class="collar" x="9" y="7" width="2" height="1"/><rect class="scarf" x="7" y="7" width="2" height="1"/><rect class="scarf dark" x="7" y="8" width="2" height="3"/>',
  bowtie: '<rect class="scarf" x="5" y="7" width="2" height="2"/><rect class="scarf" x="9" y="7" width="2" height="2"/><rect class="scarf dark" x="7" y="7" width="2" height="1"/>',
  sweater: '<rect class="scarf" x="4" y="7" width="8" height="5"/><rect class="scarf dark" x="4" y="7" width="8" height="1"/><rect class="scarf light" x="4" y="9" width="8" height="1"/>',
  hoodie: '<rect class="scarf" x="4" y="7" width="8" height="5"/><rect class="scarf dark" x="3" y="6" width="2" height="2"/><rect class="scarf dark" x="11" y="6" width="2" height="2"/><rect class="collar" x="6" y="8" width="1" height="2"/><rect class="collar" x="9" y="8" width="1" height="2"/><rect class="scarf dark" x="6" y="10" width="4" height="1"/>',
  overalls: '<rect class="scarf" x="5" y="7" width="1" height="2"/><rect class="scarf" x="10" y="7" width="1" height="2"/><rect class="scarf" x="5" y="9" width="6" height="3"/><rect class="button" x="5" y="9" width="1" height="1"/><rect class="button" x="10" y="9" width="1" height="1"/>',
  sailor: '<rect class="collar" x="4" y="7" width="8" height="5"/><rect class="scarf" x="4" y="8" width="8" height="1"/><rect class="scarf" x="4" y="10" width="8" height="1"/>',
};
const HATS = {
  none: "",
  beanie: '<rect class="hat" x="4" y="-1" width="8" height="1"/><rect class="hat dark" x="3" y="0" width="10" height="1"/><rect class="hat light" x="7" y="-2" width="2" height="1"/>',
  cap: '<rect class="hat" x="4" y="-1" width="8" height="2"/><rect class="hat dark" x="10" y="0" width="5" height="1"/>',
  glasses: '<rect class="frame" x="4" y="1" width="3" height="1"/><rect class="frame" x="4" y="2" width="1" height="2"/><rect class="frame" x="6" y="2" width="1" height="2"/><rect class="frame" x="7" y="2" width="2" height="1"/><rect class="frame" x="9" y="1" width="3" height="1"/><rect class="frame" x="9" y="2" width="1" height="2"/><rect class="frame" x="11" y="2" width="1" height="2"/>',
  headphones: '<rect class="frame" x="3" y="-1" width="10" height="1"/><rect class="frame" x="2" y="0" width="1" height="1"/><rect class="frame" x="13" y="0" width="1" height="1"/><rect class="hat" x="1" y="1" width="2" height="3"/><rect class="hat" x="13" y="1" width="2" height="3"/>',
  bow: '<rect class="hat" x="10" y="-1" width="2" height="2"/><rect class="hat" x="13" y="-1" width="2" height="2"/><rect class="hat dark" x="12" y="0" width="1" height="1"/>',
  flower: '<rect class="petal" x="11" y="-2" width="1" height="1"/><rect class="petal" x="10" y="-1" width="1" height="1"/><rect class="petal" x="12" y="-1" width="1" height="1"/><rect class="petal" x="11" y="0" width="1" height="1"/><rect class="hat light" x="11" y="-1" width="1" height="1"/>',
};

const BODY =
  '<rect class="tail" x="12" y="10" width="3" height="2"/><rect class="tail" x="14" y="9" width="1" height="1"/>' +
  '<rect class="ear" x="2" y="0" width="2" height="2"/><rect class="ear" x="12" y="0" width="2" height="2"/>' +
  '<rect class="fur" x="4" y="0" width="8" height="1"/><rect class="fur" x="3" y="1" width="10" height="6"/>' +
  '<rect class="cream" x="5" y="4" width="6" height="3"/><rect class="nose" x="7" y="4" width="2" height="1"/>' +
  '<rect class="whisker" x="1" y="5" width="2" height="1"/><rect class="whisker" x="13" y="5" width="2" height="1"/>' +
  '<rect class="fur" x="4" y="7" width="8" height="5"/><rect class="cream" x="6" y="8" width="4" height="4"/>' +
  '<rect class="ear" x="4" y="12" width="3" height="1"/><rect class="ear" x="9" y="12" width="3" height="1"/>';

function draw(el, seed) {
  const m = MOODS[el.dataset.mood] || MOODS.free;
  const extra = el.dataset.prop;
  const who = characterFor(seed);
  const body = who ? who.body : BODY;
  const arms = !who || who.arms ? ARMS[m.arms] : "";
  const eyes = !who || who.eyes ? EYES[m.eyes] : "";
  const wear = who ? "" : `<g class="wear">${OUTFITS.scarf}</g>`;
  if (who) {
    el.style.setProperty("--fur", who.fur);
    el.dataset.who = who.name;
  }
  el.innerHTML = `<svg viewBox="0 -1 17 15" shape-rendering="crispEdges">${body}${arms}${eyes}${wear}${extra ? PROPS[extra] : ""}</svg>${m.bubble ? `<b class="bubble ${m.bubble[1]}">${m.bubble[0]}</b>` : ""}${m.zz ? '<i class="zz">z<span>z</span></i>' : ""}`;
}

export function nutria(mood, size = "", prop = null) {
  const m = MOODS[mood] || MOODS.free;
  const el = document.createElement("span");
  el.className = `nutria ${mood} ${size}`.trim();
  el.setAttribute("aria-hidden", "true");
  el.dataset.mood = mood;
  const extra = prop || m.prop;
  if (extra) el.dataset.prop = extra;
  draw(el, hashOf(mood, 29, 1));
  return el;
}

export const CLAYS = ["#d97757", "#e0a63b", "#5fa86b", "#4f9bd6", "#9b7fd6", "#d76f9c", "#3fb3a8", "#c4825a"];
const FURS = ["#8a5a3b", "#a0694a", "#6f4a33", "#b07d56", "#7d5a44", "#94704f"];
const hashOf = (name, mul, seed) => [...String(name || "")].reduce((n, ch) => (n * mul + ch.charCodeAt(0)) >>> 0, seed);

const OUTFIT_KEYS = Object.keys(OUTFITS);
const HAT_KEYS = ["none", "none", ...Object.keys(HATS).filter((k) => k !== "none")];

export function paint(el, name) {
  if (currentCast() !== "nutrias") {
    draw(el, hashOf(name, 41, 13));
    return el;
  }
  const clay = hashOf(name, 31, 7) % CLAYS.length;
  el.style.setProperty("--clay", CLAYS[clay]);
  el.style.setProperty("--hat", CLAYS[(clay + 3 + (hashOf(name, 13, 5) % 4)) % CLAYS.length]);
  el.style.setProperty("--fur", FURS[hashOf(name, 17, 3) % FURS.length]);
  const wear = el.querySelector(".wear");
  if (wear) {
    const hat = ["helmet", "binoculars"].includes(el.dataset.prop) ? "" : HATS[HAT_KEYS[hashOf(name, 37, 11) % HAT_KEYS.length]];
    wear.innerHTML = OUTFITS[OUTFIT_KEYS[hashOf(name, 23, 19) % OUTFIT_KEYS.length]] + hat;
  }
  return el;
}

const DOT_MOOD = { busy: "working", wait: "blocked", bad: "blocked", on: "idle", off: "free", "": "free" };

export function sessionNutria(name, dot, size = "avatar") {
  return paint(nutria(DOT_MOOD[dot] || "idle", size), name);
}
