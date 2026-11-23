//! Port of src/server/uploads.js.
use crate::server::http::{Req, Res, decode_uri_component, send};
use regex::Regex;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

pub const MAX_MB: u64 = 500;
const MAX_BYTES: u64 = MAX_MB * 1024 * 1024;
const KEEP_DAYS: i64 = 7;
const MAIN_DIR: &str = "pruebas/hablar";
const OWN_DIR: &str = ".tablero/hablar";

fn slashes(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn clean_old(dir: &Path) {
    static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
    let Ok(days) = std::fs::read_dir(dir) else { return };
    let limit = crate::core::time::now_ms() - KEEP_DAYS * 86400000;
    for entry in days.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !DAY.is_match(&name) {
            continue;
        }
        let Some(at) = crate::core::time::parse(&name) else { continue };
        if at < limit {
            let p = entry.path();
            let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        }
    }
}

fn safe_name(name: &str) -> String {
    static UNSAFE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.-]+").unwrap());
    let name = if name.is_empty() { "fichero" } else { name };
    let trimmed = name.trim_end_matches('/');
    let base = if trimmed.is_empty() { name } else { trimmed.rsplit('/').next().unwrap_or("") };
    let base: String = base.nfd().filter(|c| !('\u{0300}'..='\u{036f}').contains(c)).collect();
    let replaced = UNSAFE.replace_all(&base, "-");
    let out: String = replaced.trim_matches('-').chars().take(80).collect();
    if out.is_empty() { "fichero".to_string() } else { out }
}

fn keep_out_of_git(root: &Path) {
    static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^/?\.tablero/?$").unwrap());
    let exclude = root.join(".git").join("info").join("exclude");
    if !exclude.parent().map_or(false, |p| p.exists()) {
        return;
    }
    let now = std::fs::read_to_string(&exclude).unwrap_or_default();
    if !LINE.is_match(&now) {
        let sep = if !now.is_empty() && !now.ends_with('\n') { "\n" } else { "" };
        let _ = std::fs::write(&exclude, format!("{now}{sep}/.tablero/\n"));
    }
}

pub fn target(conversation: &str) -> Value {
    static CONVERSATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f-]{36}$").unwrap());
    let p = if CONVERSATION.is_match(conversation) { crate::core::projects::project_of_conversation(conversation) } else { None };
    let main_root = || crate::core::config::main_project().root.as_deref().map(slashes).unwrap_or_default();
    let Some(p) = p.filter(|p| p.id != crate::core::projects::main_id()) else { return json!({ "root": main_root(), "base": MAIN_DIR, "absolute": false }) };
    let Some(root) = p.root.clone().filter(|r| r.exists()) else { return json!({ "error": format!("«{}» no tiene carpeta en este ordenador", p.name) }) };
    keep_out_of_git(&root);
    json!({ "root": slashes(&root), "base": OWN_DIR, "absolute": true })
}

fn too_big() -> Res {
    send(413, &json!({ "error": format!("pasa de {MAX_MB} MB") })).with_header("connection", "close")
}

fn local_hhmmss() -> String {
    chrono::Local::now().format("%H%M%S").to_string()
}

