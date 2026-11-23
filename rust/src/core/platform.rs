use std::collections::HashMap;

pub const IS_WIN: bool = cfg!(windows);
pub const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

#[derive(Clone, Debug, PartialEq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub command: String,
}

pub fn processes() -> Vec<Process> {
    todo!()
}

pub fn command_line(pid: u32) -> String {
    todo!()
}

pub fn kill_tree(pid: u32) {
    todo!()
}

pub fn listening_pids(port: u16) -> Vec<String> {
    todo!()
}

pub fn open_url(url: &str, env: Option<&HashMap<String, String>>) {
    todo!()
}

pub fn open_folder_in_editor(folder: &str, env: Option<&HashMap<String, String>>) {
    todo!()
}

pub fn claude_cli() -> String {
    todo!()
}

pub fn claude(args: &[String], fallback: Option<&str>) -> (String, Vec<String>) {
    todo!()
}

pub fn is_shell(name: &str) -> bool {
    todo!()
}
