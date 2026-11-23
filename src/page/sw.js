self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
self.addEventListener("push", (e) => {
  let sent = null;
  try {
    sent = e.data ? e.data.json() : null;
  } catch (x) {}
  e.waitUntil(
    (sent ? Promise.resolve(sent) : fetch("/api/push/reason", { cache: "no-store" }).then((r) => r.json()))
      .catch(() => ({}))
      .then((d) => show(d))
  );
});
const section = (title) => String(title || "").split(" · ").slice(1).join(" · ");
async function show(d) {
  const item = { section: section(d.title), text: d.text || "Hay novedades", tab: d.tab || "" };
  if (!/Android|iPhone|iPad|Mobile/i.test(self.navigator.userAgent)) return self.registration.showNotification(d.title || "NutrIA", { tag: "torre-" + (d.title || "") + "|" + item.text, renotify: false, icon: "/icon-192.png", body: item.text, data: { tab: item.tab, items: [item] } });
  const open = await self.registration.getNotifications({ tag: "torre" });
  const before = open.flatMap((n) => (n.data && n.data.items) || []);
  open.forEach((n) => n.close());
  const items = [item, ...before].slice(0, 20);
  const options = { tag: "torre", renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", data: { tab: item.tab, items } };
  if (items.length === 1) return self.registration.showNotification(d.title || "NutrIA", { ...options, body: item.text });
  const tabs = new Set(items.map((x) => x.tab));
  options.data.tab = tabs.size === 1 ? item.tab : "home";
  const lines = items.slice(0, 6).map((x) => (x.section ? x.section + ": " : "") + x.text);
  if (items.length > 6) lines.push("y " + (items.length - 6) + " más");
  return self.registration.showNotification("NutrIA · " + items.length + " novedades", { ...options, body: lines.join(String.fromCharCode(10)) });
}
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || "";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
      const w = ws.find((x) => "focus" in x);
      if (!w) return self.clients.openWindow(tab ? "/?tab=" + tab : "/");
      if (tab) w.postMessage({ tab });
      return w.focus();
    })
  );
});
