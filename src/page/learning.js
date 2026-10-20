import { h, button, when, toast, requestOrFail, render, empty, reviewer } from "./base.js";

let data = null;
let requestedAt = 0;
const fmtWeek = new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const pctText = (a, b) => (b ? `${pct(a, b)} %` : "—");

function load(force) {
  if (!force && Date.now() - requestedAt < 60000) return;
  requestedAt = Date.now();
  fetch("/api/learning", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      data = d;
      render();
    })
    .catch(() => {});
}

function rateBar(value) {
  if (value == null) return h("span", { class: "meta", text: "—" });
  return h("span", { class: "rate-bar" }, [h("i", { style: `width:${Math.min(100, value)}%` }), h("b", { text: `${value} %` })]);
}

function table(title, note, headers, rows, numeric = []) {
  const cls = (i) => (numeric.includes(i) ? "num" : i === 0 ? "first" : "");
  if (!rows.length) return null;
  return h("section", { class: "learning-table" }, [
    h("h3", { text: title }),
    note ? h("p", { class: "meta", text: note }) : null,
    h("div", { class: "learning-scroll" }, [
      h("table", {}, [
        h("thead", {}, [h("tr", {}, headers.map((c, i) => h("th", { scope: "col", class: cls(i), text: c })))]),
        h("tbody", {}, rows.map((f) => h("tr", {}, f.map((c, i) => (c instanceof Node ? h("td", { class: cls(i), "data-label": headers[i] }, [c]) : h("td", { class: cls(i), "data-label": headers[i], text: c })))))),
      ]),
    ]),
  ]);
}

function rateWith(x, minimum) {
  if (x.deliveries < minimum) return h("span", { class: "meta", text: "—" });
  return h("span", {}, [h("b", { text: pctText(x.returns, x.deliveries) }), h("span", { class: "meta", text: ` de ${x.deliveries}` })]);
}

export function renderLearning(root) {
  load(false);
  const reread = button("Volver a leer Jira", {
    title: "Lee de Jira lo que ha cambiado desde la última lectura. Tarda unos minutos y no gasta cuota de Claude.",
    onClick: (b) => {
      b.disabled = true;
      requestOrFail("/api/learning-read", {})
        .then((d) => toast(d.started ? "Leyendo Jira en segundo plano. Vuelve en unos minutos." : "Ya se está leyendo Jira."))
        .catch(() => toast("No se pudo lanzar la lectura."))
        .then(() => setTimeout(() => load(true), 1500));
    },
  });
  const read = data && data.read;
  root.appendChild(
    h("div", { class: "toolbar" }, [
      reread,
      h("span", { class: "meta", text: data && data.reading ? "Leyendo Jira ahora…" : read ? `Leído de Jira a las ${when(read.at)} (${read.tickets} tickets)` : "Todavía no se ha leído Jira: la primera lectura tarda unos minutos." }),
    ])
  );
  root.appendChild(h("p", { class: "setup-note", text: "Todo va en tasas por entrega, no en cifras absolutas: el número de tareas crece porque el equipo mete IA en cada vez más flujos de trabajo, y eso no dice nada de si se aprende. Una devolución es una tarea que otra persona saca de revisión; las vueltas que haces tú no cuentan." }));
  if (!data) return root.appendChild(empty("Cargando…", ""));
  const weeks = data.weeks.filter((s) => s.deliveries || s.returns);
  if (!weeks.length) return root.appendChild(empty("Sin datos todavía.", "Aparecen en cuanto termine la primera lectura de Jira."));

  const blocks = [
    table(
      "Semana a semana",
      `Tasa de devolución, tareas que se devuelven otra vez después de corregirse («Repiten»), comentarios de ${reviewer()} por cada entrega y, cuando la sesión lo apunta, si la causa de la devolución ya estaba escrita en context/.`,
      ["Semana", "Entregas", "Devueltas", "Tasa", "Repiten", `Coment. de ${reviewer()} por entrega`, "Causa ya escrita", "Causa nueva"],
      weeks.map((s) => [
        `lun ${fmtWeek.format(new Date(s.monday + "T12:00:00Z"))}`,
        String(s.deliveries),
        String(s.returns),
        rateBar(pct(s.returns, s.deliveries)),
        String(s.repeated),
        s.deliveries ? (s.reviewerComments / s.deliveries).toFixed(2).replace(".", ",") : "—",
        s.written ? String(s.written) : "",
        s.new ? String(s.new) : "",
      ]),
      [1, 2, 3, 4, 5, 6, 7]
    ),
    table(
      "Por área",
      "Cada sesión de área con las tareas de sus epics. Compara las últimas 4 semanas con las 4 anteriores, y con lo que había antes de que el área tuviera contexto (solo si hubo al menos 3 entregas). El contexto empieza en la primera fecha del historial de sus dominios.",
      ["Área", "Dominios", "Contexto desde", "Antes del contexto", "4 sem. anteriores", "Últimas 4 sem."],
      data.areas.map((a) => [
        a.name,
        h("span", { title: a.domains.join(", ") || "Ningún dominio cita sus tickets", text: String(a.domains.length) }),
        a.contextSince ? a.contextSince.split("-").reverse().slice(0, 2).join("/") : "—",
        rateWith(a.before, 3),
        rateWith(a.previous, 1),
        rateWith(a.recent, 1),
      ]),
      [1, 2, 3, 4, 5]
    ),
    table(
      "Últimas causas apuntadas",
      "Las sesiones las apuntan al cerrar una tarea devuelta. «Ya escrita» quiere decir que el contexto lo tenía y no se usó: ahí hay que mirar por qué no se encontró.",
      ["Tarea", "Causa", "Nota"],
      (data.recentCauses || []).map((c) => [c.key, c.cause === "written" ? "Ya escrita" : "Nueva", c.note])
    ),
  ];
  for (const b of blocks) if (b) root.appendChild(b);
}
