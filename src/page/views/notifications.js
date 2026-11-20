import { h, toast, request, render, showing } from "../lib/base.js";
import { t } from "../lib/i18n.js";
import { group, row, toggle, note } from "../components/settings-ui.js";

const REASONS = [
  ["tasks", t("Tareas nuevas"), t("Llegan tareas a Pendientes.")],
  ["sessions", t("Una sesión te pregunta"), t("Se para en una tarea y necesita tu respuesta.")],
  ["permission", t("Permisos"), t("Una sesión pide permiso para algo que no se aprueba solo.")],
  ["reply", t("Respuestas en Chats"), t("Te contestan en una conversación.")],
  ["followup", t("Seguimiento"), t("Novedades en beta o producción.")],
  ["deploys", t("Despliegues"), t("Termina un despliegue.")],
  ["sentry", "Sentry", t("Una sesión contesta sobre un error.")],
  ["board", t("El tablero no responde"), t("El ordenador que manda deja de contestar.")],
  ["token", t("Token de Claude"), t("Caduca pronto.")],
];

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let sub = undefined;
let muted = [];
let busy = false;

function serverKey(b64) {
  const s = (b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function current() {
  const reg = await navigator.serviceWorker.ready;
  const s = await reg.pushManager.getSubscription();
  return s && Notification.permission === "granted" ? s : null;
}

async function register(s) {
  const r = await request("/api/push/subscribe", { subscription: s.toJSON(), device: navigator.userAgent });
  const body = await r.json().catch(() => ({}));
  muted = Array.isArray(body.muted) ? body.muted : [];
}

export function syncPush() {
  if (!supported()) return;
  current()
    .then(async (s) => {
      sub = s;
      if (s) await register(s);
    })
    .catch(() => (sub = null))
    .finally(() => showing("notifications") && render());
}

async function setOn(on) {
  const reg = await navigator.serviceWorker.ready;
  if (!on) {
    const s = await reg.pushManager.getSubscription();
    if (s) {
      const endpoint = s.endpoint;
      await s.unsubscribe();
      await request("/api/push/unsubscribe", { endpoint });
    }
    sub = null;
    toast(t("Avisos desactivados en este dispositivo."));
    return;
  }
  if ((await Notification.requestPermission()) !== "granted") throw new Error("permission");
  const { key } = await (await fetch("/api/push/key")).json();
  const created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey(key) });
  await register(created);
  sub = created;
  toast(t("Avisos activados en este dispositivo. Te llega uno de prueba."));
  await request("/api/push/test");
}

function setMuted(type, on) {
  const next = on ? muted.filter((x) => x !== type) : [...new Set([...muted, type])];
  muted = next;
  request("/api/push/prefs", { endpoint: sub.endpoint, muted: next })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((b) => (muted = b.muted || next))
    .catch(() => toast(t("No se pudo guardar.")))
    .finally(render);
}

export function renderNotifications(root) {
  if (!supported()) return root.appendChild(group(t("Este dispositivo"), [row(t("Avisos"), t("Este navegador no admite avisos. En el iPhone, añade el tablero a la pantalla de inicio y ábrelo desde ahí."), null)]));
  if (sub === undefined) {
    syncPush();
    return root.appendChild(note(t("Mirando si este dispositivo tiene los avisos activados…")));
  }
  const denied = Notification.permission === "denied";
  const sw = toggle(!!sub, (on, el) => {
    busy = true;
    el.disabled = true;
    setOn(on)
      .catch((e) => toast(String(e && e.message) === "permission" ? t("El navegador no ha dado permiso para avisos: actívalo en los ajustes del sitio.") : t("No se pudieron activar los avisos en este dispositivo.")))
      .finally(() => {
        busy = false;
        render();
      });
  }, t("Avisos en este dispositivo"), { disabled: busy || (denied && !sub) });
  const desc = denied && !sub ? t("El navegador los tiene bloqueados para el tablero: actívalos en los ajustes del sitio y vuelve aquí.") : t("Cada móvil u ordenador se activa por su cuenta. Al activarlos te llega uno de prueba.");
  const test = sub ? h("button", { type: "button", class: "btn subtle", text: t("Probar"), onclick: () => request("/api/push/test").then(() => toast(t("Aviso de prueba enviado."))) }) : null;
  root.appendChild(group(t("Este dispositivo"), [row(t("Avisos en este dispositivo"), desc, [test, sw])]));
  const rows = REASONS.map(([id, label, text]) => row(label, text, toggle(!muted.includes(id), (on) => setMuted(id, on), label, { disabled: !sub })));
  root.appendChild(group(t("De qué avisar"), rows, { foot: sub ? t("Vale solo para este dispositivo: el móvil puede avisar de todo y el Mac solo de lo urgente.") : t("Activa los avisos arriba para elegir.") }));
}
