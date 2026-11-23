//! Port of src/server/server.js.
use crate::core::data::{BASE_URL, DATA_DIR, PORT};
use crate::core::json::parse;
use crate::server::assets::{LABEL, serve_asset};
use crate::server::http::{Req, Res, host_ok, origin_ok, send};
use regex::Regex;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

static LOCAL_API: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/(cluster|tunnel|claude-token/|push/|host/(respawned|prompt|sessions)|permission/(check|perm-)|quit)").unwrap());

static TERMINAL_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/api/term/([0-9a-f-]{36})$").unwrap());

const MAX_JSON_BODY: usize = 20000;

const PEER_TIMEOUT_MS: u64 = 15000;

const MAX_HEAD: usize = 64 * 1024;

fn panic_text(e: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else {
        "error".to_string()
    }
}

fn guarded<R>(f: impl FnOnce() -> R) -> Result<R, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|e| panic_text(&*e))
}

struct Peer {
    hostname: String,
    port: u16,
    host: String,
    origin: String,
}

fn peer() -> Option<Peer> {
    let info = crate::cluster::cluster::info();
    let url = info.get("peer").and_then(|p| p.as_str()).filter(|p| !p.is_empty())?.to_string();
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(&url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    let (hostname, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !authority.starts_with('[') || h.ends_with(']') => (h.to_string(), p.parse::<u16>().ok()),
        _ => (authority.clone(), None),
    };
    let port_num = port.unwrap_or(443);
    let host = if port.is_some() && port != Some(443) { format!("{hostname}:{port_num}") } else { hostname.clone() };
    Some(Peer { hostname: hostname.trim_start_matches('[').trim_end_matches(']').to_string(), port: port_num, origin: format!("https://{host}"), host })
}

fn has_peer() -> bool {
    crate::core::json::truthy(crate::cluster::cluster::info().get("peer"))
}

fn forwards_to_primary(url: &str) -> bool {
    url.starts_with("/api/") && !LOCAL_API.is_match(url) && !crate::cluster::cluster::is_primary() && has_peer()
}

fn peer_headers(req: &Req, peer: &Peer) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in &req.headers {
        let v = match k.as_str() {
            "host" => peer.host.clone(),
            "origin" if !v.is_empty() => peer.origin.clone(),
            _ => v.clone(),
        };
        out.push((k.clone(), v));
    }
    if !req.headers.contains_key("host") {
        out.push(("host".to_string(), peer.host.clone()));
    }
    out
}

fn respond(request: tiny_http::Request, res: Res) {
    let _ = request.respond(res.into_tiny());
}

fn handle(request: tiny_http::Request) {
    let req = Req::head_of(&request);
    if !host_ok(req.header("host").unwrap_or("")) {
        return respond(request, Res::text(403, "host no permitido"));
    }
    if forwards_to_primary(&req.url) {
        return forward_to_primary(request, req);
    }
    handle_local(request, req, None)
}

