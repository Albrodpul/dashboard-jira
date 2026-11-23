use crate::core::json::{parse, stringify, stringify_pretty, truthy};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub const SCHEMA: i64 = 2;

pub const TASK_STATUS: &[(&str, &str)] = &[("pendiente", "pending"), ("aprobada", "approved"), ("enviada", "sent"), ("duda", "waiting"), ("a-medias", "partial"), ("hecha", "done"), ("ignorada", "ignored")];
pub const TASK_KIND: &[(&str, &str)] = &[("nueva", "new"), ("devuelta", "returned"), ("comentario", "comment"), ("reenvio", "resend")];
pub const APPROVED_VIA: &[(&str, &str)] = &[("tablero", "board"), ("chat", "chat"), ("regla", "rule"), ("manual", "manual")];
pub const NOTICE_TYPE: &[(&str, &str)] = &[("hecha", "done"), ("a-medias", "partial"), ("pregunta", "question"), ("comentario", "comment"), ("respuesta", "answer")];
pub const DEPLOY_ENV: &[(&str, &str)] = &[("develop", "develop"), ("produccion", "production"), ("ambos", "both")];
const DEPLOY_STATUS: &[(&str, &str)] = &[("aprobada", "approved"), ("enviada", "sent"), ("cancelada", "cancelled")];
const ERROR_STATE: &[(&str, &str)] = &[("propuesto", "proposed"), ("aprobado", "approved"), ("enviado", "sent"), ("descartado", "discarded")];
const TIDY_STATUS: &[(&str, &str)] = &[("aprobada", "approved"), ("en-curso", "in-progress"), ("hecha", "done")];
const MESSAGE_TO: &[(&str, &str)] = &[("reporte", "reporter"), ("orquestador", "orchestrator")];
pub const CAUSE: &[(&str, &str)] = &[("escrita", "written"), ("nueva", "new")];
const PERSON_ENV: &[(&str, &str)] = &[("beta", "beta"), ("produccion", "production")];

fn tr(map: &[(&str, &str)], v: Option<Value>) -> Option<Value> {
    if let Some(Value::String(s)) = &v {
        if let Some((_, to)) = map.iter().find(|(from, _)| from == s) {
            return Some(Value::String(to.to_string()));
        }
    }
    v
}

fn tr_field(o: &mut Value, key: &str, map: &[(&str, &str)]) {
    if let Some(obj) = o.as_object_mut() {
        if let Some(v) = obj.get(key).cloned() {
            if let Some(t) = tr(map, Some(v)) {
                obj.insert(key.to_string(), t);
            }
        }
    }
}

fn rename(o: &Value, keys: &[(&str, &str)]) -> Value {
    let Some(obj) = o.as_object() else { return o.clone() };
    let mut out = Map::new();
    for (k, v) in obj {
        let name = keys.iter().find(|(from, _)| from == k).map(|(_, to)| to.to_string()).unwrap_or_else(|| k.clone());
        out.insert(name, v.clone());
    }
    Value::Object(out)
}

fn clean(entries: Vec<(&str, Option<Value>)>) -> Value {
    let mut out = Map::new();
    for (k, v) in entries {
        if let Some(v) = v {
            out.insert(k.to_string(), v);
        }
    }
    Value::Object(out)
}

fn get(o: &Value, key: &str) -> Option<Value> {
    o.get(key).cloned()
}

fn or(a: Option<Value>, b: Option<Value>) -> Option<Value> {
    if truthy(a.as_ref()) { a } else { b }
}

fn coalesce(a: Option<Value>, b: Option<Value>) -> Option<Value> {
    match a {
        Some(v) if !v.is_null() => Some(v),
        _ => b,
    }
}

fn list(v: Option<Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    }
}

fn truthy_field(o: &Value, key: &str) -> Option<Value> {
    o.get(key).filter(|v| truthy(Some(v))).cloned()
}

fn notice_entry(h: &Value) -> Value {
    clean(vec![("type", tr(NOTICE_TYPE, or(get(h, "tipo"), get(h, "type")))), ("text", get(h, "text")), ("at", get(h, "at"))])
}

