//! Port of src/features/deploy-status.js.
use crate::core::data::{DATA_DIR, read_json};
use crate::core::json::{parse, stringify, truthy};
use crate::core::time::{iso, now, now_ms};
use crate::server::http::{Res, send};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;

static FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("deploy-status.json"));
const ENVS: [&str; 2] = ["develop", "production"];
const ACTIVE_ACTIONS: [&str; 5] = ["queued", "in_progress", "waiting", "requested", "pending"];
const ACTIVE_CODEDEPLOY: [&str; 5] = ["Created", "Queued", "InProgress", "Baking", "Ready"];
const SLOW: u64 = 3 * 60000;
const FAST: u64 = 30000;
const RECENT: usize = 4;
const PAIR_BEFORE: f64 = 2.0 * 60000.0;
const PAIR_AFTER: f64 = 15.0 * 60000.0;

type Refresh = Arc<(Mutex<Option<Result<Value, String>>>, Condvar)>;

static TIMER: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));
static RUNNING: LazyLock<Mutex<Option<Refresh>>> = LazyLock::new(|| Mutex::new(None));

pub struct Pairing {
    pub by_run: HashMap<String, Value>,
    pub unpaired: Vec<Value>,
}

fn run(bin: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    match crate::features::devservers::run_with_timeout(&mut cmd, None, 60000) {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            let err = if err.is_empty() { format!("Command failed: {bin} {}", args.join(" ")) } else { err };
            Err(err.trim().split('\n').next().unwrap_or("").chars().take(200).collect())
        }
        Err(e) => Err(e.to_string().trim().split('\n').next().unwrap_or("").chars().take(200).collect()),
    }
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn actions_runs(target: &Value) -> Result<Map<String, Value>, String> {
    let repo = s(target, "repo").unwrap_or_default();
    let out = run("gh", &strings(&["run", "list", "-R", &repo, "--limit", "40", "--json", "databaseId,workflowName,headBranch,status,conclusion,createdAt,updatedAt,url,event"]))?;
    let runs: Vec<Value> = parse(&out).and_then(|v| v.as_array().cloned()).ok_or_else(|| "Unexpected end of JSON input".to_string())?;
    let mut result = Map::new();
    for env in ENVS {
        let pattern = target.get("workflows").and_then(|w| w.get(env)).and_then(Value::as_str).filter(|p| !p.is_empty()).unwrap_or(env).to_string();
        let matcher = Regex::new(&format!("(?i){pattern}")).unwrap_or_else(|_| Regex::new(&format!("(?i){}", regex::escape(&pattern))).unwrap());
        let list: Vec<&Value> = runs.iter().filter(|y| matcher.is_match(y.get("workflowName").and_then(Value::as_str).unwrap_or("undefined"))).take(RECENT).collect();
        if list.is_empty() {
            continue;
        }
        let mut items = Vec::new();
        for x in list {
            let mut item = json!({
                "id": x.get("databaseId").cloned().unwrap_or(Value::Null),
                "workflow": x.get("workflowName").cloned().unwrap_or(Value::Null),
                "ref": x.get("headBranch").cloned().unwrap_or(Value::Null),
                "status": x.get("status").cloned().unwrap_or(Value::Null),
                "conclusion": x.get("conclusion").filter(|c| truthy(Some(c))).cloned().unwrap_or(Value::Null),
                "startedAt": x.get("createdAt").cloned().unwrap_or(Value::Null),
                "updatedAt": x.get("updatedAt").cloned().unwrap_or(Value::Null),
                "url": x.get("url").cloned().unwrap_or(Value::Null),
            });
            if ACTIVE_ACTIONS.contains(&x.get("status").and_then(Value::as_str).unwrap_or("")) {
                item["progress"] = actions_progress(&repo, x.get("databaseId").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null);
            }
            items.push(item);
        }
        result.insert(env.into(), Value::from(items));
    }
    Ok(result)
}

fn id_text(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => stringify(other),
    }
}

fn actions_progress(repo: &str, id: Value) -> Option<Value> {
    let out = run("gh", &strings(&["run", "view", &id_text(&id), "-R", repo, "--json", "jobs"])).ok()?;
    let v = parse(&out)?;
    let steps: Vec<Value> = v.get("jobs")?.as_array()?.iter().flat_map(|j| j.get("steps").and_then(Value::as_array).cloned().unwrap_or_default()).collect();
    if steps.is_empty() {
        return None;
    }
    let done = steps.iter().filter(|x| x.get("status").and_then(Value::as_str) == Some("completed")).count();
    Some(json!({ "done": done, "total": steps.len() }))
}

