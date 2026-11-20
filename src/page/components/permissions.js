import { state, h, button, when, toast, requestOrFail, refresh } from "../lib/base.js";
import { t } from "../lib/i18n.js";

export const pendingPermissions = () => (state.permissions && state.permissions.pending) || [];

export function decide(p, decision, b) {
  let reason = "";
  if (decision === "deny") {
    reason = window.prompt(t("¿Por qué? (opcional, se lo dice a la sesión)"), "");
    if (reason === null) return;
  }
  b.disabled = true;
  requestOrFail("/api/permission/decide", { id: p.id, decision, reason })
    .then(() => {
      toast(decision === "deny" ? t("Denegado: la sesión sigue sin hacerlo.") : decision === "always" ? t("Permitido, y a partir de ahora «{rule}» pasa solo.", { rule: p.key }) : t("Permitido: la sesión sigue."));
      return refresh(true);
    })
    .catch(() => {
      b.disabled = false;
      toast(t("Ya no estaba esperando: puede que haya caducado."));
    });
}

function permissionCard(p) {
  const kids = [
    h("div", { class: "top" }, [h("strong", { text: p.areaName || t("Sesión sin registrar") }), p.native ? h("span", { class: "chip waiting", text: "Claude Code" }) : p.protected ? h("span", { class: "chip waiting", text: t("Necesita tu orden") }) : h("span", { class: "chip approved", text: t("Permiso") }), h("span", { class: "time", text: when(p.at) })]),
    h("div", { class: "title", text: t("Quiere: {action}", { action: p.label }) }),
    h("pre", { class: "perm-detail", text: p.detail }),
  ];
  const actions = [button(t("Permitir"), { cls: "primary", onClick: (b) => decide(p, "allow", b) })];
  if (!p.protected) actions.push(button(t("Permitir siempre"), { title: t("A partir de ahora «{rule}» se aprueba solo en todas las sesiones", { rule: p.key }), onClick: (b) => decide(p, "always", b) }));
  actions.push(button(t("Denegar"), { cls: "subtle", onClick: (b) => decide(p, "deny", b) }));
  kids.push(h("div", { class: "actions" }, actions));
  return h("article", { class: "card perm" }, kids);
}

export function renderPermissions(root, compact, onlyPending) {
  const list = pendingPermissions();
  if (list.length) root.appendChild(h("section", { class: compact ? "today-group" : onlyPending ? "perm-pending" : "" }, [h(compact ? "h3" : "div", { class: compact ? "" : "group-head" }, compact ? t("Permisos ({n})", { n: list.length }) : [h("span", { class: "group-name", text: t("Permisos que esperan ({n})", { n: list.length }) })]), h("div", { class: "cards" }, list.map(permissionCard))]));
  if (compact || onlyPending) return list.length;
  const rules = (state.permissions && state.permissions.rules) || [];
  if (rules.length) {
    const det = h("details", { class: "perm-rules" }, [h("summary", { class: "meta", text: t("Aprobados siempre ({n})", { n: rules.length }) })]);
    for (const r of rules)
      det.appendChild(
        h("div", { class: "perm-rule" }, [
          h("span", { text: r.label }),
          button(t("Quitar"), {
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
