//! Port of src/sessions/deliver.js.
#![allow(dead_code, unused_variables)]
use serde_json::Value;
use std::path::{Path, PathBuf};

const PASTE_SETTLE_MS: u64 = 400;
const CONFIRM_MS: u64 = 15000;
const POLL_MS: u64 = 500;
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

pub type TranscriptFn = Box<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;
pub type WriteFn = Box<dyn Fn(&str, &str) -> Result<Value, String> + Send + Sync>;
pub type WaitFn = Box<dyn Fn(u64) + Send + Sync>;
pub type WakeFn = Box<dyn Fn(&str, &str) -> bool + Send + Sync>;

pub struct Deps {
    pub transcript: TranscriptFn,
    pub write: WriteFn,
    pub wait: WaitFn,
    pub wake: WakeFn,
}

impl Default for Deps {
    fn default() -> Deps {
        Deps {
            transcript: Box::new(crate::sessions::registry::transcript_of),
            write: Box::new(|conversation, data| crate::sessions::host::host_request("POST", "/input", Some(&serde_json::json!({ "conversation": conversation, "data": data })))),
            wait: Box::new(|ms| std::thread::sleep(std::time::Duration::from_millis(ms))),
            wake: Box::new(|name, notice| crate::sessions::registry::wake_session(name, Some(notice))),
        }
    }
}

pub fn clean(text: &str) -> String {
    todo!()
}

fn size_of(file: &Path) -> u64 {
    todo!()
}

pub fn seen_since(file: Option<&Path>, token: &str, from: u64) -> bool {
    todo!()
}

pub fn seen_anywhere(conversation: &str, token: &str, deps: Option<&Deps>) -> bool {
    todo!()
}

fn confirm(deps: &Deps, conversation: &str, token: &str, from: u64, ms: u64) -> bool {
    todo!()
}

pub fn type_into(conversation: &str, text: &str, token: &str, deps: Option<&Deps>) -> Result<Value, String> {
    todo!()
}

pub fn send_message_into(conversation: Option<&str>, send_to: &str, text: &str, token: &str, deps: Option<&Deps>) -> Value {
    todo!()
}
