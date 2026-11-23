//! Port of src/server/http.js.
use crate::core::data::{DATA_DIR, PORT};
use crate::core::json::{parse, stringify, truthy};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::LazyLock;

static HOSTS_FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("board-hosts.txt"));

#[derive(Clone, Debug, Default)]
pub struct Req {
    pub method: String,
    pub url: String,
    pub raw_url: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Req {
    pub fn new(method: &str, raw_url: &str) -> Req {
        let (path, search) = raw_url.split_once('?').unwrap_or((raw_url, ""));
        Req { method: method.to_string(), url: path.to_string(), raw_url: raw_url.to_string(), query: parse_query(search), headers: HashMap::new(), body: Vec::new() }
    }

    pub fn post_json(raw_url: &str, input: &Value) -> Req {
        Req::new("POST", raw_url).with_header("content-type", "application/json").with_body(stringify(input).into_bytes())
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Req {
        self.headers.insert(name.to_ascii_lowercase(), value.to_string());
        self
    }

    pub fn with_body(mut self, body: Vec<u8>) -> Req {
        self.body = body;
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(|s| s.as_str())
    }

    pub fn query(&self, name: &str) -> Option<&str> {
        self.query.get(name).map(|s| s.as_str())
    }

    pub fn content_type(&self) -> &str {
        self.header("content-type").unwrap_or("")
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Option<Value> {
        parse(std::str::from_utf8(&self.body).ok()?)
    }

    pub fn head_of(request: &tiny_http::Request) -> Req {
        let mut req = Req::new(&request.method().to_string(), request.url());
        for h in request.headers() {
            let name = h.field.as_str().as_str().to_ascii_lowercase();
            let value = h.value.as_str().to_string();
            req.headers.entry(name).and_modify(|v| *v = format!("{v}, {value}")).or_insert(value);
        }
        req
    }
}

#[derive(Clone, Debug)]
pub struct Res {
    pub code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Res {
    pub fn empty(code: u16) -> Res {
        Res { code, headers: Vec::new(), body: Vec::new() }
    }

    pub fn text(code: u16, text: &str) -> Res {
        Res { code, headers: Vec::new(), body: text.as_bytes().to_vec() }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Res {
        self.set_header(name, value);
        self
    }

    pub fn set_header(&mut self, name: &str, value: &str) {
        self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        self.headers.push((name.to_string(), value.to_string()));
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Option<Value> {
        parse(std::str::from_utf8(&self.body).ok()?)
    }

    pub fn into_tiny(self) -> tiny_http::Response<Cursor<Vec<u8>>> {
        let mut out = tiny_http::Response::from_data(self.body).with_status_code(self.code);
        for (k, v) in &self.headers {
            if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                out.add_header(h);
            }
        }
        out
    }
}

pub type PostHandler = fn(input: &Value) -> Res;
pub type GetHandler = fn(req: &Req) -> Option<Res>;

fn extra_hosts() -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(&*HOSTS_FILE) else { return Vec::new() };
    text.split('\n')
        .map(|x| {
            let x = x.trim().to_lowercase();
            let after = x.rsplit("://").next().unwrap_or("");
            after.split('/').next().unwrap_or("").to_string()
        })
        .filter(|x| !x.is_empty() && !x.starts_with('#'))
        .collect()
}

pub fn host_ok(h: &str) -> bool {
    h == format!("127.0.0.1:{}", *PORT) || h == format!("localhost:{}", *PORT) || extra_hosts().contains(&h.to_lowercase())
}

pub fn origin_ok(req: &Req) -> bool {
    match req.header("origin") {
        None | Some("") => true,
        Some(origin) => {
            let bare = origin.strip_prefix("https://").or_else(|| origin.strip_prefix("http://")).unwrap_or(origin);
            host_ok(bare)
        }
    }
}

pub fn send(code: u16, body: &Value) -> Res {
    let text = if truthy(Some(body)) { stringify(body) } else { stringify(&json!({})) };
    Res { code, headers: vec![("content-type".to_string(), "application/json".to_string())], body: text.into_bytes() }
}

pub fn serve_body(content_type: &str, body: impl Into<Vec<u8>>, cache: Option<&str>) -> Res {
    Res {
        code: 200,
        headers: vec![("content-type".to_string(), content_type.to_string()), ("cache-control".to_string(), cache.unwrap_or("no-store").to_string())],
        body: body.into(),
    }
}

pub fn serve_json(v: &Value) -> Res {
    serve_body("application/json", stringify(v), None)
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str, plus_is_space: bool, strict: bool) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let decoded = if i + 2 < bytes.len() {
                match (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                    (Some(h), Some(l)) => Some(h * 16 + l),
                    _ => None,
                }
            } else {
                None
            };
            match decoded {
                Some(v) => {
                    out.push(v);
                    i += 3;
                }
                None if strict => return Err("URI malformed".to_string()),
                None => {
                    out.push(b'%');
                    i += 1;
                }
            }
        } else if b == b'+' && plus_is_space {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }
    match String::from_utf8(out) {
        Ok(s) => Ok(s),
        Err(_) if strict => Err("URI malformed".to_string()),
        Err(e) => Ok(String::from_utf8_lossy(e.as_bytes()).into_owned()),
    }
}

pub fn decode_uri_component(s: &str) -> Result<String, String> {
    percent_decode(s, false, true)
}

pub fn parse_query(search: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in search.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let k = percent_decode(k, true, false).unwrap_or_default();
        let v = percent_decode(v, true, false).unwrap_or_default();
        out.entry(k).or_insert(v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_prints_the_body_as_json_and_falls_back_to_an_empty_object() {
        let r = send(400, &json!({ "error": "petición no válida" }));
        assert_eq!(r.code, 400);
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.body_text(), r#"{"error":"petición no válida"}"#);
        assert_eq!(send(200, &Value::Null).body_text(), "{}");
    }

    #[test]
    fn a_request_splits_its_path_and_query() {
        let r = Req::new("GET", "/api/voice?to=board&x=a%20b+c");
        assert_eq!(r.url, "/api/voice");
        assert_eq!(r.query("to"), Some("board"));
        assert_eq!(r.query("x"), Some("a b c"));
    }

    #[test]
    fn decode_uri_component_rejects_malformed_text() {
        assert_eq!(decode_uri_component("caf%C3%A9.png").unwrap(), "café.png");
        assert!(decode_uri_component("%E0%A4%A").is_err());
        assert!(decode_uri_component("%").is_err());
    }
}
