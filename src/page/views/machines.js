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

let job = { state: "idle" };
let jobTimer = null;
let jobBusy = false;
let jobLoaded = false;
let codeDraft = "";

function pollJob() {
  fetch("/api/claude-token/setup", { cache: "no-store" })
    .then((r) => r.json())
    .then((j) => {
      const changed = JSON.stringify(j) !== JSON.stringify(job);
      job = j;
      jobLoaded = true;
      const typing = document.activeElement && document.activeElement.classList.contains("token-code");
      if (changed && !typing && state.tab === "machines") render();
      clearTimeout(jobTimer);
      if (j.state === "running") jobTimer = setTimeout(pollJob, 2000);
      if (j.state === "done") setTimeout(load, 1500);
    })
    .catch(() => {});
}

function jobAction(body, label) {
  jobBusy = true;
  render();
  requestOrFail("/api/claude-token/setup", body)
    .then((j) => {
      job = j;
      if (label) toast(label);
    })
    .catch((e) => toast(`No se pudo: ${e.message}`))
    .finally(() => {
      jobBusy = false;
      render();
      pollJob();
    });
}

function tokenRenew() {
  const box = h("section", { class: "token-renew" }, [h("h3", { text: "Token de Claude" })]);
  const startButton = (label) =>
    button(label, {
      cls: "primary",
      disabled: jobBusy,
      onClick: () => window.confirm("Se abrirá el navegador en este ordenador para autorizar con la cuenta de empresa. El token se guardará aquí y en el otro ordenador, y también para VS Code. ¿Seguir?") && jobAction({ action: "start" }),
    });
  if (job.state === "running") {
    box.appendChild(h("p", { class: "setup-note", text: "Se ha abierto el navegador en este ordenador: quien tenga la cuenta de empresa tiene que autorizar. Si no está delante, cópiale el enlace y mándaselo." }));
    if (job.url)
      box.appendChild(
        h("div", { class: "actions" }, [
          h("a", { class: "btn link", href: job.url, target: "_blank", rel: "noopener noreferrer", text: "Abrir el enlace de autorización" }),
          button("Copiar el enlace", { onClick: () => navigator.clipboard.writeText(job.url).then(() => toast("Enlace copiado."), () => toast("No se pudo copiar.")) }),
        ])
      );
    if (job.asksCode) {
      const input = h("input", { type: "text", class: "token-code", placeholder: "Código que da la página al autorizar", "aria-label": "Código de autorización", oninput: (e) => (codeDraft = e.target.value) });
      input.value = codeDraft;
      box.appendChild(h("div", { class: "actions" }, [input, button("Enviar el código", { cls: "primary", disabled: jobBusy, onClick: () => input.value.trim() && (jobAction({ action: "code", code: input.value.trim() }, "Código enviado."), (codeDraft = "")) })]));
    }
    if (job.tail) box.appendChild(h("pre", { class: "token-tail", text: job.tail }));
    box.appendChild(h("div", { class: "actions" }, [button("Cancelar", { cls: "subtle", disabled: jobBusy, onClick: () => jobAction({ action: "cancel" }) })]));
    return box;
  }
  if (job.state === "done") {
    const peer = job.peer === true ? "y copiado al otro ordenador" : job.peer === false ? "pero el otro ordenador no responde" : "";
    box.appendChild(h("p", { class: "setup-note", text: `Listo: token guardado en este ordenador ${peer}, caduca hacia el ${(job.expires || "").split("-").reverse().join("/")}. Ya vale también para VS Code: ciérralo del todo y ábrelo de nuevo en los dos ordenadores.` }));
    const acts = [startButton("Renovar otra vez")];
    if (job.peer === false) acts.unshift(button("Copiar al otro ordenador", { cls: "primary", disabled: jobBusy, onClick: () => jobAction({ action: "copy" }) }));
    box.appendChild(h("div", { class: "actions" }, acts));
    return box;
  }
  const mine = data.self && data.self.claudeToken, theirs = data.peer && data.peer.claudeToken;
  if (mine && mine.sessions && theirs && !theirs.sessions) {
    box.appendChild(h("p", { class: "setup-note warn", text: "Este ordenador tiene el token y el otro no (estaría apagado al renovarlo)." }));
    box.appendChild(h("div", { class: "actions" }, [button("Copiar al otro ordenador", { cls: "primary", disabled: jobBusy, onClick: () => jobAction({ action: "copy" }, "Token copiado al otro ordenador.") })]));
  }
  if (job.state === "failed") box.appendChild(h("p", { class: "setup-note warn", text: `No se ha renovado: ${job.error || "error desconocido"}` }));
  if (job.state === "failed" && job.tail) box.appendChild(h("pre", { class: "token-tail", text: job.tail }));
  box.appendChild(h("p", { class: "setup-note", text: "Las sesiones del tablero y VS Code, en los dos ordenadores, usan un token de un año que no depende del /login. Renuévalo si caduca, si te quitan el acceso o si las sesiones caen todas con «Failed to authenticate». Se puede renovar antes de tiempo: si tu navegador aún tiene abierta la sesión de claude.ai con la cuenta de empresa, autorizas tú solo." }));
  box.appendChild(h("div", { class: "actions" }, [startButton("Renovar token de Claude")]));
  return box;
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
  root.appendChild(tokenRenew());
  if (!jobLoaded) pollJob();
}
