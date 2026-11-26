//! The two wire dialects behind [`super::llm`]: request bodies, one HTTP
//! attempt (streaming or not), and reading replies and stream events into
//! one shape ([`Raw`]) that `llm` then cleans up.

// Used by the agents runtime and the chat (v1.2); until those land, parts
// of this module are only reached from tests.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{json, Map, Value};

use super::error::{AiError, Kind};
use super::http::{self, Cancel, Endpoint, Reply};
use super::llm::{Adapt, LlmRequest, Msg, Part, StreamEvent, ToolChoice, ToolSpec, Usage};
use super::llm::{CLAUDE_MAX_TOKENS, DEFAULT_MAX_TOKENS};
use super::llm_text;
use super::providers::{self, Api, ProviderId, Structured};
use super::sse;

const STEP_TIMEOUT: Duration = Duration::from_secs(180);
const THINKING_TIMEOUT: Duration = Duration::from_secs(300);
/// Provider error text kept for deciding on a retry (never shown as is).
const DETAIL_CAP: usize = 2000;
const INVALID_ARGS_CAP: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    Stop,
    ToolCalls,
    Length,
    Refusal,
    ContentFilter,
    Other,
}

#[derive(Debug, Clone)]
pub enum RawArgs {
    Text(String),
    Json(Value),
}

#[derive(Debug, Clone)]
pub struct RawCall {
    pub id: String,
    pub name: String,
    pub args: RawArgs,
}

/// A reply as the provider sent it, before clean-up.
#[derive(Debug, Clone)]
pub struct Raw {
    pub text: String,
    pub calls: Vec<RawCall>,
    pub finish: Finish,
    pub model: Option<String>,
    pub usage: Usage,
    /// Claude's content blocks, for sending back unchanged.
    pub replay: Option<Value>,
}

/// Why one attempt failed.
#[derive(Debug)]
pub enum Fail {
    /// An HTTP error status (or an error inside a 200 / a stream).
    /// `detail` is the provider's text, used only to decide what to adjust.
    Http { err: AiError, status: u16, detail: String, streamed: bool },
    /// HTTP 200 with nothing in it.
    Empty,
    /// The answer hit the output limit before anything usable came back.
    /// With tool calls, the reply is kept (calls marked as cut off, never
    /// runnable) so the caller can tell the model to make smaller calls.
    Cut(Option<Box<super::llm::LlmReply>>),
    Err(AiError),
}

impl Fail {
    pub fn into_error(self, ep: &Endpoint) -> AiError {
        match self {
            Fail::Http { err, .. } | Fail::Err(err) => err,
            Fail::Cut(_) => super::openai::truncated(&ep.label),
            Fail::Empty => AiError::new(
                Kind::BadResponse,
                format!("{} sent an empty answer. Try again or pick another model.", ep.label),
            ),
        }
    }
}

fn http_fail(status: StatusCode, headers: &reqwest::header::HeaderMap, body: &str, ep: &Endpoint, streamed: bool) -> Fail {
    let detail = http::error_detail(body);
    let err = http::map_status(status, headers, detail.as_deref(), &ep.label, ep.key.as_ref());
    let raw = detail.unwrap_or_else(|| body.chars().take(DETAIL_CAP).collect());
    Fail::Http { err, status: status.as_u16(), detail: raw.chars().take(DETAIL_CAP).collect(), streamed }
}

/// An `{"error": {...}}` object found in a 200 body or a stream event.
fn embedded_error(e: &Value, default_status: u16, ep: &Endpoint, streamed: bool) -> Fail {
    let code = e
        .get("code")
        .and_then(|c| c.as_u64().or_else(|| c.as_str().and_then(|s| s.parse().ok())))
        .filter(|c| (400..600).contains(c))
        .unwrap_or(u64::from(default_status)) as u16;
    let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY);
    let detail = e.get("message").and_then(Value::as_str).or_else(|| e.as_str()).unwrap_or_default();
    let err = http::map_status(status, &Default::default(), Some(detail), &ep.label, ep.key.as_ref());
    Fail::Http { err, status: code, detail: detail.chars().take(DETAIL_CAP).collect(), streamed }
}

// ------------------------------------------------------------ shared --

pub fn max_tokens_for(req: &LlmRequest, a: &Adapt, api: Api) -> u32 {
    let wanted = req.max_tokens.unwrap_or(match api {
        Api::OpenAi => DEFAULT_MAX_TOKENS,
        Api::Anthropic => CLAUDE_MAX_TOKENS,
    });
    a.max_tokens_cap.map_or(wanted, |cap| wanted.min(cap))
}

pub fn timeout_for(req: &LlmRequest, api: Api) -> Duration {
    req.timeout.unwrap_or(if req.thinking || api == Api::Anthropic { THINKING_TIMEOUT } else { STEP_TIMEOUT })
}

