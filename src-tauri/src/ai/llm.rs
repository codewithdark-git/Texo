//! Tool-calling chat for every provider, used by the agents and the chat
//! panel (explain & fix keeps its own one-shot path in `openai.rs` and
//! `anthropic.rs`).
//!
//! - Two dialects: OpenAI chat completions (NVIDIA, OpenRouter, Groq,
//!   Gemini, custom servers) and Anthropic Messages (`claude-opus-5-5`,
//!   adaptive thinking, explicit `output_config.effort`, no sampling
//!   parameters, `refusal` and `max_tokens` stop reasons, `tool_use` /
//!   `tool_result` and image blocks).
//! - Streaming (SSE) with a callback for the visible text, falling back to a
//!   plain request when the provider refuses to stream.
//! - Robust with open models: thinking is stripped, `reasoning_content` is
//!   ignored, tool calls written as text are found, doubled tool names and
//!   broken JSON are repaired, and an empty 200 reply is retried.
//! - Provider quirks: NVIDIA `chat_template_kwargs` for Nemotron, a smaller
//!   `max_tokens` after a "too large" 400, inline `<img>` after an image 400,
//!   ReAct-in-text after a 400 about tools.
//! - Rate limits: a token bucket per provider, `Retry-After`, backoff with
//!   jitter, and a switch to the next fallback model after repeated 429s or
//!   server errors (reported to the caller as a [`Notice`]).
//!
//! Keys never leave [`Endpoint`]; every provider text that reaches an error
//! message goes through `error::sanitize` (via `http::map_status`).

// Used by the agents runtime and the chat (v1.2); until those land, parts
// of this module are only reached from tests.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use super::error::{AiError, AiResult, Kind};
// Re-exported so callers (agents, chat) need only `ai::llm`.
#[allow(unused_imports)]
pub use super::http::{build_client, ApiKey, Cancel, Endpoint};
pub use super::providers::ProviderId;

use super::llm_wire::{self as wire, Fail, Raw};
use super::providers::{self, Api};
use super::ratelimit;

// ------------------------------------------------------------- types --

/// A piece of a user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Part {
    Text { text: String },
    /// `data_url` is `data:<mime>;base64,<data>` (bare base64 is accepted).
    Image {
        mime: String,
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
}

