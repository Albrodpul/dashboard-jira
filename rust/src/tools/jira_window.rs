//! Port of bin/jira-window.js.
use crate::commands::args::{encode_uri_component, slice_chars, text};
use crate::core::config::Project;
use crate::core::data::{ROUTES_FILE, SEEN_FILE, TO_COUNT_FILE, read_json};
use crate::core::json::{num, stringify, truthy};
use crate::core::time::{now_ms, parse};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::LazyLock;

const KEEP_FIELDS: [&str; 7] = ["status", "assignee", "summary", "description", "labels", "Attachment", "Sprint"];
static TO_STATUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"status: .* -> (.*)$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn minutes_since_last_close() -> f64 {
    let now = now_ms();
    let mut t = now - 6 * 3600 * 1000;
    while t > now - 5 * 24 * 3600 * 1000 {
        let c = crate::core::time::madrid(t);
        if c.hour == 18 && c.minute >= 30 && c.minute < 35 && !c.weekend {
            return ((now - t) as f64 / 60000.0).ceil() + 5.0;
        }
        t -= 5 * 60 * 1000;
    }
    900.0
}

fn minutes_since_last_report() -> f64 {
    let d = crate::core::data::load();
    let candidates = [d.get("lastReview").and_then(|r| r.get("at")), d.get("reports").and_then(|r| r.get(0)).and_then(|r| r.get("at"))];
    let ats: Vec<i64> = candidates.iter().filter(|x| truthy(**x)).filter_map(|x| x.and_then(Value::as_str).and_then(parse)).collect();
    let Some(latest) = ats.iter().max() else {
        return minutes_since_last_close();
    };
    let m = ((now_ms() - latest) as f64 / 60000.0).ceil() + 10.0;
    m.max(15.0).min(7.0 * 24.0 * 60.0)
}

fn js_number(x: f64) -> String {
    if x.is_nan() { "NaN".into() } else { stringify(&num(x)) }
}

struct Site {
    project: Project,
    base: String,
    auth: String,
    me: Option<String>,
    returned: Regex,
    closed: Regex,
    rejected: Regex,
}

impl Site {
    fn returned_test(&self, text: &str) -> bool {
        TO_STATUS.captures(text).is_some_and(|m| self.returned.is_match(m[1].trim()))
    }
}

fn site_context(p: &Project) -> Result<Site, String> {
    let auth = crate::jira::sites::auth(Some(p))?;
    let st = crate::jira::sites::statuses(Some(p));
    let me = crate::jira::sites::me(Some(p)).get("id").and_then(Value::as_str).map(String::from);
    let rejected = Regex::new(&format!(r"(?i)\b{}\b", text(Some(&st.reject_label)))).map_err(|e| e.to_string())?;
    Ok(Site { project: p.clone(), base: auth.base, auth: auth.auth, me, returned: st.returned_regex.clone(), closed: st.closed_regex.clone(), rejected })
}

fn sprint_text(from: Option<&str>, to: Option<&str>) -> String {
    let list = |s: Option<&str>| -> Vec<String> { s.filter(|x| !x.is_empty()).map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default() };
    let a = list(from);
    let b = list(to);
    let added: Vec<String> = b.iter().filter(|x| !a.contains(x)).cloned().collect();
    let removed: Vec<String> = a.iter().filter(|x| !b.contains(x)).cloned().collect();
    if a.is_empty() && !b.is_empty() {
        return format!("BACKLOG -> sprint ({})", added.join(", "));
    }
    if !a.is_empty() && b.is_empty() {
        return format!("sprint ({}) -> BACKLOG", removed.join(", "));
    }
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(format!("añadido a {}", added.join(", ")));
    }
    if !removed.is_empty() {
        parts.push(format!("quitado de {}", removed.join(", ")));
    }
    format!("sprint: {}", if parts.is_empty() { "sin cambios de sprint".to_string() } else { parts.join("; ") })
}

fn time_ms(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_str).and_then(parse).map(|x| x as f64).unwrap_or(f64::NAN)
}

fn madrid(iso: &str) -> String {
    let ms = parse(iso).unwrap_or(0);
    let today = crate::commands::args::madrid_format(now_ms(), "%-d/%-m");
    if crate::commands::args::madrid_format(ms, "%-d/%-m") == today { crate::commands::args::madrid_format(ms, "%H:%M:%S") } else { crate::commands::args::madrid_format(ms, "%-d/%-m, %H:%M:%S") }
}

