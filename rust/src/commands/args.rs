//! Port of src/commands/args.js.
use crate::core::json::{stringify, stringify_pretty, truthy};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

pub type Command = fn(&Args) -> Result<i32, String>;

pub const ALIASES: [(&str, &str); 33] = [
    ("informe", "report"),
    ("reporte", "reporter"),
    ("aprobar-chat", "approve-chat"),
    ("envios", "dispatches"),
    ("adjuntos", "attachments"),
    ("hecha", "done"),
    ("a-medias", "partial"),
    ("pregunta", "question"),
    ("comentario", "comment"),
    ("entregada", "delivered"),
    ("enviada", "sent"),
    ("respuesta", "reply"),
    ("cambios", "changes"),
    ("orquestador", "orchestrator"),
    ("despliegues", "deployments"),
    ("despliegue-update", "deployment-update"),
    ("arranque", "startup"),
    ("aviso-prueba", "push-test"),
    ("error-enviado", "error-sent"),
    ("seguimiento", "people"),
    ("persona-cuentas", "person-accounts"),
    ("ordenar-estado", "tidy-status"),
    ("ordenar-empieza", "tidy-start"),
    ("ordenar-fin", "tidy-end"),
    ("mensaje", "message"),
    ("contesta", "answer-message"),
    ("progreso", "progress"),
    ("contados", "counted"),
    ("pendiente", "refresh-request"),
    ("epics-jira", "jira-epics"),
    ("abrir", "open"),
    ("aprendizaje-leer", "learning-read"),
    ("causa", "cause"),
];

pub static ME: LazyLock<String> = LazyLock::new(|| text(crate::core::config::main_project().jira.as_ref().and_then(|j| j.me.get("name"))));

pub static MY_FIRST_NAME: LazyLock<Regex> = LazyLock::new(|| {
    let first = ME.split(char::is_whitespace).next().unwrap_or("");
    Regex::new(&format!("(?i){}", regex::escape(first))).unwrap()
});

pub struct Args {
    pub argv: Vec<String>,
}

impl Args {
    pub fn new(argv: Vec<String>) -> Args {
        Args { argv }
    }

    pub fn from_env() -> Args {
        let mut argv: Vec<String> = std::env::args().collect();
        if argv.is_empty() {
            argv.push("tower".to_string());
        }
        argv.insert(1, "board.js".to_string());
        Args { argv }
    }

    pub fn raw_cmd(&self) -> Option<&str> {
        self.argv.get(2).map(String::as_str)
    }

    pub fn cmd(&self) -> String {
        let raw = self.raw_cmd().unwrap_or("");
        alias(raw).unwrap_or(raw).to_string()
    }

    pub fn a(&self) -> Option<&str> {
        self.argv.get(3).map(String::as_str)
    }

    pub fn b(&self) -> Option<&str> {
        self.argv.get(4).map(String::as_str)
    }

    pub fn a_text(&self) -> String {
        self.a().unwrap_or("undefined").to_string()
    }

    pub fn from(&self, index: usize) -> &[String] {
        self.argv.get(index..).unwrap_or(&[])
    }

    pub fn has(&self, flag: &str) -> bool {
        self.argv.iter().any(|x| x == flag)
    }

    pub fn rest(&self, from: usize) -> String {
        self.from(from).join(" ").trim().to_string()
    }

    pub fn option(&self, names: &[&str]) -> Option<String> {
        for n in names {
            if let Some(i) = self.argv.iter().position(|x| x == n) {
                if i > 0 {
                    return self.argv.get(i + 1).cloned();
                }
            }
        }
        None
    }

    pub fn without_options(&self) -> Vec<String> {
        let mut args: Vec<String> = self.from(3).to_vec();
        for n in ["--person", "--persona", "--environment", "--entorno"] {
            if let Some(i) = args.iter().position(|x| x == n) {
                let end = (i + 2).min(args.len());
                args.drain(i..end);
            }
        }
        args.into_iter().filter(|x| x != "--manual").collect()
    }

