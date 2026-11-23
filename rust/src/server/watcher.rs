//! Port of src/server/watcher.js.

#[allow(dead_code)]
const MODES: [(&str, &str); 6] = [("reports", "reports"), ("reportes", "reports"), ("dispatches", "dispatches"), ("envios", "dispatches"), ("board", "board"), ("tablero", "board")];

pub fn watch(mode: Option<&str>) {
    let _ = mode;
    todo!()
}
