//! The chat kind. The chat panel itself is served by `crate::chat` (its own
//! engine and prompt); this kind lets a chat-style run go through the agents
//! runtime too (e.g. a user-made chat profile).

use super::{AgentKind, ModelRole};
#[allow(unused_imports)]
use crate::agents::tools::registry::*;

pub struct Chat;

const PROMPT: &str = include_str!("prompts/chat.md");

impl AgentKind for Chat {
    fn id(&self) -> &'static str {
        "chat"
    }

    fn label(&self) -> &'static str {
        "Chat"
    }

    fn system_prompt(&self) -> String {
        PROMPT.to_string()
    }

    fn tool_names(&self) -> Vec<&'static str> {
        [FS_READ, LITERATURE, WEB, &[READ_MEMORY, REMEMBER]].concat()
    }

    fn role(&self) -> ModelRole {
        ModelRole::Chat
    }
}
