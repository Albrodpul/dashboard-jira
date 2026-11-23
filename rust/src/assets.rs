use crate::config::Config;
use bytes::Bytes;

pub struct Asset {
    pub content_type: &'static str,
    pub cache: &'static str,
    pub body: Bytes,
}

fn page_file(url: &str) -> Option<String> {
    if url == "/" || url == "/index.html" {
        return Some("index.html".into());
    }
    let rest = url.strip_prefix("/page/")?;
    let (stem, ext) = rest.rsplit_once('.')?;
    if !matches!(ext, "js" | "css") || stem.is_empty() {
        return None;
    }
    let ok = stem.split('/').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
    ok.then(|| rest.to_string())
}

fn content_type(file: &str) -> &'static str {
    match file.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn manifest(label: &str) -> String {
    let name = if label.is_empty() { "NutrIA".to_string() } else { format!("NutrIA · {label}") };
    let short = if label.is_empty() { "NutrIA".to_string() } else { format!("NutrIA {label}") };
    serde_json::json!({
        "name": name,
        "short_name": short,
        "description": "Tareas de Jira que se pueden pasar a la sesión que lleva su epic.",
        "lang": "es",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#eef1f4",
        "theme_color": "#0b6e8a",
        "icons": [
            { "src": "/icon-192.png?v=nutria2", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/icon-512.png?v=nutria2", "sizes": "512x512", "type": "image/png", "purpose": "any" }
        ]
    })
    .to_string()
}

pub enum Found {
    Asset(Asset),
    Missing,
    NotMine,
}

pub fn find(cfg: &Config, url: &str) -> Found {
    let page = cfg.page_dir();
    let read = |path: std::path::PathBuf, content_type: &'static str, cache: &'static str| match std::fs::read(path) {
        Ok(body) => Found::Asset(Asset { content_type, cache, body: Bytes::from(body) }),
        Err(_) => Found::Missing,
    };
    if let Some(file) = page_file(url) {
        return read(page.join(&file), content_type(&file), "no-store");
    }
    match url {
        "/manifest.webmanifest" => Found::Asset(Asset { content_type: "application/manifest+json", cache: "no-store", body: Bytes::from(manifest(&cfg.label)) }),
        "/sw.js" => read(page.join("sw.js"), "text/javascript", "no-store"),
        "/vendor/xterm.js" => read(cfg.repo.join("node_modules/@xterm/xterm/lib/xterm.js"), "text/javascript; charset=utf-8", "max-age=86400"),
        "/vendor/xterm.css" => read(cfg.repo.join("node_modules/@xterm/xterm/css/xterm.css"), "text/css; charset=utf-8", "max-age=86400"),
        "/vendor/addon-fit.js" => read(cfg.repo.join("node_modules/@xterm/addon-fit/lib/addon-fit.js"), "text/javascript; charset=utf-8", "max-age=86400"),
        "/icon-192.png" | "/icon-512.png" | "/favicon.ico" => {
            let side = if url == "/icon-512.png" { 512 } else { 192 };
            let hex: String = cfg.color.iter().map(|n| format!("{n:02x}")).collect();
            match std::fs::read(page.join("icons").join(format!("icon-{side}-{hex}.png"))) {
                Ok(body) => Found::Asset(Asset { content_type: "image/png", cache: "max-age=86400", body: Bytes::from(body) }),
                Err(_) => Found::NotMine,
            }
        }
        _ => Found::NotMine,
    }
}

#[cfg(test)]
mod tests {
    use super::page_file;

    #[test]
    fn only_page_scripts_and_styles_are_served() {
        assert_eq!(page_file("/").as_deref(), Some("index.html"));
        assert_eq!(page_file("/page/views/machines.js").as_deref(), Some("views/machines.js"));
        assert_eq!(page_file("/page/styles/settings.css").as_deref(), Some("styles/settings.css"));
        assert_eq!(page_file("/page/../server/push.js"), None);
        assert_eq!(page_file("/page/Main.js"), None);
        assert_eq!(page_file("/page/main.json"), None);
        assert_eq!(page_file("/page//main.js"), None);
    }
}
