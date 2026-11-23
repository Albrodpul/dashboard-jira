//! Port of src/server/routes/operations.js.

use serde_json::Value;

use crate::server::http::Res;

pub const ENVIRONMENT_NAME: [(&str, &str); 3] = [("develop", "develop"), ("production", "producción"), ("both", "develop y producción")];

pub fn handle_deploy(input: &Value) -> Res {
    todo!()
}

pub fn handle_tidy(input: &Value) -> Res {
    todo!()
}

pub fn handle_message(input: &Value) -> Res {
    todo!()
}

pub fn handle_follow_up_error(input: &Value) -> Res {
    todo!()
}

pub fn handle_follow_up_request(input: &Value) -> Res {
    todo!()
}
