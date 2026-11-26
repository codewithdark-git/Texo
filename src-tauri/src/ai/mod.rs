//! The AI error explainer and fixer.
//!
//! The user brings their own API key for one of several providers (NVIDIA by
//! default, OpenRouter, Groq, Google Gemini, Anthropic Claude, or any
//! OpenAI-compatible server such as a local Ollama). When a compile fails and
//! the user clicks "Explain & fix", Texo gathers a small, capped excerpt of
//! the project around the error, asks the model for a plain-words
//! explanation plus exact edits, and checks every edit before the UI may
//! apply it.
//!
//! Rules this module keeps:
//! - API keys live only here, in the OS credential store (or, without one, a
//!   user-only file). They never reach the webview, logs, `settings.json` or
//!   error messages.
//! - Nothing is sent without an explicit request from the UI, and only after
//!   the user has seen the privacy notice for that provider.
//! - Only files inside the project are read, binary files are skipped, and
//!   every excerpt is size-capped.
//! - An edit is offered only when its file is a text file in the project and
//!   the text it replaces occurs exactly once.

mod anthropic;
pub mod commands;
mod context;
pub(crate) mod error;
pub(crate) mod http;
mod install;
pub(crate) mod keystore;
pub mod llm;
mod llm_text;
mod llm_wire;
mod openai;
mod prefs;
mod prompt;
mod providers;
mod ratelimit;
mod sse;
mod validate;

#[cfg(test)]
pub(crate) mod mock;

pub use commands::AiState;

/// Window event with progress updates while a request runs.
pub const PROGRESS_EVENT: &str = "ai-progress";
