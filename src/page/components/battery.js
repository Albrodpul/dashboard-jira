import { h } from "../lib/base.js";
import { t, LOCALE } from "../lib/i18n.js";

export function batteryLevel(bat) {
  if (!bat) return "";
  if (bat.charging) return "charging";
  if (!bat.onAC && bat.percent <= 20) return "low";
  if (!bat.onAC && bat.percent <= 35) return "mid";
  return "ok";
}

export function batteryText(bat) {
  if (!bat) return "";
  if (bat.charging) return t("Cargando");
  if (bat.onAC) return bat.percent >= 99 ? t("Cargada") : t("Enchufado");
  return t("Con batería");
}

export function batteryIcon(bat, size = 26) {
  const pct = Math.max(0, Math.min(100, bat ? bat.percent : 0));
  const inner = 18 * (pct / 100);
  const bolt = bat && bat.charging ? '<path class="bat-bolt" d="M13.6 2.6 9.4 8.3h2.9l-1.1 4.1 4.3-5.9h-3z"/>' : "";
  const plug = bat && bat.onAC && !bat.charging ? '<path class="bat-plug" d="M10.5 5.2v4.6M13.5 5.2v4.6"/>' : "";
  const svg = `<svg viewBox="0 0 26 15" width="${size}" height="${Math.round((size * 15) / 26)}" aria-hidden="true"><rect class="bat-shell" x="0.75" y="0.75" width="21.5" height="13.5" rx="3.5"/><rect class="bat-cap" x="23.2" y="4.6" width="2.1" height="5.8" rx="1"/><rect class="bat-fill" x="2.5" y="2.5" width="${inner.toFixed(2)}" height="10" rx="2"/>${bolt}${plug}</svg>`;
  const el = h("span", { class: `battery ${batteryLevel(bat)}` });
  el.innerHTML = svg;
  return el;
}

export function batteryBadge(bat, label = "Mac") {
  if (!bat) return null;
  const when = new Date(bat.at).toLocaleTimeString(LOCALE, { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
  return h("span", { class: `battery-badge ${batteryLevel(bat)}`, title: t("Batería del Mac: {percent} %, {state} (leída a las {time})", { percent: bat.percent, state: batteryText(bat).toLowerCase(), time: when }) }, [
    label ? h("span", { class: "battery-label", text: label }) : null,
    batteryIcon(bat),
    h("span", { class: "battery-pct", text: `${bat.percent}%` }),
  ]);
}
