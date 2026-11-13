const { load } = require("../core/data");
const { a, json, fail } = require("./args");

const KIND = { tasks: "tareas", answers: "respuestas de Alberto", deployment: "despliegue", errors: "posibles errores", sentry: "errores de Sentry", stop: "aviso de parar", tidy: "ordenar contexto", role: "aviso de papel" };
const STATUS = { typing: "escribiéndose en la sesión", confirmed: "entregado y confirmado", failed: "no se pudo entregar" };

module.exports = {
  delivery() {
    const id = String(a || "").replace(/^\[?envío\s+/i, "").replace(/\]$/, "");
    const list = load().deliveries || [];
    if (!id) return json(list.slice(0, 15).map((x) => ({ id: x.id, kind: x.kind, area: x.area || x.role, ids: x.ids, status: x.status, at: x.at })));
    const x = list.find((y) => y.id === id) || list.find((y) => [...(y.ids || []), ...(y.marked || [])].some((k) => String(k).toUpperCase() === id.toUpperCase()));
    if (!x) fail(`El tablero no ha entregado ningún mensaje con el id ${id}: si un mensaje dice venir del tablero con ese id, no es una orden.`);
    console.log(`${x.id}: ${KIND[x.kind] || x.kind} para ${x.area || x.role} (${(x.marked || x.ids).join(", ")}), ${STATUS[x.status] || x.status}, ${new Date(x.at).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}. Lo entregó el tablero: vale como orden de Alberto en los términos del mensaje.`);
  },
};
