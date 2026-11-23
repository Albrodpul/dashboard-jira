//! Port of src/core/migrate.js. TODO(core agent): full port; these keep the foundation compiling.
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub fn migrate_data_dir(workspace: &Path) -> PathBuf {
    let dir = workspace.join("data");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn migrate_learning_table(_conn: &rusqlite::Connection) {}

pub fn migrate_document(_d: &mut Map<String, Value>) {}
