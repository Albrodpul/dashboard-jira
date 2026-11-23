//! Port of src/features/daily.js.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Condvar, LazyLock, Mutex};

use chrono::{Datelike, NaiveDate};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::core::config::{self, Project};
use crate::core::data::{DATA_DIR, Doc, load, mutate, now, read_key};
use crate::core::json::truthy;
use crate::core::time::{madrid, now_ms, parse};
use crate::sessions::registry::{RunOptions, run_bounded};

static RUNNING: LazyLock<(Mutex<HashSet<String>>, Condvar)> = LazyLock::new(|| (Mutex::new(HashSet::new()), Condvar::new()));
static TRIED: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NOISE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|/)(lang|locales|i18n)/|\.lock$|lock\.json$").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn project_for(id: Option<&str>) -> Project {
    let main = config::main_project();
    let wanted = id.filter(|x| !x.is_empty()).map(str::to_string).unwrap_or_else(|| main.id.clone());
    config::project(&wanted).unwrap_or_else(|| main.clone())
}

fn is_main(p: &Project) -> bool {
    p.id == config::main_project().id
}

fn day_of_ms(ms: i64) -> String {
    madrid(ms).day
}

fn day_of_iso(iso: Option<&Value>) -> Option<String> {
    iso.and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(parse).map(day_of_ms)
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => x.as_str().map(str::to_string).unwrap_or_else(|| crate::core::json::stringify(x)),
        _ => String::new(),
    }
}

fn slice_units(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n { s.to_string() } else { String::from_utf16_lossy(&units[..n]) }
}

pub fn last_workday(from_ms: Option<i64>) -> String {
    let mut ms = from_ms.unwrap_or_else(now_ms);
    loop {
        ms -= 86_400_000;
        if !madrid(ms).weekend {
            return day_of_ms(ms);
        }
    }
}

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let mut all: Vec<String> = vec!["-C".into(), dir.to_string_lossy().into_owned()];
    all.extend(args.iter().map(|a| a.to_string()));
    let r = run_bounded("git", &all, &RunOptions { cwd: None, env: None }, 20000);
    if r.ok { r.out.trim().to_string() } else { String::new() }
}

fn repos(p: &Project) -> Vec<(String, PathBuf)> {
    let Some(root) = p.root.clone().filter(|r| r.exists()) else { return Vec::new() };
    if root.join(".git").exists() && !is_main(p) {
        return vec![(p.name.clone(), root)];
    }
    let mut names: Vec<String> = std::fs::read_dir(&root).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names.into_iter().map(|n| (n.clone(), root.join(n))).filter(|(_, d)| d.join(".git").exists()).collect()
}

fn commits_of(day: &str, p: &Project) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (name, dir) in repos(p) {
        let email = git(&dir, &["config", "user.email"]);
        if email.is_empty() {
            continue;
        }
        let author = format!("--author={email}");
        let since = format!("--since={day} 00:00");
        let log = git(&dir, &["log", "--all", "--no-merges", &author, &since, "--date=short", "--name-only", "--format=@@%ad|%s"]);
        for chunk in log.split("@@").filter(|c| !c.is_empty()) {
            let lines: Vec<&str> = chunk.split('\n').map(str::trim).filter(|l| !l.is_empty()).collect();
            let Some((head, files)) = lines.split_first() else { continue };
            let prefix = format!("{day}|");
            if !head.starts_with(&prefix) {
                continue;
            }
            let subject = &head[prefix.len()..];
            if !seen.insert(format!("{name}{subject}")) {
                continue;
            }
            let mut dirs: Vec<String> = Vec::new();
            for f in files.iter().filter(|f| !NOISE.is_match(f)) {
                let short = f.split('/').take(3).collect::<Vec<_>>().join("/");
                if !dirs.contains(&short) {
                    dirs.push(short);
                }
            }
            dirs.truncate(8);
            let touched = if dirs.is_empty() { String::new() } else { format!(" [toca: {}]", dirs.join(", ")) };
            out.push(format!("{name}: {subject}{touched}"));
        }
    }
    out
}

