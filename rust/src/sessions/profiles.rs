//! Port of src/sessions/profiles.js.
use crate::core::json::truthy;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

pub const MODELS: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "reporter": { "model": "sonnet", "effort": "low", "why": "solo lee Jira y resume lo que cambió" },
        "orchestrator": { "model": "opus", "effort": "medium", "why": "ordena el contexto y habla de tareas y restricciones" },
        "followUp": { "model": "sonnet", "effort": "medium", "why": "resume lo que hace cada uno en beta y en producción" },
        "deploy": { "model": "sonnet", "effort": "medium", "why": "sigue los pasos de despliegue con cuidado" },
        "errors": { "model": "opus", "effort": "medium", "why": "investiga errores de producción" },
        "board": { "model": "opus", "effort": "medium", "why": "cambia el código del tablero" },
        "area": { "model": "opus", "effort": "medium", "why": "desarrolla tareas de Jira" }
    })
});

pub fn profiles() -> Value {
    let mut out = DEFAULTS.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(extra)) = crate::core::config::session_profiles() {
        for (k, v) in extra {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

fn role_of(conversation: &str) -> &'static str {
    let r = crate::sessions::registry::load_routes();
    for role in ["reporter", "orchestrator", "followUp", "board"] {
        if r.get(role).filter(|x| truthy(Some(x))).and_then(|x| x.get("conversation")).and_then(|c| c.as_str()) == Some(conversation) {
            return role;
        }
    }
    let area_id = r.get("areas").and_then(|a| a.as_object()).and_then(|a| a.iter().find(|(_, x)| x.get("conversation").and_then(|c| c.as_str()) == Some(conversation)).map(|(id, _)| id.clone()));
    if let Some(id) = area_id.filter(|id| !id.is_empty()) {
        if r.get("deployer").and_then(|d| d.as_str()) == Some(id.as_str()) {
            return "deploy";
        }
        if crate::core::config::main_project().errors_area.as_deref() == Some(id.as_str()) {
            return "errors";
        }
    }
    "area"
}

fn override_of(conversation: &str) -> Option<Value> {
    crate::core::data::load().get("sessionOverrides").and_then(|o| o.get(conversation)).filter(|o| truthy(Some(o))).cloned()
}

fn present(v: Option<&Value>) -> Option<Value> {
    v.filter(|x| truthy(Some(x))).cloned()
}

pub fn profile_for(conversation: &str, overrides: Option<&Value>) -> Value {
    let role = role_of(conversation);
    let base = profiles().get(role).filter(|b| truthy(Some(b))).cloned().unwrap_or(json!({}));
    let o = match overrides {
        Some(all) => all.get(conversation).filter(|x| truthy(Some(x))).cloned(),
        None => override_of(conversation),
    }
    .unwrap_or(json!({}));
    let model = present(o.get("model"));
    let effort = present(o.get("effort"));
    let mut out = Map::new();
    out.insert("role".into(), Value::String(role.into()));
    if let Some(b) = base.as_object() {
        for (k, v) in b {
            out.insert(k.clone(), v.clone());
        }
    }
    let custom = model.is_some() || effort.is_some();
    if let Some(m) = model {
        out.insert("model".into(), m);
    }
    if let Some(e) = effort {
        out.insert("effort".into(), e);
    }
    out.insert("custom".into(), Value::Bool(custom));
    out.insert("defaults".into(), json!({ "model": present(base.get("model")).unwrap_or(Value::Null), "effort": present(base.get("effort")).unwrap_or(Value::Null) }));
    Value::Object(out)
}

pub fn set_override(conversation: &str, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
    let model = model.filter(|m| !m.is_empty());
    let effort = effort.filter(|e| !e.is_empty());
    if let Some(m) = model
        && !MODELS.contains(&m)
    {
        return Err(format!("modelo no válido: {m}"));
    }
    if let Some(e) = effort
        && !EFFORTS.contains(&e)
    {
        return Err(format!("esfuerzo no válido: {e}"));
    }
    crate::core::data::mutate(|d| {
        if !truthy(d.get("sessionOverrides")) {
            d.insert("sessionOverrides".into(), json!({}));
        }
        let Some(all) = d.get_mut("sessionOverrides").and_then(|o| o.as_object_mut()) else { return };
        if model.is_none() && effort.is_none() {
            all.remove(conversation);
        } else {
            all.insert(conversation.to_string(), json!({ "model": model, "effort": effort }));
        }
    });
    Ok(profile_for(conversation, None))
}

pub fn profile_args(conversation: &str) -> Vec<String> {
    let p = profile_for(conversation, None);
    let mut out = Vec::new();
    if let Some(m) = present(p.get("model")) {
        out.push("--model".to_string());
        out.push(m.as_str().map(String::from).unwrap_or_else(|| crate::core::json::stringify(&m)));
    }
    if let Some(e) = present(p.get("effort")) {
        out.push("--effort".to_string());
        out.push(e.as_str().map(String::from).unwrap_or_else(|| crate::core::json::stringify(&e)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_gets_its_role_profile_and_an_override_wins() {
        let _g = crate::testkit::fresh();
        let conversation = "11111111-2222-4333-8444-555555555555";
        crate::sessions::registry::change_routes(|r| r["reporter"] = json!({ "conversation": conversation }));
        let p = profile_for(conversation, None);
        assert_eq!(crate::core::json::stringify(&p), r#"{"role":"reporter","model":"sonnet","effort":"low","why":"solo lee Jira y resume lo que cambió","custom":false,"defaults":{"model":"sonnet","effort":"low"}}"#);
        assert_eq!(profile_args(conversation), vec!["--model", "sonnet", "--effort", "low"]);
        let p = set_override(conversation, Some("opus"), None).unwrap();
        assert_eq!(p["model"], "opus");
        assert_eq!(p["custom"], true);
        assert_eq!(set_override(conversation, Some("gpt"), None).unwrap_err(), "modelo no válido: gpt");
        assert_eq!(set_override(conversation, None, Some("huge")).unwrap_err(), "esfuerzo no válido: huge");
        assert_eq!(set_override(conversation, None, None).unwrap()["custom"], false);
        assert_eq!(profile_for("other", None)["role"], "area");
    }
}
