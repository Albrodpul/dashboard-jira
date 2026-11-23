# Porting the board from Node to Rust

Goal: the Rust binary `tower` replaces every server, CLI and hook file in `src/` and `bin/` (not `src/page/`, which stays JavaScript in the browser). Same behaviour, same HTTP API, same SQLite file, same files in the data dir, same texts (Spanish strings stay byte for byte). `docs/DECISIONS.md` explains why things are the way they are: read the entries for the modules you port.

## Layout

One Rust file per JS file, same place:

- `src/<dir>/<name-with-dashes>.js` → `rust/src/<dir>/<name_with_underscores>.rs`, module `crate::<dir>::<name>` (e.g. `src/features/mac-power.js` → `crate::features::mac_power`, `src/server/routes/index.js` → `crate::server::routes::index`).
- `src/cli.js` → `crate::cli`; `bin/<x>.js` → `crate::tools::<x>`.
- The `mod.rs` files and `lib.rs` already list every module. Do not add or remove modules; only fill your own files.

## Foundation (already done, use it, do not rewrite it)

- `crate::core::json`: `stringify` / `stringify_pretty` print exactly like `JSON.stringify` (needed because stored texts are compared); `truthy` is JS truthiness; `num(f64)` keeps whole numbers as integers. Never use `serde_json::to_string` for anything stored, compared or sent.
- `crate::core::time`: `now()` (= `new Date().toISOString()`), `now_ms()`, `iso(ms)`, `parse(text) -> Option<i64>` (= `Date.parse`), `minutes_since`, `madrid(ms) -> Clock { weekday "Mon".., weekend, hour, minute, min, day "YYYY-MM-DD" }`.
- `crate::core::data`: `load() -> Doc`, `read_key(key)`, `mutate(|d: &mut Doc| ...) -> R`, `mutate_keep_stamps`, `read_json(path, fallback)`, `write_json_pretty`, statics `WORKSPACE`, `DATA_DIR`, `DB_FILE`, `PORT`, `BASE_URL`, `ROUTES_FILE`, `SESSIONS_CLI`, `REPORTER_HEARTBEAT`, `BOARD_HEARTBEAT`, `SEEN_FILE`, `TO_COUNT_FILE`, consts `STATUSES`, `IN_SESSION`, `HUMAN_APPROVALS`, `is_uuid`, `is_empty_report`, `mark_counted`, `read_stdin`, `pause`. `Doc = serde_json::Map<String, Value>` with insertion order kept. `d.remove(k)` = setting it to `undefined`. One SQLite connection per thread; calling `load()` inside `mutate` is fine, nested `mutate` is not (same as Node).
- `crate::core::records`: `SPECS`, `STAMPS_KEY`, `stamp_records`, `merge_records`, `merge_key`, `to_map`.
- `crate::core::config`: `main_project()`, `projects()`, `project(id)`, `Project { id, name, root, jira: Option<Jira { projects, projects_jql, key_regex, me, reviewer, transitions, default_issue_type }>, statuses: Option<Statuses { review, returned, review_regex, returned_regex, in_progress_regex, back_from_review_regex, closed_regex, reject_label }>, follow_up, errors_area, sentry, dev_servers, deploy_projects, deploy_targets, context_domains, commands_dir, daily, context_tidy, agent, task_prefix, messages, source, env_file, raw }` with `secret(name)` and `credentials()`; also `workspace()`, `repo()`, `cli()`, `trusted_hosts()`, `cluster()`, `voice()`, `session_model()`, `session_profiles()`, `launchd_labels()`, `board_alive_minutes()`, `daily_style()`, `workspace_base()`, `local_projects()`, `local_projects_file()`, `forget_projects()`, `build_project`, `for_page()`, `parse_env`, `slug`, `slashes`, `normalize` (= `path.resolve`). `config.jira` / `config.statuses` / `config.root` etc. in JS are the main project's: `main_project().jira`.
- `crate::core::logfile`: `append_log(path, text)`, `append_log_max`, `rotate`, `rotate_in_place`.
- `crate::testkit`: `sandbox()` / `sandbox_with(extra)` = `test/helpers/env.js`; `fresh()` locks and empties the board for one test. Tests needing a different config go in `rust/tests/<name>.rs` (separate process each).

## Rules

- Synchronous code with threads. No async runtime. A JS `async` function becomes a blocking function; `await fetch(...)` becomes `ureq`; `setTimeout`/`setInterval` become a thread with `sleep` (the server module starts the periodic jobs). Module-level `let` state becomes `static X: LazyLock<Mutex<...>>`.
- Data stays dynamic: board records, request bodies and the state sent to the page are `serde_json::Value`. Use typed structs only for purely internal things. Key order of objects you build must match the JS object literal order (the page and the comparisons rely on JSON text).
- Names: camelCase → snake_case, same name otherwise. Every function a JS module exports is `pub` in Rust with that name. Helpers stay private.
- Signatures: objects/arrays → `&Value` in, `Value` out; the whole document → `&Doc` / `&mut Doc`; strings → `&str` in, `String` out; numbers → `f64` unless clearly a count/index (`usize`/`i64`); optional arguments → `Option<T>`; options objects → `&Value` (or a small struct with `Default` if you own both sides). A JS function that can throw or reject → `Result<T, String>` with the same message.
- Child processes: `std::process::Command` (same programs and arguments as the JS). HTTP client: `ureq` with the same timeouts. WebSockets: `tungstenite`. PTY: `portable-pty`; terminal screen: `vt100`. Crypto for Web Push: `p256`, `aes-gcm`, `hmac`, `sha2`. Regexes: `regex` (convert JS syntax carefully: no look-behind/look-ahead in `regex`; rewrite such patterns by hand).
- Strings shown to the user, written to logs, sent to sessions or to Jira must be identical to the JS ones.
- No comments in code (house rule). Clear names instead.
- Port the JS tests of your modules (`test/*.test.js`) to Rust `#[cfg(test)]` tests in the same file (or `rust/tests/` when they need their own config). Keep the test names in English as sentences, like the JS ones.
- `cargo build` and `cargo test` must pass with your files. Do not edit files owned by another agent; if you need something from another module that is missing or has the wrong signature, call it as the convention says and list it in your report.