fn hhmm(iso: &str) -> String {
    crate::commands::args::madrid_format(parse(iso).unwrap_or(0), "%H:%M")
}

fn api(url: &str, site: &Site) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let mut r = agent.get(url).header("Authorization", &site.auth).header("Accept", "application/json").call().map_err(|_| "fetch failed".to_string())?;
    let status = r.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("{status} {url}"));
    }
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn adf_text(node: Option<&Value>) -> String {
    match node {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(n) => {
            if truthy(n.get("text")) {
                return text(n.get("text"));
            }
            if n.get("type").and_then(Value::as_str) == Some("mention") {
                return n.get("attrs").and_then(|a| a.get("text")).filter(|t| truthy(Some(t))).map(|t| text(Some(t))).unwrap_or_else(|| "@alguien".into());
            }
            let sep = if n.get("type").and_then(Value::as_str) == Some("paragraph") { "\n" } else { " " };
            n.get("content").and_then(Value::as_array).map(|c| c.iter().map(|x| adf_text(Some(x))).collect::<Vec<_>>().join(sep)).unwrap_or_default()
        }
    }
}

fn board(cmd: &str, data: &Value) -> String {
    use std::io::Write;
    use std::process::Stdio;
    let Ok(exe) = crate::core::platform::self_exe() else { return String::new() };
    let Ok(mut child) = crate::core::platform::cmd(exe).arg(cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return String::new() };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stringify(data).as_bytes());
    }
    match child.wait_with_output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => String::new(),
    }
}

struct Event {
    key: String,
    title: Value,
    block: Option<(String, String)>,
    assignee: String,
    assignee_id: Option<String>,
    status: String,
    t: String,
    who: String,
    text: String,
    kind: String,
    site: usize,
    id: String,
}

fn oldest(list: &[Value]) -> f64 {
    list.iter().map(|h| time_ms(h.get("created"))).fold(f64::INFINITY, |a, b| if b.is_nan() || a.is_nan() { f64::NAN } else { a.min(b) })
}

fn full_changelog(site: &Site, it: &Value, cutoff: f64) -> Result<Vec<Value>, String> {
    let c = it.get("changelog").cloned().unwrap_or(json!({ "histories": [] }));
    let histories = c.get("histories").and_then(Value::as_array).cloned().unwrap_or_default();
    let total = c.get("total").and_then(Value::as_f64);
    if !total.is_some_and(|t| t > histories.len() as f64) || oldest(&histories) < cutoff {
        return Ok(histories);
    }
    let mut out = Vec::new();
    let mut end = total.unwrap() as i64;
    let key = text(it.get("key"));
    while end > 0 {
        let start = (end - 100).max(0);
        let page = api(&format!("{}/issue/{key}/changelog?startAt={start}&maxResults={}", site.base, end - start), site)?;
        let values = page.get("values").and_then(Value::as_array).cloned().unwrap_or_default();
        out.extend(values.iter().cloned());
        if values.is_empty() || oldest(&values) < cutoff {
            break;
        }
        end -= 100;
    }
    Ok(out)
}

