//! Port of src/server/smoke.js.
use crate::core::data::{BASE_URL, DATA_DIR};
use crate::core::json::{parse, stringify};
use regex::Regex;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::LazyLock;

static FILE: LazyLock<PathBuf> = LazyLock::new(|| DATA_DIR.join("smoke.json"));
const VIEWS: [&str; 15] = ["home", "pending", "approved", "sent", "waiting", "done", "ignored", "find", "projects", "deploy", "sentry", "context", "follow-up", "sessions", "machines"];
const PHONE_VIEWS: [&str; 3] = ["today", "pending", "more"];
static CUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)has been closed|Target closed|browser has disconnected").unwrap());

const DRIVER: &str = r#"
const [pwPath, base, viewsJson, phoneJson] = process.argv.slice(1);
const pw = require(pwPath);
async function visit(page, view, problems) {
  const errors = [];
  const onError = (e) => errors.push(String(e.message || e).slice(0, 200));
  const onConsole = (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 200));
  page.on("pageerror", onError);
  page.on("console", onConsole);
  await page.evaluate((v) => localStorage.setItem("board-tab", v), view);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => {
    const g = document.getElementById("groups");
    return { children: g ? g.children.length : 0, down: /El tablero no responde/.test(document.body.innerText) };
  });
  page.off("pageerror", onError);
  page.off("console", onConsole);
  if (!body.children) errors.push("la vista sale vacía");
  if (body.down) errors.push("dice que el tablero no responde");
  for (const e of errors) problems.push(`${view}: ${e}`);
}
(async () => {
  const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
  const problems = [];
  try {
    const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const open = new Map();
    desk.on("request", (r) => open.set(r, r.url()));
    desk.on("requestfinished", (r) => open.delete(r));
    desk.on("requestfailed", (r) => open.set(r, r.url() + " (" + ((r.failure() && r.failure().errorText) || "falló") + ")"));
    try {
      await desk.goto(base, { waitUntil: "domcontentloaded" });
    } catch (e) {
      throw new Error(String(e.message || e).split("\n")[0] + " · sin terminar: " + [...open.values()].map((u) => u.replace(base, "")).slice(0, 8).join(", "));
    }
    for (const v of JSON.parse(viewsJson)) await visit(desk, v, problems);
    const phone = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    await phone.goto(base, { waitUntil: "domcontentloaded" });
    for (const v of JSON.parse(phoneJson)) await visit(phone, `${v}`, problems);
  } finally {
    await browser.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify({ problems }) + "\n");
})().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String(e.message || e) }) + "\n");
  process.exit(1);
});
"#;

fn head() -> Option<String> {
    let out = crate::core::platform::cmd("git").arg("-C").arg(crate::core::config::repo()).args(["rev-parse", "--short", "HEAD"]).stderr(std::process::Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn playwright() -> Option<PathBuf> {
    let root = crate::core::config::main_project().root.clone()?;
    let p = root.join("scripts").join("mcp").join("node_modules").join("playwright");
    p.exists().then_some(p)
}

pub fn run_smoke() -> Result<Value, String> {
    let Some(pw) = playwright() else { return Ok(json!({ "skipped": "no está instalado Playwright en scripts/mcp" })) };
    let out = crate::core::platform::cmd("node")
        .arg("-e")
        .arg(DRIVER)
        .arg(pw)
        .arg(&*BASE_URL)
        .arg(stringify(&json!(VIEWS)))
        .arg(stringify(&json!(PHONE_VIEWS)))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.lines().rev().find(|l| !l.trim().is_empty()).and_then(parse);
    match last {
        Some(v) if v.get("problems").is_some() => Ok(v),
        Some(v) => Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("error").to_string()),
        None => Err(format!("node terminó con {}", out.status)),
    }
}

fn memory_free_percent() -> Option<u32> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = crate::core::platform::cmd("/usr/bin/memory_pressure").stderr(std::process::Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("free percentage"))?;
    line.rsplit(':').next()?.trim().trim_end_matches('%').parse().ok()
}

pub fn smoke_after_update() {
    if !crate::cluster::cluster::is_primary() {
        return;
    }
    for _ in 0..12 {
        match memory_free_percent() {
            Some(free) if free < 40 => std::thread::sleep(std::time::Duration::from_secs(300)),
            _ => break,
        }
    }
    let now = head();
    let last = crate::core::data::read_json(&FILE, json!({}));
    let Some(now) = now else { return };
    if last.get("head").and_then(|h| h.as_str()) == Some(now.as_str()) {
        return;
    }
    let mut result = run_smoke().unwrap_or_else(|e| {
        let msg: String = e.chars().take(200).collect();
        json!({ "problems": [format!("no se pudo lanzar la prueba: {msg}")], "cut": CUT.is_match(&e) })
    });
    if crate::core::json::truthy(result.get("cut")) || head().as_deref() != Some(now.as_str()) {
        return;
    }
    if let Some(m) = result.as_object_mut() {
        m.remove("cut");
    }
    let mut saved = serde_json::Map::new();
    saved.insert("head".to_string(), json!(now));
    saved.insert("at".to_string(), json!(crate::core::time::now()));
    for (k, v) in result.as_object().cloned().unwrap_or_default() {
        saved.insert(k, v);
    }
    let _ = crate::core::data::write_json_pretty(&FILE, &Value::Object(saved), 1);
    let problems: Vec<String> = result.get("problems").and_then(|p| p.as_array()).map(|a| a.iter().map(|x| x.as_str().map(|s| s.to_string()).unwrap_or_else(|| stringify(x))).collect()).unwrap_or_default();
    if problems.is_empty() {
        return;
    }
    let routes = crate::sessions::registry::load_routes();
    let Some(session) = routes.get("board").and_then(|b| b.get("session")).and_then(|s| s.as_str()).filter(|s| !s.is_empty()) else { return };
    let list = problems.iter().take(8).cloned().collect::<Vec<_>>().join("; ");
    crate::sessions::registry::wake_session(
        session,
        Some(&format!("Aviso del tablero: la prueba automática del tablero ha fallado con el commit {now}: {list}. Revísalo y arréglalo; si no es un fallo del tablero, dilo en una línea.")),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_playwright_the_smoke_test_is_skipped() {
        let _g = crate::testkit::fresh();
        if playwright().is_none() {
            assert_eq!(run_smoke().unwrap()["skipped"], "no está instalado Playwright en scripts/mcp");
        }
    }

    #[test]
    fn a_browser_cut_is_recognised() {
        assert!(CUT.is_match("Target closed"));
        assert!(CUT.is_match("browser has disconnected"));
        assert!(!CUT.is_match("timeout"));
    }
}