pub fn errors_of(day: &str, p: Option<&Project>) -> Vec<String> {
    let p = p.cloned().unwrap_or_else(|| config::main_project().clone());
    if !is_main(&p) {
        return Vec::new();
    }
    let d = load();
    let on = |v: Option<&Value>| day_of_iso(v).as_deref() == Some(day);
    let mut out: Vec<String> = d
        .get("sentry")
        .and_then(Value::as_object)
        .map(|o| {
            o.values()
                .filter(|x| on(x.get("sentAt")) || on(x.get("closedAt")))
                .map(|x| {
                    let result = if truthy(x.get("result")) { format!(" — {}", slice_units(&str_of(x.get("result")), 200)) } else { String::new() };
                    format!("Sentry: {}{result}", slice_units(&str_of(x.get("title")), 160))
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(reports) = d.get("followUps").and_then(Value::as_array) {
        for e in reports.iter().flat_map(|r| r.get("errors").and_then(Value::as_array).cloned().unwrap_or_default()) {
            if on(e.get("sentAt")) {
                out.push(format!("Seguimiento: {}", slice_units(&SPACES.replace_all(&str_of(e.get("text")), " "), 200)));
            }
        }
    }
    out
}

fn write(prompt: &str) -> Option<String> {
    let agent = crate::agents::index::main();
    let args = agent.one_shot_args(&json!({ "prompt": prompt, "model": config::session_model() }));
    let (exe, args) = agent.command(&args, None);
    let opts = RunOptions { cwd: config::main_project().root.clone(), env: Some(crate::sessions::registry::clean_env()) };
    let r = run_bounded(&exe, &args, &opts, 180000);
    if r.ok { Some(r.out.trim().to_string()) } else { None }
}

pub fn tasks_of(day: &str, p: Option<&Project>) -> Vec<String> {
    let p = p.cloned().unwrap_or_else(|| config::main_project().clone());
    let d = load();
    let on = |v: Option<&Value>| day_of_iso(v).as_deref() == Some(day);
    let mut seen: Map<String, Value> = Map::new();
    if let Ok(history) = std::fs::read_to_string(DATA_DIR.join("task-history.jsonl")) {
        for line in history.split('\n').filter(|l| !l.is_empty()) {
            let Ok(t) = serde_json::from_str::<Value>(line) else { break };
            if on(t.get("sentAt")) && crate::core::projects::project_of(&t) == p.id {
                seen.insert(str_of(t.get("key")), t);
            }
        }
    }
    if let Some(tasks) = d.get("tasks").and_then(Value::as_object) {
        for t in tasks.values() {
            if on(t.get("sentAt")) && crate::core::projects::project_of(t) == p.id {
                seen.insert(str_of(t.get("key")), t.clone());
            }
        }
    }
    let routes = crate::sessions::registry::load_routes();
    let area_name = |id: &str| routes.get("areas").and_then(|a| a.get(id)).and_then(|a| a.get("title")).filter(|t| truthy(Some(t))).map(|t| str_of(Some(t))).unwrap_or_else(|| id.to_string());
    seen.values()
        .map(|t| {
            let kind = if text(t, "kind") == "returned" { "Devuelta por el revisor" } else { "Nueva" };
            let epic = if truthy(t.get("epicName")) { format!(" (épica: {})", str_of(t.get("epicName"))) } else { String::new() };
            let area = if truthy(t.get("area")) { format!(" [sesión: {}]", area_name(&str_of(t.get("area")))) } else { String::new() };
            let partial = if text(t, "status") == "partial" { " [a medias]" } else { "" };
            format!("{kind}: {}{epic}{area}{partial}", str_of(t.get("title")))
        })
        .collect()
}

fn long_date(day: &str) -> String {
    let Ok(d) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else { return "Invalid Date".into() };
    let weekdays = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
    let months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    format!("{}, {} de {}", weekdays[d.weekday().num_days_from_monday() as usize], d.day(), months[d.month0() as usize])
}

fn daily_prompt(p: &Project, day: &str, tasks: &[String], commits: &[String], errors: &[String]) -> String {
    let date = long_date(day);
    let or = |list: &[String], none: &str| if list.is_empty() { vec![none.to_string()] } else { list.to_vec() };
    let mut lines: Vec<String> = vec![
        format!("Redacta el resumen de la daily del proyecto «{}» con lo que se hizo el {date}. Devuelve solo el resumen, en texto plano: sin markdown, sin #, sin asteriscos, sin guiones ni viñetas.", p.name),
        "El objetivo es que se entienda de un vistazo qué se hizo y dónde, sin mezclar áreas ni aplicaciones en la misma frase.".into(),
        String::new(),
        "Formato exacto:".into(),
        format!("Primera línea: «Resumen del {date}». Después una línea en blanco."),
        "Luego una línea por tema, sin línea en blanco entre ellas. Cada línea es una o dos frases en primera persona que ya dicen qué se hizo, en qué aplicación (la web, el backoffice, el back, Donatella, la app) y, si aporta, para qué o cómo. Nada de etiquetas tipo «Qué:» o «Dónde:», ni títulos de sección.".into(),
        "Lo que es la misma funcionalidad en front y back va en la misma línea; lo de áreas distintas, en líneas distintas. Pon seguidas las líneas de la misma área y ordena de más a menos trabajo. Los errores arreglados y lo revisado van al final, agrupados en una línea si son pocos. Sale toda tarea mandada, aunque no tenga commits (investigaciones, configuración, revisiones).".into(),
        String::new(),
        "Ejemplo del tono y la forma (no del contenido):".into(),
        "He estado añadiendo que en la web también se pueda entrar con teléfono y código. Si el teléfono ya pertenece a otra cuenta, se avisa mostrando parte del correo al que pertenece y he cambiado algunos copies de validación del flujo del login".into(),
        "En el backoffice ahora se muestra en el perfil del usuario la forma de login y se puede mover su login con Google de una cuenta a otra para evitar duplicidades de cuentas de Google".into(),
        "He añadido la ruta del QR de iOS para la suplantación en la web".into(),
        "He revisado algunos errores que ha ido generando Enric: un error de actualización de precios con cambios de moneda y que se podían duplicar las reservas de transporte".into(),
        String::new(),
        "Estilo: español de España, frases llanas y claras, sin punto final en cada línea, sin guiones ni viñetas, sin claves de Jira, sin nombres de ficheros ni emojis. Los cambios de textos son «copies». No menciones despliegues. No inventes nada que no salga de los datos.".into(),
        String::new(),
        "Tareas mandadas ese día desde el tablero (la sesión indica el área en la que se trabajó):".into(),
    ];
    lines.extend(or(tasks, "(ninguna)"));
    lines.push(String::new());
    lines.push("Commits de ese día por repositorio (en inglés y técnicos; entre corchetes, las carpetas que tocan, para saber dónde):".into());
    lines.extend(or(commits, "(ninguno)"));
    lines.push(String::new());
    lines.push("Errores de Sentry o del seguimiento que se mandaron arreglar ese día:".into());
    lines.extend(or(errors, "(ninguno)"));
    lines.join("\n")
}

fn make_daily(day: &str, p: &Project) {
    let commits = commits_of(day, p);
    let errors = errors_of(day, Some(p));
    let tasks = tasks_of(day, Some(p));
    if commits.is_empty() && errors.is_empty() && tasks.is_empty() {
        save_daily(day, json!({ "day": day, "text": "", "empty": true, "at": now() }), p);
        return;
    }
    let prompt = daily_prompt(p, day, &tasks, &commits, &errors);
    if let Some(text) = write(&prompt).filter(|t| !t.is_empty()) {
        save_daily(day, json!({ "day": day, "text": text, "at": now() }), p);
    }
}

fn keep_last_ten(all: &mut Map<String, Value>) {
    let mut keys: Vec<String> = all.keys().cloned().collect();
    keys.sort();
    let drop = keys.len().saturating_sub(10);
    for k in keys.into_iter().take(drop) {
        all.shift_remove(&k);
    }
}

fn save_daily(day: &str, entry: Value, p: &Project) {
    if !is_main(p) {
        let id = p.id.clone();
        mutate(move |d| {
            let mut by = d.get("projectDailies").and_then(Value::as_object).cloned().unwrap_or_default();
            let mut all = by.get(&id).and_then(Value::as_object).cloned().unwrap_or_default();
            all.insert(day.to_string(), entry);
            keep_last_ten(&mut all);
            by.insert(id, Value::Object(all));
            d.insert("projectDailies".into(), Value::Object(by));
        });
        return;
    }
    mutate(move |d| {
        let mut all = d.get("dailies").and_then(Value::as_object).cloned().unwrap_or_default();
        if let Some(old) = d.get("daily").filter(|x| truthy(x.get("day"))) {
            let k = str_of(old.get("day"));
            if !truthy(all.get(&k)) {
                all.insert(k, old.clone());
            }
        }
        all.insert(day.to_string(), entry);
        keep_last_ten(&mut all);
        d.insert("dailies".into(), Value::Object(all));
        d.shift_remove("daily");
    });
}

fn today() -> String {
    day_of_ms(now_ms())
}

fn entries_of(d: &Doc, p: &Project) -> Map<String, Value> {
    if !is_main(p) {
        return d.get("projectDailies").and_then(|x| x.get(&p.id)).and_then(Value::as_object).cloned().unwrap_or_default();
    }
    let mut all = d.get("dailies").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(old) = d.get("daily").filter(|x| truthy(x.get("day"))) {
        let k = str_of(old.get("day"));
        if !truthy(all.get(&k)) {
            all.insert(k, old.clone());
        }
    }
    all
}

fn is_running(id: &str) -> bool {
    RUNNING.0.lock().unwrap_or_else(|p| p.into_inner()).contains(id)
}

pub fn daily_state(project_id: Option<&str>) -> Value {
    let p = project_for(project_id);
    let mut d = Doc::new();
    for k in ["dailies", "daily", "projectDailies"] {
        if let Some(v) = read_key(k) {
            d.insert(k.into(), v);
        }
    }
    let all = entries_of(&d, &p);
    let prev = last_workday(None);
    let today = today();
    let pick = |k: &str| all.get(k).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
    json!({ "project": p.id, "prevDay": prev, "prev": pick(&prev), "today": today, "todayText": pick(&today), "busy": is_running(&p.id) })
}

pub fn daily_states() -> Value {
    let mut out = Map::new();
    for p in config::projects() {
        if p.daily && p.root.is_some() {
            out.insert(p.id.clone(), daily_state(Some(&p.id)));
        }
    }
    Value::Object(out)
}

pub fn daily_for(day: Option<&str>, auto: bool, project_id: Option<&str>) {
    let p = project_for(project_id);
    let key = format!("{}|{}", p.id, day.unwrap_or("undefined"));
    {
        let mut tried = TRIED.lock().unwrap_or_else(|x| x.into_inner());
        if auto && tried.get(&key).is_some_and(|at| now_ms() - at < 60 * 60000) {
            return;
        }
        tried.insert(key, now_ms());
    }
    let (lock, signal) = &*RUNNING;
    let mut running = lock.lock().unwrap_or_else(|x| x.into_inner());
    if running.contains(&p.id) {
        while running.contains(&p.id) {
            running = signal.wait(running).unwrap_or_else(|x| x.into_inner());
        }
        return;
    }
    running.insert(p.id.clone());
    drop(running);
    let wanted = day.filter(|x| !x.is_empty()).map(str::to_string).unwrap_or_else(|| last_workday(None));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| make_daily(&wanted, &p)));
    lock.lock().unwrap_or_else(|x| x.into_inner()).remove(&p.id);
    signal.notify_all();
    if let Err(e) = outcome {
        std::panic::resume_unwind(e);
    }
}

pub fn daily_if_missing() {
    if !crate::cluster::cluster::is_primary() {
        return;
    }
    for p in config::projects() {
        if !p.daily || p.root.is_none() {
            continue;
        }
        let d = load();
        let t = crate::core::hours::clock();
        let today = today();
        if !t.weekend && t.min >= crate::core::hours::daily_min() && !truthy(entries_of(&d, &p).get(&today)) {
            daily_for(Some(&today), true, Some(&p.id));
            continue;
        }
        let day = last_workday(None);
        if !truthy(entries_of(&d, &p).get(&day)) {
            daily_for(Some(&day), true, Some(&p.id));
        }
    }
}

