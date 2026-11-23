//! Port of src/server/assets.js.
use crate::server::http::Res;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

#[allow(dead_code)]
static PAGE_DIR: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::repo().join("src").join("page"));

#[allow(dead_code)]
const TYPES: [(&str, &str); 3] = [(".html", "text/html; charset=utf-8"), (".js", "text/javascript; charset=utf-8"), (".css", "text/css; charset=utf-8")];

pub static LABEL: LazyLock<String> = LazyLock::new(|| crate::core::config::cluster().and_then(|c| c.get("label")).and_then(|v| v.as_str()).unwrap_or("").to_string());

#[allow(dead_code)]
static MANIFEST: LazyLock<String> = LazyLock::new(|| {
    let label = LABEL.as_str();
    crate::core::json::stringify(&serde_json::json!({
        "name": if label.is_empty() { "NutrIA".to_string() } else { format!("NutrIA · {label}") },
        "short_name": if label.is_empty() { "NutrIA".to_string() } else { format!("NutrIA {label}") },
        "description": "Tareas de Jira que se pueden pasar a la sesión que lleva su epic.",
        "lang": "es",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#eef1f4",
        "theme_color": "#0b6e8a",
        "icons": [
            { "src": "/icon-192.png?v=nutria2", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/icon-512.png?v=nutria2", "sizes": "512x512", "type": "image/png", "purpose": "any" },
        ],
    }))
});

#[allow(dead_code)]
static SERVICE_WORKER: LazyLock<Vec<u8>> = LazyLock::new(|| std::fs::read(PAGE_DIR.join("sw.js")).unwrap_or_default());

#[allow(dead_code)]
static ICONS: LazyLock<Mutex<HashMap<u32, Vec<u8>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[allow(dead_code)]
static NODE_MODULES_XTERM: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::repo().join("node_modules").join("@xterm"));

pub fn serve_asset(url: &str) -> Option<Res> {
    let _ = url;
    todo!()
}
