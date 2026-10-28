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
let loading = null;
let current = null;

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

export function closeTerminal() {
  if (!current) return;
  current.closed = true;
  try {
    current.ws.close();
  } catch (e) {}
  try {
    current.term.dispose();
  } catch (e) {}
  window.removeEventListener("resize", current.onResize);
  current.root.remove();
  document.body.classList.remove("term-open");
  current = null;
}

export async function openTerminal(conversation, name) {
  closeTerminal();
  try {
    await loadXterm();
  } catch (e) {
    return toast("No se pudo cargar el visor de terminal.");
  }
  const screen = h("div", { class: "term-screen" });
  const status = h("span", { class: "meta term-status", text: "Conectando…" });
  const close = h("button", { class: "btn subtle", type: "button", text: "Cerrar", onclick: closeTerminal });
  const keys = h(
    "div",
    { class: "term-keys", role: "group", "aria-label": "Teclas" },
    KEYS.map(([label, seq, title]) => h("button", { type: "button", class: "term-key", title, text: label, onclick: () => send(seq) }))
  );
  const input = h("textarea", { class: "term-input", rows: "1", placeholder: "Escribe aquí y pulsa Enviar", "aria-label": `Escribir a ${name}` });
  const sendBtn = h("button", { class: "btn primary", type: "button", text: "Enviar" });
  const root = h("div", { class: "term-overlay", role: "dialog", "aria-label": `Sesión ${name} en directo` }, [
    h("div", { class: "term-head" }, [h("strong", { text: name }), status, close]),
    screen,
    keys,
    h("div", { class: "term-compose" }, [input, sendBtn]),
  ]);
  document.body.appendChild(root);
  document.body.classList.add("term-open");

  const term = new window.Terminal({ convertEol: false, fontSize: window.matchMedia("(max-width: 760px)").matches ? 11 : 13, fontFamily: "ui-monospace, Consolas, monospace", theme: { background: "#ffffff", foreground: "#1f2328", cursor: "#1f2328", cursorAccent: "#ffffff", selectionBackground: "#bfdbe4" }, scrollback: 5000 });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/term/${conversation}`);
  const state = { ws, term, root, closed: false };
  current = state;

  function send(data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data }));
  }
  function resize() {
    try {
      fit.fit();
    } catch (e) {}
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
  state.onResize = () => setTimeout(resize, 50);
  window.addEventListener("resize", state.onResize);

  ws.onopen = () => {
    status.textContent = "En directo";
    resize();
  };
  ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  ws.onclose = () => {
    if (!state.closed) status.textContent = "Desconectado: ciérralo y vuelve a abrirlo";
  };
  term.onData((d) => send(d));
  const submit = () => {
    const text = input.value;
    if (!text.trim()) return send("\r");
    send(text);
    setTimeout(() => send("\r"), 150);
    input.value = "";
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  setTimeout(resize, 100);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && current && document.activeElement && document.activeElement.classList.contains("term-input")) closeTerminal();
});
