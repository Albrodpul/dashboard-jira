//! Port of src/server/push.js.
use crate::core::data::{DATA_DIR, read_json};
use crate::core::json::{stringify, truthy};
use crate::core::time::{now, now_ms};
use crate::server::http::{Res, send};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::LazyLock;

static KEYS_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("push-vapid.json"));
static SUBSCRIPTIONS_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("push-subs.json"));
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

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn from_b64url(text: &str) -> Vec<u8> {
    static LENIENT: LazyLock<base64::engine::GeneralPurpose> = LazyLock::new(|| {
        base64::engine::GeneralPurpose::new(
            &base64::alphabet::URL_SAFE,
            base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
        )
    });
    let clean: String = text.chars().filter_map(|c| match c {
        '+' => Some('-'),
        '/' => Some('_'),
        c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => Some(c),
        _ => None,
    }).collect();
    let usable = if clean.len() % 4 == 1 { &clean[..clean.len() - 1] } else { &clean[..] };
    LENIENT.decode(usable).unwrap_or_default()
}

fn random_secret() -> p256::SecretKey {
    loop {
        let bytes: [u8; 32] = rand::random();
        if let Ok(k) = p256::SecretKey::from_slice(&bytes) {
            return k;
        }
    }
}

fn write_compact(file: &std::path::Path, v: &Value) {
    let _ = std::fs::write(file, stringify(v));
}

pub fn push_keys() -> Value {
    let saved = read_json(&KEYS_FILE, Value::Null);
    if truthy(saved.get("publicKey")) {
        return saved;
    }
    if truthy(saved.get("publica")) {
        let mut converted = Map::new();
        converted.insert("publicKey".to_string(), saved["publica"].clone());
        if let Some(p) = saved.get("privada") {
            converted.insert("privateKey".to_string(), p.clone());
        }
        let converted = Value::Object(converted);
        write_compact(&KEYS_FILE, &converted);
        return converted;
    }
    use p256::pkcs8::{EncodePrivateKey, LineEnding};
    let secret = random_secret();
    let public = secret.public_key().to_sec1_bytes();
    let pem = secret.to_pkcs8_pem(LineEnding::LF).map(|p| p.to_string()).unwrap_or_default();
    let keys = json!({ "publicKey": b64url(&public), "privateKey": pem });
    write_compact(&KEYS_FILE, &keys);
    keys
}

pub fn subscriptions() -> Vec<Value> {
    read_json(&SUBSCRIPTIONS_FILE, json!([])).as_array().cloned().unwrap_or_default()
}

fn save_subscriptions(subs: &[Value]) {
    let _ = crate::core::data::write_json_pretty(&SUBSCRIPTIONS_FILE, &Value::Array(subs.to_vec()), 1);
}

fn entry_of(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => json!({ "at": s }),
        Some(x) if truthy(Some(x)) => x.clone(),
        _ => json!({}),
    }
}

fn elapsed_since(at: &Value) -> Option<i64> {
    at.as_str().filter(|s| !s.is_empty()).map(|s| crate::core::time::parse(s).map_or(i64::MAX, |t| now_ms() - t))
}

fn notification_for(kind: Option<&str>, text: Option<&str>) -> Value {
    let r = kind.and_then(reason);
    let (title, default_text, tab) = r.map_or(("", "Hay novedades", "home"), |r| (r.title, r.text, r.tab));
    json!({
        "title": if title.is_empty() { "NutrIA".to_string() } else { format!("NutrIA · {title}") },
        "text": text.filter(|t| !t.is_empty()).unwrap_or(default_text),
        "tab": tab,
        "tag": kind.filter(|k| !k.is_empty()).unwrap_or("board"),
    })
}

