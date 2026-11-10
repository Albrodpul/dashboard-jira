import { h, toast, state, requestOrFail } from "../lib/base.js";

const KEYS = [
  ["Esc", "\x1b", "Interrumpe lo que esté haciendo (como Escape en VS Code)"],
  ["Ctrl+C", "\x03", "Cancela"],
  ["⇧Tab", "\x1b[Z", "Cambia de modo (plan, aceptar ediciones…)"],
  ["↑", "\x1b[A", "Arriba"],
  ["↓", "\x1b[B", "Abajo"],
  ["Tab", "\t", "Tab"],
  ["Enter", "\r", "Enter"],
];
const TERM_THEME = { background: "#0e1519", foreground: "#dfe7ea", cursor: "#5fc4d6", cursorAccent: "#0e1519", selectionBackground: "#1f4b57", black: "#0e1519", red: "#e5737a", green: "#7cc79a", yellow: "#e2c07a", blue: "#6aaee0", magenta: "#c49be0", cyan: "#5fc4d6", white: "#c9d4d8", brightBlack: "#6b7f87", brightRed: "#f0959a", brightGreen: "#9bd8b2", brightYellow: "#eed49c", brightBlue: "#8cc2ea", brightMagenta: "#d5b5ea", brightCyan: "#86d4e2", brightWhite: "#f2f6f7" };
const PENDING_MAX = 4 * 1024 * 1024;
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

const MODEL_NAMES = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const EFFORT_NAMES = { low: "bajo", medium: "medio", high: "alto", xhigh: "muy alto", max: "máximo" };

function profileControls(conversation, name) {
  const p = (state.convProfiles || {})[conversation];
  if (!p) return null;
  const current = { model: p.custom && p.model !== p.defaults.model ? p.model : "", effort: p.custom && p.effort !== p.defaults.effort ? p.effort : "" };
  let repaint = () => {};
  const pick = (kind, names, label) => {
    const def = p.defaults[kind];
    const sel = h("select", { class: "term-profile", "aria-label": `${label} de ${name}`, title: `${label}. El primero es el de serie de este tipo de sesión; en color, uno cambiado a mano.` }, [
      h("option", { value: "", text: `${label}: ${names[def] || def || "—"}` }),
      ...Object.entries(names).filter(([k]) => k !== def).map(([k, v]) => h("option", { value: k, text: `${label}: ${v}` })),
    ]);
    const mark = () => sel.classList.toggle("custom", !!sel.value);
    sel.value = current[kind];
    mark();
    sel.addEventListener("change", () => {
      const next = { ...current, [kind]: sel.value };
      if (!window.confirm(`Para aplicarlo se reinicia «${name}». La conversación sigue igual, pero si está trabajando ahora mismo se corta. ¿Seguimos?`)) {
        sel.value = current[kind];
        return;
      }
      sel.disabled = true;
      requestOrFail("/api/session-profile", { conversation, name, ...next })
        .then((d) => {
          Object.assign(current, next);
          mark();
          repaint();
          toast(`«${name}» ahora con ${MODEL_NAMES[d.profile.model] || d.profile.model} y esfuerzo ${EFFORT_NAMES[d.profile.effort] || d.profile.effort}${d.restarted ? ". Reiniciada." : "; se aplica al abrirla."}`);
        })
        .catch((e) => {
          sel.value = current[kind];
          toast(`No se pudo cambiar: ${e.message}`);
        })
        .finally(() => (sel.disabled = false));
    });
    return sel;
  };
  const model = pick("model", MODEL_NAMES, "Modelo");
  const effort = pick("effort", EFFORT_NAMES, "Esfuerzo");
  const chip = h("button", { type: "button", class: "term-profile-chip", "aria-expanded": "false", title: "Modelo y esfuerzo de esta sesión" });
  const paint = () => {
    chip.textContent = `${MODEL_NAMES[current.model || p.defaults.model] || "—"} · ${EFFORT_NAMES[current.effort || p.defaults.effort] || "—"}`;
    chip.classList.toggle("custom", !!(current.model || current.effort));
  };
  paint();
  repaint = paint;
  const box = h("span", { class: "term-profiles" }, [model, effort]);
  chip.addEventListener("click", () => {
    const open = box.classList.toggle("open");
    chip.setAttribute("aria-expanded", String(open));
  });
  return h("span", { class: "term-profile-wrap" }, [chip, box]);
}

const ACTIVITY = { busy: ["busy", "Trabajando"], idle: ["on", "Esperando"] };

function activityOf(conversation) {
  const live = ((state.sessions && state.sessions.list) || []).find((x) => x.conversation === conversation);
  if (!live) return ["", "Dormida"];
  if (live.status === "idle" && live.background) return ["on", "Esperando · con proceso de fondo"];
  return ACTIVITY[live.status] || ["bad", live.status ? `Estado «${live.status}»` : "Abierta"];
}

function autoGrow(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
}