fn read_site(site: &Site, index: usize, minutes: f64, cutoff: f64) -> Result<Vec<Event>, String> {
    let projects_jql = site.project.jira.as_ref().map(|j| j.projects_jql.clone()).unwrap_or_default();
    let jql = format!("{projects_jql} AND updated >= -{}m", js_number(minutes));
    let fields_list = "summary,comment,created,reporter,status,issuetype,assignee,parent";
    let mut issues: Vec<Value> = Vec::new();
    let mut token = String::new();
    loop {
        let next = if token.is_empty() { String::new() } else { format!("&nextPageToken={}", encode_uri_component(&token)) };
        let s = api(&format!("{}/search/jql?jql={}&fields={fields_list}&expand=changelog&maxResults=100{next}", site.base, encode_uri_component(&jql)), site)?;
        issues.extend(s.get("issues").and_then(Value::as_array).cloned().unwrap_or_default());
        token = if truthy(s.get("isLast")) { String::new() } else { s.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string() };
        if token.is_empty() {
            break;
        }
    }
    let mut out = Vec::new();
    for it in &issues {
        let key = text(it.get("key"));
        let m = it.get("fields").and_then(|f| f.get("comment"));
        let more_comments = m.is_some_and(|m| m.get("total").and_then(Value::as_f64).unwrap_or(0.0) > m.get("comments").and_then(Value::as_array).map_or(0, |c| c.len()) as f64);
        let d = if more_comments { api(&format!("{}/issue/{key}?fields={fields_list}", site.base), site)? } else { it.clone() };
        let histories = full_changelog(site, it, cutoff)?;
        let f = d.get("fields").cloned().unwrap_or(Value::Null);
        let is_epic = f.get("issuetype").and_then(|t| t.get("name")).and_then(Value::as_str) == Some("Epic");
        let block = if is_epic {
            Some((key.clone(), text(f.get("summary"))))
        } else if let Some(parent) = f.get("parent").filter(|p| truthy(Some(p))) {
            let name = parent.get("fields").and_then(|x| x.get("summary")).filter(|s| truthy(Some(s))).map(|s| text(Some(s))).unwrap_or_else(|| text(parent.get("key")));
            Some((text(parent.get("key")), name))
        } else {
            None
        };
        let mut events: Vec<(String, String, String, String)> = Vec::new();
        if time_ms(f.get("created")) >= cutoff {
            let kind = if is_epic { "EPIC NUEVA" } else { "TICKET NUEVO" };
            let who = match f.get("assignee").filter(|a| truthy(Some(a))) {
                Some(a) => format!(" (asignado a {})", text(a.get("displayName"))),
                None => " (sin asignar)".into(),
            };
            events.push((text(f.get("created")), text(f.get("reporter").and_then(|r| r.get("displayName"))), format!("{kind}: {}{who}", text(f.get("summary"))), if is_epic { "epic".into() } else { "new".into() }));
        }
        for h in &histories {
            if time_ms(h.get("created")) < cutoff || h.get("author").and_then(|a| a.get("accountId")).and_then(Value::as_str).map(String::from) == site.me {
                continue;
            }
            for i in h.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
                let field = text(i.get("field"));
                let from = i.get("fromString").filter(|x| truthy(Some(x))).map(|x| text(Some(x)));
                let to = i.get("toString").filter(|x| truthy(Some(x))).map(|x| text(Some(x)));
                if !KEEP_FIELDS.contains(&field.as_str()) || from.clone().unwrap_or_default() == to.clone().unwrap_or_default() {
                    continue;
                }
                let line = match field.as_str() {
                    "description" => "editó la descripción".to_string(),
                    "summary" => format!("cambió el título: \"{}\" -> \"{}\"", text(i.get("fromString")), text(i.get("toString"))),
                    "labels" => format!("etiqueta {}", to.clone().unwrap_or_else(|| "(quitada)".into())),
                    "Attachment" => format!("adjunto {}", to.clone().or(from.clone()).unwrap_or_else(|| text(i.get("fromString")))),
                    "Sprint" => sprint_text(from.as_deref(), to.as_deref()),
                    _ => format!("{field}: {} -> {}", from.clone().unwrap_or_else(|| "-".into()), to.clone().unwrap_or_else(|| "-".into())),
                };
                let rejected = field == "labels" && site.rejected.is_match(to.as_deref().unwrap_or("")) && !site.rejected.is_match(from.as_deref().unwrap_or(""));
                events.push((text(h.get("created")), text(h.get("author").and_then(|a| a.get("displayName"))), line, if rejected { "rejected".into() } else { field.clone() }));
            }
        }
        for c in f.get("comment").and_then(|c| c.get("comments")).and_then(Value::as_array).cloned().unwrap_or_default() {
            if time_ms(c.get("created")) < cutoff || c.get("author").and_then(|a| a.get("accountId")).and_then(Value::as_str).map(String::from) == site.me {
                continue;
            }
            let body = match c.get("body") {
                Some(Value::String(s)) => s.clone(),
                other => adf_text(other),
            };
            events.push((text(c.get("created")), text(c.get("author").and_then(|a| a.get("displayName"))), format!("COMENTARIO: {}", slice_chars(&SPACES.replace_all(&body, " "), 1500)), "comment".into()));
        }
        let assignee = f.get("assignee").filter(|a| truthy(Some(a))).map(|a| text(a.get("displayName"))).unwrap_or_else(|| "sin asignar".into());
        let assignee_id = f.get("assignee").filter(|a| truthy(Some(a))).and_then(|a| a.get("accountId")).and_then(Value::as_str).map(String::from);
        let status = f.get("status").and_then(|s| s.get("name")).filter(|n| truthy(Some(n))).map(|n| text(Some(n))).unwrap_or_default();
        for (t, who, line, kind) in events {
            let suffix = match kind.as_str() {
                "new" => "nuevo".to_string(),
                "epic" => "epic".to_string(),
                _ => slice_chars(&line, 120),
            };
            out.push(Event { id: format!("{key}|{t}|{suffix}"), key: key.clone(), title: f.get("summary").cloned().unwrap_or(Value::Null), block: block.clone(), assignee: assignee.clone(), assignee_id: assignee_id.clone(), status: status.clone(), t, who, text: line, kind, site: index });
        }
    }
    Ok(out)
}

