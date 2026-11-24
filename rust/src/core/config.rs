//! Port of src/core/config.js.
use crate::core::json::stringify_pretty;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub fn workspace() -> PathBuf {
    let w = std::env::var("TOWER_WORKSPACE").or_else(|_| std::env::var("TORRE_ESPACIO")).map(PathBuf::from).unwrap_or_else(|_| repo());
    std::path::absolute(w).unwrap_or_default()
}

/// The dashboard-jira checkout (holds `src/page`, `node_modules/@xterm`, `templates`).
pub fn repo() -> PathBuf {
    std::env::var("TOWER_REPO").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf())
}

pub fn parse_env(file: &Path) -> HashMap<String, String> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$").unwrap());
    static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"(.*)"$|^'(.*)'$"#).unwrap());
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(file) else { return out };
    for line in text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if line.trim().starts_with('#') {
            continue;
        }
        if let Some(m) = LINE.captures(line) {
            let v = m[2].to_string();
            let v = QUOTED.captures(&v).map(|q| q.get(1).or(q.get(2)).unwrap().as_str().to_string()).unwrap_or(v);
            out.insert(m[1].to_string(), v);
        }
    }
    out
}

fn load_env(file: &Path) {
    for (k, v) in parse_env(file) {
        if std::env::var_os(&k).is_none() {
            unsafe { std::env::set_var(k, v) };
        }
    }
}

pub fn slug(s: &str) -> String {
    let folded: String = s.chars().flat_map(|c| fold(c)).collect::<String>().to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    if dash && !out.is_empty() && false {
        out.push('-');
    }
    out.chars().take(40).collect()
}

/// NFD and drop combining marks, for the letters the board can meet.
pub fn fold(c: char) -> Vec<char> {
    const FROM: &str = "ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇçÝýÿ";
    const TO: &str = "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCcYyy";
    match FROM.chars().position(|x| x == c) {
        Some(i) => vec![TO.chars().nth(i).unwrap()],
        None if ('\u{300}'..='\u{36f}').contains(&c) => vec![],
        None => vec![c],
    }
}

pub fn escape_regex(s: &str) -> String {
    regex::escape(s)
}

fn alternatives(xs: &[String]) -> String {
    xs.iter().map(|x| escape_regex(x)).collect::<Vec<_>>().join("|")
}

pub fn slashes(p: &str) -> String {
    p.replace('\\', "/")
}

#[derive(Clone)]
pub struct Jira {
    pub projects: Vec<String>,
    pub projects_jql: String,
    pub key_regex: Regex,
    pub me: Value,
    pub reviewer: Value,
    pub transitions: Value,
    pub default_issue_type: Option<String>,
}

#[derive(Clone)]
pub struct Statuses {
    pub review: String,
    pub returned: Vec<String>,
    pub review_regex: Regex,
    pub returned_regex: Regex,
    pub in_progress_regex: Regex,
    pub back_from_review_regex: Regex,
    pub closed_regex: Regex,
    pub reject_label: Value,
}

#[derive(Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub task_prefix: Value,
    pub messages: Value,
    pub daily: bool,
    pub context_tidy: bool,
    pub root: Option<PathBuf>,
    pub company: String,
    pub env_file: PathBuf,
    pub index: usize,
    pub commands_dir: Option<String>,
    pub source: String,
    pub jira: Option<Jira>,
    pub statuses: Option<Statuses>,
    pub follow_up: Vec<Value>,
    pub errors_area: Option<String>,
    pub sentry: Value,
    pub dev_servers: Vec<Value>,
    pub deploy_projects: Vec<String>,
    pub deploy_targets: Vec<Value>,
    pub context_domains: Option<PathBuf>,
    /// The definition this project was built from (file or panel).
    pub raw: Value,
    pub file_values: Option<Value>,
}

pub struct Credentials {
    pub site: String,
    pub email: String,
    pub token: String,
}

static ENV_CACHE: LazyLock<Mutex<HashMap<PathBuf, HashMap<String, String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