function createPanel(conversation, name, onClose) {
  const screen = h("div", { class: "term-screen" });
  const status = h("span", { class: "meta term-status", text: "Conectando…" });
  const dot = h("span", { class: "dot", "aria-hidden": "true" });
  const activity = h("span", { class: "term-activity" });
  const adjust = h("button", { class: "btn subtle term-adjust", type: "button", hidden: true, text: "Ajustar a esta pantalla", title: "Otro dispositivo tiene la sesión a su tamaño. Pulsa para ponerla al de esta pantalla." });
  const head = [h("span", { class: "term-title" }, [dot, h("strong", { text: name }), h("span", { class: "term-sub" }, [activity, status])]), adjust, profileControls(conversation, name)];
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
  const root = h("div", { class: "term-panel" }, [h("div", { class: "term-head" }, head), h("div", { class: "term-wrap" }, [screen, scrollBtns]), keys, h("div", { class: "term-compose" }, [attachButton(input, conversation), input, sendBtn, mentions(input)])]);
  const panel = { root, conversation, ws: null, term: null, fit: null, closed: false, pending: [], pendingBytes: 0, overflowed: false, replaying: false };
  panel.paintActivity = () => {
    const [cls, text] = activityOf(conversation);
    dot.className = `dot ${cls}`;
    activity.textContent = text;
  };
  panel.paintActivity();
  input.addEventListener("input", () => autoGrow(input));
  panel.visible = () => !document.hidden && root.isConnected;
  panel.catchUp = () => {
    if (!panel.term || !panel.visible()) return;
    if (panel.overflowed) {
      panel.overflowed = false;
      panel.replaying = true;
      if (panel.ws) panel.ws.close();
      return;
    }
    if (!panel.pending.length) return;
    const chunks = panel.pending;
    panel.pending = [];
    panel.pendingBytes = 0;
    for (const c of chunks) panel.term.write(c);
  };
  root.addEventListener("pointerdown", () => setTimeout(() => panel.claim("clic"), 50));

  adjust.addEventListener("click", () => panel.claim("ajustar"));
  panel.checkFit = () => {
    let dims = null;
    try {
      dims = panel.term && panel.fit.proposeDimensions();
    } catch (e) {}
    adjust.hidden = !dims || (Math.abs(dims.cols - 1 - panel.term.cols) < 3 && Math.abs(dims.rows - panel.term.rows) < 3);
  };
  panel.claim = (why = "?") => {
    if (!panel.term || !root.isConnected || !panel.ws || panel.ws.readyState !== 1) return;
    if (document.hidden && why !== "escribir") return;
    let dims = null;
    try {
      dims = panel.fit.proposeDimensions();
    } catch (e) {}
    if (dims && dims.cols && dims.rows && (dims.cols - 1 !== panel.term.cols || dims.rows !== panel.term.rows)) {
      const size = { cols: Math.max(20, dims.cols - 1), rows: dims.rows };
      panel.ws.send(JSON.stringify({ type: "resize", ...size }));
      fetch("/api/term-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation, why, ...size, from: `${panel.term.cols}x${panel.term.rows}`, device: `${location.host} ${window.innerWidth}x${window.innerHeight} ${navigator.platform}` }) }).catch(() => {});
    }
  };
  panel.send = (data) => {
    if (!panel.ws || panel.ws.readyState !== 1) return;
    panel.claim("escribir");
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
    autoGrow(input);
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
      const term = new window.Terminal({ fontSize: window.matchMedia("(max-width: 760px)").matches ? 11 : 13, fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Consolas, monospace', theme: TERM_THEME, scrollback: 5000, macOptionClickForcesSelection: true });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(screen);
      Object.assign(panel, { term, fit });
      term.onData((d) => panel.send(d));
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "c" || !term.hasSelection()) return true;
        copyText(term.getSelection());
        term.clearSelection();
        e.preventDefault();
        return false;
      });
      const MOUSE = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
      let appMouse = false;
      const keepMouseLocal = (final) => (params) => {
        const ps = (Array.isArray(params) ? params : params.toArray()).map((p) => (Array.isArray(p) ? p[0] : p));
        if (!ps.some((p) => MOUSE.has(p))) return false;
        if (ps.some((p) => p >= 1000 && p <= 1003)) appMouse = final === "h";
        const rest = ps.filter((p) => !MOUSE.has(p));
        if (rest.length) term.write(`\x1b[?${rest.join(";")}${final}`);
        return true;
      };
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, keepMouseLocal("h"));
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, keepMouseLocal("l"));
      let wheel = 0;
      term.attachCustomWheelEventHandler((e) => {
        if (!appMouse || term.buffer.active.type !== "alternate") return true;
        e.preventDefault();
        wheel += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
        while (Math.abs(wheel) >= 40) {
          panel.send(wheel < 0 ? "\x1b[<64;1;1M" : "\x1b[<65;1;1M");
          wheel += wheel < 0 ? 40 : -40;
        }
        return false;
      });
      term.parser.registerOscHandler(52, (data) => {
        const b64 = data.slice(data.indexOf(";") + 1);
        if (!b64 || b64 === "?" || Date.now() - (panel.openedAt || 0) < 2500) return true;
        try {
          copyText(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
        } catch (x) {}
        return true;
      });
      const connect = () => {
        if (panel.closed) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/api/term/${conversation}`);
        panel.ws = ws;
        ws.onopen = () => {
          panel.openedAt = Date.now();
          status.textContent = "En directo";
          term.reset();
          if (!document.hidden && !panel.replaying) setTimeout(() => panel.claim("conectar"), 400);
          panel.replaying = false;
        };
        ws.onmessage = (e) => {
          if (typeof e.data === "string" && e.data.charCodeAt(0) === 0) {
            try {
              const { cols, rows } = JSON.parse(e.data.slice(1));
              if (cols && rows) term.resize(cols, rows);
              setTimeout(panel.checkFit, 50);
            } catch (x) {}
            return;
          }
          const data = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
          if (panel.visible()) return term.write(data);
          if (panel.overflowed) return;
          panel.pending.push(data);
          panel.pendingBytes += data.length;
          if (panel.pendingBytes > PENDING_MAX) {
            panel.pending = [];
            panel.pendingBytes = 0;
            panel.overflowed = true;
          }
        };
        ws.onclose = () => {
          if (panel.closed) return;
          status.textContent = "Reconectando…";
          setTimeout(connect, panel.replaying ? 0 : 3000);
        };
      };
      connect();
      setTimeout(panel.resize, 100);
    },
    () => toast("No se pudo cargar el visor de terminal.")
  );
  return panel;
}

function insertAtCaret(input, text) {
  const at = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, at);
  const pad = before && !/s$/.test(before) ? " " : "";
  input.value = before + pad + text + input.value.slice(input.selectionEnd ?? at);
  input.selectionStart = input.selectionEnd = at + pad.length + text.length;
  input.focus();
}

function uploadFiles(input, files, conversation) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;
  toast(list.length === 1 ? "Subiendo el fichero…" : `Subiendo ${list.length} ficheros…`);
  list
    .reduce(
      (chain, file, i) =>
        chain.then(() =>
          fetch("/api/upload", { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name || `captura-${i + 1}.png`), "x-conversation": conversation || "" }, body: file })
            .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 413 ? "pasa de 25 MB" : (await r.json().catch(() => ({}))).error || `error ${r.status}`))))
            .then((d) => insertAtCaret(input, `@${d.path} `))
        ),
      Promise.resolve()
    )
    .catch((e) => toast(`No se pudo subir: ${e.message}`));
}

function attachButton(input, conversation) {
  const picker = h("input", { type: "file", multiple: true, hidden: true });
  picker.addEventListener("change", () => {
    uploadFiles(input, picker.files, conversation);
    picker.value = "";
  });
  input.addEventListener("paste", (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    uploadFiles(input, files, conversation);
  });
  input.addEventListener("dragover", (e) => e.preventDefault());
  input.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    uploadFiles(input, e.dataTransfer.files, conversation);
  });
  const b = h("button", { class: "btn term-attach", type: "button", title: "Adjuntar ficheros o imágenes (también puedes pegarlos o arrastrarlos al cuadro)", "aria-label": "Adjuntar", text: "📎", onclick: () => picker.click() });
  return h("span", { class: "term-attach-wrap" }, [b, picker]);
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
  for (const p of panels.values()) if (p.root.isConnected) setTimeout(() => p.claim("ventana"), 150);
  if (overlay) setTimeout(() => overlay.claim("ventana"), 150);
}
let lastWidth = window.innerWidth;
document.addEventListener("visibilitychange", () => {
  for (const p of panels.values()) p.catchUp();
  if (overlay) overlay.catchUp();
});
window.addEventListener("layoutchange", () => {
  requestAnimationFrame(() => {
    for (const p of panels.values()) {
      fitInline(p);
      if (p.checkFit) p.checkFit();
    }
    claimVisible();
  });
});
window.addEventListener("resize", () => {
  for (const p of panels.values()) fitInline(p);
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  claimVisible();
});

export function livePanel(conversation, name) {
  let p = panels.get(conversation);
  if (!p || p.closed) {
    p = createPanel(conversation, name);
    p.root.classList.add("term-inline");
    panels.set(conversation, p);
  }
  const entering = p.seenAt !== state.renderSeq - 1;
  p.seenAt = state.renderSeq;
  p.paintActivity();
  requestAnimationFrame(() => {
    fitInline(p);
    p.catchUp();
    if (p.checkFit) p.checkFit();
    if (entering) setTimeout(() => p.claim("entrar"), 150);
  });
  return p.root;
}

function copyText(text) {
  if (!text) return;
  const fallback = () => {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand("copy");
    } catch (x) {}
    t.remove();
  };
  (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Copiado."), () => (fallback(), toast("Copiado.")));
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