pub fn sends_template_kwargs(ep: &Endpoint, a: &Adapt) -> bool {
    ep.provider == ProviderId::Nvidia && ep.model.to_ascii_lowercase().contains("nemotron") && !a.no_template_kwargs
}

pub fn sends_json_format(ep: &Endpoint, a: &Adapt, req: &LlmRequest) -> bool {
    req.json.is_some()
        && !a.no_json_format
        && (req.tools.is_empty() || a.text_tools)
        && providers::get(ep.provider).structured != Structured::None
}

fn uses_text_tools(req: &LlmRequest, a: &Adapt) -> bool {
    a.text_tools && !req.tools.is_empty()
}

/// ReAct with tools allowed in this request (not a last, answer-only round).
fn offers_text_tools(req: &LlmRequest, a: &Adapt) -> bool {
    uses_text_tools(req, a) && req.tool_choice != ToolChoice::None
}

/// Where the model's own `Observation:` would start: the request stops
/// there so a weak model can't invent tool results.
pub const REACT_STOP: &str = "\nObservation:";

/// The Claude effort sent for this request.
fn effort_for(req: &LlmRequest, a: &Adapt) -> String {
    if a.less_thinking {
        return "low".into();
    }
    req.effort.clone().unwrap_or_else(|| if req.thinking { "high".into() } else { "medium".into() })
}

/// The request spends output on reasoning that a retry can turn down
/// (Nemotron `enable_thinking`, Claude's effort).
pub fn can_lower_thinking(ep: &Endpoint, req: &LlmRequest, a: &Adapt) -> bool {
    if a.less_thinking {
        return false;
    }
    match providers::get(ep.provider).api {
        Api::OpenAi => req.thinking && sends_template_kwargs(ep, a),
        Api::Anthropic => !a.plain_anthropic && effort_for(req, a) != "low",
    }
}

/// Arguments as a JSON object, plus the raw text when they were unreadable.
pub fn parse_args(args: RawArgs) -> (Value, Option<String>) {
    let empty = || Value::Object(Map::new());
    let cap = |s: &str| s.chars().take(INVALID_ARGS_CAP).collect::<String>();
    match args {
        RawArgs::Json(v @ Value::Object(_)) => (v, None),
        RawArgs::Json(Value::Null) => (empty(), None),
        RawArgs::Json(Value::String(s)) => parse_args(RawArgs::Text(s)),
        RawArgs::Json(other) => (empty(), Some(cap(&other.to_string()))),
        RawArgs::Text(s) if s.trim().is_empty() => (empty(), None),
        // Cut off mid-string (a file text that stopped halfway): closing
        // the string would run the tool with a shortened value.
        RawArgs::Text(s) if llm_text::ends_in_open_string(&s) => (empty(), Some(cap(&s))),
        RawArgs::Text(s) => match llm_text::repair_json(&s) {
            Some(v @ Value::Object(_)) => (v, None),
            _ => (empty(), Some(cap(&s))),
        },
    }
}

/// Gives every call a unique id (some open models send none, or repeat
/// one). Generated ids are 9 letters and digits, which every provider
/// accepts (Mistral requires exactly that).
pub fn fill_ids(calls: &mut [super::llm::ToolCall]) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut seen: Vec<String> = Vec::new();
    for c in calls.iter_mut() {
        if c.id.trim().is_empty() || seen.contains(&c.id) {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            let mut x = (t ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15)).wrapping_add(n);
            let mut id = String::new();
            for _ in 0..9 {
                let d = (x % 36) as u32;
                id.push(std::char::from_digit(d, 36).unwrap_or('0'));
                x /= 36;
                if x == 0 {
                    x = t.rotate_left(17) ^ n;
                }
            }
            c.id = id;
        }
        seen.push(c.id.clone());
    }
}

fn anthropic_id(id: &str) -> String {
    let s: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if s.is_empty() {
        "call".into()
    } else {
        s
    }
}

fn data_url(mime: &str, url: &str) -> String {
    if url.starts_with("data:") {
        url.to_string()
    } else {
        format!("data:{mime};base64,{url}")
    }
}

/// `(media_type, base64)` from a data URL.
fn split_data_url<'a>(mime: &'a str, url: &'a str) -> (&'a str, &'a str) {
    if let Some(rest) = url.strip_prefix("data:") {
        if let Some((meta, data)) = rest.split_once(',') {
            let media = meta.split(';').next().filter(|m| !m.is_empty()).unwrap_or(mime);
            return (media, data);
        }
    }
    (mime, url)
}

// ------------------------------------------------- text-tools (ReAct) --

/// The system prompt with the tool list for models that reject `tools`.
pub fn react_system(system: &str, tools: &[ToolSpec]) -> String {
    let mut s = String::from(system.trim_end());
    if !s.is_empty() {
        s.push_str("\n\n");
    }
    s.push_str(
        "## Tools\nYou can use the tools below. To use one, write a line in exactly this form, then stop and wait:\n\
         Action: tool_name {\"argument\": \"value\"}\n\
         The arguments are one JSON object on the same line. The result comes back in a message that starts with \
         \"Observation:\". When you have finished, answer normally without an Action line.\n\nAvailable tools:\n",
    );
    for t in tools {
        s.push_str(&format!("- {}: {}\n  Arguments (JSON Schema): {}\n", t.name, t.description.trim(), t.parameters));
    }
    s
}

