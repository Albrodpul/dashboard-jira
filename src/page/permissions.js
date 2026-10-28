import { state, h, button, when, toast, requestOrFail, refresh } from "./base.js";

export const pendingPermissions = () => (state.permissions && state.permissions.pending) || [];

function decide(p, decision, b) {
  let reason = "";
  if (decision === "deny") {
    reason = window.prompt("¿Por qué? (opcional, se lo dice a la sesión)", "");
    if (reason === null) return;
  }
  b.disabled = true;
  requestOrFail("/api/permission/decide", { id: p.id, decision, reason })
    .then(() => {
      toast(decision === "deny" ? "Denegado: la sesión sigue sin hacerlo." : decision === "always" ? `Permitido, y a partir de ahora «${p.key}» pasa solo.` : "Permitido: la sesión sigue.");
      return refresh(true);
    })
    .catch(() => {
      b.disabled = false;
      toast("Ya no estaba esperando: puede que haya caducado.");
    });
}

function permissionCard(p) {
  const kids = [
    h("div", { class: "top" }, [h("strong", { text: p.areaName || "Sesión sin registrar" }), p.protected ? h("span", { class: "chip waiting", text: "Necesita tu orden" }) : h("span", { class: "chip approved", text: "Permiso" }), h("span", { class: "time", text: when(p.at) })]),
    h("div", { class: "title", text: `Quiere: ${p.label}` }),
    h("pre", { class: "perm-detail", text: p.detail }),
  ];
  const actions = [button("Permitir", { cls: "primary", onClick: (b) => decide(p, "allow", b) })];
  if (!p.protected) actions.push(button("Permitir siempre", { title: `A partir de ahora «${p.key}» se aprueba solo en todas las sesiones`, onClick: (b) => decide(p, "always", b) }));
  actions.push(button("Denegar", { cls: "subtle", onClick: (b) => decide(p, "deny", b) }));
  kids.push(h("div", { class: "actions" }, actions));
  return h("article", { class: "card perm" }, kids);
}

export function renderPermissions(root, compact) {
  const list = pendingPermissions();
  if (list.length) root.appendChild(h("section", { class: compact ? "today-group" : "" }, [h(compact ? "h3" : "div", { class: compact ? "" : "group-head" }, compact ? `Permisos (${list.length})` : [h("span", { class: "group-name", text: `Permisos que esperan (${list.length})` })]), h("div", { class: "cards" }, list.map(permissionCard))]));
  if (compact) return list.length;
  const rules = (state.permissions && state.permissions.rules) || [];
  if (rules.length) {
    const det = h("details", { class: "perm-rules" }, [h("summary", { class: "meta", text: `Aprobados siempre (${rules.length})` })]);
    for (const r of rules)
      det.appendChild(
        h("div", { class: "perm-rule" }, [
          h("span", { text: r.label }),
          button("Quitar", {
            cls: "subtle",
            onClick: (b) => {
              b.disabled = true;
              requestOrFail("/api/permission/rule-remove", { key: r.key }).then(() => refresh(true));
            },
          }),
        ])
      );
    root.appendChild(det);
  }
  return list.length;
}
