//! Port of src/server/assets.js.
use crate::server::http::{Res, serve_body};
use std::io::Write;
use regex::Regex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

static PAGE_DIR: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::repo().join("src").join("page"));

const TYPES: [(&str, &str); 3] = [(".html", "text/html; charset=utf-8"), (".js", "text/javascript; charset=utf-8"), (".css", "text/css; charset=utf-8")];

pub static LABEL: LazyLock<String> = LazyLock::new(|| crate::core::config::cluster().and_then(|c| c.get("label")).and_then(|v| v.as_str()).unwrap_or("").to_string());

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

static SERVICE_WORKER: LazyLock<Vec<u8>> = LazyLock::new(|| std::fs::read(PAGE_DIR.join("sw.js")).unwrap_or_default());

static ICONS: LazyLock<Mutex<HashMap<u32, Vec<u8>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

static NODE_MODULES_XTERM: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::repo().join("node_modules").join("@xterm"));

fn color() -> Vec<u8> {
    crate::core::config::cluster()
        .and_then(|c| c.get("color"))
        .and_then(|c| c.as_array())
        .map(|a| a.iter().map(|n| n.as_f64().unwrap_or(0.0) as u8).collect())
        .unwrap_or_else(|| vec![11, 110, 138])
}

fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    table
}

fn chunk(table: &[u32; 256], kind: &[u8], data: &[u8]) -> Vec<u8> {
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    let mut c = 0xffffffffu32;
    for b in &body {
        c = table[((c ^ *b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    let sum = c ^ 0xffffffff;
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    out.extend_from_slice(&sum.to_be_bytes());
    out
}

fn draw(side: u32, background: &[u8]) -> Vec<u8> {
    let paper = [255u8, 255, 255];
    let accent = [255u8, 196, 87];
    let row = (side * 4 + 1) as usize;
    let mut raw = vec![0u8; row * side as usize];
    let s = side as f64;
    let inside = |x: u32, y: u32, x0: f64, y0: f64, x1: f64, y1: f64| {
        let (x, y) = (x as f64, y as f64);
        x >= x0 * s && x < x1 * s && y >= y0 * s && y < y1 * s
    };
    for y in 0..side {
        raw[y as usize * row] = 0;
        for x in 0..side {
            let mut c: &[u8] = background;
            if inside(x, y, 0.2, 0.22, 0.8, 0.36) || inside(x, y, 0.2, 0.43, 0.8, 0.57) || inside(x, y, 0.2, 0.64, 0.8, 0.78) {
                c = &paper;
            }
            if inside(x, y, 0.2, 0.22, 0.26, 0.36) {
                c = &accent;
            }
            let at = y as usize * row + 1 + x as usize * 4;
            for (k, v) in c.iter().take(3).enumerate() {
                raw[at + k] = *v;
            }
            raw[at + 3] = 255;
        }
    }
    let table = crc_table();
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&side.to_be_bytes());
    header.extend_from_slice(&side.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = z.write_all(&raw);
    let deflated = z.finish().unwrap_or_default();
    let mut png = vec![137u8, 80, 78, 71, 13, 10, 26, 10];
    png.extend(chunk(&table, b"IHDR", &header));
    png.extend(chunk(&table, b"IDAT", &deflated));
    png.extend(chunk(&table, b"IEND", &[]));
    png
}

fn icon(side: u32) -> Vec<u8> {
    if let Some(i) = ICONS.lock().unwrap().get(&side) {
        return i.clone();
    }
    let background = color();
    let hex: String = background.iter().map(|n| format!("{n:02x}")).collect();
    let png = std::fs::read(PAGE_DIR.join("icons").join(format!("icon-{side}-{hex}.png"))).unwrap_or_else(|_| draw(side, &background));
    ICONS.lock().unwrap().insert(side, png.clone());
    png
}

fn page_file(url: &str) -> Option<PathBuf> {
    static PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/page/((?:[a-z0-9-]+/)*[a-z0-9-]+\.(?:js|css))$").unwrap());
    if url == "/" || url == "/index.html" {
        return Some(PAGE_DIR.join("index.html"));
    }
    PAGE.captures(url).map(|m| PAGE_DIR.join(&m[1]))
}

fn vendor(url: &str) -> Option<(PathBuf, &'static str)> {
    match url {
        "/vendor/xterm.js" => Some((NODE_MODULES_XTERM.join("xterm").join("lib").join("xterm.js"), "text/javascript; charset=utf-8")),
        "/vendor/xterm.css" => Some((NODE_MODULES_XTERM.join("xterm").join("css").join("xterm.css"), "text/css; charset=utf-8")),
        "/vendor/addon-fit.js" => Some((NODE_MODULES_XTERM.join("addon-fit").join("lib").join("addon-fit.js"), "text/javascript; charset=utf-8")),
        _ => None,
    }
}

pub fn serve_asset(url: &str) -> Option<Res> {
    if let Some(file) = page_file(url) {
        let Ok(body) = std::fs::read(&file) else { return Some(Res::empty(404)) };
        let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let kind = TYPES.iter().find(|(k, _)| *k == ext).map(|(_, v)| *v).unwrap_or("");
        return Some(serve_body(kind, body, None));
    }
    if url == "/manifest.webmanifest" {
        return Some(serve_body("application/manifest+json", MANIFEST.as_bytes(), None));
    }
    if url == "/sw.js" {
        return Some(serve_body("text/javascript", SERVICE_WORKER.clone(), None));
    }
    if let Some((file, kind)) = vendor(url) {
        let Ok(body) = std::fs::read(&file) else { return Some(Res::empty(404)) };
        return Some(serve_body(kind, body, Some("max-age=86400")));
    }
    if ["/icon-192.png", "/icon-512.png", "/favicon.ico"].contains(&url) {
        return Some(serve_body("image/png", icon(if url == "/icon-512.png" { 512 } else { 192 }), Some("max-age=86400")));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_and_its_modules_are_served_but_nothing_outside_it() {
        let index = serve_asset("/").unwrap();
        assert_eq!(index.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(index.header("cache-control"), Some("no-store"));
        assert!(page_file("/page/../cli.js").is_none());
        assert!(serve_asset("/api/state").is_none());
        assert_eq!(serve_asset("/page/nothing-here.js").unwrap().code, 404);
    }

    #[test]
    fn a_drawn_icon_is_a_valid_png() {
        let png = draw(16, &[11, 110, 138]);
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        assert_eq!(&png[png.len() - 4..], &[0xae, 0x42, 0x60, 0x82]);
    }

    #[test]
    fn the_manifest_names_the_board() {
        let m = serve_asset("/manifest.webmanifest").unwrap();
        assert_eq!(m.header("content-type"), Some("application/manifest+json"));
        assert!(m.body_text().starts_with(r#"{"name":"NutrIA"#));
    }
}