pub fn push_reason() -> Value {
    let last = read_json(&LAST_FILE, json!({}));
    let mut found: Vec<(String, Value)> = last
        .as_object()
        .into_iter()
        .flatten()
        .map(|(t, v)| (t.clone(), entry_of(Some(v))))
        .filter(|(t, v)| reason(t).is_some() && truthy(v.get("at")) && elapsed_since(&v["at"]).map_or(false, |e| e < 10 * 60000))
        .collect();
    found.sort_by(|a, b| b.1["at"].as_str().unwrap_or("").cmp(a.1["at"].as_str().unwrap_or("")));
    match found.first() {
        Some((kind, entry)) => notification_for(Some(kind), entry.get("text").and_then(|t| t.as_str())),
        None => notification_for(None, None),
    }
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn encrypt(payload: &[u8], keys: &Value) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::KeyInit;
    let ua_public = from_b64url(keys["p256dh"].as_str().unwrap_or(""));
    let auth_secret = from_b64url(keys["auth"].as_str().unwrap_or(""));
    let ua_key = p256::PublicKey::from_sec1_bytes(&ua_public).map_err(|_| "Public key is not valid for specified curve".to_string())?;
    let ephemeral = random_secret();
    let as_public = ephemeral.public_key().to_sec1_bytes().to_vec();
    let shared = ephemeral.diffie_hellman(&ua_key);
    let shared = shared.raw_secret_bytes().to_vec();
    let salt: [u8; 16] = rand::random();
    let info = [b"WebPush: info".as_slice(), &[0], &ua_public, &as_public, &[1]].concat();
    let ikm = hmac(&hmac(&auth_secret, &shared), &info);
    let prk = hmac(&salt, &ikm);
    let cek = hmac(&prk, &[b"Content-Encoding: aes128gcm".as_slice(), &[0, 1]].concat())[..16].to_vec();
    let nonce = hmac(&prk, &[b"Content-Encoding: nonce".as_slice(), &[0, 1]].concat())[..12].to_vec();
    let cipher = aes_gcm::Aes128Gcm::new_from_slice(&cek).map_err(|e| e.to_string())?;
    let plain = [payload, &[2]].concat();
    let nonce = aes_gcm::Nonce::try_from(nonce.as_slice()).map_err(|_| "nonce".to_string())?;
    let body = cipher.encrypt(&nonce, plain.as_slice()).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(21 + as_public.len() + body.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(as_public.len() as u8);
    out.extend_from_slice(&as_public);
    out.extend_from_slice(&body);
    Ok(out)
}

struct Url {
    origin: String,
    host: String,
}

fn parse_url(text: &str) -> Option<Url> {
    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    if authority.is_empty() {
        return None;
    }
    let default_port = match scheme.as_str() {
        "https" | "wss" => Some("443"),
        "http" | "ws" => Some("80"),
        _ => None,
    };
    let split = if authority.starts_with('[') { authority.rfind("]:").map(|i| (&authority[..i + 1], &authority[i + 2..])) } else { authority.rsplit_once(':') };
    let host = match split {
        Some((h, p)) if p.is_empty() || Some(p) == default_port => h.to_string(),
        _ => authority.clone(),
    };
    Some(Url { origin: format!("{scheme}://{host}"), host })
}

fn url_host(endpoint: Option<&Value>) -> Option<String> {
    parse_url(endpoint?.as_str()?).map(|u| u.host)
}

pub type Poster<'a> = &'a dyn Fn(&str, &[(String, String)], &[u8]) -> Result<u16, String>;

fn post_with_ureq(url: &str, headers: &[(String, String)], body: &[u8]) -> Result<u16, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(std::time::Duration::from_secs(300))).build().into();
    let mut req = agent.post(url);
    for (k, v) in headers {
        if !k.eq_ignore_ascii_case("content-length") {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    req.send(body).map(|r| r.status().as_u16()).map_err(|e| e.to_string())
}

pub fn send_push(kind: &str, force: bool, text: Option<&str>) -> usize {
    send_push_with(kind, force, text, &post_with_ureq)
}

pub fn send_push_with(kind: &str, force: bool, text: Option<&str>, post: Poster) -> usize {
    let text = text.filter(|t| !t.is_empty());
    let subs = subscriptions();
    if subs.is_empty() || (kind != "test" && crate::core::hours::resting(None)) {
        return 0;
    }
    let mut last = read_json(&LAST_FILE, json!({}));
    if !last.is_object() {
        last = json!({});
    }
    let prev = entry_of(last.get(kind));
    let prev_elapsed = elapsed_since(prev.get("at").unwrap_or(&Value::Null));
    if !force && prev_elapsed.map_or(false, |e| e < 60000) {
        return 0;
    }
    if let Some(t) = text {
        if prev.get("text").and_then(|p| p.as_str()) == Some(t) && prev_elapsed.map_or(false, |e| e < 120000) {
            return 0;
        }
    }
    if kind == "test" {
        last = json!({});
    }
    last.as_object_mut().unwrap().insert(kind.to_string(), json!({ "at": now(), "text": text }));
    write_compact(&LAST_FILE, &last);
    let keys = push_keys();
    let mut dead: Vec<String> = Vec::new();
    let mut sent = 0;
    for s in &subs {
        if s.get("muted").and_then(|m| m.as_array()).map_or(false, |m| m.iter().any(|x| x.as_str() == Some(kind))) {
            continue;
        }
        let attempt = || -> Result<Option<u16>, String> {
            let endpoint = s.get("endpoint").and_then(|e| e.as_str()).ok_or("Invalid URL")?;
            let aud = parse_url(endpoint).ok_or("Invalid URL")?.origin;
            let header = b64url(stringify(&json!({ "typ": "JWT", "alg": "ES256" })).as_bytes());
            let body = b64url(stringify(&json!({ "aud": aud, "exp": now_ms() / 1000 + 12 * 3600, "sub": "mailto:tablero@example.com" })).as_bytes());
            let signature = sign(&format!("{header}.{body}"), keys["privateKey"].as_str().unwrap_or(""))?;
            let mut headers: Vec<(String, String)> = vec![
                ("TTL".to_string(), "3600".to_string()),
                ("Urgency".to_string(), "high".to_string()),
                ("Authorization".to_string(), format!("vapid t={header}.{body}.{signature}, k={}", keys["publicKey"].as_str().unwrap_or(""))),
            ];
            let sub_keys = s.get("keys").filter(|k| truthy(k.get("p256dh")) && truthy(k.get("auth")));
            let payload = match sub_keys {
                Some(k) => {
                    let p = encrypt(stringify(&notification_for(Some(kind), text)).as_bytes(), k)?;
                    headers.push(("Content-Encoding".to_string(), "aes128gcm".to_string()));
                    headers.push(("Content-Type".to_string(), "application/octet-stream".to_string()));
                    headers.push(("Content-Length".to_string(), p.len().to_string()));
                    p
                }
                None => {
                    headers.push(("Content-Length".to_string(), "0".to_string()));
                    Vec::new()
                }
            };
            Ok(Some(post(endpoint, &headers, &payload)?))
        };
        match attempt() {
            Ok(Some(404)) | Ok(Some(410)) => dead.push(s["endpoint"].as_str().unwrap_or("").to_string()),
            Ok(Some(code)) if (200..300).contains(&code) => sent += 1,
            _ => {}
        }
    }
    if !dead.is_empty() {
        let kept: Vec<Value> = subscriptions().into_iter().filter(|s| !dead.iter().any(|d| s.get("endpoint").and_then(|e| e.as_str()) == Some(d.as_str()))).collect();
        save_subscriptions(&kept);
    }
    sent
}

fn sign(message: &str, pem: &str) -> Result<String, String> {
    use p256::ecdsa::signature::Signer;
    use p256::pkcs8::DecodePrivateKey;
    let secret = p256::SecretKey::from_pkcs8_pem(pem).map_err(|e| e.to_string())?;
    let key = p256::ecdsa::SigningKey::from(&secret);
    let signature: p256::ecdsa::Signature = key.sign(message.as_bytes());
    Ok(b64url(&signature.to_bytes()))
}

fn js_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(x) if truthy(Some(x)) => match x {
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Array(_) => x.as_array().unwrap().iter().map(|i| js_string(Some(i))).collect::<Vec<_>>().join(","),
            _ => "[object Object]".to_string(),
        },
        _ => String::new(),
    }
}