pub fn handle_upload(req: &Req, body: &mut dyn Read) -> Res {
    let conversation = req.header("x-conversation").unwrap_or("");
    let place = target(conversation);
    if let Some(error) = place.get("error") {
        let _ = std::io::copy(body, &mut std::io::sink());
        return send(409, &json!({ "error": error }));
    }
    let root = PathBuf::from(place["root"].as_str().unwrap_or(""));
    let base = place["base"].as_str().unwrap_or(MAIN_DIR).to_string();
    let absolute = place["absolute"].as_bool().unwrap_or(false);
    let day = crate::core::time::madrid_now().day;
    let raw_name = req.header("x-file-name").unwrap_or("");
    let decoded = decode_uri_component(raw_name).unwrap_or_else(|_| raw_name.to_string());
    let name = format!("{}-{}", local_hhmmss(), safe_name(&decoded));
    let top = root.join(&base);
    let dir = top.join(&day);
    let declared: u64 = req.header("content-length").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    if declared > MAX_BYTES {
        return too_big();
    }
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return send(500, &json!({ "error": e.to_string() }));
    }
    let file = dir.join(&name);
    let part = PathBuf::from(format!("{}.part", file.to_string_lossy()));
    let mut out = match std::fs::File::create(&part) {
        Ok(f) => std::io::BufWriter::with_capacity(1 << 20, f),
        Err(e) => return send(500, &json!({ "error": e.to_string() })),
    };
    let fail = |code: u16, error: &str| -> Res {
        let _ = std::fs::remove_file(&part);
        if code == 413 { too_big() } else { send(code, &json!({ "error": error })) }
    };
    let mut size: u64 = 0;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = match body.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                drop(out);
                return fail(400, "subida cortada");
            }
        };
        size += n as u64;
        if size > MAX_BYTES {
            drop(out);
            return fail(413, "");
        }
        if let Err(e) = out.write_all(&buf[..n]) {
            drop(out);
            return fail(500, &e.to_string());
        }
    }
    if let Err(e) = out.flush() {
        drop(out);
        return fail(500, &e.to_string());
    }
    drop(out);
    if size == 0 {
        return fail(400, "fichero vacío");
    }
    if let Err(e) = std::fs::rename(&part, &file) {
        return fail(500, &e.to_string());
    }
    clean_old(&top);
    let rel = format!("{base}/{day}/{name}");
    send(200, &json!({ "path": if absolute { slashes(&file) } else { rel } }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpStream;

    fn serve() -> u16 {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let req = Req::head_of(&request);
                let res = handle_upload(&req, request.as_reader());
                let _ = request.respond(res.into_tiny());
            }
        });
        port
    }

    fn post(port: u16, body: &[u8], content_length: u64) -> (u16, Value) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nx-file-name: video.mp4\r\ncontent-length: {content_length}\r\n\r\n").unwrap();
        s.write_all(body).unwrap();
        s.flush().unwrap();
        let mut r = BufReader::new(s);
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let code: u16 = line.split_whitespace().nth(1).unwrap().parse().unwrap();
        let mut length = 0usize;
        loop {
            let mut h = String::new();
            r.read_line(&mut h).unwrap();
            if h == "\r\n" || h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    length = v.trim().parse().unwrap();
                }
            }
        }
        let mut data = vec![0u8; length];
        r.read_exact(&mut data).unwrap();
        (code, crate::core::json::parse(&String::from_utf8_lossy(&data)).unwrap_or(Value::Null))
    }

    #[test]
    fn a_30_mb_video_is_saved_whole_instead_of_cutting_the_connection() {
        let _g = crate::testkit::fresh();
        let port = serve();
        let body = vec![7u8; 30 * 1024 * 1024];
        let (code, r) = post(port, &body, body.len() as u64);
        assert_eq!(code, 200, "{r}");
        let root = crate::core::config::main_project().root.clone().unwrap();
        let file = root.join(r["path"].as_str().unwrap());
        assert_eq!(std::fs::metadata(&file).unwrap().len(), body.len() as u64);
        assert!(!PathBuf::from(format!("{}.part", file.to_string_lossy())).exists());
    }

    #[test]
    fn an_upload_over_the_limit_gets_a_clear_413() {
        let _g = crate::testkit::fresh();
        let port = serve();
        let (code, r) = post(port, &[0u8; 10], (MAX_MB + 1) * 1024 * 1024);
        assert_eq!(code, 413);
        assert!(r["error"].as_str().unwrap().contains("pasa de"));
    }

    #[test]
    fn file_names_lose_accents_and_odd_characters() {
        assert_eq!(safe_name("Captura de pantalla café.png"), "Captura-de-pantalla-cafe.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name(""), "fichero");
        assert_eq!(safe_name("ñ"), "n");
    }
}