/// Tool calls and results rewritten as text, for the ReAct fallback.
pub fn react_messages(messages: &[Msg]) -> Vec<Msg> {
    messages
        .iter()
        .map(|m| match m {
            Msg::Assistant { text, tool_calls, .. } if !tool_calls.is_empty() => {
                let mut t = text.trim_end().to_string();
                for c in tool_calls {
                    if !t.is_empty() {
                        t.push('\n');
                    }
                    t.push_str(&format!("Action: {} {}", c.name, c.arguments));
                }
                Msg::Assistant { text: t, tool_calls: Vec::new(), replay: None }
            }
            Msg::Assistant { text, .. } => Msg::Assistant { text: text.clone(), tool_calls: Vec::new(), replay: None },
            Msg::Tool { name, content, is_error, .. } => {
                let tag = if *is_error { format!("{name}, error") } else { name.clone() };
                Msg::user(format!("Observation: [{tag}]\n{content}"))
            }
            other => other.clone(),
        })
        .collect()
}

fn system_text(req: &LlmRequest, a: &Adapt) -> String {
    let mut system = if offers_text_tools(req, a) {
        react_system(&req.system, &req.tools)
    } else if uses_text_tools(req, a) {
        // The last round: earlier calls stay in the history as text, but
        // no more may be made.
        let mut s = req.system.trim_end().to_string();
        if !s.is_empty() {
            s.push_str("\n\n");
        }
        s.push_str("Don't use any more tools and don't write Action lines. Answer the user now from what you have found.");
        s
    } else {
        req.system.clone()
    };
    if let Some(schema) = &req.json {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(&format!(
            "Answer with one JSON object that matches this JSON Schema, and nothing else:\n{schema}"
        ));
    }
    system
}

// ------------------------------------------------------ OpenAI body --

