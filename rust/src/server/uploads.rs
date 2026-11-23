//! Port of src/server/uploads.js.
use crate::server::http::{Req, Res};
use serde_json::Value;
use std::io::Read;

pub const MAX_MB: u64 = 500;
#[allow(dead_code)]
const MAX_BYTES: u64 = MAX_MB * 1024 * 1024;
#[allow(dead_code)]
const KEEP_DAYS: i64 = 7;
#[allow(dead_code)]
const MAIN_DIR: &str = "pruebas/hablar";
#[allow(dead_code)]
const OWN_DIR: &str = ".tablero/hablar";

pub fn target(conversation: &str) -> Value {
    let _ = conversation;
    todo!()
}

pub fn handle_upload(req: &Req, body: &mut dyn Read) -> Res {
    let _ = (req, body);
    todo!()
}
