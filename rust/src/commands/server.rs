//! Port of src/commands/server.js.
use crate::commands::args::{Args, json};
use crate::core::data::{BASE_URL, DATA_DIR, PORT, pause, read_stdin};
use serde_json::json;
use std::io::{IsTerminal, Write};
use std::process::Stdio;

pub fn spawn_self_detached(args: &[&str]) -> bool {
    let Ok(exe) = crate::core::platform::self_exe() else { return false };
    let mut command = crate::core::platform::cmd(exe);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x08000000);
    }
    crate::core::platform::stop_inheriting_std_handles();
    command.spawn().is_ok()
}

fn launch_server(message: &str) {
    launch_server_with(message, false)
}

fn launch_server_with(message: &str, force: bool) {
    let via_agent = crate::core::mac_agent::IS_MAC && crate::core::mac_agent::loaded() && (if force { crate::core::mac_agent::restart_agent() } else { crate::core::mac_agent::kickstart() });
    if !via_agent {
        spawn_self_detached(&["serve"]);
    }
    pause(if via_agent { 6000 } else { 800 });
    if crate::server::state::ping() {
        println!("{message}: {}", *BASE_URL);
    } else {
        println!("No se pudo arrancar el tablero");
    }
}

pub fn serve(_args: &Args) -> Result<i32, String> {
    crate::core::logfile::rotate_in_place(&DATA_DIR.join("serve.log"), crate::core::logfile::MAX_BYTES);
    crate::server::server::serve();
    Ok(0)
}

pub fn ensure(_args: &Args) -> Result<i32, String> {
    if crate::server::state::ping() {
        println!("Tablero ya en marcha: {}", *BASE_URL);
    } else {
        launch_server("Tablero arrancado");
    }
    Ok(0)
}

fn post_status(route: &str) -> Option<u16> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    agent.post(&format!("{}{route}", *BASE_URL)).send_empty().ok().map(|r| r.status().as_u16())
}

pub fn restart(_args: &Args) -> Result<i32, String> {
    match post_status("/api/quit") {
        None => launch_server_with("Tablero reiniciado", true),
        Some(200) => {
            pause(400);
            launch_server_with("Tablero reiniciado", true);
        }
        Some(_) => match post_status("/api/salir") {
            None => launch_server_with("Tablero reiniciado", true),
            Some(200) => {
                pause(400);
                launch_server_with("Tablero reiniciado", true);
            }
            Some(_) => println!("El servidor en marcha no sabe reiniciarse: cierra a mano el proceso node del puerto {} (por su PID, nunca `taskkill /IM node.exe`) y ejecuta `ensure`.", *PORT),
        },
    }
    Ok(0)
}

pub fn watch(args: &Args) -> Result<i32, String> {
    crate::server::watcher::watch(args.a());
    Ok(0)
}

pub fn host(_args: &Args) -> Result<i32, String> {
    crate::sessions::host::serve();
    Ok(0)
}

pub fn startup(args: &Args) -> Result<i32, String> {
    let child = matches!(args.a(), Some("--child") | Some("--hijo"));
    crate::server::startup::launch_startup(child, args.has("--force"));
    Ok(0)
}

pub fn overtime(args: &Args) -> Result<i32, String> {
    if let Some(a @ ("on" | "off")) = args.a() {
        let v = crate::server::startup::set_overtime(a == "on");
        json(&json!({ "overtime": v }));
        return Ok(0);
    }
    json(&json!({ "overtime": crate::core::hours::overtime(), "workHours": crate::core::hours::work_hours(None) }));
    Ok(0)
}

pub fn push_test(_args: &Args) -> Result<i32, String> {
    let n = crate::server::push::send_push("test", true, None);
    println!("aviso de prueba enviado a {n} de {} dispositivo(s)", crate::server::push::subscriptions().len());
    Ok(0)
}

pub fn claude_token(args: &Args) -> Result<i32, String> {
    let a = args.a();
    let remove = a == Some("--remove");
    match a {
        Some("--setup") => {
            let expires = crate::features::claude_token::setup_token()?;
            println!("\nToken de Claude guardado en el .env de este ordenador (caduca hacia el {expires}) y puesto también para VS Code. Cierra VS Code del todo y ábrelo de nuevo. Falta copiarlo al otro ordenador.");
            return Ok(0);
        }
        Some("--import") => {
            let expires = crate::features::claude_token::import_token(&read_stdin())?;
            println!("Token de Claude guardado en este ordenador (caduca hacia el {expires}) y puesto también para VS Code.");
            return Ok(0);
        }
        Some("--export") => {
            if std::io::stdout().is_terminal() {
                return Err("--export solo se usa encadenado a otro comando (… | ssh mac \"… claude-token --import\"), para no enseñar el token.".into());
            }
            let Some(token) = crate::sessions::registry::session_token().filter(|x| !x.is_empty()) else {
                return Err("No hay token en el .env de este ordenador.".into());
            };
            let mut out = std::io::stdout();
            let _ = out.write_all(token.as_bytes());
            let _ = out.flush();
            return Ok(0);
        }
        _ => {}
    }
    crate::features::claude_token::apply_user_token(remove)?;
    println!("{}", if remove { "Token de Claude quitado de las variables de tu usuario: VS Code vuelve a usar el /login." } else { "Token de Claude puesto en las variables de tu usuario. Cierra VS Code del todo y ábrelo de nuevo para que lo use." });
    Ok(0)
}