fn task(t: &Value) -> Value {
    let mut x = rename(
        t,
        &[
            ("replyAnterior", "previousReply"),
            ("vueltas", "rounds"),
            ("eventos", "events"),
            ("cambios", "changes"),
            ("adjuntos", "attachments"),
            ("aviso", "notice"),
            ("historial", "history"),
            ("respuesta", "answer"),
            ("retirada", "withdrawn"),
            ("jiraListo", "jiraClosedAt"),
            ("revisada", "reviewedAt"),
            ("comentarioPublicado", "publishedComment"),
        ],
    );
    tr_field(&mut x, "status", TASK_STATUS);
    tr_field(&mut x, "kind", TASK_KIND);
    tr_field(&mut x, "approvedVia", APPROVED_VIA);
    let notice = truthy_field(&x, "notice");
    let history = truthy_field(&x, "history");
    let answer = truthy_field(&x, "answer");
    let withdrawn = truthy_field(&x, "withdrawn");
    let comment = truthy_field(&x, "publishedComment");
    let Some(obj) = x.as_object_mut() else { return x };
    if let Some(n) = notice {
        obj.insert("notice".into(), notice_entry(&n));
    }
    if let Some(h) = history {
        obj.insert("history".into(), Value::Array(h.as_array().map(|a| a.iter().map(notice_entry).collect()).unwrap_or_default()));
    }
    if let Some(a) = answer {
        obj.insert(
            "answer".into(),
            clean(vec![("text", get(&a, "text")), ("at", get(&a, "at")), ("delivered", coalesce(get(&a, "entregada"), get(&a, "delivered"))), ("deliveredAt", coalesce(get(&a, "entregadaAt"), get(&a, "deliveredAt")))]),
        );
    }
    if let Some(w) = withdrawn {
        obj.insert("withdrawn".into(), clean(vec![("by", coalesce(get(&w, "por"), get(&w, "by"))), ("at", get(&w, "at"))]));
    }
    if let Some(c) = comment {
        obj.insert("publishedComment".into(), clean(vec![("at", get(&c, "at")), ("text", coalesce(get(&c, "texto"), get(&c, "text")))]));
    }
    x
}

fn renamed_list(v: Option<Value>, keys: &[(&str, &str)], fix: impl Fn(&mut Value)) -> Option<Value> {
    Some(Value::Array(
        list(v)
            .iter()
            .map(|x| {
                let mut y = rename(x, keys);
                fix(&mut y);
                y
            })
            .collect(),
    ))
}

