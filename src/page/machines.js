import { state, h, button, when, toast, requestOrFail, render, empty } from "./base.js";

let data = null;
let loading = false;
let busy = false;

function load() {
  if (loading) return;
  loading = true;
  fetch("/api/cluster/machines", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => (data = d))
    .catch(() => (data = { error: "No se pudo leer el estado de los equipos." }))
    .finally(() => {
      loading = false;
      if (state.tab === "machines") render();
    });
}

setInterval(() => state.tab === "machines" && !document.hidden && load(), 5000);

function act(target, action, label) {
  busy = true;
  render();
  requestOrFail("/api/cluster/command", { target, action })
    .then(() => toast(label))
    .catch((e) => toast(`No se pudo: ${e.message}`))
    .finally(() => {
      busy = false;
      setTimeout(load, 1500);
    });
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
};

function boardOf(device) {
  const boards = [data.self, data.peer].filter(Boolean);
  return boards.find((b) => b.self && hostOf(b.self) === device.dns) || null;
}

function card(device) {
  const b = boardOf(device);
  const commander = b && b.role === "primary";
  const top = [
    h("span", { class: `dot ${device.online ? "on" : "off"}` }),
    h("strong", { text: b && b.label ? `${b.label} · ${device.name}` : device.name }),
    h("span", { class: "meta", text: device.os }),
    h("span", { class: `chip ${commander ? "done" : "ignored"}`, text: !device.online ? "Desconectado" : !b ? (data.self && hostOf(data.self.peer) === device.dns ? "Su tablero no responde" : "Sin tablero") : commander ? (b.manual ? "Manda (lo pediste tú)" : "Manda") : "En espera" }),
  ];
  const lines = [];
  if (!device.online && device.lastSeen) lines.push(`Visto por última vez ${when(device.lastSeen)}`);
  if (b && commander) lines.push(`Manda desde ${when(b.since)}${b.preferred ? " · es el preferido" : ""}`);
  if (b && !commander && device.online) lines.push(`Datos copiados ${b.lastSnapshot ? when(b.lastSnapshot) : "nunca"} · conversaciones ${b.lastTranscripts ? when(b.lastTranscripts) : "nunca"}`);
  if (device.ip) lines.push(device.ip);
  const actions = [];
  if (b && device.online && !commander) actions.push(button(`Que mande el ${b.label}`, { cls: "primary", disabled: busy, onClick: () => window.confirm(`¿Pasar el mando al ${b.label}? El otro ordenador para sus sesiones y este las retoma.`) && act(b.label, "take", `Pasando el mando al ${b.label}…`) }));
  if (b && commander && b.manual) actions.push(button("Volver al automático", { disabled: busy, onClick: () => act(b.label, "auto", "Vuelve el automático: si el preferido está encendido, recupera el mando en menos de un minuto.") }));
  return h("article", { class: "card dev-server" }, [h("div", { class: "top" }, top), ...lines.map((t) => h("div", { class: "meta", text: t })), actions.length ? h("div", { class: "actions" }, actions) : null]);
}

export function renderMachines(root) {
  if (!data) {
    load();
    return root.appendChild(empty("Mirando los equipos…", ""));
  }
  if (data.error) return root.appendChild(h("div", { class: "setup-note warn", text: data.error }));
  root.appendChild(h("p", { class: "setup-note", text: "Si el que manda deja de responder, el otro toma el mando al minuto. Cuando vuelve el preferido, lo recupera, salvo que le hayas pasado el mando al otro a mano." }));
  if (!data.devices) return root.appendChild(empty("No se pudo leer Tailscale en este ordenador.", ""));
  root.appendChild(h("div", { class: "cards" }, data.devices.map(card)));
}
