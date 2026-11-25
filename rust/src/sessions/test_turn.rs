//! Port of src/sessions/test-turn.js.
use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

pub const MAX_PASSES: usize = 2;
const FIRST: usize = 6;
const SECOND: usize = 3;
const CLAIM_MS: i64 = 20000;
const HARD_MAX_PASSES: usize = 4;
const WORKER_GB: f64 = 0.45;
const RESERVE_GB: f64 = 3.0;
const MIN_FREE_PCT: f64 = 20.0;
const BROWSER_FREE_PCT: f64 = 12.0;

static RUN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|&&|\|\||[;|(\n])\s*(?:[A-Za-z0-9_]+=\S*\s+)*(?:(?:\S*/)?php[0-9.]*\s+)?(?:\S*/)?(?:artisan\s+test|vendor/bin/(?:phpunit|paratest))(?:\s|$|[;&|)])").unwrap()
});
static TEST_PROC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bartisan\s+test\b|vendor/bin/(?:phpunit|paratest)\b|paratest/bin/|phpunit-wrapper").unwrap());
static PHP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\S*/)?php(?:[0-9.]+)?(?:\s|$)").unwrap());
static HEREDOC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^<<-?\s*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|([A-Za-z0-9_]+))"#).unwrap());
static PARALLEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"--parallel\b").unwrap());
static PROCESSES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"--processes([=\s]+)([0-9]+)").unwrap());
static WORKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"phpunit-wrapper|paratest/bin/phpunit").unwrap());
static BROWSER_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bplaywright\b").unwrap());
static PS_ROW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(\d+)\s+(.*)$").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub struct Process {
    pub pid: String,
    pub ppid: String,
    pub cmd: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub kind: &'static str,
    pub reason: Option<String>,
    pub command: Option<String>,
}

impl Plan {
    fn of(kind: &'static str) -> Plan {
        Plan { kind, reason: None, command: None }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Load {
    pub cores: f64,
    pub load1: f64,
    pub mem_gb: f64,
    pub free_pct: f64,
    pub critical: bool,
}

#[derive(Default)]
pub struct DecideOptions<'a> {
    pub list: Option<&'a [Process]>,
    pub file: Option<PathBuf>,
    pub now_ms: Option<i64>,
    pub load: Option<Option<Load>>,
}

fn sysctl(names: &[&str]) -> Option<Vec<String>> {
    let out = crate::core::platform::cmd("/usr/sbin/sysctl").arg("-n").args(names).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let lines: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).collect();
    (lines.len() == names.len()).then_some(lines)
}

pub fn measure() -> Option<Load> {
    let v = sysctl(&["hw.ncpu", "hw.memsize", "vm.loadavg", "kern.memorystatus_level", "kern.memorystatus_vm_pressure_level"])?;
    let load1 = v[2].trim_start_matches('{').split_whitespace().next()?.parse().ok()?;
    Some(Load {
        cores: v[0].parse().ok()?,
        load1,
        mem_gb: v[1].parse::<f64>().ok()? / 1073741824.0,
        free_pct: v[3].parse().ok()?,
        critical: v[4].parse::<u32>().ok()? >= 4,
    })
}

fn describe(l: &Load) -> String {
    format!("carga {:.1} de {} núcleos, {:.0} % de memoria libre{}", l.load1, l.cores, l.free_pct, if l.critical { ", presión de memoria crítica" } else { "" })
}