pub fn migrate_document(d: &mut Map<String, Value>) {
    if d.get("schema").and_then(Value::as_f64) == Some(SCHEMA as f64) {
        return;
    }
    let src = Value::Object(d.clone());
    let g = |k: &str| get(&src, k);
    let mut n: Vec<(&str, Option<Value>)> = Vec::new();
    n.push(("schema", Some(json!(SCHEMA))));
    let mut tasks = Map::new();
    if let Some(Value::Object(m)) = or(g("tasks"), None) {
        for (k, t) in m {
            tasks.insert(k, task(&t));
        }
    }
    n.push(("tasks", Some(Value::Object(tasks))));
    n.push(("aliases", or(g("aliases"), Some(json!({})))));
    n.push(("refs", or(g("refs"), Some(json!({})))));
    let sessions = truthy_field(&src, "sessions").map(|s| {
        let items: Vec<Value> = list(or(get(&s, "list"), None)).iter().map(|x| rename(x, &[("conversacion", "conversation"), ("statusDesde", "statusSince"), ("titulo", "title")])).collect();
        json!({ "list": items, "syncedAt": or(get(&s, "syncedAt"), Some(Value::Null)) })
    });
    n.push(("sessions", sessions));
    n.push(("seenEpics", or(g("epicsVistas"), g("seenEpics"))));
    n.push(("reports", renamed_list(or(or(g("informes"), g("reports")), None), &[("peticion", "request")], |_| {})));
    n.push(("refreshRequest", truthy_field(&src, "peticion").map(|p| rename(&p, &[("atendida", "handled")])).or_else(|| or(g("refreshRequest"), Some(Value::Null)))));
    n.push(("jiraEpics", or(g("epicsJira"), g("jiraEpics"))));
    n.push(("jiraEpicsAt", or(g("epicsJiraAt"), g("jiraEpicsAt"))));
    n.push((
        "deployments",
        renamed_list(or(or(g("despliegues"), g("deployments")), None), &[("proyectos", "projects"), ("entorno", "environment"), ("canceladaAt", "cancelledAt")], |y| {
            tr_field(y, "environment", DEPLOY_ENV);
            tr_field(y, "status", DEPLOY_STATUS);
            tr_field(y, "approvedVia", APPROVED_VIA);
        }),
    ));
    n.push((
        "followUps",
        renamed_list(or(g("followUps"), None), &[("persona", "person"), ("errores", "errors")], |y| {
            if let Some(errors) = truthy_field(y, "errors") {
                let items = renamed_list(Some(errors), &[("texto", "text"), ("estado", "state"), ("resumen", "wholeSummary"), ("resumenAt", "summaryAt")], |z| {
                    tr_field(z, "state", ERROR_STATE);
                    tr_field(z, "approvedVia", APPROVED_VIA);
                });
                y["errors"] = items.unwrap_or(Value::Null);
            }
        }),
    ));
    n.push(("followUpRequest", or(g("followUpRequest"), Some(Value::Null))));
    n.push((
        "messages",
        renamed_list(
            or(or(g("mensajes"), g("messages")), None),
            &[("para", "to"), ("texto", "text"), ("leido", "readAt"), ("respuesta", "reply"), ("respuestas", "replies"), ("despertada", "wokenUp")],
            |y| {
                tr_field(y, "to", MESSAGE_TO);
                if let Some(replies) = truthy_field(y, "replies") {
                    y["replies"] = renamed_list(Some(replies), &[("texto", "text")], |_| {}).unwrap_or(Value::Null);
                }
            },
        ),
    ));
    n.push(("lastReview", truthy_field(&src, "ultimaRevision").map(|x| rename(&x, &[("vacio", "empty"), ("peticion", "request")])).or_else(|| g("lastReview"))));
    n.push(("config", truthy_field(&src, "config").map(|x| rename(&x, &[("autoDevueltas", "autoReturned"), ("pausa", "paused"), ("pausaDesde", "pausedAt")]))));
    n.push(("deleted", or(g("borradas"), g("deleted"))));
    if let Some(tidy) = or(truthy_field(&src, "ordenar"), truthy_field(&src, "contextTidy")) {
        let mut y = rename(&tidy, &[("empezada", "startedAt"), ("terminada", "finishedAt"), ("resumen", "summary")]);
        tr_field(&mut y, "status", TIDY_STATUS);
        tr_field(&mut y, "approvedVia", APPROVED_VIA);
        n.push(("contextTidy", Some(y)));
    }
    n.push((
        "causes",
        renamed_list(or(or(g("causas"), g("causes")), None), &[("clave", "key"), ("causa", "cause"), ("nota", "note")], |y| tr_field(y, "cause", CAUSE)),
    ));
    let seguimiento = truthy_field(&src, "seguimiento");
    let follow_up = truthy_field(&src, "followUp");
    if seguimiento.is_some() || follow_up.is_some() {
        let people = match &seguimiento {
            Some(s) => get(s, "personas"),
            None => follow_up.as_ref().and_then(|f| get(f, "people")),
        };
        let items = renamed_list(or(people, None), &[("nombre", "name"), ("entorno", "environment"), ("cadaHora", "hourly"), ("cuentas", "accounts"), ("cuentasAt", "accountsAt")], |y| {
            tr_field(y, "environment", PERSON_ENV)
        });
        n.push(("followUp", Some(json!({ "people": items }))));
    }
    n.push(("learningRead", truthy_field(&src, "aprendizajeLeido").map(|x| rename(&x, &[("fallos", "failures")])).or_else(|| g("learningRead"))));
    d.clear();
    if let Value::Object(m) = clean(n) {
        d.extend(m);
    }
}

pub fn migrate_routes(r: &Value) -> Value {
    let role = |x: Option<Value>| or(x, None).map(|x| rename(&x, &[("sesion", "session"), ("desde", "since"), ("conversacion", "conversation"), ("titulo", "title")]));
    let mut areas = Map::new();
    if let Some(m) = r.get("areas").and_then(Value::as_object) {
        for (id, a) in m {
            areas.insert(id.clone(), rename(a, &[("titulo", "title"), ("epicas", "epics"), ("sesion", "session"), ("desde", "since"), ("conversacion", "conversation")]));
        }
    }
    clean(vec![
        ("reporter", role(or(get(r, "reporte"), get(r, "reporter")))),
        ("orchestrator", role(or(get(r, "orquestador"), get(r, "orchestrator")))),
        ("followUp", role(get(r, "followUp"))),
        ("deployer", or(get(r, "despliegue"), get(r, "deployer"))),
        ("areas", Some(Value::Object(areas))),
    ])
}

const LEGACY_FILES: &[(&str, &str)] = &[
    ("tablero.db", "board.db"),
    ("tablero.db-wal", "board.db-wal"),
    ("tablero.db-shm", "board.db-shm"),
    ("jira-vistos.json", "jira-seen.json"),
    ("jira-por-contar.json", "jira-to-count.json"),
    ("push-ultimo", "push-last.json"),
    ("arranque.log", "startup.log"),
    ("tablero-hosts.txt", "board-hosts.txt"),
    ("cuota.json", "quota.json"),
    ("tablero-data.json.migrado", "legacy-board-data.json"),
];

