use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicI64};

static RUNNING: AtomicBool = AtomicBool::new(false);
static RUNNING_HEAD: LazyLock<Option<String>> = LazyLock::new(|| None);
static LAST_BEAT: LazyLock<AtomicI64> = LazyLock::new(|| AtomicI64::new(crate::core::time::now_ms()));

pub fn sync_context() {
    todo!()
}

pub fn wake_check() {
    todo!()
}

pub fn context_sync_enabled() -> bool {
    todo!()
}
