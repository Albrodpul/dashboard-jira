//! Port of src/server/routes/sessions.js.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value, json};

use super::tasks::{clip, error_res, is_true, js_string, obj, ok, text_or_empty};
use crate::core::config::{self, Project, main_project};
use crate::core::data::{mutate, now};
use crate::core::json::truthy;
use crate::core::time::now_ms;
use crate::server::http::{Res, send};
use crate::sessions::registry::{change_routes, create_conversation, live_sessions, load_routes, open_in_vs_code, real_area, rename_area, sessions_cli, title_key};

const CREATING_MS: i64 = 2 * 60000;

static CREATING: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn areas_mut(r: &mut Value) -> &mut Map<String, Value> {
    let r = obj(r);
    if !r.get("areas").is_some_and(Value::is_object) {
        r.insert("areas".into(), json!({}));
    }
    r.get_mut("areas").and_then(Value::as_object_mut).unwrap()
}

fn area_key(r: &Value, name: &str) -> String {
    let wanted = title_key(name);
    let found = r.get("areas").and_then(Value::as_object).and_then(|areas| areas.iter().find(|(_, a)| title_key(&text_or_empty(a.get("title"))) == wanted).map(|(k, _)| k.clone()));
    found.unwrap_or_else(|| if wanted.is_empty() { format!("session-{}", now_ms()) } else { wanted })
}