impl Project {
    pub fn secret(&self, name: &str) -> Option<String> {
        let mut cache = ENV_CACHE.lock().unwrap();
        let env = cache.entry(self.env_file.clone()).or_insert_with(|| parse_env(&self.env_file));
        if let Some(v) = env.get(name) {
            return Some(v.clone());
        }
        if self.index == 0 { std::env::var(name).ok() } else { None }
    }

    pub fn credentials(&self) -> Result<Credentials, String> {
        match (self.secret("JIRA_SITE"), self.secret("JIRA_EMAIL"), self.secret("JIRA_TOKEN")) {
            (Some(site), Some(email), Some(token)) if !site.is_empty() && !email.is_empty() && !token.is_empty() => Ok(Credentials { site, email, token }),
            _ => Err(format!("Missing JIRA_SITE, JIRA_EMAIL or JIRA_TOKEN in {} (copy .env.example).", self.env_file.display())),
        }
    }

    pub fn key_regex_global(&self) -> Option<Regex> {
        self.jira.as_ref().map(|j| j.key_regex.clone())
    }
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn ci(pattern: &str) -> Regex {
    Regex::new(&format!("(?i){pattern}")).unwrap()
}

pub fn build_project(p: &Value, index: usize) -> Result<Project, String> {
    let config_file = workspace().join("board.config.json");
    let id = s(p, "id").unwrap_or_default();
    if id.is_empty() || !Regex::new(r"^[a-z0-9][a-z0-9-]*$").unwrap().is_match(&id) {
        return Err(format!("{}: every project needs an id in lowercase letters, digits and dashes", config_file.display()));
    }
    let ws = workspace();
    let root = match s(p, "root") {
        Some(r) => Some(std::path::absolute(ws.join(r)).unwrap_or_default()),
        None if index == 0 => Some(normalize(&ws.join(".."))),
        None => None,
    };
    let env_file = normalize(&ws.join(s(p, "env").unwrap_or_else(|| if index == 0 { ".env".into() } else { format!(".env.{id}") })));
    let jira = p.get("jira").filter(|j| j.is_object()).map(|j| {
        let keys = strings(j.get("projects"));
        Jira {
            projects_jql: format!("project in ({})", keys.join(", ")),
            key_regex: Regex::new(&format!(r"\b(?:{})-\d+\b", alternatives(&keys))).unwrap(),
            projects: keys,
            me: j.get("me").cloned().unwrap_or(Value::Null),
            reviewer: j.get("reviewer").cloned().unwrap_or(Value::Null),
            transitions: j.get("transitions").cloned().filter(|v| !v.is_null()).unwrap_or(json!({})),
            default_issue_type: s(j, "defaultIssueType"),
        }
    });
    let statuses = p.get("statuses").filter(|v| v.is_object()).map(|st| {
        let returned = strings(st.get("returned"));
        let in_progress = strings(st.get("inProgress"));
        let closed = strings(st.get("closed"));
        let review = s(st, "review").unwrap_or_default();
        let both: Vec<String> = returned.iter().chain(in_progress.iter()).cloned().collect();
        Statuses {
            review_regex: ci(&escape_regex(&review)),
            returned_regex: ci(&format!("^({})$", alternatives(&returned))),
            in_progress_regex: ci(&format!("^({})$", alternatives(&in_progress))),
            back_from_review_regex: ci(&format!("^({})$", alternatives(&both))),
            closed_regex: ci(&format!("^({})$", alternatives(&closed))),
            reject_label: st.get("rejectLabel").cloned().unwrap_or(Value::Null),
            review,
            returned,
        }
    });
    let deploy_targets: Vec<Value> = p.get("deployProjects").and_then(|v| v.as_array()).map(|a| a.iter().map(|t| if t.is_string() { json!({ "id": t }) } else { t.clone() }).collect()).unwrap_or_default();
    Ok(Project {
        name: s(p, "name").or_else(|| s(p, "company")).unwrap_or_else(|| id.clone()),
        agent: s(p, "agent").unwrap_or_else(|| "claude".into()),
        task_prefix: p.get("taskPrefix").cloned().filter(|v| crate::core::json::truthy(Some(v))).unwrap_or(Value::Null),
        messages: p.get("messages").cloned().filter(|v| crate::core::json::truthy(Some(v))).unwrap_or(Value::Null),
        daily: p.get("daily").map(|v| crate::core::json::truthy(Some(v))).unwrap_or(index == 0),
        context_tidy: p.get("contextTidy").map(|v| crate::core::json::truthy(Some(v))).unwrap_or(index == 0),
        company: s(p, "company").or_else(|| s(p, "name")).unwrap_or_default(),
        commands_dir: root.as_ref().map(|r| slashes(&r.join(".claude").join("commands").to_string_lossy())),
        source: s(p, "source").unwrap_or_else(|| "file".into()),
        follow_up: p.get("followUp").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        errors_area: s(p, "errorsArea"),
        sentry: p.get("sentry").cloned().filter(|v| crate::core::json::truthy(Some(v))).unwrap_or(Value::Null),
        dev_servers: p.get("devServers").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        deploy_projects: deploy_targets.iter().filter_map(|t| t.get("id").and_then(|x| x.as_str()).map(String::from)).collect(),
        deploy_targets,
        context_domains: root.as_ref().map(|r| r.join(s(p, "contextDomains").unwrap_or_else(|| "context/dominios".into()))),
        id,
        root,
        env_file,
        index,
        jira,
        statuses,
        raw: p.clone(),
        file_values: None,
    })
}

/// `path.resolve` without touching the disk.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()).components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

const COMMON_KEYS: [&str; 9] = ["cluster", "trustedHosts", "voice", "sessionModel", "sessionProfiles", "launchdLabels", "dailyStyle", "boardAliveMinutes", "reviewerCriteria"];

pub struct Settings {
    pub common: Map<String, Value>,
    pub file_projects: Vec<Project>,
}

fn read_config() -> Value {
    let ws = workspace();
    let file = ws.join("board.config.json");
    let legacy = ws.join("tablero.config.json");
    if !file.exists() && legacy.exists() {
        panic!("{}: convert tablero.config.json with the Node version first", file.display());
    }
    std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| panic!("Missing or invalid {}: copy board.config.example.json and fill it in.", file.display()))
}