pub fn budget(l: &Load, passes: usize, running_workers: f64, claimed_workers: f64) -> Result<usize, String> {
    let busy = l.load1.max(running_workers) + claimed_workers;
    let cpu = l.cores - busy - 1.0;
    let mem = (l.free_pct / 100.0 * l.mem_gb - RESERVE_GB) / WORKER_GB - claimed_workers;
    let top = (l.cores - 2.0).max(2.0);
    let n = cpu.min(mem).min(top).floor();
    if passes == 0 {
        return Ok(if l.critical { 2 } else { n.max(2.0) as usize });
    }
    let why = if passes >= HARD_MAX_PASSES {
        format!("ya hay {passes} pasadas de tests del back en marcha, el máximo")
    } else if l.critical || l.free_pct < MIN_FREE_PCT {
        format!("hay {passes} pasada(s) en marcha y el ordenador va justo de memoria ({})", describe(l))
    } else if n < 2.0 {
        format!("hay {passes} pasada(s) en marcha y no queda CPU ni memoria para otra ({})", describe(l))
    } else {
        return Ok(n as usize);
    };
    Err(format!("No lanzo esta pasada: {why} (context/TESTS-CI.md). Espera a que acabe una (no la mates ni la relances) y vuelve a lanzarla; mientras, sigue con otra cosa."))
}

pub fn is_browser_launch(tool: &str, command: Option<&str>) -> bool {
    if tool.starts_with("mcp__playwright") {
        return tool.ends_with("browser_navigate");
    }
    tool == "Bash" && command.map(|c| BROWSER_RUN.is_match(&mask(c))).unwrap_or(false)
}

pub fn browser_wait(load: Option<&Load>) -> Option<String> {
    let l = load?;
    (l.critical || l.free_pct < BROWSER_FREE_PCT).then(|| format!("No abro otro navegador ahora: el ordenador está sin memoria ({}). Espera un par de minutos o cierra navegadores tuyos que ya no uses y vuelve a intentarlo (context/PLAYWRIGHT.md).", describe(l)))
}

fn is_php(cmd: &str) -> bool {
    PHP.is_match(cmd)
}

fn heredoc_word(rest: &str) -> Option<String> {
    let c = HEREDOC.captures(rest)?;
    c.get(1).or(c.get(2)).or(c.get(3)).map(|m| m.as_str().to_string())
}

pub fn mask(command: &str) -> String {
    let chars: Vec<char> = command.chars().collect();
    let mut out = chars.clone();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < out.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == '\\' && q == '"' {
                out[i] = 'x';
                if i + 1 < out.len() {
                    i += 1;
                    out[i] = 'x';
                }
            } else if c == q {
                quote = None;
            } else {
                out[i] = 'x';
            }
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '<' {
            let rest: String = chars[i..].iter().collect();
            if let Some(word) = heredoc_word(&rest) {
                let Some(start) = chars[i..].iter().position(|&ch| ch == '\n').map(|p| p + i) else { break };
                let tail: String = chars[start..].iter().collect();
                let end = Regex::new(&format!(r"\n\s*{}\s*(?:\n|$)", regex::escape(&word))).unwrap();
                let stop = match end.find(&tail) {
                    Some(m) => start + tail[..m.start()].chars().count() + 1,
                    None => out.len(),
                };
                for j in start + 1..stop {
                    if chars[j] != '\n' {
                        out[j] = 'x';
                    }
                }
                i = stop;
                continue;
            }
        }
        i += 1;
    }
    out.into_iter().collect()
}

pub fn is_back_test(command: &str) -> bool {
    RUN.is_match(&mask(command))
}

fn processes() -> Vec<Process> {
    let Ok(out) = crate::core::platform::cmd("/bin/ps").args(["-axo", "pid=,ppid=,command="]).output() else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .split('\n')
        .filter_map(|l| PS_ROW.captures(l))
        .map(|m| Process { pid: m[1].to_string(), ppid: m[2].to_string(), cmd: m[3].to_string() })
        .collect()
}

pub fn running_passes(list: Option<&[Process]>) -> usize {
    let owned;
    let list = match list {
        Some(l) => l,
        None => {
            owned = processes();
            &owned[..]
        }
    };
    let php: std::collections::HashSet<&str> = list.iter().filter(|p| is_php(&p.cmd)).map(|p| p.pid.as_str()).collect();
    list.iter().filter(|p| is_php(&p.cmd) && TEST_PROC.is_match(&p.cmd) && !php.contains(p.ppid.as_str())).count()
}