const HOP_BY_HOP: [&str; 6] = ["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "proxy-connection"];

fn forward_to_primary(mut request: tiny_http::Request, req: Req) {
    let Some(peer) = peer() else { return handle_local(request, req, None) };
    let via = if LABEL.is_empty() { "otro".to_string() } else { LABEL.clone() };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_millis(PEER_TIMEOUT_MS)))
        .timeout_recv_response(Some(Duration::from_millis(PEER_TIMEOUT_MS)))
        .timeout_per_read(Some(Duration::from_millis(PEER_TIMEOUT_MS)))
        .timeout_per_write(Some(Duration::from_millis(PEER_TIMEOUT_MS)))
        .user_agent(ureq::config::AutoHeaderValue::None)
        .accept(ureq::config::AutoHeaderValue::None)
        .build()
        .into();
    let url = format!("https://{}:{}{}", peer.hostname, peer.port, req.raw_url);
    let mut builder = ureq::http::Request::builder().method(req.method.as_str()).uri(&url);
    for (k, v) in peer_headers(&req, &peer) {
        if k == "transfer-encoding" || k == "connection" || k == "keep-alive" {
            continue;
        }
        builder = builder.header(k, v);
    }
    let has_body = req.header("content-length").map_or(false, |l| l.trim() != "0") || req.header("transfer-encoding").is_some();
    let run = |r: Result<ureq::http::Request<ureq::SendBody<'_>>, ureq::http::Error>| match r {
        Ok(r) => agent.run(r).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let result = if has_body { run(builder.body(ureq::SendBody::from_reader(request.as_reader()))) } else { run(builder.body(ureq::SendBody::none())) };
    match result {
        Ok(up) => {
            let status = up.status().as_u16();
            let length = up.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<usize>().ok());
            let mut headers: Vec<tiny_http::Header> = Vec::new();
            for (k, v) in up.headers() {
                if HOP_BY_HOP.contains(&k.as_str()) {
                    continue;
                }
                if let Ok(h) = tiny_http::Header::from_bytes(k.as_str().as_bytes(), v.as_bytes()) {
                    headers.push(h);
                }
            }
            if let Ok(h) = tiny_http::Header::from_bytes(&b"x-tower-via"[..], via.as_bytes()) {
                headers.push(h);
            }
            let reader = up.into_body().into_reader();
            let response = tiny_http::Response::new(tiny_http::StatusCode(status), headers, reader, length, None);
            let _ = request.respond(response);
        }
        Err(_) => {
            if req.method == "GET" {
                return handle_local(request, req, Some(("x-tower-stale".to_string(), via)));
            }
            respond(request, send(502, &json!({ "error": "el ordenador que manda no responde" })));
        }
    }
}

fn read_limited(request: &mut tiny_http::Request, limit: usize) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    let _ = request.as_reader().take(limit as u64 + 1).read_to_end(&mut body);
    if body.len() > limit { None } else { Some(body) }
}

fn local_response(request: &mut tiny_http::Request, mut req: Req) -> (Res, bool) {
    let url = req.url.clone();
    if req.method == "GET" {
        if let Some(r) = serve_asset(&url) {
            return (r, false);
        }
        match guarded(|| crate::server::routes::index::handle_get(&req)) {
            Ok(Some(r)) => return (r, false),
            Ok(None) => {}
            Err(e) => return (send(500, &json!({ "error": e })), false),
        }
    }
    if req.method == "POST" && url == "/api/quit" {
        if !origin_ok(&req) {
            return (Res::text(403, "origen no permitido"), false);
        }
        return (Res::text(200, "bye"), true);
    }
    if req.method == "POST" && url == "/api/upload" {
        if !origin_ok(&req) {
            return (Res::text(403, "origen no permitido"), false);
        }
        let reader = request.as_reader();
        return (crate::server::uploads::handle_upload(&req, reader), false);
    }
    if req.method == "POST" && url == "/api/voice" {
        if !origin_ok(&req) || !req.content_type().starts_with("audio/") {
            return (Res::text(403, "origen no permitido"), false);
        }
        let mut body = Vec::new();
        let _ = request.as_reader().read_to_end(&mut body);
        req.body = body;
        let r = match guarded(|| crate::features::voice::handle_voice(&req, crate::server::routes::operations::handle_message)) {
            Ok(Ok(r)) => r,
            Ok(Err(e)) | Err(e) => send(500, &json!({ "error": e })),
        };
        return (r, false);
    }
    let route = if req.method == "POST" { crate::server::routes::index::post_route(&url) } else { None };
    let Some(route) = route else { return (Res::empty(404), false) };
    if !origin_ok(&req) || !req.content_type().starts_with("application/json") {
        return (Res::text(403, "origen no permitido"), false);
    }
    let Some(body) = read_limited(request, MAX_JSON_BODY) else { return (Res::empty(413).with_header("connection", "close"), false) };
    let Some(input) = parse(&String::from_utf8_lossy(&body)) else { return (send(400, &json!({ "error": "petición no válida" })), false) };
    let r = match guarded(|| route(&input)) {
        Ok(r) => r,
        Err(e) => send(500, &json!({ "error": e })),
    };
    (r, false)
}

