//! Port of src/server/routes/tasks.js.

use serde_json::Value;

use crate::server::http::Res;

pub fn handle_task(input: &Value) -> Res {
    todo!()
}

pub fn approve_many(pairs: &Value, via: &str) -> Value {
    todo!()
}

pub fn handle_batch(input: &Value) -> Res {
    todo!()
}

pub fn handle_delete(input: &Value) -> Res {
    todo!()
}

pub fn archive_done() {
    todo!()
}

pub fn handle_answer(input: &Value) -> Res {
    todo!()
}

pub fn handle_reviewed(input: &Value) -> Res {
    todo!()
}

pub fn handle_reviewed_all(input: &Value) -> Res {
    todo!()
}

pub fn review_job_state() -> Value {
    todo!()
}

pub fn handle_comment(input: &Value) -> Res {
    todo!()
}

pub fn handle_config(input: &Value) -> Res {
    todo!()
}

pub fn handle_refresh() -> Res {
    todo!()
}

pub fn handle_search(input: &Value) -> Res {
    todo!()
}

pub fn handle_new_task(input: &Value) -> Res {
    todo!()
}

pub fn handle_ticket(input: &Value) -> Res {
    todo!()
}

pub fn handle_import(input: &Value) -> Res {
    todo!()
}

pub fn handle_restriction(input: &Value) -> Res {
    todo!()
}