fn claims_file() -> PathBuf {
    crate::core::data::DATA_DIR.join("test-turn.json")
}

fn recent_claims(file: &std::path::Path, now_ms: i64) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    match crate::core::json::parse(&text) {
        Some(Value::Array(list)) => list.into_iter().filter(|c| claim_at(c).map(|at| (now_ms as f64) - at < CLAIM_MS as f64).unwrap_or(false)).collect(),
        _ => Vec::new(),
    }
}

fn command_offset(visible: &str, command: &str, byte: usize) -> usize {
    let n = visible[..byte].chars().count();
    command.char_indices().nth(n).map(|(b, _)| b).unwrap_or(command.len())
}

pub fn with_processes(command: &str, n: usize) -> String {
    let visible = mask(command);
    if !PARALLEL.is_match(&visible) {
        return command.to_string();
    }
    let procs: Vec<regex::Captures> = PROCESSES.captures_iter(&visible).collect();
    if !procs.is_empty() {
        let mut out = command.to_string();
        for m in procs.iter().rev() {
            let whole = m.get(0).unwrap();
            let from = command_offset(&visible, command, whole.start());
            let to = command_offset(&visible, command, whole.end());
            let asked = m[2].parse::<f64>().unwrap_or(f64::INFINITY);
            let value = if asked < n as f64 { asked } else { n as f64 };
            out = format!("{}--processes{}{}{}", &out[..from], &m[1], value as u64, &out[to..]);
        }
        return out;
    }
    let at = command_offset(&visible, command, PARALLEL.find(&visible).unwrap().start() + "--parallel".len());
    format!("{} --processes={}{}", &command[..at], n, &command[at..])
}

pub fn running_workers(list: &[Process]) -> usize {
    list.iter().filter(|p| is_php(&p.cmd) && WORKER.is_match(&p.cmd)).count()
}

pub fn plan_with_load(command: &str, passes: usize, load: Option<&Load>, running: f64, claimed: f64) -> Plan {
    if !is_back_test(command) {
        return Plan::of("none");
    }
    let Some(l) = load else { return plan(command, passes) };
    match budget(l, passes, running, claimed) {
        Err(reason) => Plan { kind: "wait", reason: Some(reason), command: None },
        Ok(n) => {
            let next = with_processes(command, n);
            if next == command { Plan::of("go") } else { Plan { kind: "go", reason: None, command: Some(next) } }
        }
    }
}

fn claim_workers(claim: &Value) -> f64 {
    claim.get("n").and_then(Value::as_f64).unwrap_or(FIRST as f64)
}

fn claim_at(claim: &Value) -> Option<f64> {
    claim.as_f64().or_else(|| claim.get("at").and_then(Value::as_f64))
}

fn workers_of(command: &str) -> f64 {
    let visible = mask(command);
    if !PARALLEL.is_match(&visible) {
        return 1.0;
    }
    PROCESSES.captures(&visible).and_then(|m| m[2].parse::<f64>().ok()).unwrap_or(FIRST as f64)
}

pub fn plan(command: &str, passes: usize) -> Plan {
    if !is_back_test(command) {
        return Plan::of("none");
    }
    if passes >= MAX_PASSES {
        return Plan { kind: "wait", reason: Some(format!("Ya hay {passes} pasadas de tests del back en marcha en este ordenador y más a la vez lo dejan sin memoria ni CPU (context/TESTS-CI.md). Espera a que acabe una (no la mates ni la relances) y vuelve a lanzar esta; mientras, sigue con otra cosa.")), command: None };
    }
    let next = with_processes(command, if passes > 0 { SECOND } else { FIRST });
    if next == command { Plan::of("go") } else { Plan { kind: "go", reason: None, command: Some(next) } }
}

