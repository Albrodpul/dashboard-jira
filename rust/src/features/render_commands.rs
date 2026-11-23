//! Port of src/features/render-commands.js.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::core::config::{self, Project, slashes};

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{([A-Z]+)\}\}").unwrap());

fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "undefined".into(),
        Value::String(s) => s.clone(),
        other => crate::core::json::stringify(other),
    }
}

fn name_of(person: &Value) -> Option<String> {
    person.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn path_text(p: &Path) -> String {
    slashes(&p.to_string_lossy())
}

fn values_for(p: &Project) -> Vec<(&'static str, String)> {
    let main = config::main_project();
    let main_me = main.jira.as_ref().and_then(|j| name_of(&j.me)).unwrap_or_else(|| "undefined".into());
    let me = p.jira.as_ref().and_then(|j| name_of(&j.me)).unwrap_or(main_me);
    let st = p.statuses.as_ref().or(if p.jira.is_some() { main.statuses.as_ref() } else { None });
    vec![
        ("ROOT", p.root.as_deref().map(path_text).unwrap_or_else(|| "undefined".into())),
        ("WORKSPACE", path_text(&config::workspace())),
        ("REPO", path_text(&config::repo())),
        ("ME", me.clone()),
        ("REVIEWER", p.jira.as_ref().and_then(|j| name_of(&j.reviewer)).unwrap_or(me)),
        ("COMPANY", p.company.clone()),
        ("PROJECTS", p.jira.as_ref().map(|j| j.projects.join("/")).unwrap_or_default()),
        ("JQLPROJECTS", p.jira.as_ref().map(|j| j.projects_jql.clone()).unwrap_or_default()),
        ("REJECTLABEL", st.map(|s| js_string(&s.reject_label)).unwrap_or_default()),
        ("RETURNED", st.map(|s| s.returned.join("»/«")).unwrap_or_default()),
    ]
}

fn wanted(p: &Project, f: &str) -> bool {
    p.id == config::main_project().id || f == "soy.md" || (f == "resumen-jira.md" && p.jira.is_some()) || (f == "seguimiento.md" && !p.follow_up.is_empty())
}

pub fn render_project(p: &Project, warn: Option<&dyn Fn(&str)>) -> Result<Value, String> {
    let repo = config::repo();
    let templates = repo.join("templates").join("commands");
    let values = values_for(p);
    let render = |text: &str| {
        PLACEHOLDER
            .replace_all(text, |c: &regex::Captures| values.iter().find(|(k, _)| *k == &c[1]).map(|(_, v)| v.clone()).unwrap_or_else(|| c[0].to_string()))
            .into_owned()
    };
    let out = p.root.clone().unwrap_or_default().join(".claude").join("commands");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = std::fs::read_dir(&templates).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|x| x.ends_with(".md") && wanted(p, x)).collect();
    names.sort();
    let mut written = Vec::new();
    for f in names {
        let basic = repo.join("templates").join("basic").join(&f);
        let source = if p.jira.is_none() && basic.exists() { basic } else { templates.join(&f) };
        let text = render(&std::fs::read_to_string(&source).map_err(|e| e.to_string())?);
        let mut missing: Vec<String> = Vec::new();
        for m in PLACEHOLDER.find_iter(&text) {
            if !missing.iter().any(|x| x == m.as_str()) {
                missing.push(m.as_str().to_string());
            }
        }
        if let (false, Some(w)) = (missing.is_empty(), warn) {
            w(&format!("warning: {f} has placeholders without a value: {}", missing.join(", ")));
        }
        std::fs::write(out.join(&f), text).map_err(|e| e.to_string())?;
        written.push(f);
    }
    Ok(json!({ "folder": path_text(&out), "files": written }))
}

pub fn render_all(log: Option<&dyn Fn(&str)>) {
    let print = |s: &str| println!("{s}");
    let log: &dyn Fn(&str) = log.unwrap_or(&print);
    let main_id = config::main_project().id.clone();
    for p in config::projects() {
        if p.id != main_id && !p.root.as_ref().is_some_and(|r| r.exists()) {
            let why = match &p.root {
                Some(r) => format!("{} does not exist", path_text(r)),
                None => "no folder on this machine".into(),
            };
            log(&format!("skipped {}: {why}", p.id));
            continue;
        }
        match render_project(&p, Some(log)) {
            Ok(r) => log(&format!("commands ({}) → {}", p.id, r["folder"].as_str().unwrap_or(""))),
            Err(e) => log(&e),
        }
    }
}
