//! Chat about the paper (v1.2, spec section "Chat").
//!
//! - Conversations live in `.texo/ai/chats/<id>.json` ([`store`]), written
//!   atomically (temporary file plus rename).
//! - `ai_chat_send` streams the answer as `agent-message` window events
//!   keyed by chat id and request id ([`ChatEvent`]).
//! - During a turn the model may call read-only tools ([`tools`]): files,
//!   literature, web pages, project memory, plus `propose_task`, which is
//!   returned to the UI as a "Run as task" suggestion instead of running.
//! - Long chats are fitted to the model's context ([`budget`]): the oldest
//!   turns are summarised to one line each, then left out.
//!
//! Keys stay in Rust: the chat goes through `ai::llm` with the endpoint
//! `AiState` builds, and nothing key-related is stored or emitted.

pub mod budget;
pub mod commands;
pub mod dropped;
pub mod engine;
pub mod store;
pub mod tools;

/// Window event with streamed chat text and progress; every payload carries
/// `chatId` and `requestId`. It follows `agent-message` (streamed run text,
/// `{runId, text, reset}`, owned by the agents runtime) but has its own name
/// so listeners of either never see the other's payload shape.
pub const CHAT_EVENT: &str = "ai-chat-message";