pub fn decide(command: &str, options: &DecideOptions) -> Plan {
    if !is_back_test(command) {
        return Plan::of("none");
    }
    let file = options.file.clone().unwrap_or_else(claims_file);
    let now_ms = options.now_ms.unwrap_or_else(crate::core::time::now_ms);
    let mut claims = recent_claims(&file, now_ms);
    let owned;
    let list = match options.list {
        Some(l) => l,
        None => {
            owned = processes();
            &owned[..]
        }
    };
    let load = match &options.load {
        Some(l) => l.clone(),
        None => measure(),
    };
    let claimed: f64 = claims.iter().map(claim_workers).sum();
    let p = plan_with_load(command, running_passes(Some(list)) + claims.len(), load.as_ref(), running_workers(list) as f64, claimed);
    if p.kind == "go" {
        let n = workers_of(p.command.as_deref().unwrap_or(command));
        claims.push(serde_json::json!({ "at": now_ms, "n": n }));
        let _ = std::fs::write(&file, crate::core::json::stringify(&Value::Array(claims)));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: &str, ppid: &str, cmd: &str) -> Process {
        Process { pid: pid.into(), ppid: ppid.into(), cmd: cmd.into() }
    }

    #[test]
    fn only_back_test_runs_take_a_turn() {
        assert!(is_back_test("cd super-app && php artisan test --parallel tests/Feature/Plans"));
        assert!(is_back_test("php vendor/bin/phpunit tests/Unit/FooTest.php"));
        assert!(is_back_test("vendor/bin/paratest -p 4"));
        assert!(!is_back_test("grep -rn 'artisan test' context/"));
        assert!(!is_back_test("npm test"));
        assert!(!is_back_test("php artisan tinker"));
        assert!(is_back_test("XDEBUG_MODE=off php artisan test tests/Unit"));
        assert!(!is_back_test(r#"echo '{"command":"cd super-app && php artisan test --parallel"}' | node hook.js"#));
    }

    #[test]
    fn text_inside_quotes_or_a_heredoc_is_never_taken_for_a_test_run_nor_rewritten() {
        let heredoc = "python3 - <<'EOF'\nrun('php artisan test --parallel')\nEOF\necho done";
        assert!(!is_back_test(heredoc));
        assert_eq!(with_processes(heredoc, 3), heredoc);
        let mixed = "cd super-app && php artisan test --parallel tests && echo '--parallel'";
        assert_eq!(with_processes(mixed, 3), "cd super-app && php artisan test --parallel --processes=3 tests && echo '--parallel'");
        assert!(is_back_test("cat <<EOF > x\nhi\nEOF\nphp artisan test tests/Unit"));
    }

    #[test]
    fn a_pass_counts_once_whatever_workers_it_has_and_the_shell_that_launched_it_does_not_count() {
        let list = vec![
            p("10", "1", "/bin/zsh -c cd super-app && php artisan test --parallel tests"),
            p("11", "10", "php artisan test --parallel tests"),
            p("12", "11", "/opt/homebrew/bin/php vendor/bin/paratest --processes=6"),
            p("13", "12", "/opt/homebrew/bin/php vendor/brianium/paratest/bin/phpunit-wrapper.php"),
            p("14", "12", "/opt/homebrew/bin/php vendor/brianium/paratest/bin/phpunit-wrapper.php"),
            p("20", "1", "php vendor/bin/phpunit tests/Unit/A.php"),
            p("30", "1", "php artisan serve"),
        ];
        assert_eq!(running_passes(Some(&list)), 2);
    }

    #[test]
    fn the_first_pass_gets_6_processes_the_second_3_and_a_third_waits() {
        assert_eq!(plan("php artisan test --parallel tests", 0).command.as_deref(), Some("php artisan test --parallel --processes=6 tests"));
        assert_eq!(plan("php artisan test --parallel --processes=8 tests", 1).command.as_deref(), Some("php artisan test --parallel --processes=3 tests"));
        assert_eq!(plan("php artisan test --parallel --processes=2 tests", 1).command, None);
        assert_eq!(plan("php vendor/bin/phpunit tests/Unit/A.php", 1).kind, "go");
        assert_eq!(plan("php artisan test --parallel tests", 2).kind, "wait");
    }

    #[test]
    fn two_runs_launched_at_the_same_moment_do_not_both_get_the_first_turn() {
        let dir = std::env::temp_dir().join(format!("turn-{}-{}", std::process::id(), crate::core::time::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-turn.json");
        let at = |now_ms: i64| decide("php artisan test --parallel tests", &DecideOptions { list: Some(&[]), file: Some(file.clone()), now_ms: Some(now_ms), load: Some(None) });
        let a = at(1000);
        let b = at(2000);
        let c = at(3000);
        assert!(a.command.unwrap().contains("--processes=6"));
        assert!(b.command.unwrap().contains("--processes=3"));
        assert_eq!(c.kind, "wait");
        assert!(at(60000).command.unwrap().contains("--processes=6"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn mac(load1: f64, free_pct: f64) -> Load {
        Load { cores: 11.0, load1, mem_gb: 18.0, free_pct, critical: false }
    }

    #[test]
    fn processes_follow_free_cpu_and_memory() {
        assert_eq!(budget(&mac(1.0, 60.0), 0, 0.0, 0.0), Ok(9));
        assert_eq!(budget(&mac(5.0, 60.0), 0, 0.0, 0.0), Ok(5));
        assert_eq!(budget(&mac(1.0, 25.0), 0, 0.0, 0.0), Ok(3));
        assert_eq!(budget(&mac(10.0, 10.0), 0, 0.0, 0.0), Ok(2));
        assert_eq!(budget(&mac(1.0, 60.0), 1, 6.0, 0.0), Ok(4));
        assert_eq!(budget(&mac(1.0, 60.0), 1, 0.0, 6.0), Ok(3));
    }

    #[test]
    fn a_new_pass_waits_only_when_the_machine_is_short_or_at_the_ceiling() {
        assert!(budget(&mac(1.0, 70.0), 2, 4.0, 0.0).is_ok());
        assert!(budget(&mac(1.0, 70.0), 3, 4.0, 0.0).is_ok());
        assert!(budget(&mac(1.0, 70.0), 4, 4.0, 0.0).is_err());
        assert!(budget(&mac(1.0, 15.0), 1, 2.0, 0.0).is_err());
        assert!(budget(&mac(9.5, 60.0), 1, 2.0, 0.0).is_err());
        let mut critical = mac(1.0, 50.0);
        critical.critical = true;
        assert!(budget(&critical, 1, 0.0, 0.0).is_err());
        assert_eq!(budget(&critical, 0, 0.0, 0.0), Ok(2));
    }

    #[test]
    fn claims_carry_their_workers_so_a_burst_does_not_overbook() {
        let dir = std::env::temp_dir().join(format!("turnload-{}-{}", std::process::id(), crate::core::time::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-turn.json");
        let at = |now_ms: i64| decide("php artisan test --parallel tests", &DecideOptions { list: Some(&[]), file: Some(file.clone()), now_ms: Some(now_ms), load: Some(Some(mac(1.0, 60.0))) });
        assert!(at(1000).command.unwrap().contains("--processes=9"));
        assert_eq!(at(2000).kind, "wait");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn browsers_only_wait_under_memory_pressure() {
        assert!(is_browser_launch("mcp__playwright__browser_navigate", None));
        assert!(!is_browser_launch("mcp__playwright__browser_click", None));
        assert!(is_browser_launch("Bash", Some("cd backoffice && npx playwright test e2e/x.spec.ts")));
        assert!(!is_browser_launch("Bash", Some("grep -rn 'playwright' context/")));
        assert!(browser_wait(Some(&mac(3.0, 40.0))).is_none());
        assert!(browser_wait(Some(&mac(3.0, 8.0))).is_some());
        assert!(browser_wait(None).is_none());
    }
}