fn same_device(x: &Value, device: &str, host: &Option<String>) -> bool {
    !device.is_empty() && x.get("device").and_then(|d| d.as_str()) == Some(device) && url_host(x.get("endpoint")) == *host
}

pub fn handle_push(route: &str, input: &Value) -> Res {
    if route == "/api/push/subscribe" {
        let s = input.get("subscription").filter(|s| truthy(Some(s)));
        let endpoint = s.and_then(|s| s.get("endpoint")).and_then(|e| e.as_str()).filter(|e| e.starts_with("https://"));
        let (Some(s), Some(endpoint)) = (s, endpoint) else { return send(400, &json!({ "error": "suscripción no válida" })) };
        let device = String::from_utf16_lossy(&js_string(input.get("device")).encode_utf16().take(80).collect::<Vec<u16>>());
        let host = parse_url(endpoint).map(|u| u.host);
        let all = subscriptions();
        let mut subs: Vec<Value> = all.iter().filter(|x| x.get("endpoint").and_then(|e| e.as_str()) != Some(endpoint) && !same_device(x, &device, &host)).cloned().collect();
        let keys = match s.get("keys") {
            Some(k) if k.get("p256dh").map_or(false, |v| v.is_string()) && k.get("auth").map_or(false, |v| v.is_string()) => json!({ "p256dh": k["p256dh"], "auth": k["auth"] }),
            _ => Value::Null,
        };
        let prev = all.iter().find(|x| x.get("endpoint").and_then(|e| e.as_str()) == Some(endpoint)).or_else(|| all.iter().find(|x| same_device(x, &device, &host)));
        let muted = prev.and_then(|p| p.get("muted")).filter(|m| truthy(Some(m))).cloned().unwrap_or(json!([]));
        let mut entry = Map::new();
        entry.insert("endpoint".to_string(), json!(endpoint));
        entry.insert("keys".to_string(), keys);
        entry.insert("device".to_string(), json!(device));
        entry.insert("at".to_string(), json!(now()));
        if muted.as_array().map_or(false, |m| !m.is_empty()) {
            entry.insert("muted".to_string(), muted.clone());
        }
        subs.push(Value::Object(entry));
        save_subscriptions(&subs);
        return send(200, &json!({ "ok": true, "muted": muted }));
    }
    if route == "/api/push/prefs" {
        let endpoint = input.get("endpoint").cloned().unwrap_or(Value::Null);
        let mut subs = subscriptions();
        let Some(i) = subs.iter().position(|x| x.get("endpoint").cloned().unwrap_or(Value::Null) == endpoint) else {
            return send(404, &json!({ "error": "este dispositivo no tiene avisos" }));
        };
        if let Some(list) = input.get("muted").and_then(|m| m.as_array()) {
            let mut muted: Vec<String> = Vec::new();
            for x in list {
                if let Some(k) = x.as_str() {
                    if reason(k).is_some() && k != "test" && !muted.iter().any(|m| m == k) {
                        muted.push(k.to_string());
                    }
                }
            }
            let s = subs[i].as_object_mut().unwrap();
            if muted.is_empty() {
                s.remove("muted");
            } else {
                s.insert("muted".to_string(), json!(muted));
            }
            save_subscriptions(&subs);
        }
        let muted = subs[i].get("muted").filter(|m| truthy(Some(m))).cloned().unwrap_or(json!([]));
        return send(200, &json!({ "muted": muted }));
    }
    if route == "/api/push/unsubscribe" {
        let endpoint = input.get("endpoint").cloned().unwrap_or(Value::Null);
        let kept: Vec<Value> = subscriptions().into_iter().filter(|x| x.get("endpoint").cloned().unwrap_or(Value::Null) != endpoint).collect();
        save_subscriptions(&kept);
        return send(200, &json!({ "ok": true }));
    }
    let n = send_push("test", true, None);
    send(200, &json!({ "sent": n }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn sub(endpoint: &str, device: &str) -> Value {
        json!({ "subscription": { "endpoint": endpoint, "keys": { "p256dh": "x", "auth": "y" } }, "device": device })
    }

    #[test]
    fn each_device_keeps_what_it_does_not_want_to_be_told_about() {
        let _g = crate::testkit::fresh();
        handle_push("/api/push/subscribe", &sub("https://push.example/phone", "phone"));
        assert_eq!(handle_push("/api/push/prefs", &json!({ "endpoint": "https://push.example/nobody", "muted": [] })).code, 404);
        let set = handle_push("/api/push/prefs", &json!({ "endpoint": "https://push.example/phone", "muted": ["deploys", "nope", "test", "deploys"] }));
        assert_eq!(set.json().unwrap()["muted"], json!(["deploys"]));
        let again = handle_push("/api/push/subscribe", &sub("https://push.example/phone", "phone"));
        assert_eq!(again.json().unwrap()["muted"], json!(["deploys"]));
        let renewed = handle_push("/api/push/subscribe", &sub("https://push.example/phone-2", "phone"));
        assert_eq!(renewed.json().unwrap()["muted"], json!(["deploys"]));
        let endpoints: Vec<Value> = subscriptions().iter().map(|s| s["endpoint"].clone()).collect();
        assert_eq!(endpoints, vec![json!("https://push.example/phone-2")]);
        let cleared = handle_push("/api/push/prefs", &json!({ "endpoint": "https://push.example/phone-2", "muted": [] }));
        assert_eq!(cleared.json().unwrap()["muted"], json!([]));
        assert_eq!(subscriptions()[0].get("muted"), None);
    }

    #[test]
    fn a_muted_reason_is_not_sent_to_that_device() {
        let _g = crate::testkit::fresh();
        handle_push("/api/push/subscribe", &json!({ "subscription": { "endpoint": "https://push.example/mac" }, "device": "mac" }));
        handle_push("/api/push/prefs", &json!({ "endpoint": "https://push.example/mac", "muted": ["tasks"] }));
        let hits = RefCell::new(Vec::<String>::new());
        let post = |url: &str, _: &[(String, String)], _: &[u8]| {
            hits.borrow_mut().push(url.to_string());
            Ok(201)
        };
        send_push_with("tasks", true, None, &post);
        assert!(!hits.borrow().contains(&"https://push.example/mac".to_string()));
        hits.borrow_mut().clear();
        send_push_with("deploys", true, None, &post);
        assert_eq!(hits.borrow().contains(&"https://push.example/mac".to_string()), !crate::core::hours::resting(None));
    }

    #[test]
    fn a_push_is_signed_and_encrypted_for_the_device() {
        let _g = crate::testkit::fresh();
        let device = random_secret();
        let p256dh = b64url(&device.public_key().to_sec1_bytes());
        handle_push("/api/push/subscribe", &json!({ "subscription": { "endpoint": "https://push.example:8443/x", "keys": { "p256dh": p256dh, "auth": b64url(&[9u8; 16]) } }, "device": "phone" }));
        let seen = RefCell::new(Vec::<(String, Vec<(String, String)>, Vec<u8>)>::new());
        let post = |url: &str, h: &[(String, String)], b: &[u8]| {
            seen.borrow_mut().push((url.to_string(), h.to_vec(), b.to_vec()));
            Ok(201)
        };
        assert_eq!(send_push_with("test", true, Some("hola"), &post), 1);
        let (url, headers, body) = seen.borrow()[0].clone();
        assert_eq!(url, "https://push.example:8443/x");
        let auth = headers.iter().find(|(k, _)| k == "Authorization").unwrap().1.clone();
        let token = auth.strip_prefix("vapid t=").unwrap().split(", k=").next().unwrap().to_string();
        let claims = crate::core::json::parse(&String::from_utf8(from_b64url(token.split('.').nth(1).unwrap())).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://push.example:8443");
        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        assert_eq!(body[20], 65);
        assert_eq!(body.len(), 21 + 65 + stringify(&notification_for(Some("test"), Some("hola"))).len() + 1 + 16);
    }

    #[test]
    fn the_reason_of_a_push_is_the_latest_recent_one() {
        let _g = crate::testkit::fresh();
        write_compact(&LAST_FILE, &json!({ "tasks": crate::core::time::iso(now_ms() - 60000), "deploys": { "at": now(), "text": "Subido" }, "nope": now() }));
        assert_eq!(stringify(&push_reason()), r#"{"title":"NutrIA · Despliegues","text":"Subido","tab":"deploy","tag":"deploys"}"#);
        write_compact(&LAST_FILE, &json!({}));
        assert_eq!(stringify(&push_reason()), r#"{"title":"NutrIA","text":"Hay novedades","tab":"home","tag":"board"}"#);
    }
}