fn normalize_config(c: &Value) -> (Map<String, Value>, Vec<Value>, bool) {
    let mut common = Map::new();
    if let Some(list) = c.get("projects").and_then(|v| v.as_array()).filter(|a| a.first().map_or(false, |x| x.is_object())) {
        for k in COMMON_KEYS {
            if let Some(v) = c.get(k) {
                common.insert(k.into(), v.clone());
            }
        }
        return (common, list.clone(), false);
    }
    let company = c.get("company").and_then(|v| v.as_str()).unwrap_or("");
    let mut project = Map::new();
    project.insert("id".into(), Value::from(if slug(company).is_empty() { "main".to_string() } else { slug(company) }));
    project.insert("name".into(), Value::from(company));
    for (k, v) in c.as_object().cloned().unwrap_or_default() {
        if COMMON_KEYS.contains(&k.as_str()) {
            common.insert(k, v);
        } else {
            project.insert(k, v);
        }
    }
    (common, vec![Value::Object(project)], true)
}

pub static SETTINGS: LazyLock<Settings> = LazyLock::new(|| {
    let ws = workspace();
    let file = ws.join("board.config.json");
    let (common, raw, flat) = normalize_config(&read_config());
    if flat {
        let _ = std::fs::copy(&file, format!("{}.flat.bak", file.display()));
        let mut out = common.clone();
        out.insert("projects".into(), Value::Array(raw.clone()));
        let _ = std::fs::write(&file, stringify_pretty(&Value::Object(out), 2) + "\n");
    }
    let file_projects: Vec<Project> = raw.iter().enumerate().map(|(i, p)| build_project(p, i).unwrap_or_else(|e| panic!("{e}"))).collect();
    let mut ids: Vec<&str> = file_projects.iter().map(|p| p.id.as_str()).collect();
    ids.sort();
    ids.dedup();
    if ids.len() != file_projects.len() {
        panic!("{}: project ids must be unique", file.display());
    }
    let main = &file_projects[0];
    if main.jira.is_none() || main.statuses.is_none() {
        panic!("{}: the first project still needs jira and statuses", file.display());
    }
    if normalize(&main.env_file) == normalize(&ws.join(".env")) {
        load_env(&ws.join(".env"));
    }
    Settings { common, file_projects }
});

