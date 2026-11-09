const STAMPS_KEY = "syncStamps";
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;

const SPECS = {
  config: { type: "map" },
  aliases: { type: "map" },
  seenEpics: { type: "map" },
  sentry: { type: "map" },
  sessionOverrides: { type: "map" },
  deployments: { type: "list", id: "id", cap: 40 },
  messages: { type: "list", id: "id", cap: 60 },
  followUps: { type: "list", id: "at", cap: 120 },
  reports: { type: "list", id: "at", cap: 20 },
  permissionRules: { type: "list", id: "key", ascending: true },
  refreshRequest: { type: "doc" },
  lastReview: { type: "doc" },
  contextTidy: { type: "doc" },
};

const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x) => (x === undefined ? undefined : JSON.stringify(x));

function toMap(spec, value) {
  if (spec.type === "doc") return value == null ? {} : { "": value };
  if (value == null) return {};
  if (spec.type === "map") return isObject(value) ? value : null;
  if (!Array.isArray(value)) return null;
  const map = {};
  for (const r of value) {
    const id = isObject(r) ? r[spec.id] : undefined;
    if (typeof id !== "string" || !id || Object.prototype.hasOwnProperty.call(map, id)) return null;
    map[id] = r;
  }
  return map;
}

function stampRecords(rawBefore, d, texts = null, at = new Date().toISOString()) {
  let stamps = null;
  const cutoff = new Date(new Date(at).getTime() - TOMBSTONE_MS).toISOString();
  for (const [key, spec] of Object.entries(SPECS)) {
    const after = texts ? texts[key] : text(d[key]);
    if (after === rawBefore[key]) continue;
    const a = toMap(spec, rawBefore[key] === undefined ? undefined : JSON.parse(rawBefore[key]));
    const b = toMap(spec, d[key]);
    if (!a || !b) continue;
    let own = null;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (text(a[id]) === text(b[id])) continue;
      stamps = stamps || { ...(d[STAMPS_KEY] || {}) };
      own = own || (stamps[key] = { ...(stamps[key] || {}) });
      own[id] = at;
    }
    if (!own) continue;
    for (const [id, t] of Object.entries(own)) if (!(id in b) && t < cutoff) delete own[id];
  }
  if (stamps) d[STAMPS_KEY] = stamps;
  return !!stamps;
}

function sortList(spec, list) {
  const order = new Map(list.map((r, i) => [r, i]));
  const at = (r) => String(r.at || "");
  list.sort((x, y) => (spec.ascending ? at(x).localeCompare(at(y)) : at(y).localeCompare(at(x))) || order.get(x) - order.get(y));
  return spec.cap ? list.slice(0, spec.cap) : list;
}

function mergeKey(spec, mineValue, theirsValue, mineStamps, theirStamps, theirsOnTie) {
  if (spec.type === "doc") {
    const ta = mineStamps[""] || "";
    const tb = theirStamps[""] || "";
    const theirs = tb > ta || (tb === ta && theirsOnTie);
    const stamp = theirs ? tb : ta;
    return { value: theirs ? theirsValue : mineValue, stamps: stamp ? { "": stamp } : {} };
  }
  const a = toMap(spec, mineValue);
  const b = toMap(spec, theirsValue);
  if (!a || !b) return { value: theirsOnTie ? theirsValue : mineValue, stamps: theirsOnTie ? theirStamps : mineStamps };
  const [first, second] = theirsOnTie ? [b, a] : [a, b];
  const ids = new Set([...Object.keys(first), ...Object.keys(second), ...Object.keys(mineStamps), ...Object.keys(theirStamps)]);
  const out = {};
  const stamps = {};
  for (const id of ids) {
    const ta = mineStamps[id] || "";
    const tb = theirStamps[id] || "";
    const theirs = tb > ta || (tb === ta && theirsOnTie);
    const value = theirs ? b[id] : a[id];
    const stamp = theirs ? tb : ta;
    if (value !== undefined) out[id] = value;
    if (stamp) stamps[id] = stamp;
  }
  if (spec.type === "map") return { value: !Object.keys(out).length && mineValue == null ? mineValue : out, stamps };
  return { value: sortList(spec, Object.values(out)), stamps };
}

function mergeRecords(d, docs, theirStamps, theirsOnTie) {
  const mine = d[STAMPS_KEY] || {};
  const next = { ...mine };
  for (const [key, spec] of Object.entries(SPECS)) {
    if (docs[key] === undefined && !(theirStamps || {})[key]) continue;
    const r = mergeKey(spec, d[key], docs[key], mine[key] || {}, (theirStamps || {})[key] || {}, theirsOnTie);
    d[key] = r.value;
    if (Object.keys(r.stamps).length) next[key] = r.stamps;
    else delete next[key];
  }
  d[STAMPS_KEY] = next;
}

module.exports = { SPECS, STAMPS_KEY, stampRecords, mergeRecords, mergeKey, toMap };