fn codedeploy_progress(id: &str) -> Option<Value> {
    let list = run("aws", &strings(&["deploy", "list-deployment-targets", "--deployment-id", id, "--query", "targetIds", "--output", "json"])).ok()?;
    let ids: Vec<String> = parse(&list)?.as_array()?.iter().map(id_text).collect();
    if ids.is_empty() {
        return None;
    }
    let mut args = strings(&["deploy", "batch-get-deployment-targets", "--deployment-id", id, "--target-ids"]);
    args.extend(ids.into_iter().take(25));
    args.extend(strings(&["--query", "deploymentTargets[].instanceTarget.lifecycleEvents[].status", "--output", "json"]));
    let info = run("aws", &args).ok()?;
    let events: Vec<Value> = parse(&info)?.as_array()?.iter().flat_map(|x| match x {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    }).filter(|x| truthy(Some(x))).collect();
    if events.is_empty() {
        return None;
    }
    let done = events.iter().filter(|x| x.as_str() == Some("Succeeded") || x.as_str() == Some("Skipped")).count();
    Some(json!({ "done": done, "total": events.len() }))
}

fn iso_time(t: Option<&Value>) -> Value {
    match t {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Number(n)) => Value::from(iso((n.as_f64().unwrap_or(0.0) * 1000.0).trunc() as i64)),
        Some(other) => other.clone(),
    }
}