pub fn openai_body(ep: &Endpoint, req: &LlmRequest, a: &Adapt, stream: bool) -> Value {
    let text_tools = uses_text_tools(req, a);
    let system = system_text(req, a);
    let msgs = if text_tools { react_messages(&req.messages) } else { req.messages.clone() };
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(json!({"role": "system", "content": system}));
    }
    for m in &msgs {
        match m {
            Msg::User { content } => messages.push(json!({"role": "user", "content": openai_user_content(content, a.inline_images)})),
            Msg::Assistant { text, tool_calls, .. } => {
                let mut o = json!({"role": "assistant"});
                o["content"] = if text.is_empty() && !tool_calls.is_empty() { Value::Null } else { json!(text) };
                if !tool_calls.is_empty() {
                    o["tool_calls"] = tool_calls
                        .iter()
                        .map(|c| json!({"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments.to_string()}}))
                        .collect();
                }
                messages.push(o);
            }
            Msg::Tool { tool_call_id, content, .. } => {
                messages.push(json!({"role": "tool", "tool_call_id": tool_call_id, "content": content}))
            }
        }
    }
    let mut body = json!({
        "model": ep.model,
        "messages": messages,
        "max_tokens": max_tokens_for(req, a, Api::OpenAi),
        "stream": stream,
    });
    if stream {
        body["stream_options"] = json!({"include_usage": true});
    }
    if !req.tools.is_empty() && !text_tools {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
            .collect();
        body["tool_choice"] = match &req.tool_choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Tool(name) => json!({"type": "function", "function": {"name": name}}),
        };
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if offers_text_tools(req, a) {
        body["stop"] = json!([REACT_STOP]);
    }
    if sends_json_format(ep, a, req) {
        let schema = req.json.clone().unwrap_or(Value::Null);
        body["response_format"] = match providers::get(ep.provider).structured {
            Structured::JsonSchema => json!({"type": "json_schema", "json_schema": {"name": "texo_output", "schema": schema}}),
            _ => json!({"type": "json_object"}),
        };
    }
    if sends_template_kwargs(ep, a) {
        body["chat_template_kwargs"] = json!({"enable_thinking": req.thinking && !a.less_thinking, "force_nonempty_content": true});
    }
    body
}

fn openai_user_content(parts: &[Part], inline_images: bool) -> Value {
    let only_text = parts.iter().all(|p| matches!(p, Part::Text { .. }));
    if only_text || inline_images {
        // One string; images (if any) as NVIDIA's inline `<img>` form.
        let mut s = String::new();
        for p in parts {
            match p {
                Part::Text { text } => {
                    if !s.is_empty() {
                        s.push('\n');
                    }
                    s.push_str(text);
                }
                Part::Image { mime, data_url: url } => {
                    if !s.is_empty() {
                        s.push('\n');
                    }
                    s.push_str(&format!("<img src=\"{}\" />", data_url(mime, url)));
                }
            }
        }
        return json!(s);
    }
    parts
        .iter()
        .map(|p| match p {
            Part::Text { text } => json!({"type": "text", "text": text}),
            Part::Image { mime, data_url: url } => json!({"type": "image_url", "image_url": {"url": data_url(mime, url)}}),
        })
        .collect()
}

// --------------------------------------------------- Anthropic body --

pub fn anthropic_body(ep: &Endpoint, req: &LlmRequest, a: &Adapt, stream: bool) -> Value {
    let text_tools = uses_text_tools(req, a);
    let system = system_text(req, a);
    let msgs = if text_tools { react_messages(&req.messages) } else { req.messages.clone() };
    let mut out: Vec<(String, Vec<Value>)> = Vec::new();
    for m in &msgs {
        let (role, blocks) = match m {
            Msg::User { content } => {
                let blocks: Vec<Value> = content
                    .iter()
                    .filter_map(|p| match p {
                        Part::Text { text } if text.is_empty() => None,
                        Part::Text { text } => Some(json!({"type": "text", "text": text})),
                        Part::Image { mime, data_url: url } => {
                            let (media, data) = split_data_url(mime, url);
                            Some(json!({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}))
                        }
                    })
                    .collect();
                ("user", blocks)
            }
            Msg::Assistant { text, tool_calls, replay } => {
                let blocks = match replay {
                    Some(r) if r.model == ep.model && !text_tools && r.blocks.as_array().is_some_and(|b| !b.is_empty()) => {
                        r.blocks.as_array().cloned().unwrap_or_default()
                    }
                    _ => {
                        let mut b = Vec::new();
                        if !text.trim().is_empty() {
                            b.push(json!({"type": "text", "text": text}));
                        }
                        for c in tool_calls {
                            let input = if c.arguments.is_object() { c.arguments.clone() } else { json!({}) };
                            b.push(json!({"type": "tool_use", "id": anthropic_id(&c.id), "name": c.name, "input": input}));
                        }
                        b
                    }
                };
                ("assistant", blocks)
            }
            Msg::Tool { tool_call_id, content, is_error, .. } => {
                let mut b = json!({"type": "tool_result", "tool_use_id": anthropic_id(tool_call_id), "content": content});
                if *is_error {
                    b["is_error"] = json!(true);
                }
                ("user", vec![b])
            }
        };
        match out.last_mut() {
            Some((r, b)) if r == role => b.extend(blocks),
            _ => out.push((role.to_string(), blocks)),
        }
    }
    let messages: Vec<Value> = out
        .into_iter()
        .map(|(role, mut blocks)| {
            if blocks.is_empty() {
                blocks.push(json!({"type": "text", "text": "(empty)"}));
            }
            json!({"role": role, "content": blocks})
        })
        .collect();
    let mut body = json!({
        "model": ep.model,
        "max_tokens": max_tokens_for(req, a, Api::Anthropic),
        "messages": messages,
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if stream {
        body["stream"] = json!(true);
    }
    let thinking = !a.plain_anthropic;
    if !req.tools.is_empty() && !text_tools {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters}))
            .collect();
        body["tool_choice"] = match &req.tool_choice {
            ToolChoice::None => json!({"type": "none"}),
            // Forcing a tool doesn't combine with thinking.
            ToolChoice::Required if !thinking => json!({"type": "any"}),
            ToolChoice::Tool(name) if !thinking => json!({"type": "tool", "name": name}),
            _ => json!({"type": "auto"}),
        };
    }
    if offers_text_tools(req, a) {
        body["stop_sequences"] = json!([REACT_STOP]);
    }
    if thinking {
        body["thinking"] = json!({"type": "adaptive"});
        body["output_config"] = json!({"effort": effort_for(req, a)});
        if let Some(schema) = &req.json {
            body["output_config"]["format"] = json!({"type": "json_schema", "schema": schema});
        }
    }
    body
}

// ---------------------------------------------------------- attempt --

fn build_request(client: &Client, ep: &Endpoint, api: Api, body: &Value, stream: bool) -> RequestBuilder {
    let accept = if stream { "text/event-stream" } else { "application/json" };
    match api {
        Api::OpenAi => {
            let mut r = client.post(ep.url("chat/completions"));
            if !stream {
                r = r.header("accept", accept);
            }
            if let Some(key) = &ep.key {
                r = r.bearer_auth(key.expose());
            }
            if ep.provider == ProviderId::Openrouter {
                r = r.header("X-OpenRouter-Title", "Texo");
            }
            r.json(body)
        }
        Api::Anthropic => {
            let mut r = client.post(ep.url("messages")).header("anthropic-version", super::anthropic::API_VERSION);
            if !stream {
                r = r.header("accept", accept);
            }
            if let Some(key) = &ep.key {
                r = r.header("x-api-key", key.expose());
            }
            r.json(body)
        }
    }
}

/// One HTTP attempt. With a sink (and streaming not turned off), the reply
/// is streamed and the visible text goes to the sink; `emitted` holds what
/// was sent so far.
pub async fn attempt(
    client: &Client,
    ep: &Endpoint,
    req: &LlmRequest,
    a: &Adapt,
    cancel: &Cancel,
    sink: Option<&mut (dyn FnMut(StreamEvent) + Send + '_)>,
    emitted: &mut String,
) -> Result<Raw, Fail> {
    let api = providers::get(ep.provider).api;
    let stream = sink.is_some() && !a.no_stream;
    let body = match api {
        Api::OpenAi => openai_body(ep, req, a, stream),
        Api::Anthropic => anthropic_body(ep, req, a, stream),
    };
    let request = build_request(client, ep, api, &body, stream);
    let timeout = timeout_for(req, api);
    let react = uses_text_tools(req, a);

    let Some(sink) = sink.filter(|_| stream) else {
        let reply = http::send(request, timeout, cancel, &ep.label).await.map_err(Fail::Err)?;
        return whole_reply(reply, ep, api, false);
    };

    let mut oa = OaAcc::default();
    let mut an = AnAcc::default();
    let mut stream_fail: Option<Fail> = None;
    let mut on_event = |ev: sse::Event| -> Result<(), AiError> {
        let fed = match api {
            Api::OpenAi => oa.feed(&ev.data, ep),
            Api::Anthropic => an.feed(&ev.event, &ev.data, ep),
        };
        match fed {
            Ok(true) => {
                let raw_text = match api {
                    Api::OpenAi => oa.text.clone(),
                    Api::Anthropic => an.text(),
                };
                push_visible(&mut *sink, &mut *emitted, &llm_text::visible_prefix(&raw_text, react));
                Ok(())
            }
            Ok(false) => Ok(()),
            Err(f) => {
                stream_fail = Some(f);
                Err(AiError::new(Kind::Other, "stream error"))
            }
        }
    };
    let outcome = sse::send(request, timeout, cancel, &ep.label, &mut on_event).await;
    if let Some(f) = stream_fail {
        return Err(f);
    }
    match outcome.map_err(Fail::Err)? {
        sse::Outcome::Whole(reply) => whole_reply(reply, ep, api, true),
        sse::Outcome::Streamed => {
            let unfinished = match api {
                Api::OpenAi => oa.unfinished(),
                Api::Anthropic => an.unfinished(),
            };
            if unfinished {
                // Half an answer (or half a tool call) is never used.
                return Err(Fail::Err(stopped_early(ep)));
            }
            match api {
                Api::OpenAi => Ok(oa.into_raw()),
                Api::Anthropic => Ok(an.into_raw()),
            }
        }
    }
}

fn stopped_early(ep: &Endpoint) -> AiError {
    AiError::new(
        Kind::Network,
        format!("{} stopped sending its answer before it was finished. Check your connection and try again.", ep.label),
    )
}

fn push_visible(sink: &mut (dyn FnMut(StreamEvent) + Send + '_), emitted: &mut String, visible: &str) {
    if let Some(delta) = visible.strip_prefix(emitted.as_str()) {
        if !delta.is_empty() {
            sink(StreamEvent::Text(delta.to_string()));
            emitted.push_str(delta);
        }
    } else {
        sink(StreamEvent::Reset);
        emitted.clear();
        if !visible.is_empty() {
            sink(StreamEvent::Text(visible.to_string()));
            emitted.push_str(visible);
        }
    }
}

/// After the final clean-up: makes sure the sink ends up holding exactly
/// the final text.
pub fn finish_stream(sink: &mut (dyn FnMut(StreamEvent) + Send + '_), final_text: &str, emitted: &str) {
    if emitted == final_text {
        return;
    }
    if !emitted.is_empty() {
        sink(StreamEvent::Reset);
    }
    if !final_text.is_empty() {
        sink(StreamEvent::Text(final_text.to_string()));
    }
}

fn whole_reply(reply: Reply, ep: &Endpoint, api: Api, streamed: bool) -> Result<Raw, Fail> {
    if !reply.status.is_success() {
        return Err(http_fail(reply.status, &reply.headers, &reply.body, ep, streamed));
    }
    match api {
        Api::OpenAi => parse_openai(&reply.body, ep),
        Api::Anthropic => parse_anthropic(&reply.body, ep),
    }
}

fn bad_reply(ep: &Endpoint) -> Fail {
    Fail::Err(AiError::new(Kind::BadResponse, format!("{} sent a reply Texo couldn't read.", ep.label)))
}

// --------------------------------------------------- OpenAI replies --

fn finish_of(reason: Option<&str>) -> Finish {
    match reason {
        Some("stop") | Some("eos") | Some("end_turn") | None => Finish::Stop,
        Some("tool_calls") | Some("function_call") | Some("tool_use") => Finish::ToolCalls,
        Some("length") | Some("max_tokens") => Finish::Length,
        Some("content_filter") => Finish::ContentFilter,
        Some("refusal") => Finish::Refusal,
        Some(_) => Finish::Other,
    }
}

fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str).is_none_or(|t| t == "text" || t == "output_text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

fn openai_usage(v: &Value) -> Usage {
    Usage {
        input_tokens: v.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        output_tokens: v.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0),
    }
}

pub fn parse_openai(body: &str, ep: &Endpoint) -> Result<Raw, Fail> {
    if body.trim().is_empty() {
        return Err(Fail::Empty);
    }
    let v: Value = serde_json::from_str(body).map_err(|_| bad_reply(ep))?;
    let Some(choices) = v.get("choices").and_then(Value::as_array) else {
        if let Some(e) = v.get("error") {
            return Err(embedded_error(e, 502, ep, false));
        }
        if is_error_object(&v) {
            return Err(embedded_error(&v, 502, ep, false));
        }
        return Err(bad_reply(ep));
    };
    let Some(choice) = choices.first() else { return Err(Fail::Empty) };
    let message = &choice["message"];
    // `reasoning_content` / `reasoning` are ignored on purpose.
    let text = content_text(&message["content"]);
    let mut calls: Vec<RawCall> = message["tool_calls"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| RawCall {
                    id: c["id"].as_str().unwrap_or_default().to_string(),
                    name: c.pointer("/function/name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    args: match c.pointer("/function/arguments") {
                        Some(Value::String(s)) => RawArgs::Text(s.clone()),
                        Some(other) => RawArgs::Json(other.clone()),
                        None => RawArgs::Json(Value::Null),
                    },
                })
                .collect()
        })
        .unwrap_or_default();
    if calls.is_empty() {
        if let Some(f) = message.get("function_call").filter(|f| f.is_object()) {
            calls.push(RawCall {
                id: String::new(),
                name: f["name"].as_str().unwrap_or_default().to_string(),
                args: RawArgs::Text(f["arguments"].as_str().unwrap_or_default().to_string()),
            });
        }
    }
    Ok(Raw {
        text,
        calls,
        finish: finish_of(choice["finish_reason"].as_str()),
        model: v["model"].as_str().map(str::to_string),
        usage: openai_usage(&v),
        replay: None,
    })
}

/// vLLM / NIM report some errors as a top-level `{"object": "error",
/// "message": …, "code": …}` instead of `{"error": {…}}`.
fn is_error_object(v: &Value) -> bool {
    v.get("object").and_then(Value::as_str) == Some("error")
}

#[derive(Default)]
struct CallAcc {
    index: i64,
    id: String,
    name: String,
    args: String,
}

#[derive(Default)]
pub struct OaAcc {
    pub text: String,
    calls: Vec<CallAcc>,
    finish: Option<String>,
    model: Option<String>,
    usage: Usage,
    /// A chunk with a choice arrived.
    saw_choice: bool,
    /// `data: [DONE]` arrived.
    done: bool,
    /// Calls without `index` sent in separate chunks get slots from here on.
    unindexed_base: i64,
}

/// The arguments so far are one whole JSON object.
fn complete_args(args: &str) -> bool {
    let t = args.trim();
    t.starts_with('{') && llm_text::balanced_end(t, 0) == Some(t.len())
}

impl OaAcc {
    /// The stream ended without a finish reason or `[DONE]` after it
    /// started answering: the answer is incomplete.
    pub fn unfinished(&self) -> bool {
        self.saw_choice && self.finish.is_none() && !self.done
    }

    /// Feeds one `data:` payload. `Ok(true)` when the text grew.
    pub fn feed(&mut self, data: &str, ep: &Endpoint) -> Result<bool, Fail> {
        let data = data.trim();
        if data == "[DONE]" {
            self.done = true;
            return Ok(false);
        }
        if data.is_empty() {
            return Ok(false);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(false) };
        if v.get("choices").is_none() {
            if let Some(e) = v.get("error") {
                return Err(embedded_error(e, 500, ep, true));
            }
            if is_error_object(&v) {
                return Err(embedded_error(&v, 500, ep, true));
            }
        }
        if let Some(m) = v["model"].as_str() {
            self.model = Some(m.to_string());
        }
        if v.get("usage").is_some_and(Value::is_object) {
            self.usage = openai_usage(&v);
        }
        let mut grew = false;
        let Some(choice) = v["choices"].as_array().and_then(|c| c.first()) else { return Ok(false) };
        self.saw_choice = true;
        let delta = choice.get("delta").filter(|d| d.is_object()).unwrap_or(&choice["message"]);
        let text = content_text(&delta["content"]);
        if !text.is_empty() {
            self.text.push_str(&text);
            grew = true;
        }
        if let Some(tcs) = delta["tool_calls"].as_array() {
            for (pos, tc) in tcs.iter().enumerate() {
                let index = match tc["index"].as_i64() {
                    Some(i) => i,
                    None => self.unindexed_slot(tc, pos as i64),
                };
                let slot = match self.calls.iter().position(|c| c.index == index) {
                    Some(i) => i,
                    None => {
                        self.calls.push(CallAcc { index, ..Default::default() });
                        self.calls.len() - 1
                    }
                };
                let acc = &mut self.calls[slot];
                if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                    if acc.id.is_empty() {
                        acc.id = id.to_string();
                    }
                }
                if let Some(name) = tc.pointer("/function/name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    // Some servers repeat the full name in every chunk.
                    if acc.name.is_empty() {
                        acc.name = name.to_string();
                    } else if acc.name != name {
                        acc.name.push_str(name);
                    }
                }
                match tc.pointer("/function/arguments") {
                    Some(Value::String(s)) => acc.args.push_str(s),
                    Some(v @ Value::Object(_)) => acc.args = v.to_string(),
                    _ => {}
                }
            }
        }
        if let Some(f) = choice["finish_reason"].as_str() {
            self.finish = Some(f.to_string());
        }
        Ok(grew)
    }

    /// The slot for a streamed call without `index` (some servers, e.g.
    /// Gemini's, omit it and send each parallel call in its own chunk at
    /// position 0). A different id, or a new name and arguments after a
    /// whole argument object, starts a new call instead of appending.
    fn unindexed_slot(&mut self, tc: &Value, pos: i64) -> i64 {
        let index = self.unindexed_base + pos;
        let Some(acc) = self.calls.iter().find(|c| c.index == index) else { return index };
        let id = tc["id"].as_str().unwrap_or_default();
        let new_id = !id.is_empty() && !acc.id.is_empty() && acc.id != id;
        let has_name = tc.pointer("/function/name").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
        let fresh_args = match tc.pointer("/function/arguments") {
            Some(Value::String(s)) => s.trim_start().starts_with('{'),
            Some(Value::Object(_)) => true,
            _ => false,
        };
        if new_id || (has_name && fresh_args && complete_args(&acc.args)) {
            let next = self.calls.iter().map(|c| c.index).max().unwrap_or(-1) + 1;
            self.unindexed_base = next - pos;
            return next;
        }
        index
    }

    pub fn into_raw(self) -> Raw {
        Raw {
            text: self.text,
            calls: self
                .calls
                .into_iter()
                .map(|c| RawCall { id: c.id, name: c.name, args: RawArgs::Text(c.args) })
                .collect(),
            finish: finish_of(self.finish.as_deref()),
            model: self.model,
            usage: self.usage,
            replay: None,
        }
    }
}

