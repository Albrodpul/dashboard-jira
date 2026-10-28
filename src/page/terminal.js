import { h, toast } from "./base.js";

const KEYS = [
  ["Esc", "\x1b", "Interrumpe lo que esté haciendo (como Escape en VS Code)"],
  ["Ctrl+C", "\x03", "Cancela"],
  ["⇧Tab", "\x1b[Z", "Cambia de modo (plan, aceptar ediciones…)"],
  ["↑", "\x1b[A", "Arriba"],
  ["↓", "\x1b[B", "Abajo"],
  ["Tab", "\t", "Tab"],
  ["Enter", "\r", "Enter"],
];
const TERM_THEME = { background: "#0d1117", foreground: "#e6edf3", cursor: "#e6edf3", cursorAccent: "#0d1117", selectionBackground: "#264f78", black: "#0d1117", brightBlack: "#6e7681" };
let loading = null;
let overlay = null;
const panels = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (!loading) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/xterm.css";
    document.head.appendChild(css);
    loading = loadScript("/vendor/xterm.js").then(() => loadScript("/vendor/addon-fit.js"));
  }
  return loading;
}

function createPanel(conversation, name, onClose) {
  const screen = h("div", { class: "term-screen" });
  const status = h("span", { class: "meta term-status", text: "Conectando…" });
  const head = [h("strong", { text: name }), status];
  if (onClose) head.push(h("button", { class: "btn subtle", type: "button", text: "Cerrar", onclick: onClose }));
  const input = h("textarea", { class: "term-input", rows: "1", placeholder: "Escribe aquí y pulsa Enviar", "aria-label": `Escribir a ${name}` });
  const sendBtn = h("button", { class: "btn primary", type: "button", text: "Enviar" });
  const keys = h(
    "div",
    { class: "term-keys", role: "group", "aria-label": "Teclas" },
    KEYS.map(([label, seq, title]) => h("button", { type: "button", class: "term-key", title, text: label, onclick: () => panel.send(seq) }))
  );
  const scrollBtns = h("div", { class: "term-scroll" }, [
    h("button", { type: "button", title: "Subir (Re Pág)", "aria-label": "Subir", text: "⇞", onclick: () => panel.send("[5~") }),
    h("button", { type: "button", title: "Bajar (Av Pág)", "aria-label": "Bajar", text: "⇟", onclick: () => panel.send("[6~") }),
    h("button", { type: "button", title: "Ir al final (Ctrl+Fin)", "aria-label": "Ir al final", text: "⤓", onclick: () => panel.send("[1;5F") }),
  ]);
  const root = h("div", { class: "term-panel" }, [h("div", { class: "term-head" }, head), h("div", { class: "term-wrap" }, [screen, scrollBtns]), keys, h("div", { class: "term-compose" }, [input, sendBtn])]);
  const panel = { root, conversation, ws: null, term: null, fit: null, closed: false };

  panel.claim = () => {
    if (!panel.term || !root.isConnected || !panel.ws || panel.ws.readyState !== 1) return;
    let dims = null;
    try {
      dims = panel.fit.proposeDimensions();
    } catch (e) {}
    if (dims && dims.cols && dims.rows && (dims.cols - 1 !== panel.term.cols || dims.rows !== panel.term.rows)) panel.ws.send(JSON.stringify({ type: "resize", cols: Math.max(20, dims.cols - 1), rows: dims.rows }));
  };
  panel.send = (data) => {
    if (!panel.ws || panel.ws.readyState !== 1) return;
    panel.claim();
    panel.ws.send(JSON.stringify({ type: "input", data }));
  };
  panel.resize = () => {};
  panel.dispose = () => {
    panel.closed = true;
    try {
      panel.ws && panel.ws.close();
    } catch (e) {}
    try {
      panel.term && panel.term.dispose();
    } catch (e) {}
    root.remove();
  };
  const submit = () => {
    const text = input.value;
    if (!text.trim()) return panel.send("\r");
    panel.send(text);
    setTimeout(() => panel.send("\r"), 150);
    input.value = "";
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  loadXterm().then(
    () => {
      if (panel.closed) return;
      const term = new window.Terminal({ fontSize: window.matchMedia("(max-width: 760px)").matches ? 11 : 13, fontFamily: "ui-monospace, Consolas, monospace", theme: TERM_THEME, scrollback: 5000 });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(screen);
      Object.assign(panel, { term, fit });
      term.onData((d) => panel.send(d));
      const connect = () => {
        if (panel.closed) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/api/term/${conversation}`);
        panel.ws = ws;
        ws.onopen = () => {
          status.textContent = "En directo";
          term.reset();
        };
        ws.onmessage = (e) => {
          if (typeof e.data === "string" && e.data.charCodeAt(0) === 0) {
            try {
              const { cols, rows } = JSON.parse(e.data.slice(1));
              if (cols && rows) term.resize(cols, rows);
            } catch (x) {}
            return;
          }
          term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
        };
        ws.onclose = () => {
          if (panel.closed) return;
          status.textContent = "Reconectando…";
          setTimeout(connect, 3000);
        };
      };
      connect();
      setTimeout(panel.resize, 100);
    },
    () => toast("No se pudo cargar el visor de terminal.")
  );
  return panel;
}

window.addEventListener("resize", () => {
  for (const p of panels.values()) setTimeout(p.resize, 50);
  if (overlay) setTimeout(overlay.resize, 50);
});

export function livePanel(conversation, name) {
  let p = panels.get(conversation);
  if (!p || p.closed) {
    p = createPanel(conversation, name);
    p.root.classList.add("term-inline");
    panels.set(conversation, p);
  }
  setTimeout(p.resize, 50);
  return p.root;
}

export function closeTerminal() {
  if (!overlay) return;
  overlay.dispose();
  overlay = null;
  document.body.classList.remove("term-open");
}

export function openTerminal(conversation, name) {
  closeTerminal();
  overlay = createPanel(conversation, name, closeTerminal);
  overlay.root.classList.add("term-overlay");
  document.body.appendChild(overlay.root);
  document.body.classList.add("term-open");
}