fn handle_local(mut request: tiny_http::Request, req: Req, extra: Option<(String, String)>) {
    let (mut res, quit) = local_response(&mut request, req);
    if let Some((k, v)) = extra {
        res.set_header(&k, &v);
    }
    respond(request, res);
    if quit {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            std::process::exit(0);
        });
    }
}

fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

struct Head {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
}

fn parse_head(bytes: &[u8]) -> Option<Head> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let url = parts.next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Some(Head { method, url, headers })
}

fn splice(a: TcpStream, b: TcpStream) {
    let (Ok(mut a2), Ok(mut b2)) = (a.try_clone(), b.try_clone()) else { return };
    let mut a1 = a;
    let mut b1 = b;
    let t = std::thread::spawn(move || {
        let _ = std::io::copy(&mut a2, &mut b2);
        let _ = b2.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut b1, &mut a1);
    let _ = a1.shutdown(std::net::Shutdown::Write);
    let _ = t.join();
}

fn front(mut client: TcpStream, inner_port: u16) {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let end = loop {
        match client.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if let Some(end) = head_end(&buf) {
            break end;
        }
        if buf.len() > MAX_HEAD {
            break buf.len();
        }
    };
    let head = parse_head(&buf[..end]);
    let upgrade = head.as_ref().map_or(false, |h| h.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("upgrade")));
    if upgrade {
        let head = head.unwrap();
        return proxy_terminal(client, head, buf[end..].to_vec());
    }
    let Ok(mut inner) = TcpStream::connect(("127.0.0.1", inner_port)) else { return };
    if inner.write_all(&buf).is_err() {
        return;
    }
    splice(client, inner);
}

fn head_to_req(head: &Head) -> Req {
    let mut req = Req::new(&head.method, &head.url);
    for (k, v) in &head.headers {
        let name = k.to_ascii_lowercase();
        req.headers.entry(name).and_modify(|x| *x = format!("{x}, {v}")).or_insert_with(|| v.clone());
    }
    req
}

fn proxy_terminal(socket: TcpStream, head: Head, rest: Vec<u8>) {
    let req = head_to_req(&head);
    let Some(m) = TERMINAL_PATH.captures(&head.url) else { return };
    if !origin_ok(&req) {
        return;
    }
    if forwards_to_primary(&head.url) {
        return proxy_terminal_to_primary(socket, &req, &head, rest);
    }
    let port = *crate::sessions::host::HOST_PORT;
    let Ok(mut upstream) = TcpStream::connect(("127.0.0.1", port)) else { return };
    let mut lines = vec![format!("GET /attach/{} HTTP/1.1", &m[1])];
    for (k, v) in &head.headers {
        if !k.eq_ignore_ascii_case("host") {
            lines.push(format!("{k}: {v}"));
        }
    }
    lines.push(format!("Host: 127.0.0.1:{port}"));
    if upstream.write_all(format!("{}\r\n\r\n", lines.join("\r\n")).as_bytes()).is_err() {
        return;
    }
    if !rest.is_empty() && upstream.write_all(&rest).is_err() {
        return;
    }
    splice(socket, upstream);
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("tls")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(config)
    });
    CONFIG.clone()
}

