import { state, h, button, when, toast, requestOrFail, render, empty } from "../lib/base.js";
import { batteryIcon, batteryText } from "../components/battery.js";

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

const ICON = {
  macOS: '<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20l-1.5-2.5h-17z"/>',
  windows: '<rect x="2.5" y="3.5" width="19" height="13" rx="1.5"/><path d="M8 20.5h8M12 16.5v4"/>',
};
const deviceIcon = (os) => {
  const el = h("span", { class: "dev-icon", "aria-hidden": "true" });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[os] || ICON.windows}</svg>`;
  return el;
};
const row = (label, value) => h("div", { class: "dev-row" }, [h("span", { class: "dev-label", text: label }), h("span", { class: "dev-value" }, [].concat(value))]);
const fmtDate = (d) => (d ? d.split("-").reverse().join("/") : "");

function card(device) {
  const b = boardOf(device);
  const commander = b && b.role === "primary";
  const isMac = device.os === "macOS";
  const status = !device.online ? ["off", "Desconectado"] : !b ? ["warn", data.self && hostOf(data.self.peer) === device.dns ? "Su tablero no responde" : "Sin tablero"] : commander ? ["on", "Manda"] : ["idle", "En espera"];
  const head = h("div", { class: "dev-head" }, [
    deviceIcon(device.os),
    h("div", { class: "dev-title" }, [h("strong", { text: (b && b.label) || device.name }), h("span", { class: "meta", text: `${device.name} · ${device.os}` })]),
    h("span", { class: `dev-status ${status[0]}` }, [h("span", { class: "dot" }), status[1]]),
  ]);
  const rows = [];
  const mp = state.cluster && state.cluster.macPower;
  if (isMac && mp && mp.battery) rows.push(row("Batería", h("span", { class: "dev-battery" }, [batteryIcon(mp.battery, 30), `${mp.battery.percent} % · ${batteryText(mp.battery).toLowerCase()}`])));
  if (isMac && mp && mp.schedule) rows.push(row("Horario", `despierto de ${mp.schedule.wake} a ${mp.schedule.sleep}, de lunes a viernes`));
  if (!device.online && device.lastSeen) rows.push(row("Visto", when(device.lastSeen)));
  if (b && commander) rows.push(row("Manda desde", when(b.since)));
  if (b && !commander && device.online) rows.push(row("Copia", `datos ${b.lastSnapshot ? when(b.lastSnapshot) : "nunca"} · conversaciones ${b.lastTranscripts ? when(b.lastTranscripts) : "nunca"}`));
  if (b && b.claudeToken) rows.push(row("Token", b.claudeToken.sessions ? `hasta el ${fmtDate(b.claudeToken.expires) || "?"}${b.claudeToken.vscode ? " · también VS Code" : " · VS Code aún con /login"}` : "no tiene; usa el /login"));
  if (device.ip) rows.push(row("Tailscale", device.ip));
  const actions = [];
  if (b && device.online && !commander) actions.push(button(`Que mande el ${b.label}`, { cls: "primary", disabled: busy, onClick: () => window.confirm(`¿Pasar el mando al ${b.label}? El otro ordenador para sus sesiones y este las retoma.`) && act(b.label, "take", `Pasando el mando al ${b.label}…`) }));
  return h("article", { class: `card dev-card${commander ? " is-commander" : ""}${device.online ? "" : " offline"}` }, [head, h("div", { class: "dev-rows" }, rows), actions.length ? h("div", { class: "actions" }, actions) : null]);
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
  const box = h("section", { class: "card setting-card token-renew" }, [h("h3", { text: "Token de Claude" })]);
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
  const exp = (mine && mine.expires) || (theirs && theirs.expires);
  if (exp) box.appendChild(h("p", { class: "token-exp" }, [h("strong", { text: `Caduca el ${fmtDate(exp)}` }), h("span", { class: "meta", text: " · sesiones y VS Code, en los dos ordenadores" })]));
  box.appendChild(h("p", { class: "meta", text: "Renuévalo si caduca, si te quitan el acceso o si todas las sesiones caen con «Failed to authenticate». Si tu navegador sigue dentro de claude.ai con la cuenta de empresa, lo autorizas tú solo." }));
  box.appendChild(h("div", { class: "actions" }, [startButton("Renovar token de Claude")]));
  return box;
}

export function renderMachines(root) {
  if (!data) {
    load();
    return root.appendChild(empty("Mirando los equipos…", ""));
  }
  if (data.error) return root.appendChild(h("div", { class: "setup-note warn", text: data.error }));
  if (!data.devices) return root.appendChild(empty("No se pudo leer Tailscale en este ordenador.", ""));
  root.appendChild(h("div", { class: "dev-grid" }, data.devices.map(card)));
  root.appendChild(
    h("details", { class: "dev-help" }, [
      h("summary", { text: "¿Cuándo cambia el mando?" }),
      h("p", { text: "Solo cuando tú lo pasas con el botón, o si el que manda deja de responder (apagado o suspendido): entonces el otro lo toma al minuto y lo conserva cuando el primero vuelve. Al encender por la mañana, un ordenador solo coge el mando si no manda ninguno." }),
    ])
  );
  root.appendChild(h("div", { class: "settings-grid" }, [workSchedule(), macSchedule(), tokenRenew()]));
  if (!jobLoaded) pollJob();
}

function workSchedule() {
  const s = state.workSchedule || { start: "07:30", end: "18:30" };
  const start = h("input", { type: "time", value: s.start, class: "time-input" });
  const end = h("input", { type: "time", value: s.end, class: "time-input" });
  const save = button("Guardar", {
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/work-hours", { start: start.value, end: end.value })
        .then(() => toast(`Jornada de ${start.value} a ${end.value}, de lunes a viernes.`))
        .finally(() => (b.disabled = false));
    },
  });
  const kids = [
    h("h3", { text: "Horario de trabajo" }),
    h("p", { class: "meta", text: "De lunes a viernes. Al empezar arrancan las sesiones fijas y el reporte; durante la jornada se mira Jira cada minuto y salen los seguimientos; al acabar se paran los proyectos y se redacta la daily hora y media antes. Fuera de este horario solo funciona con «Activarlo todo»." }),
    h("div", { class: "schedule-row" }, [h("label", {}, [h("span", { text: "Empieza" }), start]), h("label", {}, [h("span", { text: "Acaba" }), end])]),
    h("div", { class: "actions" }, [save]),
  ];
  const mp = (state.cluster && state.cluster.macPower) || null;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  if (mp && mp.schedule && (toMin(mp.schedule.wake) > toMin(s.start) || toMin(mp.schedule.sleep) < toMin(s.end))) kids.push(h("div", { class: "setup-note warn" }, [h("p", { text: `El Mac está despierto de ${mp.schedule.wake} a ${mp.schedule.sleep}: no cubre toda la jornada.` })]));
  return h("section", { class: "card setting-card work-schedule" }, kids);
}

function macSchedule() {
  const mp = (state.cluster && state.cluster.macPower) || null;
  const s = (mp && mp.schedule) || { wake: "06:00", sleep: "21:00" };
  const wake = h("input", { type: "time", value: s.wake, class: "time-input" });
  const sleep = h("input", { type: "time", value: s.sleep, class: "time-input" });
  const save = button("Guardar", {
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/mac-power", { wake: wake.value, sleep: sleep.value })
        .then(() => toast(`El Mac se despertará a las ${wake.value} y se dormirá a las ${sleep.value}, de lunes a viernes.`))
        .finally(() => (b.disabled = false));
    },
  });
  const kids = [
    h("h3", { text: "Horario del Mac" }),
    h("p", { class: "meta", text: "De lunes a viernes. Entre las dos horas no se duerme, ni con la tapa cerrada ni sin cargador; si baja del 10 % sin cargar, se deja dormir." }),
    h("div", { class: "schedule-row" }, [h("label", {}, [h("span", { text: "Se despierta" }), wake]), h("label", {}, [h("span", { text: "Se duerme" }), sleep])]),
    h("div", { class: "actions" }, [save]),
  ];
  if (mp && mp.allowed === false)
    kids.push(
      h("div", { class: "setup-note warn" }, [
        h("p", { text: "Falta un permiso para que el Mac pueda programar su despertar y quedarse despierto con la tapa cerrada. Ejecuta esto una vez en la terminal del Mac (te pedirá tu contraseña):" }),
        h("code", { class: "cmd", text: "echo \"$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset\" | sudo tee /etc/sudoers.d/nutria-pmset" }),
        h("p", { class: "meta", text: "Solo permite al tablero usar pmset, el ajuste de energía del Mac; nada más." }),
      ])
    );
  return h("section", { class: "card setting-card mac-schedule" }, kids);
}