pub fn main_project() -> &'static Project {
    &SETTINGS.file_projects[0]
}

pub fn common(key: &str) -> Option<&'static Value> {
    SETTINGS.common.get(key).filter(|v| !v.is_null())
}

pub fn workspace_base() -> Option<PathBuf> {
    main_project().root.as_ref().and_then(|r| r.parent().map(Path::to_path_buf))
}

fn folder_root(folder: Option<&str>) -> Option<PathBuf> {
    let (f, base) = (folder?, workspace_base()?);
    let r = normalize(&base.join(f));
    r.exists().then_some(r)
}

pub fn local_projects_file() -> PathBuf {
    crate::core::data::DATA_DIR.join("projects-local.json")
}

pub fn local_projects() -> Value {
    crate::core::data::read_json(&local_projects_file(), json!({}))
}

static CACHE: LazyLock<Mutex<(i64, Option<Vec<Project>>)>> = LazyLock::new(|| Mutex::new((0, None)));

/// File projects with their panel overrides, plus projects added from the panel. Cached 3 s.
pub fn projects() -> Vec<Project> {
    let now = crate::core::time::now_ms();
    {
        let c = CACHE.lock().unwrap();
        if let Some(list) = &c.1 {
            if now - c.0 < 3000 {
                return list.clone();
            }
        }
    }
    ENV_CACHE.lock().unwrap().retain(|f, _| *f == main_project().env_file);
    let defs = crate::core::data::read_key("projectDefs").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let local = local_projects();
    let mut list: Vec<Project> = Vec::new();
    for base in &SETTINGS.file_projects {
        let mut p = base.clone();
        let fv = json!({ "name": base.name, "taskPrefix": base.task_prefix, "messages": base.messages, "daily": base.daily, "contextTidy": base.context_tidy });
        p.file_values = Some(fv.clone());
        let def = defs.get(&p.id).filter(|d| crate::core::json::truthy(d.get("override")) && !crate::core::json::truthy(d.get("removed")));
        let pick = |k: &str| def.and_then(|d| d.get(k)).cloned().unwrap_or_else(|| fv[k].clone());
        p.name = pick("name").as_str().unwrap_or("").to_string();
        p.task_prefix = pick("taskPrefix");
        p.messages = pick("messages");
        p.daily = crate::core::json::truthy(Some(&pick("daily")));
        p.context_tidy = crate::core::json::truthy(Some(&pick("contextTidy")));
        list.push(p);
    }
    let n = SETTINGS.file_projects.len();
    for def in defs.values() {
        let id = def.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if crate::core::json::truthy(def.get("removed")) || id.is_empty() || SETTINGS.file_projects.iter().any(|p| p.id == id) {
            continue;
        }
        let mut d = def.clone();
        let root = local.get(id).and_then(|l| l.get("root")).and_then(|r| r.as_str()).map(PathBuf::from).or_else(|| folder_root(def.get("folder").and_then(|v| v.as_str())));
        d["root"] = root.map(|r| Value::from(r.to_string_lossy().to_string())).unwrap_or(Value::Null);
        d["source"] = Value::from("panel");
        if let Ok(p) = build_project(&d, n + list.len() - n) {
            list.push(p);
        }
    }
    *CACHE.lock().unwrap() = (now, Some(list.clone()));
    list
}

pub fn forget_projects() {
    *CACHE.lock().unwrap() = (0, None);
    ENV_CACHE.lock().unwrap().clear();
}

pub fn project(id: &str) -> Option<Project> {
    projects().into_iter().find(|p| p.id == id)
}

pub fn cli() -> String {
    format!("node {}", slashes(&workspace().join("board.js").to_string_lossy()))
}

pub fn trusted_hosts() -> Vec<String> {
    strings(common("trustedHosts"))
}