pub fn migrate_data_dir(workspace: &Path) -> PathBuf {
    let data_dir = workspace.join("data");
    let legacy_dir = workspace.join("datos");
    if !data_dir.exists() && legacy_dir.exists() {
        let _ = std::fs::rename(&legacy_dir, &data_dir);
    }
    if !data_dir.exists() {
        let _ = std::fs::create_dir_all(&data_dir);
    }
    for (from, to) in LEGACY_FILES {
        let a = data_dir.join(from);
        let b = data_dir.join(to);
        if a.exists() && !b.exists() {
            let _ = std::fs::rename(&a, &b);
        }
    }
    for stale in ["latido-orquestador", "latido-reporte", "arranque.lock"] {
        let _ = std::fs::remove_file(data_dir.join(stale));
    }
    let old_routes = data_dir.join("sesiones.json");
    let new_routes = data_dir.join("sessions.json");
    if old_routes.exists() && !new_routes.exists() {
        if let Some(parsed) = std::fs::read_to_string(&old_routes).ok().and_then(|t| parse(&t)) {
            let _ = std::fs::write(&new_routes, stringify_pretty(&migrate_routes(&parsed), 2) + "\n");
            let _ = std::fs::rename(&old_routes, data_dir.join("sesiones.json.migrated"));
        }
    }
    data_dir
}

pub fn migrate_learning_table(conn: &rusqlite::Connection) {
    let old: Option<String> = conn.query_row("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'aprendizaje_tickets'", [], |r| r.get(0)).ok();
    if old.is_none() {
        return;
    }
    let _ = conn.execute_batch("CREATE TABLE IF NOT EXISTS learning_tickets (key TEXT PRIMARY KEY, epic TEXT, epic_name TEXT, events TEXT NOT NULL)");
    let rows: Vec<(Option<String>, Option<String>, Option<String>, String)> = match conn.prepare("SELECT clave, epic, epic_nombre, eventos FROM aprendizaje_tickets") {
        Ok(mut stmt) => stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for (key, epic, epic_name, events) in rows {
        let e = parse(&events).unwrap_or(Value::Null);
        let pick = |k: &str| truthy_field(&e, k).unwrap_or(json!([]));
        let migrated = json!({ "deliveries": pick("entregas"), "returns": pick("devoluciones"), "reviewerComments": [] });
        let _ = conn.execute("INSERT OR REPLACE INTO learning_tickets VALUES (?, ?, ?, ?)", rusqlite::params![key, epic, epic_name, stringify(&migrated)]);
    }
    let _ = conn.execute_batch("DROP TABLE aprendizaje_tickets");
    let _ = conn.execute_batch("DROP TABLE IF EXISTS consumo");
    let _ = conn.execute_batch("DROP TABLE IF EXISTS consumo_ficheros");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_a_spanish_document_to_the_english_schema_once() {
        let mut d: Map<String, Value> = serde_json::from_value(json!({
            "tasks": { "ABC-1": { "key": "ABC-1", "status": "enviada", "kind": "nueva", "aviso": { "tipo": "hecha", "text": "ok", "at": "x" }, "respuesta": { "text": "r", "entregada": true } } },
            "informes": [{ "peticion": 1 }],
            "mensajes": [{ "para": "reporte", "texto": "hola" }],
            "causas": [{ "clave": "ABC-1", "causa": "escrita" }]
        }))
        .unwrap();
        migrate_document(&mut d);
        let first = stringify(&Value::Object(d.clone()));
        assert_eq!(
            first,
            r#"{"schema":2,"tasks":{"ABC-1":{"key":"ABC-1","status":"sent","kind":"new","notice":{"type":"done","text":"ok","at":"x"},"answer":{"text":"r","delivered":true}}},"aliases":{},"refs":{},"reports":[{"request":1}],"refreshRequest":null,"deployments":[],"followUps":[],"followUpRequest":null,"messages":[{"to":"reporter","text":"hola"}],"causes":[{"key":"ABC-1","cause":"written"}]}"#
        );
        migrate_document(&mut d);
        assert_eq!(stringify(&Value::Object(d)), first);
    }

    #[test]
    fn migrates_the_old_routes_file() {
        let r = json!({ "reporte": { "sesion": "R", "conversacion": "c" }, "areas": { "pagos": { "titulo": "Pagos", "epicas": {} } } });
        assert_eq!(stringify(&migrate_routes(&r)), r#"{"reporter":{"session":"R","conversation":"c"},"areas":{"pagos":{"title":"Pagos","epics":{}}}}"#);
    }
}