// ------------------------------------------------ Anthropic replies --

fn anthropic_finish(stop: Option<&str>) -> Finish {
    match stop {
        Some("refusal") => Finish::Refusal,
        Some("max_tokens") | Some("model_context_window_exceeded") => Finish::Length,
        Some("tool_use") => Finish::ToolCalls,
        _ => Finish::Stop,
    }
}

/// Private marker on a streamed `tool_use` block whose arguments were unreadable.
const UNREADABLE_ARGS: &str = "_texoUnreadableArgs";

fn raw_from_blocks(blocks: Vec<Value>, stop: Option<&str>, model: Option<String>, usage: Usage) -> Raw {
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut replay = Vec::new();
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => {
                let t = b["text"].as_str().unwrap_or_default();
                text.push_str(t);
                if !t.is_empty() {
                    replay.push(json!({"type": "text", "text": t}));
                }
            }
            Some("tool_use") => {
                let mut b = b;
                // A streamed call whose argument text couldn't be repaired:
                // report the raw text so the model is asked for valid JSON.
                let unreadable = b.as_object_mut().and_then(|o| o.remove(UNREADABLE_ARGS));
                let args = match unreadable {
                    Some(Value::String(raw)) => RawArgs::Text(raw),
                    _ => RawArgs::Json(b.get("input").cloned().unwrap_or(Value::Null)),
                };
                calls.push(RawCall {
                    id: b["id"].as_str().unwrap_or_default().to_string(),
                    name: b["name"].as_str().unwrap_or_default().to_string(),
                    args,
                });
                replay.push(b);
            }
            Some("thinking") | Some("redacted_thinking") => replay.push(b),
            _ => {}
        }
    }
    Raw {
        text,
        calls,
        finish: anthropic_finish(stop),
        model,
        usage,
        replay: if replay.is_empty() { None } else { Some(Value::Array(replay)) },
    }
}

