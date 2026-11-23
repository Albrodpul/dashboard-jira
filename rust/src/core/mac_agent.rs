use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const LABEL: &str = "com.nutria.board";
pub static PLIST: LazyLock<PathBuf> = LazyLock::new(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")));
pub const IS_MAC: bool = cfg!(target_os = "macos");

pub fn under_agent() -> bool {
    todo!()
}

fn plist_body(exe: &Path, workspace: &Path, log_file: &Path) -> String {
    todo!()
}

pub fn loaded() -> bool {
    todo!()
}

pub fn kickstart() -> bool {
    todo!()
}

pub fn install(workspace: &Path, log_file: &Path) -> bool {
    todo!()
}
