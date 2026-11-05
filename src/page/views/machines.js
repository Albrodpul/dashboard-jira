import { state, h, button, when, toast, requestOrFail, render, empty } from "../lib/base.js";

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
    h("span", { class: `chip ${commander ? "done" : "ignored"}`, text: !device.online ? "Desconectado" : !b ? (data.self && hostOf(data.self.peer) === device.dns ? "Su tablero no responde" : "Sin tablero") : commander ? "Manda" : "En espera" }),
  ];
  const lines = [];
  if (!device.online && device.lastSeen) lines.push(`Visto por última vez ${when(device.lastSeen)}`);
  if (b && commander) lines.push(`Manda desde ${when(b.since)}`);
  if (b && !commander && device.online) lines.push(`Datos copiados ${b.lastSnapshot ? when(b.lastSnapshot) : "nunca"} · conversaciones ${b.lastTranscripts ? when(b.lastTranscripts) : "nunca"}`);
  if (b && b.claudeToken) lines.push(tokenLine(b.claudeToken));
  if (device.ip) lines.push(device.ip);
  const actions = [];
  if (b && device.online && !commander) actions.push(button(`Que mande el ${b.label}`, { cls: "primary", disabled: busy, onClick: () => window.confirm(`¿Pasar el mando al ${b.label}? El otro ordenador para sus sesiones y este las retoma.`) && act(b.label, "take", `Pasando el mando al ${b.label}…`) }));
  return h("article", { class: "card dev-server" }, [h("div", { class: "top" }, top), ...lines.map((t) => h("div", { class: "meta", text: t })), actions.length ? h("div", { class: "actions" }, actions) : null]);
}

function tokenLine(t) {
  if (!t.sessions) return "Token de Claude: no tiene; las sesiones usan el /login";
  const until = t.expires ? `, caduca el ${t.expires.split("-").reverse().join("/")}` : ", sin fecha de caducidad apuntada";
  return `Token de Claude: sí${until} · VS Code ${t.vscode ? "también lo usa" : "aún con su /login"}`;
}

const TOKEN_STEPS = [
  ["Cuándo", "Si las sesiones caen todas a la vez con «Login reached its time limit» o «Failed to authenticate», si te han revocado el acceso, o cuando el aviso junto a la cuota diga que el token caduca pronto."],
  ["1", "En una sesión de Claude de cualquiera de los dos ordenadores escribe: ! node <workspace>/board.js claude-token --setup. Se abre el navegador: quien tenga la cuenta de empresa autoriza. El comando coge el token solo, sin enseñarlo, lo guarda en el .env de ese ordenador y lo pone también para VS Code. No tienes que copiar ni pegar nada."],
  ["2", "Pide a la sesión del Tablero que lo copie al otro ordenador (lo hace por SSH sin enseñarlo). A mano sería: node <workspace>/board.js claude-token --export | ssh <otro ordenador> \"node <workspace>/board.js claude-token --import\"."],
  ["3", "Cierra VS Code del todo y ábrelo de nuevo en los dos ordenadores."],
  ["4", "Comprueba aquí que los dos dicen «Token de Claude: sí» con la fecha nueva. Las sesiones del tablero lo cogen solas la próxima vez que se abran; si alguna sigue fallando, reiníciala desde Sesiones."],
  ["Sin token", "Para volver al /login de siempre: borra CLAUDE_CODE_OAUTH_TOKEN y CLAUDE_TOKEN_EXPIRES del .env y ejecuta node <workspace>/board.js claude-token --remove en cada ordenador."],
];

function tokenHelp() {
  const det = h("details", { class: "token-help" }, [h("summary", { text: "Token de Claude: qué hacer si caduca o te quitan el acceso" })]);
  det.open = [data.self, data.peer].some((b) => b && b.claudeToken && !b.claudeToken.sessions);
  det.appendChild(h("dl", { class: "token-steps" }, TOKEN_STEPS.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])));
  return det;
}

export function renderMachines(root) {
  if (!data) {
    load();
    return root.appendChild(empty("Mirando los equipos…", ""));
  }
  if (data.error) return root.appendChild(h("div", { class: "setup-note warn", text: data.error }));
  root.appendChild(h("p", { class: "setup-note", text: "El mando solo cambia cuando tú lo pasas con el botón, o si el que manda deja de responder (apagado o suspendido): entonces el otro lo toma al minuto y lo conserva cuando el primero vuelve. Al encender por la mañana, un ordenador solo coge el mando si no manda ninguno." }));
  if (!data.devices) return root.appendChild(empty("No se pudo leer Tailscale en este ordenador.", ""));
  root.appendChild(h("div", { class: "cards" }, data.devices.map(card)));
  root.appendChild(tokenHelp());
}