fn anthropic_usage(u: &Value) -> (u64, u64) {
    let input = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .iter()
        .filter_map(|k| u.get(*k).and_then(Value::as_u64))
        .sum();
    (input, u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0))
}

pub fn parse_anthropic(body: &str, ep: &Endpoint) -> Result<Raw, Fail> {
    if body.trim().is_empty() {
        return Err(Fail::Empty);
    }
    let v: Value = serde_json::from_str(body).map_err(|_| bad_reply(ep))?;
    if v["type"] == "error" {
        return Err(anthropic_error(&v["error"], ep, false));
    }
    let blocks = v["content"].as_array().cloned().ok_or_else(|| bad_reply(ep))?;
    let (input_tokens, output_tokens) = anthropic_usage(&v["usage"]);
    Ok(raw_from_blocks(
        blocks,
        v["stop_reason"].as_str(),
        v["model"].as_str().map(str::to_string),
        Usage { input_tokens, output_tokens },
    ))
}

fn anthropic_error(e: &Value, ep: &Endpoint, streamed: bool) -> Fail {
    let status = match e["type"].as_str() {
        Some("overloaded_error") => 529,
        Some("rate_limit_error") => 429,
        Some("invalid_request_error") => 400,
        Some("authentication_error") => 401,
        Some("permission_error") => 403,
        Some("not_found_error") => 404,
        Some("request_too_large") => 413,
        _ => 500,
    };
    let mut e = e.clone();
    e["code"] = json!(status);
    embedded_error(&e, status, ep, streamed)
}