fn iso_of(t: &str) -> String {
    crate::core::time::iso(parse(t).unwrap_or(0))
}

fn base_card(e: &Event, area_of: &dyn Fn(&str) -> String) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("key".into(), Value::from(e.key.as_str()));
    m.insert("title".into(), e.title.clone());
    m.insert("epicKey".into(), Value::from(e.block.as_ref().map(|b| b.0.clone()).unwrap_or_default()));
    m.insert("epicName".into(), Value::from(e.block.as_ref().map(|b| b.1.clone()).unwrap_or_default()));
    m.insert("assignee".into(), Value::from(e.assignee.as_str()));
    m.insert("at".into(), Value::from(iso_of(&e.t)));
    m.insert("proposedArea".into(), Value::from(e.block.as_ref().map(|b| area_of(&b.0)).unwrap_or_default()));
    m.insert("event".into(), Value::from(e.id.as_str()));
    m
}

fn window(args: &[String]) -> Result<i32, String> {
    let all = args.iter().any(|x| x == "--all" || x == "--todo");
    let check_only = args.iter().any(|x| x == "--check");
    let arg = args.iter().find(|x| !x.starts_with("--")).map(String::as_str).unwrap_or("auto");
    let minutes = match arg {
        "close" | "cierre" => minutes_since_last_close(),
        "auto" => minutes_since_last_report(),
        other => other.trim().parse::<f64>().unwrap_or(if other.trim().is_empty() { 0.0 } else { f64::NAN }),
    };
    let cutoff = now_ms() as f64 - minutes * 60.0 * 1000.0;
    let projects = crate::jira::sites::jira_projects();
    let mut sites: Vec<Site> = Vec::new();
    let mut out: Vec<Event> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    for p in &projects {
        let attempt = site_context(p).and_then(|site| {
            let index = sites.len();
            let events = read_site(&site, index, minutes, cutoff)?;
            Ok((site, events))
        });
        match attempt {
            Ok((site, events)) => {
                sites.push(site);
                out.extend(events);
            }
            Err(e) => failed.push((p.name.clone(), e)),
        }
    }
    if !failed.is_empty() && failed.len() == projects.len() {
        return Err(failed.iter().map(|(n, e)| format!("{n}: {e}")).collect::<Vec<_>>().join("; "));
    }
    for (name, error) in &failed {
        eprintln!("AVISO: no se pudo leer el Jira de {name} ({error}); el resto sí.");
    }
    out.sort_by(|a, b| time_ms(Some(&Value::from(a.t.as_str()))).partial_cmp(&time_ms(Some(&Value::from(b.t.as_str())))).unwrap_or(std::cmp::Ordering::Equal));

    let seen = read_json(&SEEN_FILE, json!({ "ids": {} })).get("ids").cloned().filter(|v| truthy(Some(v))).unwrap_or(json!({}));
    let fresh: Vec<&Event> = out.iter().filter(|e| all || !truthy(seen.get(e.id.as_str()))).collect();
    let repeated = out.len() - fresh.len();
    if check_only {
        println!("{}", stringify(&json!({ "fresh": fresh.len() })));
        return Ok(0);
    }
    let mut to_count: Vec<String> = read_json(&TO_COUNT_FILE, json!({ "ids": [] })).get("ids").and_then(Value::as_array).map(|a| a.iter().map(|x| text(Some(x))).collect()).unwrap_or_default();
    let mut known: HashSet<String> = HashSet::new();
    to_count.retain(|x| known.insert(x.clone()));
    for e in &fresh {
        if known.insert(e.id.clone()) {
            to_count.push(e.id.clone());
        }
    }
    let _ = std::fs::write(&*TO_COUNT_FILE, stringify(&json!({ "ids": to_count })));

    let block_label = |b: &Option<(String, String)>| b.as_ref().map(|(k, n)| format!("{k} {n}")).unwrap_or_else(|| "sin epic".into());
    let repeated_note = if repeated > 0 { format!(" · {repeated} evento(s) ya contados en revisiones anteriores no se repiten (--all para verlos)") } else { String::new() };
    println!("Ventana: {} min (hora Madrid ahora: {}){repeated_note}", js_number(minutes), crate::commands::args::madrid_format(now_ms(), "%-d/%-m, %H:%M:%S"));
    let mut attachments: Vec<(String, Vec<&Event>)> = Vec::new();
    for e in fresh.iter().filter(|e| e.kind == "Attachment") {
        match attachments.iter_mut().find(|(w, _)| *w == e.who) {
            Some((_, list)) => list.push(e),
            None => attachments.push((e.who.clone(), vec![e])),
        }
    }
    let bulk: Vec<&(String, Vec<&Event>)> = attachments.iter().filter(|(_, list)| list.len() > 20).collect();
    let in_bulk = |who: &str| bulk.iter().any(|(w, _)| w == who);
    for e in &fresh {
        if !(e.kind == "Attachment" && in_bulk(&e.who)) {
            println!("{} | {} | {} | {} | asignado: {} | epic: {}", madrid(&e.t), e.key, e.who, e.text, e.assignee, block_label(&e.block));
        }
    }
    for (who, list) in &bulk {
        let mut keys: Vec<String> = Vec::new();
        for e in list {
            if !keys.contains(&e.key) {
                keys.push(e.key.clone());
            }
        }
        let shown = keys.iter().take(15).cloned().collect::<Vec<_>>().join(", ");
        let more = if keys.len() > 15 { ", …" } else { "" };
        println!("{}–{} | {} tickets | {who} | {} adjuntos en bloque ({shown}{more}) | resumido: no se listan uno a uno", madrid(&list[0].t), hhmm(&list[list.len() - 1].t), keys.len(), list.len());
    }
    if fresh.is_empty() {
        println!("(nada nuevo)");
    }

    let routes = read_json(&ROUTES_FILE, json!({ "areas": {} }));
    let route_areas = routes.get("areas").and_then(Value::as_object).cloned().unwrap_or_default();
    let area_of = |key: &str| -> String { route_areas.iter().find(|(_, a)| a.get("epics").filter(|e| truthy(Some(e))).is_some_and(|e| truthy(e.get(key)))).map(|(k, _)| k.clone()).unwrap_or_default() };

    let changes: Vec<Value> = out
        .iter()
        .filter(|e| e.kind != "new" && e.kind != "epic")
        .map(|e| {
            let first = e.who.split(' ').next().unwrap_or("");
            json!({ "key": e.key, "at": iso_of(&e.t), "who": e.who, "assignee": e.assignee, "text": format!("{first}: {}", slice_chars(&SPACES.replace_all(&e.text, " "), 220)) })
        })
        .collect();
    let changes_result = if changes.is_empty() { String::new() } else { board("changes", &Value::Array(changes)).trim().to_string() };
    if changes_result.contains("retirada") {
        println!("Tablero: {changes_result}");
    }

    let mut cards: Vec<Value> = Vec::new();
    let mut by_ticket: Vec<(String, Vec<&Event>)> = Vec::new();
    for e in &fresh {
        match by_ticket.iter_mut().find(|(k, _)| *k == e.key) {
            Some((_, list)) => list.push(e),
            None => by_ticket.push((e.key.clone(), vec![e])),
        }
    }
    for (_, evs) in &by_ticket {
        let e0 = evs[0];
        let site = &sites[e0.site];
        let available_or_mine = e0.assignee_id.is_none() || e0.assignee_id == site.me;
        let created = evs.iter().find(|e| e.kind == "new");
        let closed = site.closed.is_match(&e0.status);
        if let Some(created) = created.filter(|_| available_or_mine && !closed) {
            let mut card = base_card(created, &area_of);
            card.insert("kind".into(), Value::from("new"));
            card.insert("note".into(), Value::from(format!("La crea a las {}, {}.", hhmm(&created.t), if e0.assignee_id.is_some() { "asignada a ti" } else { "sin asignar" })));
            card.insert("noteBy".into(), Value::from(created.who.as_str()));
            cards.push(Value::Object(card));
            continue;
        }
        if created.is_some() || e0.assignee_id != site.me || closed {
            continue;
        }
        let returned = evs.iter().filter(|e| e.kind == "rejected" || (e.kind == "status" && site.returned_test(&e.text))).last();
        let comment = evs.iter().filter(|e| e.kind == "comment").last();
        if let Some(returned) = returned {
            let note = match comment {
                Some(c) => c.text.strip_prefix("COMENTARIO: ").unwrap_or(&c.text).to_string(),
                None => returned.text.clone(),
            };
            let mut card = base_card(returned, &area_of);
            card.insert("kind".into(), Value::from("returned"));
            card.insert("note".into(), Value::from(slice_chars(&note, 900)));
            card.insert("noteBy".into(), Value::from(comment.unwrap_or(returned).who.as_str()));
            cards.push(Value::Object(card));
        } else if let Some(comment) = comment {
            let mut card = base_card(comment, &area_of);
            card.insert("kind".into(), Value::from("comment"));
            card.insert("note".into(), Value::from(slice_chars(comment.text.strip_prefix("COMENTARIO: ").unwrap_or(&comment.text), 900)));
            card.insert("noteBy".into(), Value::from(comment.who.as_str()));
            cards.push(Value::Object(card));
        }
    }
    if !cards.is_empty() {
        let res = board("add", &Value::Array(cards.clone())).trim().to_string();
        println!("--- Tarjetas del tablero ---");
        for t in &cards {
            let area = t.get("proposedArea").and_then(Value::as_str).unwrap_or("");
            println!("{}: {}{}", text(t.get("key")), text(t.get("kind")), if area.is_empty() { " (epic sin sesión)".to_string() } else { format!(" -> {area}") });
        }
        if !res.is_empty() {
            println!("{res}");
        }
    }

    let mut epics: Vec<(String, String)> = Vec::new();
    for e in &fresh {
        if let Some((key, name)) = &e.block {
            match epics.iter_mut().find(|(k, _)| k == key) {
                Some(entry) => entry.1 = name.clone(),
                None => epics.push((key.clone(), name.clone())),
            }
        }
    }
    if !epics.is_empty() {
        board("epics", &Value::Array(epics.iter().map(|(key, name)| json!({ "key": key, "name": name })).collect()));
        println!("--- Sesión que lleva cada epic de esta ventana ---");
        for (key, name) in &epics {
            let area = route_areas.values().find(|a| a.get("epics").filter(|e| truthy(Some(e))).is_some_and(|e| truthy(e.get(key.as_str()))));
            let target = match area {
                Some(a) => format!("{} (sesión: {})", text(a.get("title")), if truthy(a.get("session")) { text(a.get("session")) } else { "sin registrar".into() }),
                None => "SIN SESIÓN".into(),
            };
            println!("{key} {name} -> {target}");
        }
    }
    Ok(0)
}

pub fn run(args: &[String]) -> i32 {
    match window(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("ERROR {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprint_changes_read_as_backlog_moves_or_additions() {
        assert_eq!(sprint_text(None, Some("S1")), "BACKLOG -> sprint (S1)");
        assert_eq!(sprint_text(Some("S1"), None), "sprint (S1) -> BACKLOG");
        assert_eq!(sprint_text(Some("S1"), Some("S1, S2")), "sprint: añadido a S2");
        assert_eq!(sprint_text(Some("S1"), Some("S1")), "sprint: sin cambios de sprint");
    }

    #[test]
    fn adf_comments_flatten_to_text_with_mentions() {
        let node = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "mention", "attrs": { "text": "@Ana" } }, { "type": "text", "text": "hola" }] }] });
        assert_eq!(adf_text(Some(&node)), "@Ana\nhola");
    }
}