fn proxy_terminal_to_primary(socket: TcpStream, req: &Req, head: &Head, rest: Vec<u8>) {
    let Some(peer) = peer() else { return };
    let Ok(name) = rustls::pki_types::ServerName::try_from(peer.hostname.clone()) else { return };
    let Ok(conn) = rustls::ClientConnection::new(tls_config(), name) else { return };
    let Ok(tcp) = TcpStream::connect((peer.hostname.as_str(), peer.port)) else { return };
    let mut tls = rustls::StreamOwned::new(conn, tcp);
    let mut lines = vec![format!("GET {} HTTP/1.1", head.url)];
    for (k, v) in peer_headers(req, &peer) {
        lines.push(format!("{k}: {v}"));
    }
    if tls.write_all(format!("{}\r\n\r\n", lines.join("\r\n")).as_bytes()).is_err() {
        return;
    }
    if !rest.is_empty() && tls.write_all(&rest).is_err() {
        return;
    }
    let _ = tls.flush();
    let _ = tls.sock.set_read_timeout(Some(Duration::from_millis(20)));
    let tls = Arc::new(Mutex::new(tls));
    let Ok(mut client_in) = socket.try_clone() else { return };
    let mut client_out = socket;
    let up = tls.clone();
    let writer = std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            let n = match client_in.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut s = up.lock().unwrap();
            if s.write_all(&buf[..n]).and_then(|_| s.flush()).is_err() {
                break;
            }
        }
        let mut s = up.lock().unwrap();
        s.conn.send_close_notify();
        let _ = s.flush();
        let _ = s.sock.shutdown(std::net::Shutdown::Both);
    });
    let mut buf = [0u8; 16384];
    loop {
        let read = {
            let mut s = tls.lock().unwrap();
            s.read(&mut buf)
        };
        match read {
            Ok(0) => break,
            Ok(n) => {
                if client_out.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    let _ = client_out.shutdown(std::net::Shutdown::Both);
    let _ = writer.join();
}

fn every(f: impl Fn() + Send + 'static, ms: u64) {
    std::thread::spawn(move || {
        loop {
            let started = std::time::Instant::now();
            let _ = guarded(&f);
            let spent = started.elapsed();
            let period = Duration::from_millis(ms);
            std::thread::sleep(period.saturating_sub(spent).max(Duration::from_millis(1)));
        }
    });
}

fn after(ms: u64, f: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        let _ = guarded(f);
    });
}

fn listen_port() -> u16 {
    std::env::var("TOWER_LISTEN_PORT").ok().and_then(|p| p.trim().parse::<u16>().ok()).filter(|p| *p != 0).unwrap_or(*PORT)
}

fn start_jobs() {
    after(0, || {
        crate::sessions::host::ensure_host();
    });
    every(|| drop(crate::jira::client::sync_jira_epics()), 30 * 60 * 1000);
    every(|| drop(crate::jira::client::refresh_attachments()), 45 * 1000);
    every(crate::server::routes::tasks::archive_done, 10 * 60 * 1000);
    every(|| drop(crate::features::quota::fetch_quota()), 10 * 60 * 1000);
    every(|| { crate::jira::learning::start_reading(); }, 3 * 60 * 60 * 1000);
    after(0, crate::features::deploy_status::start_deploy_status);
    every(|| drop(crate::features::devservers::schedule()), 60 * 1000);
    every(crate::features::tunnel::guard, 60 * 1000);
    every(|| drop(crate::core::hours::overtime()), 60 * 1000);
    every(crate::cluster::contextsync::sync_context, 3 * 60 * 1000);
    every(crate::cluster::contextsync::wake_check, 30 * 1000);
    every(crate::cluster::cluster::tick, 30 * 1000);
    every(|| crate::sessions::autosleep::sleep_idle_sessions(false), 5 * 60 * 1000);
    every(crate::sessions::hostfresh::refresh_host_when_quiet, 3 * 60 * 1000);
    every(crate::features::followup_schedule::tick, 30 * 1000);
    every(crate::features::jira_watch::tick, 5 * 1000);
    after(0, crate::features::mailman::start);
    every(crate::features::yolo::tick, 5 * 1000);
    every(crate::features::daily::daily_if_missing, 5 * 60 * 1000);
    every(|| drop(crate::features::claude_token::warn_expiry()), 3 * 60 * 60 * 1000);
    every(|| drop(crate::features::memory_sync::sync_memory()), 10 * 60 * 1000);
    every(crate::features::mac_power::tick, 60 * 1000);
    every(crate::sessions::rotate::rotate_if_morning, 5 * 60 * 1000);
    every(crate::features::watchdog::tick, 2 * 60 * 1000);
    every(|| drop(crate::features::github::poll()), 3 * 60 * 1000);
    after(5000, crate::features::files::warm_files);
    after(30000, crate::server::smoke::smoke_after_update);
}