pub fn cluster() -> Option<&'static Value> {
    common("cluster")
}

pub fn voice() -> Value {
    common("voice").cloned().unwrap_or(json!({}))
}

pub fn session_model() -> String {
    common("sessionModel").and_then(|v| v.as_str()).unwrap_or("claude-opus-5-5").to_string()
}

pub fn session_profiles() -> Option<&'static Value> {
    common("sessionProfiles")
}

pub fn launchd_labels() -> Vec<String> {
    let mut l = vec!["com.nutria.".to_string()];
    l.extend(strings(common("launchdLabels")));
    l
}

pub fn board_alive_minutes() -> f64 {
    common("boardAliveMinutes").and_then(|v| v.as_f64()).filter(|n| *n > 0.0).unwrap_or(5.0)
}

pub fn daily_style() -> Option<PathBuf> {
    common("dailyStyle").and_then(|v| v.as_str()).map(|s| normalize(&workspace().join(s)))
}

/// `config.forPage()`.
pub fn for_page() -> Value {
    let main = main_project();
    let j = main.jira.as_ref().unwrap();
    let st = main.statuses.as_ref().unwrap();
    let all = projects();
    json!({
        "jiraUrl": format!("https://{}/browse/", main.secret("JIRA_SITE").unwrap_or_default()),
        "jiraSites": all.iter().filter_map(|p| {
            let jira = p.jira.as_ref()?;
            let site = p.secret("JIRA_SITE").unwrap_or_default();
            (!site.is_empty()).then(|| json!({ "projects": jira.projects, "url": format!("https://{site}/browse/") }))
        }).collect::<Vec<_>>(),
        "projects": j.projects,
        "me": { "name": j.me.get("name").cloned().unwrap_or(Value::Null) },
        "reviewer": { "name": j.reviewer.get("name").cloned().unwrap_or(Value::Null) },
        "reviewStatus": st.review,
        "deployProjects": main.deploy_projects,
        "workspaceBase": workspace_base().map(|b| slashes(&b.to_string_lossy())),
        "workspaces": all.iter().map(|p| json!({
            "id": p.id,
            "name": p.name,
            "jira": p.jira.is_some(),
            "modules": {
                "jira": p.jira.is_some(),
                "followUp": !p.follow_up.is_empty(),
                "sentry": crate::core::json::truthy(p.sentry.get("org")),
                "deploy": !p.deploy_projects.is_empty(),
                "devServers": !p.dev_servers.is_empty(),
                "context": p.context_tidy && p.root.as_ref().map_or(false, |r| r.exists()),
                "daily": p.daily,
            },
            "source": p.source,
        })).collect::<Vec<_>>(),
    })
}

pub fn reviewer_criteria() -> Option<String> {
    common("reviewerCriteria").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub fn is_reviewer(project_id: &str, who: &str) -> bool {
    let p = project(project_id).unwrap_or_else(|| main_project().clone());
    let name = p.jira.as_ref().and_then(|j| j.reviewer.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let first = name.split_whitespace().next().unwrap_or("");
    let who = who.to_lowercase();
    !first.is_empty() && !who.is_empty() && (who.contains(&name) || name.contains(&who) || who.split_whitespace().next() == Some(first))
}

pub fn cause_advice(cause: &str) -> String {
    let criteria = reviewer_criteria();
    match (cause, criteria) {
        ("new", Some(c)) => format!("Como es nueva, añade su línea a {c}: qué mira el revisor, en una frase."),
        ("new", None) => String::new(),
        ("written", _) => "Ya estaba escrita: revisa por qué el agente revisor no lo vio antes de entregarla y apúntalo donde corresponda para que la próxima vez lo vea.".into(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod reviewer_tests {
    #[test]
    fn a_comment_counts_as_the_reviewers_by_first_name_or_full_name() {
        let _g = crate::testkit::fresh();
        assert!(super::is_reviewer("", "Reviewer"));
        assert!(super::is_reviewer("", "reviewer smith"));
        assert!(!super::is_reviewer("", "Someone Else"));
        assert!(!super::is_reviewer("", ""));
    }
}