#[derive(Default)]
pub struct AnAcc {
    blocks: Vec<Value>,
    json_parts: Vec<String>,
    stop: Option<String>,
    model: Option<String>,
    usage: Usage,
    started: bool,
    /// `message_stop` arrived.
    stopped: bool,
}

impl AnAcc {
    /// The stream ended before `message_stop` or a stop reason.
    pub fn unfinished(&self) -> bool {
        self.started && self.stop.is_none() && !self.stopped
    }

    fn slot(&mut self, i: usize) {
        while self.blocks.len() <= i {
            self.blocks.push(json!({"type": "text", "text": ""}));
            self.json_parts.push(String::new());
        }
    }

    pub fn text(&self) -> String {
        self.blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect()
    }

    /// Feeds one event. `Ok(true)` when the text grew.
    pub fn feed(&mut self, event: &str, data: &str, ep: &Endpoint) -> Result<bool, Fail> {
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(false) };
        let kind = v["type"].as_str().unwrap_or(event).to_string();
        let index = v["index"].as_u64().unwrap_or(0) as usize;
        match kind.as_str() {
            "message_start" => {
                self.started = true;
                self.model = v.pointer("/message/model").and_then(Value::as_str).map(str::to_string);
                let (i, o) = anthropic_usage(&v["message"]["usage"]);
                self.usage.input_tokens = i;
                self.usage.output_tokens = o;
            }
            "content_block_start" => {
                self.slot(index);
                let mut block = v["content_block"].clone();
                if block["type"] == "tool_use" {
                    block["input"] = json!({});
                }
                self.blocks[index] = block;
                self.json_parts[index].clear();
            }
            "content_block_delta" => {
                self.slot(index);
                let d = &v["delta"];
                let b = &mut self.blocks[index];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let t = d["text"].as_str().unwrap_or_default();
                        let cur = b["text"].as_str().unwrap_or_default().to_string();
                        b["text"] = json!(cur + t);
                        return Ok(!t.is_empty());
                    }
                    Some("thinking_delta") => {
                        let cur = b["thinking"].as_str().unwrap_or_default().to_string();
                        b["thinking"] = json!(cur + d["thinking"].as_str().unwrap_or_default());
                    }
                    Some("signature_delta") => b["signature"] = d["signature"].clone(),
                    Some("input_json_delta") => self.json_parts[index].push_str(d["partial_json"].as_str().unwrap_or_default()),
                    _ => {}
                }
            }
            "content_block_stop" => {
                self.slot(index);
                self.close_tool(index);
            }
            "message_delta" => {
                if let Some(s) = v.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop = Some(s.to_string());
                }
                if let Some(o) = v.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                    self.usage.output_tokens = o;
                }
            }
            "message_stop" => self.stopped = true,
            "error" => return Err(anthropic_error(&v["error"], ep, true)),
            _ => {}
        }
        Ok(false)
    }

    fn close_tool(&mut self, i: usize) {
        if self.blocks[i]["type"] == "tool_use" && !self.json_parts[i].trim().is_empty() {
            let parsed = Some(&self.json_parts[i])
                .filter(|t| !llm_text::ends_in_open_string(t))
                .and_then(|t| llm_text::repair_json(t))
                .filter(Value::is_object);
            match parsed {
                Some(input) => self.blocks[i]["input"] = input,
                None => {
                    // Replayed blocks need an object; the raw text travels
                    // beside it and is taken out again in raw_from_blocks.
                    self.blocks[i]["input"] = json!({});
                    self.blocks[i][UNREADABLE_ARGS] = json!(std::mem::take(&mut self.json_parts[i]));
                }
            }
            self.json_parts[i].clear();
        }
    }

    pub fn into_raw(mut self) -> Raw {
        for i in 0..self.blocks.len() {
            self.close_tool(i);
        }
        raw_from_blocks(self.blocks, self.stop.as_deref(), self.model, self.usage)
    }
}
