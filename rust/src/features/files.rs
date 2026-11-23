//! Port of src/features/files.js.

use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const TTL_MS: i64 = 60000;

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| crate::core::config::main_project().root.clone().unwrap_or_default());

#[derive(Default)]
struct FileIndex {
    files: Option<Vec<String>>,
    built_at: i64,
    building: bool,
}

static INDEX: LazyLock<Mutex<FileIndex>> = LazyLock::new(|| Mutex::new(FileIndex::default()));

pub fn search_files(q: &str) -> Vec<String> {
    todo!()
}

pub fn warm_files() {
    todo!()
}
