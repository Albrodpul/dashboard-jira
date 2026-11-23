pub use crate::cluster::handover::{back_to_auto, command, handle_yield, take_here, tick};
pub use crate::cluster::peer::{machines, peer_get, send_claude_token};
pub use crate::cluster::power::{keep_awake, let_sleep};
pub use crate::cluster::role::{info, is_primary, primary_now};
pub use crate::cluster::snapshot::{apply_snapshot, merge_peer, merge_tasks, snapshot};
pub use crate::cluster::transcripts::{last_reply, project_dir, serve_transcript, transcripts};

pub fn cluster_enabled() -> bool {
    crate::cluster::role::CLUSTER.is_some()
}