pub fn serve() {
    if crate::core::mac_agent::IS_MAC && !crate::core::mac_agent::under_agent() {
        if crate::core::mac_agent::install(&crate::core::config::workspace(), &DATA_DIR.join("serve.log")) {
            println!("NutrIA pasa a ejecutarse como servicio del Mac (launchd), que lo mantiene siempre en marcha.");
            std::process::exit(0);
        }
    }
    let mut tries = 0;
    let listener = loop {
        match bind(listen_port()) {
            Ok(l) => break l,
            Err(e) if tries < 30 && e.contains("in use") => {
                tries += 1;
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    };
    println!("NutrIA en {}", *BASE_URL);
    start_jobs();
    run(listener);
}

struct Listeners {
    front: TcpListener,
    inner: tiny_http::Server,
}

fn bind(port: u16) -> Result<Listeners, String> {
    let inner = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let front = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    Ok(Listeners { front, inner })
}

fn run(listeners: Listeners) {
    let Listeners { front: listener, inner } = listeners;
    let inner_port = inner.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    std::thread::spawn(move || {
        for request in inner.incoming_requests() {
            std::thread::spawn(move || handle(request));
        }
    });
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        std::thread::spawn(move || front(stream, inner_port));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn start() -> u16 {
        let l = bind(0).unwrap();
        let port = l.front.local_addr().unwrap().port();
        std::thread::spawn(move || run(l));
        port
    }

    fn call(port: u16, raw: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut r = BufReader::new(s);
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let code = line.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
        let mut length = 0usize;
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    length = v.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; length];
        r.read_exact(&mut body).unwrap();
        (code, String::from_utf8_lossy(&body).into_owned())
    }

    fn host() -> String {
        format!("127.0.0.1:{}", *PORT)
    }

    #[test]
    fn an_unknown_host_is_refused() {
        let _g = crate::testkit::fresh();
        let port = start();
        let (code, body) = call(port, "GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
        assert_eq!((code, body.as_str()), (403, "host no permitido"));
    }

    #[test]
    fn the_page_assets_are_served_and_unknown_posts_are_not_found() {
        let _g = crate::testkit::fresh();
        let port = start();
        let (code, body) = call(port, &format!("GET /manifest.webmanifest HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", host()));
        assert_eq!(code, 200);
        assert!(body.contains("NutrIA"));
        let (code, _) = call(port, &format!("POST /api/nothing HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", host()));
        assert_eq!(code, 404);
    }

    #[test]
    fn a_post_from_another_origin_is_refused() {
        let _g = crate::testkit::fresh();
        let port = start();
        let (code, body) = call(port, &format!("POST /api/quit HTTP/1.1\r\nHost: {}\r\nOrigin: https://evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", host()));
        assert_eq!((code, body.as_str()), (403, "origen no permitido"));
    }

    #[test]
    fn a_terminal_websocket_is_proxied_to_the_session_host() {
        let _g = crate::testkit::fresh();
        let upstream = TcpListener::bind(("127.0.0.1", *crate::sessions::host::HOST_PORT)).unwrap();
        let port = start();
        let id = "0123abcd-0000-4000-8000-0123456789ab";
        let host_side = std::thread::spawn(move || {
            let (mut s, _) = upstream.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let mut got = Vec::new();
            while head_end(&got).is_none() {
                let n = s.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhola").unwrap();
            let mut echo = [0u8; 5];
            s.read_exact(&mut echo).unwrap();
            (String::from_utf8_lossy(&got).into_owned(), echo)
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(format!("GET /api/term/{id} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\n\r\n", host()).as_bytes()).unwrap();
        let mut got = Vec::new();
        let mut buf = [0u8; 256];
        while !String::from_utf8_lossy(&got).ends_with("hola") {
            let n = c.read(&mut buf).unwrap();
            assert!(n > 0);
            got.extend_from_slice(&buf[..n]);
        }
        c.write_all(b"vuelta").unwrap();
        let (head, echo) = host_side.join().unwrap();
        assert!(head.starts_with(&format!("GET /attach/{id} HTTP/1.1\r\n")));
        assert!(head.contains(&format!("Host: 127.0.0.1:{}\r\n", *crate::sessions::host::HOST_PORT)));
        assert!(head.contains("Sec-WebSocket-Key: abc"));
        assert_eq!(&echo, b"vuelt");
    }
}