fn codedeploy_recent(application: &str, group: &str) -> Result<Vec<Value>, String> {
    let list = run("aws", &strings(&["deploy", "list-deployments", "--application-name", application, "--deployment-group-name", group, "--max-items", &RECENT.to_string(), "--query", "deployments", "--output", "json"]))?;
    let ids: Vec<String> = match parse(&list) {
        Some(Value::Array(a)) => a.iter().map(id_text).collect(),
        Some(Value::Null) => Vec::new(),
        _ => return Err("respuesta de CodeDeploy ilegible".into()),
    };
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = strings(&["deploy", "batch-get-deployments", "--deployment-ids"]);
    args.extend(ids);
    args.extend(strings(&["--query", "deploymentsInfo[].{id:deploymentId,status:status,createTime:createTime,completeTime:completeTime,overview:deploymentOverview,error:errorInformation.message}", "--output", "json"]));
    let info = run("aws", &args)?;
    let list = parse(&info).and_then(|v| v.as_array().cloned()).ok_or_else(|| "Unexpected end of JSON input".to_string())?;
    let mut out = Vec::new();
    for d in list {
        let o = d.get("overview").filter(|o| truthy(Some(o))).cloned().unwrap_or(json!({}));
        let n = |k: &str| o.get(k).and_then(Value::as_f64).filter(|x| *x != 0.0).unwrap_or(0.0);
        let status = s(&d, "status").unwrap_or_default();
        let progress = if ACTIVE_CODEDEPLOY.contains(&status.as_str()) { codedeploy_progress(&s(&d, "id").unwrap_or_default()) } else { None };
        out.push(json!({
            "id": d.get("id").cloned().unwrap_or(Value::Null),
            "status": d.get("status").cloned().unwrap_or(Value::Null),
            "startedAt": iso_time(d.get("createTime")),
            "finishedAt": iso_time(d.get("completeTime")),
            "done": crate::core::json::num(n("Succeeded")),
            "total": crate::core::json::num(n("Succeeded") + n("Failed") + n("InProgress") + n("Pending") + n("Ready") + n("Skipped")),
            "progress": progress,
            "error": d.get("error").filter(|e| truthy(Some(e))).cloned().unwrap_or(Value::Null),
        }));
    }
    out.sort_by(|a, b| ms(b.get("startedAt")).partial_cmp(&ms(a.get("startedAt"))).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

fn ms(x: Option<&Value>) -> f64 {
    match x {
        Some(Value::String(t)) => crate::core::time::parse(t).map(|v| v as f64).unwrap_or(f64::NAN),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

fn started_or_updated(r: &Value) -> Option<&Value> {
    r.get("startedAt").filter(|v| truthy(Some(v))).or_else(|| r.get("updatedAt"))
}

pub fn pair(runs: &[Value], deployments: &[Value]) -> Pairing {
    let mut by_run: HashMap<String, Value> = HashMap::new();
    let mut used: Vec<String> = Vec::new();
    for d in deployments.iter().rev() {
        let start = ms(d.get("startedAt"));
        let mut cand: Vec<&Value> = runs
            .iter()
            .filter(|r| {
                let key = id_text(r.get("id").unwrap_or(&Value::Null));
                !by_run.contains_key(&key) && r.get("status").and_then(Value::as_str) == Some("completed") && start >= ms(started_or_updated(r)) - PAIR_BEFORE && start - ms(r.get("updatedAt")) <= PAIR_AFTER
            })
            .collect();
        cand.sort_by(|a, b| {
            let (x, y) = (ms(started_or_updated(b)), ms(started_or_updated(a)));
            x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(first) = cand.first() {
            by_run.insert(id_text(first.get("id").unwrap_or(&Value::Null)), d.clone());
            used.push(id_text(d.get("id").unwrap_or(&Value::Null)));
        }
    }
    let unpaired = deployments.iter().filter(|d| !used.contains(&id_text(d.get("id").unwrap_or(&Value::Null)))).cloned().collect();
    Pairing { by_run, unpaired }
}

enum Cd<'a> {
    Undefined,
    Is(Option<&'a Value>),
}

fn overall(actions: Option<&Value>, codedeploy: Cd) -> (String, String) {
    let st = |a: &str, b: &str| (a.to_string(), b.to_string());
    let cd_status = |c: &Value| c.get("status").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(actions) = actions else {
        if let Cd::Is(Some(c)) = codedeploy {
            if ACTIVE_CODEDEPLOY.contains(&cd_status(c).as_str()) {
                return st("running", "CodeDeploy en curso");
            }
        }
        return st("unknown", "Sin despliegues");
    };
    if ACTIVE_ACTIONS.contains(&actions.get("status").and_then(Value::as_str).unwrap_or("")) {
        return st("running", "GitHub Actions en curso");
    }
    if let Some(conclusion) = actions.get("conclusion").and_then(Value::as_str).filter(|c| !c.is_empty() && *c != "success") {
        return if conclusion == "cancelled" { st("cancelled", "Cancelado en GitHub Actions") } else { st("failed", "Falló en GitHub Actions") };
    }
    let c = match codedeploy {
        Cd::Undefined => return st("success", "Desplegado"),
        Cd::Is(None) => None,
        Cd::Is(Some(c)) if truthy(c.get("error")) => None,
        Cd::Is(Some(c)) => Some(c),
    };
    let Some(c) = c else {
        return if now_ms() as f64 - ms(actions.get("updatedAt")) < PAIR_AFTER { st("running", "Esperando a CodeDeploy") } else { st("unknown", "No se ve su despliegue en CodeDeploy") };
    };
    let status = cd_status(c);
    if ACTIVE_CODEDEPLOY.contains(&status.as_str()) {
        let total = c.get("total").and_then(Value::as_f64).unwrap_or(0.0);
        let machines = if total != 0.0 { format!(" ({}/{} máquinas)", c.get("done").map(id_text).unwrap_or_default(), id_text(&c["total"])) } else { String::new() };
        return ("running".into(), format!("CodeDeploy en curso{machines}"));
    }
    if status == "Succeeded" {
        return st("success", "Desplegado");
    }
    let error = c.get("error").filter(|e| truthy(Some(e))).map(|e| format!(" · {}", id_text(e))).unwrap_or_default();
    ((if status == "Stopped" { "cancelled" } else { "failed" }).into(), format!("CodeDeploy: {status}{error}"))
}

fn collect() -> Value {
    let mut items = Vec::new();
    for t in &crate::core::config::main_project().deploy_targets {
        let has_repo = t.get("repo").is_some_and(|r| truthy(Some(r)));
        let runs = if has_repo { actions_runs(t) } else { Ok(Map::new()) };
        let (runs, error) = match runs {
            Ok(r) => (r, Value::Null),
            Err(e) => (Map::new(), Value::from(e)),
        };
        let mut envs = Map::new();
        for env in ENVS {
            let list: Vec<Value> = runs.get(env).and_then(Value::as_array).cloned().unwrap_or_default();
            let group = t.get("codedeploy").and_then(|c| c.get(env)).filter(|g| truthy(Some(g))).map(id_text);
            let recent = group.as_ref().map(|g| codedeploy_recent(&t["codedeploy"].get("application").map(id_text).unwrap_or_default(), g));
            let cd_error = match &recent {
                Some(Err(e)) => Some(json!({ "error": e })),
                _ => None,
            };
            let recent_list: Vec<Value> = match &recent {
                Some(Ok(l)) => l.clone(),
                _ => Vec::new(),
            };
            let pairing = pair(&list, &recent_list);
            let entry = |actions: Option<&Value>, cd: Option<&Value>| -> Value {
                let codedeploy = if group.is_none() { Cd::Undefined } else { Cd::Is(cd.or(cd_error.as_ref())) };
                let shown = match &codedeploy {
                    Cd::Is(Some(c)) => (*c).clone(),
                    _ => Value::Null,
                };
                let (state, step) = overall(actions, codedeploy);
                json!({ "actions": actions.cloned().unwrap_or(Value::Null), "codedeploy": shown, "hasCodedeploy": group.is_some(), "codedeployCurrent": cd.is_some(), "state": state, "step": step })
            };
            let chains: Vec<Value> = list.iter().map(|r| entry(Some(r), pairing.by_run.get(&id_text(r.get("id").unwrap_or(&Value::Null))))).collect();
            let loose: Vec<Value> = pairing.unpaired.iter().filter(|d| ACTIVE_CODEDEPLOY.contains(&d.get("status").and_then(Value::as_str).unwrap_or(""))).map(|d| entry(None, Some(d))).collect();
            let mut main = chains.first().cloned().unwrap_or_else(|| entry(None, None));
            let parallel: Vec<Value> = chains.iter().skip(1).chain(loose.iter()).filter(|c| c["state"] == "running").cloned().collect();
            main["parallel"] = Value::from(parallel);
            envs.insert(env.into(), main);
        }
        items.push(json!({ "id": t.get("id").cloned().unwrap_or(Value::Null), "repo": if has_repo { t["repo"].clone() } else { Value::Null }, "error": error, "envs": envs }));
    }
    json!({ "at": now(), "items": items })
}

pub fn read_status() -> Option<Value> {
    Some(read_json(&FILE, Value::Null)).filter(|v| !v.is_null())
}

fn recent_order() -> bool {
    let d = crate::core::data::load();
    d.get("deployments").and_then(Value::as_array).is_some_and(|list| {
        list.iter().any(|x| {
            x.get("status").and_then(Value::as_str) == Some("approved")
                || x.get("sentAt").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(crate::core::time::parse).is_some_and(|t| now_ms() - t < 30 * 60000)
        })
    })
}

pub fn any_running(s: Option<&Value>) -> bool {
    recent_order()
        || s.is_some_and(|s| s.get("items").and_then(Value::as_array).is_some_and(|items| items.iter().any(|i| ENVS.iter().any(|e| i.get("envs").and_then(|x| x.get(*e)).is_some_and(|x| x.get("state").and_then(Value::as_str) == Some("running"))))))
}

fn finished(prev: Option<&Value>, next: &Value) -> Vec<(String, String, String)> {
    let Some(prev) = prev else { return Vec::new() };
    let mut out = Vec::new();
    for item in next["items"].as_array().into_iter().flatten() {
        let before = prev.get("items").and_then(Value::as_array).and_then(|a| a.iter().find(|x| x.get("id") == item.get("id")));
        for env in ENVS {
            let a = before.and_then(|b| b.get("envs")).and_then(|e| e.get(env)).filter(|x| truthy(Some(x)));
            let b = item.get("envs").and_then(|e| e.get(env)).filter(|x| truthy(Some(x)));
            if let (Some(a), Some(b)) = (a, b) {
                let bs = b.get("state").and_then(Value::as_str).unwrap_or("");
                if a.get("state").and_then(Value::as_str) == Some("running") && bs != "running" && bs != "unknown" {
                    out.push((item.get("id").map(id_text).unwrap_or_default(), env.to_string(), bs.to_string()));
                }
            }
        }
    }
    out
}

fn do_refresh() -> Result<Value, String> {
    let prev = read_status();
    let next = collect();
    let tmp = PathBuf::from(format!("{}.{}.tmp", FILE.display(), std::process::id()));
    std::fs::write(&tmp, stringify(&next)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &*FILE).map_err(|e| e.to_string())?;
    let ended = finished(prev.as_ref(), &next);
    if !ended.is_empty() {
        let text = ended
            .iter()
            .map(|(id, env, state)| {
                let name = if env == "develop" { "develop" } else { "producción" };
                let word = match state.as_str() {
                    "success" => "desplegado",
                    "failed" => "ha fallado",
                    "cancelled" => "cancelado",
                    other => other,
                };
                format!("{id} en {name}: {word}")
            })
            .collect::<Vec<_>>()
            .join(" · ");
        std::thread::spawn(move || {
            crate::server::push::send_push("deploys", true, Some(&text));
        });
    }
    Ok(next)
}

pub fn refresh_status() -> Result<Value, String> {
    let (job, mine) = {
        let mut running = RUNNING.lock().unwrap();
        match running.as_ref() {
            Some(j) => (j.clone(), false),
            None => {
                let j: Refresh = Arc::new((Mutex::new(None), Condvar::new()));
                *running = Some(j.clone());
                (j, true)
            }
        }
    };
    if mine {
        let result = std::panic::catch_unwind(do_refresh).unwrap_or_else(|_| Err("fallo inesperado".into()));
        *job.0.lock().unwrap() = Some(result.clone());
        job.1.notify_all();
        *RUNNING.lock().unwrap() = None;
        return result;
    }
    let mut slot = job.0.lock().unwrap();
    while slot.is_none() {
        slot = job.1.wait(slot).unwrap();
    }
    slot.clone().unwrap()
}

fn schedule() {
    let generation = {
        let mut t = TIMER.lock().unwrap();
        *t += 1;
        *t
    };
    let delay = if any_running(read_status().as_ref()) { FAST } else { SLOW };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay));
        if *TIMER.lock().unwrap() != generation {
            return;
        }
        let _ = refresh_status();
        if *TIMER.lock().unwrap() == generation {
            schedule();
        }
    });
}

pub fn start_deploy_status() {
    if !crate::core::config::main_project().deploy_targets.iter().any(|t| truthy(t.get("repo"))) {
        return;
    }
    std::thread::spawn(|| {
        let _ = refresh_status();
        schedule();
    });
}

pub fn handle_deploy_status_refresh() -> Res {
    match refresh_status() {
        Ok(_) => {
            schedule();
            send(200, &Value::Null)
        }
        Err(e) => send(502, &json!({ "error": e })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_codedeploy_created_while_its_workflow_is_still_running_pairs_with_that_run() {
        let runs = vec![json!({ "id": 2, "status": "completed", "startedAt": "2026-11-18T14:46:22Z", "updatedAt": "2026-11-18T14:53:45Z" })];
        let deployments = vec![json!({ "id": "d-beta", "status": "Succeeded", "startedAt": "2026-11-18T14:51:29.725Z" })];
        assert_eq!(pair(&runs, &deployments).by_run["2"]["id"], "d-beta");
    }

    #[test]
    fn each_codedeploy_pairs_with_the_run_that_started_just_before_it() {
        let runs = vec![
            json!({ "id": 2, "status": "completed", "startedAt": "2026-11-18T14:10:00Z", "updatedAt": "2026-11-18T14:18:00Z" }),
            json!({ "id": 1, "status": "completed", "startedAt": "2026-11-18T14:00:00Z", "updatedAt": "2026-11-18T14:08:00Z" }),
        ];
        let deployments = vec![json!({ "id": "d-b", "status": "Succeeded", "startedAt": "2026-11-18T14:12:00Z" }), json!({ "id": "d-a", "status": "Succeeded", "startedAt": "2026-11-18T14:05:00Z" })];
        let p = pair(&runs, &deployments);
        assert_eq!(p.by_run["1"]["id"], "d-a");
        assert_eq!(p.by_run["2"]["id"], "d-b");
    }

    #[test]
    fn a_codedeploy_long_after_the_run_does_not_pair() {
        let runs = vec![json!({ "id": 1, "status": "completed", "startedAt": "2026-11-18T14:00:00Z", "updatedAt": "2026-11-18T14:08:00Z" })];
        assert_eq!(pair(&runs, &[json!({ "id": "d-x", "status": "Succeeded", "startedAt": "2026-11-18T15:00:00Z" })]).by_run.len(), 0);
    }
}