/// One message of the conversation (the system prompt is separate).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Msg {
    User {
        content: Vec<Part>,
    },
    Assistant {
        #[serde(default)]
        text: String,
        #[serde(default)]
        tool_calls: Vec<ToolCall>,
        /// Claude's own content blocks (thinking included), sent back as
        /// they were when the same model continues the conversation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replay: Option<Replay>,
    },
    Tool {
        tool_call_id: String,
        /// The tool's name (needed by the text-tools fallback).
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// `invalid_arguments` of a call that the output limit cut off.
pub const CUT_OFF_ARGS: &str = "(cut off at the output limit)";

impl ToolCall {
    /// The call was cut off by the output limit (it must not run).
    pub fn cut_off(&self) -> bool {
        self.invalid_arguments.as_deref().is_some_and(|a| a.starts_with(CUT_OFF_ARGS))
    }

    /// What to tell the model instead of running a call with unusable
    /// arguments.
    pub fn invalid_message(&self) -> String {
        if self.cut_off() {
            format!(
                "Your call to {} was cut off because the answer reached the length limit, so it did not run. Make smaller calls: change files with edit_file, or split a long write_file into several smaller edits.",
                self.name
            )
        } else {
            format!("Your arguments for {} were not valid JSON. Call it again with one JSON object as the arguments.", self.name)
        }
    }
}

impl Msg {
    pub fn user(text: impl Into<String>) -> Msg {
        Msg::User { content: vec![Part::Text { text: text.into() }] }
    }

    pub fn tool_result(call: &ToolCall, content: impl Into<String>, is_error: bool) -> Msg {
        Msg::Tool { tool_call_id: call.id.clone(), name: call.name.clone(), content: content.into(), is_error }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Always a JSON object (empty when the model sent nothing usable).
    pub arguments: Value,
    /// The raw arguments when they couldn't be read as JSON, even after
    /// repair. The caller should answer with an error asking for valid JSON
    /// instead of running the tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalid_arguments: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    pub model: String,
    pub blocks: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments (an object schema).
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolChoice {
    #[default]
    Auto,
    None,
    /// The model must call some tool (Claude with thinking: sent as auto).
    Required,
    Tool(String),
}

/// Retry and pacing knobs; the defaults follow the spec.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Attempts per model for 429, server errors and empty replies.
    pub tries: u32,
    /// First backoff step (then doubled), plus up to half of it as jitter.
    pub backoff: Duration,
    /// A `Retry-After` longer than this switches model (or fails) instead.
    pub max_wait: Duration,
    /// Use the per-provider token bucket.
    pub rate_limit: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy { tries: 3, backoff: Duration::from_secs(2), max_wait: Duration::from_secs(60), rate_limit: true }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LlmRequest {
    pub system: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<ToolSpec>,
    pub tool_choice: ToolChoice,
    /// `None`: 8192 for the OpenAI dialect (4096 after a "too large" 400),
    /// 16000 for Claude.
    pub max_tokens: Option<u32>,
    /// Ask for reasoning (Nemotron `enable_thinking`; Claude always thinks
    /// adaptively, this only picks the default effort).
    pub thinking: bool,
    /// A JSON Schema the answer must match. Sent as structured output where
    /// the provider supports it, otherwise asked for in the system prompt;
    /// the parsed value is in [`LlmReply::json`].
    pub json: Option<Value>,
    /// Claude `output_config.effort` (`low` … `max`). Default: `high` with
    /// `thinking`, else `medium`.
    pub effort: Option<String>,
    /// OpenAI dialect only; `None` leaves the model's default.
    pub temperature: Option<f32>,
    /// Models to switch to, in order, after repeated 429s or server errors,
    /// or when the current model is unavailable.
    pub fallback_models: Vec<String>,
    /// Per-request timeout. Default 180 s, 300 s with thinking.
    pub timeout: Option<Duration>,
    pub policy: RetryPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    /// The text hit the output limit. Tool calls in a cut-off turn come
    /// back as [`ToolCall::cut_off`] calls (stop `ToolUse`) that must not run.
    MaxTokens,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Something the caller should know and show in the run log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Notice {
    ModelSwitched { from: String, to: String, reason: String },
    /// The model rejected native tools; tools now go through the prompt.
    TextTools,
    MaxTokensLowered { from: u32, to: u32 },
    /// The model rejected image parts; images are now inline `<img>` tags.
    ImagesInline,
    /// The provider refused to stream; answers now arrive in one piece.
    StreamingOff,
    Retrying { attempt: u32, wait_ms: u64, reason: String },
    /// The reasoning used up the output limit; one retry thinks less.
    LessThinking,
}

impl Notice {
    /// Plain words for the run log.
    pub fn message(&self) -> String {
        match self {
            Notice::ModelSwitched { from, to, reason } => format!("Switched from {from} to {to}: {reason}"),
            Notice::TextTools => "This model doesn't take tools directly, so Texo describes them in the prompt instead.".into(),
            Notice::MaxTokensLowered { from, to } => format!("The answer limit of {from} tokens was too large for this model; using {to}."),
            Notice::ImagesInline => "This model didn't accept images as attachments; Texo sent them inline instead.".into(),
            Notice::StreamingOff => "This provider didn't stream the answer; Texo waits for the whole answer instead.".into(),
            Notice::LessThinking => "The model's reasoning used up its answer limit, so Texo asked again with less thinking.".into(),
            Notice::Retrying { attempt, wait_ms, reason } => {
                format!("{reason} Trying again in {:.0} s (attempt {attempt}).", (*wait_ms as f64 / 1000.0).ceil())
            }
        }
    }
}

/// What the streaming callback receives.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// More visible answer text (thinking and text tool calls held back).
    Text(String),
    /// Forget the text streamed so far (a retry, a model switch, or the
    /// final clean-up changed it). The final text follows as `Text`.
    Reset,
    Notice(Notice),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LlmReply {
    /// The answer text, thinking and text tool calls removed.
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: StopReason,
    /// The model that answered (after any switch).
    pub model: String,
    pub usage: Usage,
    pub replay: Option<Replay>,
    /// The answer parsed as JSON when [`LlmRequest::json`] was set.
    pub json: Option<Value>,
    pub notices: Vec<Notice>,
    /// Tools went through the prompt (ReAct) for this answer.
    pub text_tools: bool,
}

impl LlmReply {
    /// The assistant message to append to the conversation.
    pub fn to_msg(&self) -> Msg {
        Msg::Assistant { text: self.text.clone(), tool_calls: self.tool_calls.clone(), replay: self.replay.clone() }
    }
}

// ------------------------------------------------------ capabilities --

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingParam {
    /// No reasoning switch is sent.
    None,
    /// NVIDIA Nemotron: `chat_template_kwargs.enable_thinking`.
    ChatTemplateKwargs,
    /// Claude: `thinking: {type: "adaptive"}` plus `output_config.effort`.
    Adaptive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    pub vision: bool,
    pub tools: bool,
    pub thinking: ThinkingParam,
    pub context_length: Option<u64>,
    /// The model is in Texo's list; otherwise these are guesses.
    pub known: bool,
}

/// (id prefix, vision, tools, context length)
const KNOWN_MODELS: &[(&str, bool, bool, Option<u64>)] = &[
    ("nvidia/nemotron-3-ultra", false, true, Some(1_000_000)),
    ("nvidia/nemotron-3.5-lightning", false, true, None),
    ("nvidia/nemotron-3.5-bolt", false, true, None),
    ("nvidia/nemotron-3.5-super-vl", true, true, None),
    ("nvidia/nemotron-3-nano-omni", true, true, None),
    ("moonshotai/kimi-k3", true, true, None),
    ("mistralai/mistral-large-4", true, true, Some(1_000_000)),
    ("minimaxai/minimax-m3", true, true, None),
    ("google/gemma-4", true, true, None),
    ("stepfun-ai/step-5", true, true, Some(1_000_000)),
    ("z-ai/glm-5", false, true, None),
    ("openai/gpt-oss", false, true, None),
    ("claude-", true, true, None),
    ("gemini-", true, true, None),
];

/// What a model can do, from its id (OpenRouter's `:free` suffix ignored).
/// Unknown models are assumed to take tools (a 400 switches to text tools)
/// and to see images only when their id says so.
pub fn model_caps(provider: ProviderId, model: &str) -> ModelCaps {
    let id = model.trim().to_ascii_lowercase();
    let id = id.strip_suffix(":free").unwrap_or(&id);
    let thinking = if provider == ProviderId::Anthropic || id.starts_with("claude-") {
        ThinkingParam::Adaptive
    } else if provider == ProviderId::Nvidia && id.contains("nemotron") {
        ThinkingParam::ChatTemplateKwargs
    } else {
        ThinkingParam::None
    };
    match KNOWN_MODELS.iter().find(|(p, ..)| id.starts_with(p)) {
        Some(&(_, vision, tools, context_length)) => ModelCaps { vision, tools, thinking, context_length, known: true },
        None => ModelCaps {
            vision: id.contains("-vl") || id.contains("vision") || id.contains("omni"),
            tools: true,
            thinking,
            context_length: None,
            known: false,
        },
    }
}

/// A preferred model for one role, with its fallbacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelChoice {
    pub model: &'static str,
    pub fallbacks: &'static [&'static str],
    pub thinking: bool,
}

/// The spec's NVIDIA defaults (used when the live list has them).
pub const NVIDIA_AGENT: ModelChoice = ModelChoice {
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    fallbacks: &["moonshotai/kimi-k3.1-pro", "mistralai/mistral-large-4-1t-a52b", "minimaxai/minimax-m3.1-flash"],
    thinking: true,
};
pub const NVIDIA_CHAT: ModelChoice = ModelChoice {
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    fallbacks: &["nvidia/nemotron-3.5-bolt-e4b"],
    thinking: false,
};
pub const NVIDIA_VISION: ModelChoice = ModelChoice {
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    fallbacks: &["mistralai/mistral-large-4-1t-a52b", "moonshotai/kimi-k3.1-pro", "google/gemma-4-31b-it"],
    thinking: false,
};
pub const NVIDIA_REVIEW: ModelChoice = ModelChoice {
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    fallbacks: &["moonshotai/kimi-k3.1-pro", "stepfun-ai/step-5-preview"],
    thinking: true,
};

// ----------------------------------------------------------- session --

/// What a session learned about the current model; kept across steps.
#[derive(Debug, Clone, Default)]
pub(crate) struct Adapt {
    pub text_tools: bool,
    pub max_tokens_cap: Option<u32>,
    pub inline_images: bool,
    pub no_stream: bool,
    pub no_json_format: bool,
    pub no_template_kwargs: bool,
    /// Claude without adaptive thinking / effort (an older model).
    pub plain_anthropic: bool,
    /// One request only: Nemotron thinking off, Claude effort `low`, after
    /// the reasoning used up the output limit. Never kept in the session.
    pub less_thinking: bool,
}

pub const DEFAULT_MAX_TOKENS: u32 = 8192;
pub const FALLBACK_MAX_TOKENS: u32 = 4096;
pub const CLAUDE_MAX_TOKENS: u32 = 16000;

/// A conversation with one provider over several steps (an agent run or a
/// chat). It remembers model switches and fallbacks (text tools, smaller
/// `max_tokens`, inline images) so later steps don't repeat failed requests.
pub struct LlmSession {
    ep: Endpoint,
    adapt: Adapt,
    abandoned: Vec<String>,
}

impl LlmSession {
    pub fn new(ep: Endpoint) -> Self {
        LlmSession { ep, adapt: Adapt::default(), abandoned: Vec::new() }
    }

    /// The model the next request goes to.
    pub fn model(&self) -> &str {
        &self.ep.model
    }

    #[allow(dead_code)] // part of the session API; the runtime reads the model only
    pub fn endpoint(&self) -> &Endpoint {
        &self.ep
    }

    /// Tools go through the prompt (ReAct) for this session.
    #[allow(dead_code)] // part of the session API (ReAct fallback is reported as a notice)
    pub fn text_tools(&self) -> bool {
        self.adapt.text_tools
    }

    /// Sends one request. With `sink`, the answer is streamed: visible text
    /// arrives as [`StreamEvent::Text`], and the final reply is returned as
    /// well.
    pub async fn complete(
        &mut self,
        client: &Client,
        req: &LlmRequest,
        cancel: &Cancel,
        mut sink: Option<&mut (dyn FnMut(StreamEvent) + Send + '_)>,
    ) -> AiResult<LlmReply> {
        let mut notices: Vec<Notice> = Vec::new();
        // Visible text already streamed by the current attempt.
        let mut emitted = String::new();
        loop {
            // One model: retries and request adjustments.
            let mut tries = 0u32;
            let last_err: AiError;
            let reason: String;
            // One retry with less thinking after a cut-off answer.
            let mut lowered = false;
            loop {
                cancel.check()?;
                if req.policy.rate_limit {
                    ratelimit::acquire(self.ep.provider, &self.ep.base_url, cancel).await?;
                }
                if !emitted.is_empty() {
                    if let Some(s) = sink.as_deref_mut() {
                        s(StreamEvent::Reset);
                    }
                    emitted.clear();
                }
                let adapt = Adapt { less_thinking: lowered, ..self.adapt.clone() };
                let text_tools = adapt.text_tools && !req.tools.is_empty();
                let attempt = wire::attempt(client, &self.ep, req, &adapt, cancel, sink.as_deref_mut(), &mut emitted).await;
                let result = match attempt.and_then(|raw| finalize(raw, req, &self.ep, text_tools)) {
                    // Cut off at the output limit: first ask again with less
                    // reasoning; then hand back cut-off tool calls (the
                    // caller tells the model to make smaller calls), or try
                    // the next model when nothing usable came back.
                    Err(Fail::Cut(cut)) => {
                        if wire::can_lower_thinking(&self.ep, req, &adapt) {
                            lowered = true;
                            let n = Notice::LessThinking;
                            if let Some(s) = sink.as_deref_mut() {
                                s(StreamEvent::Notice(n.clone()));
                            }
                            notices.push(n);
                            continue;
                        }
                        match cut {
                            Some(reply) => Ok(*reply),
                            None => {
                                last_err = super::openai::truncated(&self.ep.label);
                                reason = "The answer was cut off at the length limit.".into();
                                break;
                            }
                        }
                    }
                    other => other,
                };
                let fail = match result {
                    Ok(mut reply) => {
                        if let Some(s) = sink.as_deref_mut() {
                            wire::finish_stream(s, &reply.text, &emitted);
                        }
                        reply.notices = notices;
                        reply.text_tools = self.adapt.text_tools;
                        return Ok(reply);
                    }
                    Err(f) => f,
                };
                match classify(&fail, req, &self.ep, &self.adapt) {
                    Next::Adjust(adjust) => {
                        let notice = adjust.apply(&mut self.adapt, req);
                        if let Some(n) = notice {
                            if let Some(s) = sink.as_deref_mut() {
                                s(StreamEvent::Notice(n.clone()));
                            }
                            notices.push(n);
                        }
                    }
                    Next::Retry(server_wait) => {
                        tries += if matches!(&fail, Fail::Err(e) if e.kind == Kind::Timeout) { 2 } else { 1 };
                        let err = fail.into_error(&self.ep);
                        let too_long = server_wait.is_some_and(|w| w > req.policy.max_wait);
                        if tries >= req.policy.tries || too_long {
                            // The connection itself keeps failing: every
                            // fallback model is on the same server.
                            if err.kind == Kind::Network {
                                return Err(err);
                            }
                            reason = retry_reason(&err);
                            last_err = err;
                            break;
                        }
                        let wait = server_wait.unwrap_or_else(|| backoff(&req.policy, tries));
                        let n = Notice::Retrying { attempt: tries + 1, wait_ms: wait.as_millis() as u64, reason: retry_reason(&err) };
                        if let Some(s) = sink.as_deref_mut() {
                            s(StreamEvent::Notice(n.clone()));
                        }
                        notices.push(n);
                        cancel
                            .run(async {
                                tokio::time::sleep(wait).await;
                                Ok(())
                            })
                            .await?;
                    }
                    Next::Switch => {
                        let err = fail.into_error(&self.ep);
                        reason = retry_reason(&err);
                        last_err = err;
                        break;
                    }
                    Next::Fatal => return Err(fail.into_error(&self.ep)),
                }
            }
            // This model gave up: move to the next fallback, if any.
            let current = self.ep.model.clone();
            let next = req
                .fallback_models
                .iter()
                .find(|m| **m != current && !m.trim().is_empty() && !self.abandoned.contains(m))
                .cloned();
            let Some(next) = next else { return Err(last_err) };
            self.abandoned.push(current.clone());
            self.ep.model = next.clone();
            // The new model gets a fresh start (it may take tools or images).
            self.adapt = Adapt { no_stream: self.adapt.no_stream, ..Adapt::default() };
            let n = Notice::ModelSwitched { from: current, to: next, reason };
            if let Some(s) = sink.as_deref_mut() {
                s(StreamEvent::Notice(n.clone()));
            }
            notices.push(n);
        }
    }
}

/// One request without a session (no memory between calls, but retries and
/// fallback models still apply).
pub async fn complete(client: &Client, ep: &Endpoint, req: LlmRequest, cancel: &Cancel) -> AiResult<LlmReply> {
    LlmSession::new(ep.clone()).complete(client, &req, cancel, None).await
}

/// Like [`complete`], streaming the visible text to `sink`.
#[allow(dead_code)] // one-shot streaming entry point; runs and chat stream through LlmSession
pub async fn complete_streaming(
    client: &Client,
    ep: &Endpoint,
    req: LlmRequest,
    cancel: &Cancel,
    sink: &mut (dyn FnMut(StreamEvent) + Send + '_),
) -> AiResult<LlmReply> {
    LlmSession::new(ep.clone()).complete(client, &req, cancel, Some(sink)).await
}

fn retry_reason(err: &AiError) -> String {
    match err.kind {
        Kind::RateLimited => "The provider is limiting requests.".into(),
        Kind::Server => "The provider is having trouble.".into(),
        Kind::Timeout => "The model took too long.".into(),
        Kind::NotFound => "The model isn't available.".into(),
        Kind::Forbidden | Kind::Payment => "This key can't use the model.".into(),
        Kind::BadResponse => "The model sent an empty or unreadable answer.".into(),
        _ => err.message.clone(),
    }
}

/// 2 s, 4 s, 8 s … plus up to half a step of jitter.
fn backoff(policy: &RetryPolicy, tries: u32) -> Duration {
    let base = policy.backoff.saturating_mul(1u32 << (tries.saturating_sub(1)).min(6));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let jitter = policy.backoff.mul_f64(f64::from(nanos % 1000) / 2000.0);
    base + jitter
}

// ------------------------------------------------- retry decisions --

enum Next {
    Adjust(Adjust),
    /// Retry the same model, after the server's wait if it gave one.
    Retry(Option<Duration>),
    Switch,
    Fatal,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Adjust {
    TextTools,
    LowerMaxTokens,
    InlineImages,
    NoStream,
    NoJsonFormat,
    NoTemplateKwargs,
    PlainAnthropic,
}

impl Adjust {
    fn apply(self, a: &mut Adapt, req: &LlmRequest) -> Option<Notice> {
        match self {
            Adjust::TextTools => {
                a.text_tools = true;
                Some(Notice::TextTools)
            }
            Adjust::LowerMaxTokens => {
                let from = req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
                a.max_tokens_cap = Some(FALLBACK_MAX_TOKENS);
                Some(Notice::MaxTokensLowered { from, to: FALLBACK_MAX_TOKENS })
            }
            Adjust::InlineImages => {
                a.inline_images = true;
                Some(Notice::ImagesInline)
            }
            Adjust::NoStream => {
                a.no_stream = true;
                Some(Notice::StreamingOff)
            }
            Adjust::NoJsonFormat => {
                a.no_json_format = true;
                None
            }
            Adjust::NoTemplateKwargs => {
                a.no_template_kwargs = true;
                None
            }
            Adjust::PlainAnthropic => {
                a.plain_anthropic = true;
                None
            }
        }
    }
}

fn has_images(req: &LlmRequest) -> bool {
    req.messages.iter().any(|m| matches!(m, Msg::User { content } if content.iter().any(|p| matches!(p, Part::Image { .. }))))
}

fn classify(fail: &Fail, req: &LlmRequest, ep: &Endpoint, a: &Adapt) -> Next {
    let api = providers::get(ep.provider).api;
    match fail {
        Fail::Empty => Next::Retry(None),
        // Handled before classifying (less thinking, then the next model).
        Fail::Cut(_) => Next::Switch,
        Fail::Err(e) => match e.kind {
            Kind::Timeout | Kind::Network | Kind::BadResponse => Next::Retry(None),
            _ => Next::Fatal,
        },
        Fail::Http { err, status, detail, streamed } => {
            let d = detail.to_ascii_lowercase();
            match status {
                400 | 422 => {
                    let sent_max = wire::max_tokens_for(req, a, api);
                    if *streamed && !a.no_stream && d.contains("stream") {
                        Next::Adjust(Adjust::NoStream)
                    } else if api == Api::OpenAi && !a.text_tools && !req.tools.is_empty()
                        && (d.contains("tool") || d.contains("function"))
                    {
                        Next::Adjust(Adjust::TextTools)
                    } else if a.max_tokens_cap.is_none() && sent_max > FALLBACK_MAX_TOKENS
                        && (d.contains("max_tokens") || d.contains("max_completion_tokens") || d.contains("too large")
                            || d.contains("maximum") || d.contains("exceed"))
                    {
                        Next::Adjust(Adjust::LowerMaxTokens)
                    } else if api == Api::OpenAi && !a.no_template_kwargs && wire::sends_template_kwargs(ep, a)
                        && d.contains("chat_template")
                    {
                        Next::Adjust(Adjust::NoTemplateKwargs)
                    } else if api == Api::Anthropic && !a.plain_anthropic
                        && ["thinking", "effort", "adaptive", "output_config"].iter().any(|w| d.contains(w))
                    {
                        Next::Adjust(Adjust::PlainAnthropic)
                    } else if api == Api::OpenAi && has_images(req) && !a.inline_images
                        && (matches!(ep.provider, ProviderId::Nvidia | ProviderId::Custom)
                            || d.contains("image") || d.contains("multimodal") || d.contains("content"))
                    {
                        Next::Adjust(Adjust::InlineImages)
                    } else if req.json.is_some() && !a.no_json_format && api == Api::OpenAi
                        && wire::sends_json_format(ep, a, req)
                    {
                        // Not every model behind a provider takes structured
                        // output; the prompt asks for JSON anyway.
                        Next::Adjust(Adjust::NoJsonFormat)
                    } else {
                        Next::Fatal
                    }
                }
                408 | 429 | 500..=599 => Next::Retry(err.retry_after_secs.map(Duration::from_secs)),
                402..=404 => Next::Switch,
                _ => Next::Fatal,
            }
        }
    }
}

// --------------------------------------------------------- finalize --

fn finalize(raw: Raw, req: &LlmRequest, ep: &Endpoint, text_tools: bool) -> Result<LlmReply, Fail> {
    let label = &ep.label;
    match raw.finish {
        wire::Finish::Refusal => {
            return Err(Fail::Err(AiError::new(
                Kind::Refused,
                format!("{label} declined to help with this request. Try rewording it, or pick another model."),
            )))
        }
        wire::Finish::ContentFilter if raw.text.trim().is_empty() && raw.calls.is_empty() => {
            return Err(Fail::Err(AiError::new(Kind::Refused, format!("{label} declined to answer this request."))))
        }
        _ => {}
    }
    let names: Vec<&str> = req.tools.iter().map(|t| t.name.as_str()).collect();
    let mut text = super::llm_text::strip_think(&raw.text);
    let mut calls: Vec<ToolCall> = raw
        .calls
        .into_iter()
        .map(|c| {
            let name = super::llm_text::resolve_tool_name(&c.name, &names).unwrap_or_else(|| c.name.trim().to_string());
            let (arguments, invalid_arguments) = wire::parse_args(c.args);
            ToolCall { id: c.id, name, arguments, invalid_arguments }
        })
        .collect();
    if calls.is_empty() && !names.is_empty() && req.tool_choice != ToolChoice::None {
        let (rest, found) = super::llm_text::extract_text_calls(&text, &names);
        if !found.is_empty() {
            text = rest;
            calls = found
                .into_iter()
                .map(|c| {
                    let (arguments, invalid_arguments) = wire::parse_args(wire::RawArgs::Text(c.arguments));
                    ToolCall { id: String::new(), name: c.name, arguments, invalid_arguments }
                })
                .collect();
        }
    } else if calls.is_empty() && !names.is_empty() && text_tools {
        // An answer-only round in ReAct mode: an Action line the model
        // wrote anyway is not part of the answer.
        let (rest, found) = super::llm_text::extract_text_calls(&text, &names);
        if !found.is_empty() {
            text = rest;
        }
    }
    wire::fill_ids(&mut calls);
    let cut = raw.finish == wire::Finish::Length;
    if text.is_empty() && calls.is_empty() {
        if cut {
            return Err(Fail::Cut(None));
        }
        return Err(Fail::Empty);
    }
    let cut_calls = cut && !calls.is_empty();
    if cut_calls {
        // A tool call cut off mid-arguments must never run: the caller
        // tells the model it was cut off.
        for c in &mut calls {
            let raw = c.invalid_arguments.take().unwrap_or_else(|| c.arguments.to_string());
            let kept: String = raw.chars().take(200).collect();
            c.invalid_arguments = Some(format!("{CUT_OFF_ARGS} {kept}"));
            c.arguments = Value::Object(Default::default());
        }
    }
    let json = req.json.as_ref().and_then(|_| super::llm_text::repair_json(&text));
    let stop = if !calls.is_empty() {
        StopReason::ToolUse
    } else if cut {
        StopReason::MaxTokens
    } else {
        StopReason::EndTurn
    };
    let reply = LlmReply {
        text,
        tool_calls: calls,
        stop,
        model: raw.model.unwrap_or_else(|| ep.model.clone()),
        usage: raw.usage,
        replay: raw.replay.map(|blocks| Replay { model: ep.model.clone(), blocks }),
        json,
        notices: Vec::new(),
        text_tools: false,
    };
    if cut_calls {
        return Err(Fail::Cut(Some(Box::new(reply))));
    }
    Ok(reply)
}

#[cfg(test)]
#[path = "llm_tests.rs"]
mod tests;
