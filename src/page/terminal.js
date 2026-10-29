import { h, toast, state } from "./base.js";

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
  const root = h("div", { class: "term-panel" }, [h("div", { class: "term-head" }, head), h("div", { class: "term-wrap" }, [screen, scrollBtns]), keys, h("div", { class: "term-compose" }, [input, sendBtn, mentions(input)])]);
  const panel = { root, conversation, ws: null, term: null, fit: null, closed: false };
  root.addEventListener("pointerdown", () => setTimeout(() => panel.claim(), 50));
  let movedAt = 0;
  root.addEventListener("pointermove", () => {
    if (Date.now() - movedAt < 1500) return;
    movedAt = Date.now();
    panel.claim();
  });
  root.addEventListener("focusin", () => setTimeout(() => panel.claim(), 50));

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
    if (e.defaultPrevented) return;
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
          if (!document.hidden) setTimeout(panel.claim, 400);
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

const MENTION = /(^|\s)@([^\s@]{1,80})$/;

function mentions(input) {
  const list = h("ul", { class: "term-mentions", role: "listbox", hidden: true });
  let items = [];
  let picked = 0;
  let timer = null;
  let asked = "";
  const close = () => {
    list.hidden = true;
    items = [];
  };
  const paint = () => {
    list.textContent = "";
    items.forEach((f, i) => {
      const slash = f.lastIndexOf("/");
      const li = h("li", { role: "option", "aria-selected": String(i === picked) }, [h("strong", { text: f.slice(slash + 1) }), h("span", { text: slash > 0 ? f.slice(0, slash) : "" })]);
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        choose(i);
      });
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  const choose = (i) => {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const m = MENTION.exec(before);
    if (!m) return close();
    const start = caret - m[2].length - 1;
    const text = `@${items[i]} `;
    input.value = input.value.slice(0, start) + text + input.value.slice(caret);
    input.selectionStart = input.selectionEnd = start + text.length;
    close();
    input.focus();
  };
  input.addEventListener("input", () => {
    const m = MENTION.exec(input.value.slice(0, input.selectionStart));
    clearTimeout(timer);
    if (!m) return close();
    const q = m[2];
    timer = setTimeout(() => {
      asked = q;
      fetch(`/api/files?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((found) => {
          if (asked !== q) return;
          items = Array.isArray(found) ? found : [];
          picked = 0;
          paint();
        })
        .catch(close);
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      picked = (picked + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(picked);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  return list;
}

function fitInline(p) {
  if (!p.root.isConnected) return;
  let scroller = p.root.parentElement;
  while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const inBody = !scroller || scroller === document.body;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const visible = inBody ? vh : Math.min(vh, scroller.clientHeight);
  const bar = document.getElementById("bottom");
  const barHeight = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().height : 0;
  const top = inBody ? p.root.getBoundingClientRect().top + window.scrollY : p.root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const left = Math.floor(visible - top - barHeight - 12);
  const height = Math.max(260, left >= 360 ? left : visible - barHeight - 24);
  if (p.root.style.height !== `${height}px`) p.root.style.height = `${height}px`;
}

function claimVisible() {
  if (document.hidden) return;
  for (const p of panels.values()) if (p.root.isConnected) setTimeout(p.claim, 150);
  if (overlay) setTimeout(overlay.claim, 150);
}
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  for (const p of panels.values()) fitInline(p);
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  claimVisible();
});
window.addEventListener("focus", claimVisible);
document.addEventListener("visibilitychange", claimVisible);

export function livePanel(conversation, name) {
  let p = panels.get(conversation);
  if (!p || p.closed) {
    p = createPanel(conversation, name);
    p.root.classList.add("term-inline");
    panels.set(conversation, p);
  }
  const entering = p.seenAt !== state.renderSeq - 1;
  p.seenAt = state.renderSeq;
  requestAnimationFrame(() => {
    fitInline(p);
    if (entering) setTimeout(p.claim, 150);
  });
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