    pub fn environment_option(&self) -> Result<String, String> {
        let raw = self.option(&["--environment", "--entorno"]);
        let env = match raw.as_deref() {
            Some("produccion") | Some("producción") | Some("prod") => "production".to_string(),
            Some(r) if !r.is_empty() => r.to_string(),
            _ => "beta".to_string(),
        };
        if !crate::features::follow_up::ENVIRONMENTS.contains(&env.as_str()) {
            return Err(format!("entorno desconocido: {} (beta o production)", raw.unwrap_or_else(|| "null".into())));
        }
        Ok(env)
    }
}

pub fn alias(name: &str) -> Option<&'static str> {
    ALIASES.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

pub fn key_list(text: &str) -> Vec<String> {
    text.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

pub fn json(x: &Value) {
    println!("{}", stringify_pretty(x, 2));
}

pub fn json_of(x: Option<&Value>) {
    match x {
        Some(v) => json(v),
        None => println!("undefined"),
    }
}

pub fn status(s: &str) -> String {
    crate::core::migrate::TASK_STATUS.iter().find(|(k, _)| *k == s).map(|(_, v)| v.to_string()).unwrap_or_else(|| s.to_string())
}

pub fn fail(text: &str) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    eprintln!("{text}");
    std::process::exit(1)
}

pub fn text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(n @ Value::Number(_)) => stringify(n),
        Some(Value::Array(_)) => join(v, ","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

pub fn join(v: Option<&Value>, sep: &str) -> String {
    v.and_then(Value::as_array).map(|a| a.iter().map(|x| if x.is_null() { String::new() } else { text(Some(x)) }).collect::<Vec<_>>().join(sep)).unwrap_or_default()
}

pub fn or(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    if truthy(a) { a.cloned() } else { b.cloned() }
}

pub fn obj(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    }
    Value::Object(m)
}

pub fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn slice_chars(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

pub fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("SyntaxError: {e}"))
}

pub fn concat(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        other => vec![other],
    }
}

pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn list_mut<'a>(d: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !d.get(key).is_some_and(Value::is_array) {
        d.insert(key.to_string(), Value::Array(Vec::new()));
    }
    d.get_mut(key).and_then(Value::as_array_mut).unwrap()
}

pub fn map_mut<'a>(d: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !d.get(key).is_some_and(Value::is_object) {
        d.insert(key.to_string(), Value::Object(Map::new()));
    }
    d.get_mut(key).and_then(Value::as_object_mut).unwrap()
}

pub fn list_of(d: &Map<String, Value>, key: &str) -> Vec<Value> {
    d.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

pub fn assign(target: &mut Value, patch: &Value) {
    if let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            t.insert(k.clone(), v.clone());
        }
    }
}

pub fn is_one_of(v: Option<&Value>, options: &[&str]) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| options.contains(&s))
}

fn ms_of(at: Option<&Value>) -> Option<i64> {
    match at {
        Some(Value::String(s)) => crate::core::time::parse(s),
        Some(Value::Number(n)) => n.as_f64().map(|x| x as i64),
        _ => None,
    }
}

pub fn madrid_format(ms: i64, pattern: &str) -> String {
    use chrono::TimeZone;
    match chrono_tz::Europe::Madrid.timestamp_millis_opt(ms).single() {
        Some(t) => t.format(pattern).to_string(),
        None => "Invalid Date".into(),
    }
}

pub fn madrid_locale_string(at: Option<&Value>) -> String {
    ms_of(at).map_or_else(|| "Invalid Date".into(), |ms| madrid_format(ms, "%-d/%-m/%Y, %-H:%M:%S"))
}

pub fn madrid_hour_minute(at: Option<&Value>) -> String {
    ms_of(at).map_or_else(|| "Invalid Date".into(), |ms| madrid_format(ms, "%H:%M"))
}
