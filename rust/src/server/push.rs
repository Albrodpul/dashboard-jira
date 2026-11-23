//! Port of src/server/push.js.
use crate::core::data::DATA_DIR;
use crate::server::http::Res;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

#[allow(dead_code)]
static KEYS_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("push-vapid.json"));
#[allow(dead_code)]
static SUBSCRIPTIONS_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("push-subs.json"));
#[allow(dead_code)]
static LAST_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("push-last.json"));

pub struct Reason {
    pub title: &'static str,
    pub text: &'static str,
    pub tab: &'static str,
}

pub const REASONS: [(&str, Reason); 10] = [
    ("tasks", Reason { title: "Tareas", text: "Hay tareas nuevas en Pendientes", tab: "pending" }),
    ("sessions", Reason { title: "Sesiones", text: "Una sesión necesita tu respuesta", tab: "waiting" }),
    ("followup", Reason { title: "Seguimiento", text: "Hay novedades en el seguimiento", tab: "follow-up" }),
    ("reply", Reason { title: "Chats", text: "Te han contestado en Chats", tab: "talk" }),
    ("deploys", Reason { title: "Despliegues", text: "Ha terminado un despliegue", tab: "deploy" }),
    ("permission", Reason { title: "Permiso", text: "Una sesión pide permiso", tab: "waiting" }),
    ("sentry", Reason { title: "Sentry", text: "Una sesión ha contestado sobre un error de Sentry", tab: "sentry" }),
    ("test", Reason { title: "Prueba", text: "Aviso de prueba del tablero", tab: "home" }),
    ("board", Reason { title: "Tablero", text: "El tablero no responde", tab: "home" }),
    ("token", Reason { title: "Token de Claude", text: "El token de Claude caduca pronto: renuévalo en Ajustes → Cuenta de Claude", tab: "claude" }),
];

pub fn reason(kind: &str) -> Option<&'static Reason> {
    REASONS.iter().find(|(k, _)| *k == kind).map(|(_, r)| r)
}

pub fn push_keys() -> Value {
    todo!()
}

pub fn subscriptions() -> Vec<Value> {
    todo!()
}

pub fn push_reason() -> Value {
    todo!()
}

pub fn send_push(kind: &str, force: bool, text: Option<&str>) -> usize {
    let _ = (kind, force, text);
    todo!()
}

pub fn handle_push(route: &str, input: &Value) -> Res {
    let _ = (route, input);
    todo!()
}