fn merged(base: Value, layers: &[&Value]) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    for layer in layers {
        if let Some(o) = layer.as_object() {
            for (k, v) in o {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

fn release(r: &mut Value, conversation: Option<&Value>, name: &str) {
    let by_conversation = truthy(conversation);
    for a in areas_mut(r).values_mut() {
        let hit = if by_conversation { a.get("conversation") == conversation } else { a.get("session").and_then(Value::as_str) == Some(name) };
        if hit {
            let a = obj(a);
            for k in ["session", "ref", "since", "conversation"] {
                a.insert(k.into(), Value::Null);
            }
        }
    }
}

pub fn handle_session(input: &Value) -> Res {
    let Some(name) = input.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) else { return error_res(400, "falta la sesión") };
    let area_id = js_string(input.get("areaId"));
    if let Some(keep_open) = input.get("keepOpen") {
        let error = change_routes(|r| {
            let Some(x) = areas_mut(r).get_mut(&area_id) else { return "sesión desconocida".to_string() };
            let x = obj(x);
            if truthy(Some(keep_open)) {
                x.insert("keepOpen".into(), json!(true));
            } else {
                x.shift_remove("keepOpen");
            }
            String::new()
        });
        return if error.is_empty() { ok() } else { error_res(400, &error) };
    }
    if is_true(input, "remove") {
        let error = change_routes(|r| {
            let deployer = r.get("deployer").and_then(Value::as_str).map(str::to_string);
            let areas = areas_mut(r);
            let Some(x) = areas.get(&area_id) else { return "sesión desconocida".to_string() };
            if x.get("epics").and_then(Value::as_object).is_some_and(|e| !e.is_empty()) {
                return "quítale antes sus epics".to_string();
            }
            if deployer.as_deref() == Some(area_id.as_str()) {
                return "es la sesión que despliega".to_string();
            }
            areas.shift_remove(&area_id);
            String::new()
        });
        return if error.is_empty() { ok() } else { error_res(400, &error) };
    }
    let conversation = input.get("conversation").filter(|c| truthy(Some(c)));
    let link = json!({
        "session": name,
        "ref": if is_true(input, "ref") { input["ref"].clone() } else { Value::Null },
        "since": now(),
        "conversation": conversation.cloned().unwrap_or(Value::Null),
    });
    if let Some(title) = input.get("title") {
        let clean = clip(js_string(Some(title)).trim(), 60);
        if clean.is_empty() {
            return error_res(400, "el nombre no puede quedar vacío");
        }
        if is_true(input, "areaId") {
            if !rename_area(&area_id, &clean) {
                return error_res(400, "sesión desconocida");
            }
        } else {
            change_routes(|r| {
                let k = area_key(r, &clean);
                release(r, conversation, name);
                let areas = areas_mut(r);
                let existing = areas.get(&k).cloned().unwrap_or(Value::Null);
                areas.insert(k, merged(json!({ "title": clean, "epics": {} }), &[&existing, &link]));
            });
        }
        return ok();
    }
    if let Some(alias) = input.get("alias") {
        let id = if is_true(input, "ref") { js_string(input.get("ref")) } else { name.to_string() };
        mutate(|d| {
            if !d.get("aliases").is_some_and(Value::is_object) {
                d.insert("aliases".into(), json!({}));
            }
            let aliases = d.get_mut("aliases").and_then(Value::as_object_mut).unwrap();
            if truthy(Some(alias)) {
                aliases.insert(id, json!(clip(&js_string(Some(alias)), 60)));
            } else {
                aliases.shift_remove(&id);
            }
        });
    }
    if let Some(area) = input.get("area") {
        if area.as_str() == Some("") {
            change_routes(|r| release(r, conversation, name));
        } else {
            let key = js_string(Some(area));
            let found = change_routes(|r| {
                if !truthy(r.get("areas").and_then(|a| a.get(&key))) {
                    return false;
                }
                release(r, conversation, name);
                let target = obj(areas_mut(r).get_mut(&key).unwrap());
                for (k, v) in link.as_object().unwrap() {
                    target.insert(k.clone(), v.clone());
                }
                true
            });
            if !found {
                return error_res(400, "sesión desconocida");
            }
        }
    }
    ok()
}

fn link_new(clean: &str, epic_key: Option<&Value>, epic_name: Option<&Value>, created: Option<String>, project: &Project) -> Res {
    let conversations = |list: &Option<Vec<Value>>| -> Vec<Value> { list.clone().unwrap_or_default() };
    let before: HashSet<String> = conversations(&live_sessions()).iter().map(|s| js_string(s.get("conversation"))).collect();
    let own = if project.id != main_project().id { Some(project.clone()) } else { None };
    if let Some(created) = created.clone() {
        let name = clean.to_string();
        let cwd = own.as_ref().map(|p| p.root.clone().unwrap_or_default().to_string_lossy().into_owned());
        std::thread::spawn(move || {
            crate::sessions::host::ensure_host();
            let mut body = json!({ "conversation": created, "name": name });
            if let Some(cwd) = cwd {
                obj(&mut body).insert("cwd".into(), json!(cwd));
            }
            let _ = crate::sessions::host::host_request("POST", "/start", Some(&body));
        });
    } else {
        open_in_vs_code(None);
    }
    let mut found: Option<Value> = None;
    for attempts in 1..=15 {
        crate::core::data::pause(2000);
        found = conversations(&live_sessions()).into_iter().find(|s| match &created {
            Some(c) => s.get("conversation").and_then(Value::as_str) == Some(c.as_str()),
            None => !before.contains(&js_string(s.get("conversation"))),
        });
        if found.is_some() || attempts >= 15 {
            break;
        }
    }
    let area = change_routes(|r| {
        let k = area_key(r, clean);
        let link = match (&found, &created) {
            (Some(f), _) => json!({ "session": f.get("name").cloned().unwrap_or(Value::Null), "ref": null, "since": now(), "conversation": f.get("conversation").cloned().unwrap_or(Value::Null) }),
            (None, Some(c)) => json!({ "conversation": c }),
            (None, None) => json!({}),
        };
        let own_project = own.as_ref().map(|p| json!({ "project": p.id })).unwrap_or(json!({}));
        let areas = areas_mut(r);
        let existing = areas.get(&k).cloned().unwrap_or(Value::Null);
        let mut entry = merged(json!({ "title": clean, "epics": {} }), &[&existing, &link, &own_project]);
        if !is_true(&entry, "epics") {
            obj(&mut entry).insert("epics".into(), json!({}));
        }
        areas.insert(k.clone(), entry);
        if truthy(epic_key) {
            let epic = js_string(epic_key);
            for a in areas.values_mut() {
                if let Some(e) = a.get_mut("epics").and_then(Value::as_object_mut) {
                    e.shift_remove(&epic);
                }
            }
            let label = if truthy(epic_name) { epic_name.cloned().unwrap() } else { epic_key.cloned().unwrap() };
            if let Some(e) = areas.get_mut(&k).and_then(|a| a.get_mut("epics")) {
                obj(e).insert(epic, label);
            }
        }
        k
    });
    send(
        200,
        &json!({
            "area": area,
            "open": found.is_some(),
            "window": found.as_ref().map(|f| f.get("name").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null),
            "named": created.is_some(),
            "conversation": found.as_ref().map(|f| f.get("conversation").cloned().unwrap_or(Value::Null)).or(created.map(Value::String)).unwrap_or(Value::Null),
        }),
    )
}

pub fn handle_new_session(input: &Value) -> Res {
    let clean = clip(text_or_empty(input.get("title")).trim(), 60);
    if clean.is_empty() {
        return error_res(400, "falta el nombre");
    }
    let project = if is_true(input, "project") { config::project(&js_string(input.get("project"))) } else { Some(main_project().clone()) };
    let Some(project) = project else { return error_res(400, "proyecto desconocido") };
    if !project.root.as_ref().is_some_and(|r| !r.as_os_str().is_empty() && r.exists()) {
        return error_res(400, &format!("{} no tiene carpeta en este ordenador", project.name));
    }
    let key = format!("{}|{}", project.id, title_key(&clean));
    {
        let mut creating = CREATING.lock().unwrap_or_else(|p| p.into_inner());
        if now_ms() - creating.get(&key).copied().unwrap_or(0) < CREATING_MS {
            return error_res(409, &format!("«{clean}» ya se está creando"));
        }
        creating.insert(key, now_ms());
    }
    let created = create_conversation(&clean, project.root.as_deref());
    link_new(&clean, input.get("epicKey"), input.get("epicName"), created, &project)
}

pub fn handle_epic(input: &Value) -> Res {
    let Some(key) = input.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) else { return error_res(400, "falta la épica") };
    let area = input.get("area");
    let r = if area.and_then(Value::as_str) == Some("") {
        sessions_cli(&["unroute", key])
    } else {
        let id = if truthy(area) { real_area(&js_string(area)).filter(|a| !a.is_empty()) } else { None };
        let Some(id) = id.filter(|id| truthy(load_routes().get("areas").and_then(|a| a.get(id)))) else { return error_res(400, "sesión desconocida") };
        let name = if is_true(input, "name") { js_string(input.get("name")) } else { key.to_string() };
        sessions_cli(&["route", key, &id, &name])
    };
    match r {
        Ok(_) => ok(),
        Err(e) => error_res(500, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::data::load;
    use crate::sessions::registry::targets;

    #[test]
    fn an_area_session_can_be_pinned_so_it_never_sleeps_on_its_own_and_unpinned_again() {
        let _guard = crate::testkit::fresh();
        change_routes(|r| {
            areas_mut(r).insert("herrero".into(), json!({ "title": "Investigación inicial", "epics": {}, "conversation": "11111111-2222-3333-4444-555555555555" }));
        });
        assert_eq!(handle_session(&json!({ "name": "Investigación inicial", "areaId": "herrero", "keepOpen": true })).code, 200);
        assert_eq!(load_routes()["areas"]["herrero"]["keepOpen"], json!(true));
        let pinned = targets(&load(), &load_routes()).into_iter().find(|a| a["id"] == json!("herrero")).unwrap();
        assert_eq!(pinned["keepOpen"], json!(true));
        assert_eq!(handle_session(&json!({ "name": "Investigación inicial", "areaId": "herrero", "keepOpen": false })).code, 200);
        assert_eq!(load_routes()["areas"]["herrero"].get("keepOpen"), None);
        assert_eq!(handle_session(&json!({ "name": "x", "areaId": "nope", "keepOpen": true })).code, 400);
    }

    #[test]
    fn a_session_without_a_name_is_refused() {
        assert_eq!(handle_session(&json!({ "areaId": "herrero", "keepOpen": true })).code, 400);
        assert_eq!(handle_session(&json!({ "name": 3 })).code, 400);
        assert_eq!(handle_epic(&json!({ "area": "" })).code, 400);
    }
}
