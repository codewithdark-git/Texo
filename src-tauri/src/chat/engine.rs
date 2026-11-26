//! One chat turn: the user's message with its context and attachments, then
//! up to [`MAX_TOOL_ROUNDS`] rounds of read-only tool calls, then the answer.
//! Kept apart from Tauri so tests can drive it against the mock server.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine as _;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::budget::{budget_chars, fit_history, msg_chars, shrink_tool_results, RESERVE};
use super::store::{
    clip_line, AttachmentKind, ChatError, ChatMessage, ChatRole, ContextItem, ContextKind, ProposedTask,
    StoredAttachment, ToolUse,
};
use super::tools::{self, ToolEnv};
use crate::agents::tools::net::NetCtx;
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::{Cancel, Endpoint};
use crate::ai::llm::{
    self, model_caps, LlmRequest, LlmSession, Msg, Part, RetryPolicy, StopReason, StreamEvent, ToolChoice, Usage,
};
use crate::fsops;

/// Tool rounds per answer (spec: a small step cap). After the last one the
/// model must answer without tools.
pub const MAX_TOOL_ROUNDS: usize = 6;
const MAX_MESSAGE_CHARS: usize = 32_000;
const MAX_ATTACHMENTS: usize = 10;
const MAX_IMAGES: usize = 6;
const MAX_MENTIONS: usize = 8;
const MAX_BUFFERS: usize = 64;
const FILE_CAP: usize = 20_000;
const CONTEXT_CAP: usize = 80_000;
/// Data URL length; the webview sends JPEGs under 180 KB.
const MAX_IMAGE_URL: usize = 1_500_000;
const IMAGE_MIMES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

// ------------------------------------------------------------ request --

/// Payload of `ai_chat_send` (serde camelCase).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    pub chat_id: String,
    /// Chosen by the UI so it can match events and cancel; generated when empty.
    #[serde(default)]
    pub request_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentIn>,
    /// `@file` mentions: project paths sent along as context.
    #[serde(default)]
    pub mentions: Vec<String>,
    /// Only when "Include current file / selection" is on.
    #[serde(default)]
    pub current_file: Option<CurrentFile>,
    /// Unsaved editor buffers; tools and mentions read these instead of disk.
    #[serde(default)]
    pub dirty_buffers: Vec<DirtyBuffer>,
    /// Model for this message (and remembered for the chat).
    #[serde(default)]
    pub model: Option<String>,
}

/// An attachment: `text` for text files and PDFs (text extracted by the
/// webview), `dataUrl` for images (already downscaled by the webview).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIn {
    pub name: String,
    pub mime: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentFile {
    pub file: String,
    /// The editor's text (may be unsaved); read from disk when missing.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub selection: Option<Selection>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyBuffer {
    pub file: String,
    pub text: String,
}

// ------------------------------------------------------------- events --

/// Payload of the `ai-chat-message` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub chat_id: String,
    pub request_id: String,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EventBody {
    /// The user's message as saved (sent first).
    UserMessage { message: ChatMessage },
    /// More answer text: append it.
    Delta { text: String },
    /// Replace all answer text shown so far with this (after a retry or a
    /// model switch).
    Replace { text: String },
    /// Plain words for a note under the answer.
    Notice { message: String },
    ToolStarted { name: String, summary: String },
    ToolFinished { tool: ToolUse },
    ProposedTask { task: ProposedTask },
    /// The finished assistant message as saved (also on error or stop).
    Done { message: ChatMessage },
}

pub type Emit<'a> = &'a (dyn Fn(EventBody) + Send + Sync);

// ------------------------------------------------------------ prepare --

/// The user's message ready to store and send.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub user: ChatMessage,
    /// Image parts for this turn only.
    pub images: Vec<Part>,
    pub buffers: HashMap<String, String>,
    /// Problems worth telling the user (a mention that couldn't be read).
    pub notices: Vec<String>,
}

fn norm(path: &str) -> String {
    path.trim().trim_start_matches('@').replace('\\', "/").trim_matches('/').to_string()
}

fn cap_text(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        (text.to_string(), false)
    } else {
        let mut s: String = text.chars().take(max).collect();
        s.push_str("\n[… shortened]");
        (s, true)
    }
}

/// XML-style attributes need `"` escaped.
fn attr(v: &str) -> String {
    v.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

/// Checks the request and gathers its context. Fails only for things the
/// user must change (empty message, unreadable attachment, too much data).
pub fn prepare(root: &Path, req: &ChatSendRequest) -> AiResult<Prepared> {
    let text = req.text.trim().to_string();
    if text.is_empty() && req.attachments.is_empty() {
        return Err(AiError::invalid("Type a message first."));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(AiError::invalid(
            "This message is very long. Attach the text as a file instead, or send it in parts.",
        ));
    }
    if req.attachments.len() > MAX_ATTACHMENTS {
        return Err(AiError::invalid(format!("You can attach up to {MAX_ATTACHMENTS} files to one message.")));
    }

    let mut buffers = HashMap::new();
    for b in req.dirty_buffers.iter().take(MAX_BUFFERS) {
        let file = norm(&b.file);
        if fsops::resolve(root, &file).is_ok() && b.text.len() as u64 <= fsops::MAX_TEXT_BYTES {
            buffers.insert(file, b.text.clone());
        }
    }

    let mut user = ChatMessage::new(ChatRole::User, text);
    let mut notices = Vec::new();
    let mut images = Vec::new();
    let mut ctx = String::new();
    fn add_ctx(ctx: &mut String, block: String) -> bool {
        if ctx.len() + block.len() > CONTEXT_CAP {
            return false;
        }
        ctx.push_str(&block);
        ctx.push_str("\n\n");
        true
    }

    // The editor: selection, or else the whole current file.
    let mut current_included: Option<String> = None;
    if let Some(cf) = &req.current_file {
        let file = norm(&cf.file);
        if fsops::resolve(root, &file).is_ok() {
            if let Some(sel) = cf.selection.as_ref().filter(|s| !s.text.trim().is_empty()) {
                let (t, cut) = cap_text(&sel.text, FILE_CAP);
                let (a, b) = (sel.start_line.min(sel.end_line), sel.start_line.max(sel.end_line));
                let block = format!(
                    "<selection file=\"{}\" lines=\"{a}-{b}\">\n{t}\n</selection>",
                    attr(&file)
                );
                if add_ctx(&mut ctx, block) {
                    user.context.push(ContextItem {
                        kind: ContextKind::Selection,
                        file: file.clone(),
                        start_line: Some(a),
                        end_line: Some(b),
                        truncated: cut,
                    });
                }
            } else {
                let body = match &cf.text {
                    Some(t) => Ok(t.clone()),
                    None => tools::file_text(root, &buffers, &file),
                };
                match body {
                    Ok(body) => {
                        let (t, cut) = cap_text(&body, FILE_CAP);
                        let block = format!("<file path=\"{}\" open-in-editor=\"true\">\n{t}\n</file>", attr(&file));
                        if add_ctx(&mut ctx, block) {
                            user.context.push(ContextItem {
                                kind: ContextKind::CurrentFile,
                                file: file.clone(),
                                start_line: None,
                                end_line: None,
                                truncated: cut,
                            });
                            current_included = Some(file.clone());
                        }
                    }
                    Err(e) => notices.push(format!("The open file wasn't sent: {}", e.message)),
                }
            }
        }
    }

    // @file mentions.
    let mut seen: Vec<String> = Vec::new();
    for m in &req.mentions {
        let file = norm(m);
        if file.is_empty() || seen.contains(&file) || current_included.as_deref() == Some(file.as_str()) {
            continue;
        }
        if seen.len() >= MAX_MENTIONS {
            notices.push(format!("Only the first {MAX_MENTIONS} @files were sent."));
            break;
        }
        seen.push(file.clone());
        match tools::file_text(root, &buffers, &file) {
            Ok(body) => {
                let (t, cut) = cap_text(&body, FILE_CAP);
                let block = format!("<file path=\"{}\">\n{t}\n</file>", attr(&file));
                if add_ctx(&mut ctx, block) {
                    user.context.push(ContextItem {
                        kind: ContextKind::Mention,
                        file,
                        start_line: None,
                        end_line: None,
                        truncated: cut,
                    });
                } else {
                    notices.push(format!("@{file} wasn't sent: the message already holds as much text as it can."));
                }
            }
            Err(e) => notices.push(format!("@{file} wasn't sent: {}", e.message)),
        }
    }

    // Attachments.
    for a in &req.attachments {
        let name = clip_line(&a.name, 120);
        let name = if name.is_empty() { "attachment".to_string() } else { name };
        let mime = a.mime.trim().to_ascii_lowercase();
        if let Some(url) = a.data_url.as_deref().filter(|u| !u.trim().is_empty()) {
            let mime = if mime == "image/jpg" { "image/jpeg".to_string() } else { mime };
            if !IMAGE_MIMES.contains(&mime.as_str()) {
                return Err(AiError::invalid(format!(
                    "\u{201c}{name}\u{201d} can't be sent as a picture. Use PNG, JPEG, WebP or GIF."
                )));
            }
            if images.len() >= MAX_IMAGES {
                return Err(AiError::invalid(format!("You can attach up to {MAX_IMAGES} pictures to one message.")));
            }
            let data_url = image_data_url(url.trim(), &mime).ok_or_else(|| {
                AiError::invalid(format!("\u{201c}{name}\u{201d} couldn't be read as a picture. Try attaching it again."))
            })?;
            if data_url.len() > MAX_IMAGE_URL {
                return Err(AiError::invalid(format!(
                    "\u{201c}{name}\u{201d} is too large. Try a smaller picture or a screenshot of part of it."
                )));
            }
            user.attachments.push(StoredAttachment {
                name: name.clone(),
                mime: mime.clone(),
                kind: AttachmentKind::Image,
                size: data_url.len() as u64,
                data_url: Some(data_url.clone()),
                truncated: false,
            });
            images.push(Part::Image { mime, data_url });
        } else if let Some(body) = &a.text {
            let (t, cut) = cap_text(body, FILE_CAP);
            let block = format!("<attachment name=\"{}\">\n{t}\n</attachment>", attr(&name));
            if !add_ctx(&mut ctx, block) {
                return Err(AiError::invalid(
                    "The attachments hold too much text for one message. Send fewer or smaller files.",
                ));
            }
            user.attachments.push(StoredAttachment {
                name,
                mime: if mime.is_empty() { "text/plain".into() } else { mime },
                kind: AttachmentKind::Text,
                size: body.chars().count() as u64,
                data_url: None,
                truncated: cut,
            });
        } else {
            return Err(AiError::invalid(format!(
                "Texo can't read \u{201c}{name}\u{201d}. Attach text files (.tex, .bib, .txt, .md, .csv), PDFs or pictures."
            )));
        }
    }

    user.context_text = ctx.trim_end().to_string();
    Ok(Prepared { user, images, buffers, notices })
}

/// A checked `data:<mime>;base64,…` URL (bare base64 is accepted).
fn image_data_url(input: &str, mime: &str) -> Option<String> {
    let data = match input.strip_prefix("data:") {
        Some(rest) => {
            let (head, data) = rest.split_once(',')?;
            let mut parts = head.split(';');
            let m = parts.next()?.trim().to_ascii_lowercase();
            let m = if m == "image/jpg" { "image/jpeg".to_string() } else { m };
            if !IMAGE_MIMES.contains(&m.as_str()) || !head.contains(";base64") {
                return None;
            }
            data
        }
        None => input,
    };
    let data: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if data.is_empty() || base64::engine::general_purpose::STANDARD.decode(&data).is_err() {
        return None;
    }
    Some(format!("data:{mime};base64,{data}"))
}

// --------------------------------------------------------------- turn --

/// A model that can describe pictures for a model that can't see them.
#[derive(Debug, Clone)]
pub struct VisionHelper {
    pub model: String,
    pub fallbacks: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TurnConfig {
    pub thinking: bool,
    pub effort: Option<String>,
    pub fallback_models: Vec<String>,
    pub policy: RetryPolicy,
    pub max_rounds: usize,
    pub vision: Option<VisionHelper>,
}

impl Default for TurnConfig {
    fn default() -> Self {
        TurnConfig {
            thinking: false,
            effort: None,
            fallback_models: Vec::new(),
            policy: RetryPolicy::default(),
            max_rounds: MAX_TOOL_ROUNDS,
            vision: None,
        }
    }
}

const SYSTEM_PROMPT: &str = "You are the writing assistant in Texo, a LaTeX editor. You chat with the author about their paper. Many users are not LaTeX experts, so use plain, friendly words.

Rules:
1. Answer the question directly and briefly. Use Markdown. Put LaTeX in ```latex code blocks and math in $...$.
2. To look at the project, use list_files, read_file and search. Read a file before you talk about what is in it, and point to places as file:line.
3. For literature use search_papers and get_bibtex. Never invent papers, authors, DOIs or BibTeX.
4. fetch_url reads a web page or PDF the user names.
5. You can't change files. When the user wants something changed (edit, fix, rewrite, add, translate), call propose_task with a complete instruction and the files involved. The user starts it with one click. Then say in one or two sentences what it will do.
6. When the user says \"remember ...\", call remember with a short note. read_memory shows notes saved earlier.
7. Use a few tool calls at most, then answer.

Example tool call: read_file {\"path\": \"main.tex\", \"start_line\": 1, \"end_line\": 60}

Always finish with a plain answer to the user.";

fn system_prompt(root: &Path, buffers: &HashMap<String, String>) -> String {
    let mut s = SYSTEM_PROMPT.to_string();
    let files: Vec<String> = crate::project::list_files(root)
        .into_iter()
        .filter(|e| !e.is_dir)
        .map(|e| e.path)
        .chain(buffers.keys().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if !files.is_empty() {
        s.push_str("\n\nProject files");
        if files.len() > 80 {
            s.push_str(&format!(" (first 80 of {})", files.len()));
        }
        s.push_str(":\n");
        s.push_str(&files.iter().take(80).cloned().collect::<Vec<_>>().join("\n"));
    }
    let memory = tools::memory_text(root);
    if !memory.trim().is_empty() {
        s.push_str("\n\n");
        s.push_str(crate::agents::tools::memory::PROMPT_HEADING);
        s.push('\n');
        s.push_str(&tools::cap(memory.trim(), tools::MEMORY_CAP));
    }
    s
}

fn join_text(a: &str, b: &str) -> String {
    match (a.trim().is_empty(), b.trim().is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}\n\n{b}"),
    }
}

fn add_usage(total: &mut Option<Usage>, u: Usage) {
    let t = total.get_or_insert_with(Usage::default);
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
}

/// The parts the model gets for this turn's pictures: the pictures
/// themselves, or (for a model that can't see) a description by the vision
/// helper, or a note.
async fn picture_parts(
    client: &Client,
    ep: &Endpoint,
    cfg: &TurnConfig,
    prepared: &Prepared,
    cancel: &Cancel,
    notices: &mut Vec<String>,
    emit: Emit<'_>,
) -> AiResult<Vec<Part>> {
    if prepared.images.is_empty() {
        return Ok(Vec::new());
    }
    let caps = model_caps(ep.provider, &ep.model);
    if caps.vision || !caps.known {
        return Ok(prepared.images.clone());
    }
    let names: Vec<&str> = prepared
        .user
        .attachments
        .iter()
        .filter(|a| a.kind == AttachmentKind::Image)
        .map(|a| a.name.as_str())
        .collect();
    let mut note = |m: String| {
        emit(EventBody::Notice { message: m.clone() });
        notices.push(m);
    };
    let Some(helper) = &cfg.vision else {
        note(format!(
            "{} can't see pictures, so only their names were sent. Pick a model that can see pictures to ask about them.",
            ep.model
        ));
        return Ok(vec![Part::Text { text: format!("[Pictures attached that you can't see: {}]", names.join(", ")) }]);
    };
    let vep = Endpoint { model: helper.model.clone(), ..ep.clone() };
    let mut content = vec![Part::Text {
        text: "Describe each picture precisely for someone who can't see it: what it shows, all visible text, numbers, axes, labels, equations (as LaTeX) and anything that looks wrong. Number the pictures.".into(),
    }];
    content.extend(prepared.images.iter().cloned());
    let req = LlmRequest {
        system: "You describe pictures for a writing assistant. Be factual and complete; don't guess what isn't visible.".into(),
        messages: vec![Msg::User { content }],
        tools: Vec::new(),
        tool_choice: ToolChoice::None,
        max_tokens: Some(2_000),
        fallback_models: helper.fallbacks.clone(),
        policy: cfg.policy.clone(),
        ..Default::default()
    };
    emit(EventBody::ToolStarted { name: "describe_images".into(), summary: "Looking at the pictures".into() });
    match llm::complete(client, &vep, req, cancel).await {
        Ok(r) if !r.text.trim().is_empty() => {
            note(format!("{} can't see pictures, so {} described them first.", ep.model, r.model));
            Ok(vec![Part::Text {
                text: format!("[Description of the attached pictures ({}):]\n{}", names.join(", "), r.text.trim()),
            }])
        }
        Err(e) if e.kind == Kind::Cancelled => Err(e),
        other => {
            let why = match other {
                Err(e) => e.message,
                Ok(_) => "the answer was empty".into(),
            };
            note(format!("The pictures couldn't be described ({why}), so only their names were sent."));
            Ok(vec![Part::Text { text: format!("[Pictures attached that you can't see: {}]", names.join(", ")) }])
        }
    }
}

/// Runs one turn and returns the assistant message. Never fails: errors,
/// a stop, or a cut-off answer are recorded on the message.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    client: &Client,
    ep: Endpoint,
    cfg: &TurnConfig,
    root: &Path,
    earlier: &[ChatMessage],
    prepared: &Prepared,
    net: &NetCtx,
    cancel: &Cancel,
    emit: Emit<'_>,
) -> ChatMessage {
    let mut out = ChatMessage::new(ChatRole::Assistant, "");
    out.model = Some(ep.model.clone());
    for n in &prepared.notices {
        emit(EventBody::Notice { message: n.clone() });
        out.notices.push(n.clone());
    }
    let mut text = String::new();
    let result = turn_inner(client, ep, cfg, root, earlier, prepared, net, cancel, emit, &mut out, &mut text).await;
    out.text = text.trim().to_string();
    if let Err(e) = result {
        if e.kind == Kind::Cancelled {
            out.stopped = true;
        } else {
            out.error = Some(ChatError::from(&e));
        }
    } else if out.text.is_empty() && out.proposed_task.is_none() {
        out.error = Some(ChatError {
            kind: "badResponse".into(),
            message: "The model didn't send an answer. Try again, or pick another model.".into(),
        });
    }
    out
}

#[allow(clippy::too_many_arguments)]
async fn turn_inner(
    client: &Client,
    ep: Endpoint,
    cfg: &TurnConfig,
    root: &Path,
    earlier: &[ChatMessage],
    prepared: &Prepared,
    net: &NetCtx,
    cancel: &Cancel,
    emit: Emit<'_>,
    out: &mut ChatMessage,
    text: &mut String,
) -> AiResult<()> {
    let caps = model_caps(ep.provider, &ep.model);
    let budget = budget_chars(&caps);
    // The prompt lists the project's files: walk them off the async runtime.
    let system = {
        let root = root.to_path_buf();
        let names: HashMap<String, String> = prepared.buffers.keys().map(|k| (k.clone(), String::new())).collect();
        tokio::task::spawn_blocking(move || system_prompt(&root, &names)).await.unwrap_or_else(|_| SYSTEM_PROMPT.to_string())
    };
    let tool_specs = tools::specs(net.web_search_available());

    // This turn's user message.
    let mut parts = vec![Part::Text { text: join_text(&prepared.user.context_text, &prepared.user.text) }];
    parts.extend(picture_parts(client, &ep, cfg, prepared, cancel, &mut out.notices, emit).await?);
    let current: usize = msg_chars(&Msg::User { content: parts.clone() });
    let room = budget.saturating_sub(RESERVE + system.len() + current);
    let fitted = fit_history(earlier, room);
    if fitted.summarised + fitted.dropped > 0 {
        let m = "This chat is long, so the model sees a short summary of its start.".to_string();
        emit(EventBody::Notice { message: m.clone() });
        out.notices.push(m);
    }
    let mut msgs = fitted.msgs;
    match msgs.last_mut() {
        // An earlier message that never got an answer: join them.
        Some(Msg::User { content }) => content.extend(parts),
        _ => msgs.push(Msg::User { content: parts }),
    }

    let env = ToolEnv { root, buffers: &prepared.buffers, net };
    // A web or literature result in this turn: `remember` is refused.
    let mut outside_text = false;
    let mut session = LlmSession::new(ep);
    for round in 0..=cfg.max_rounds {
        cancel.check()?;
        let last = round == cfg.max_rounds;
        let req = LlmRequest {
            system: system.clone(),
            messages: msgs.clone(),
            tools: tool_specs.clone(),
            tool_choice: if last { ToolChoice::None } else { ToolChoice::Auto },
            thinking: cfg.thinking,
            effort: cfg.effort.clone(),
            fallback_models: cfg.fallback_models.clone(),
            policy: cfg.policy.clone(),
            ..Default::default()
        };
        let before = text.clone();
        let mut round_text = String::new();
        let reply = {
            let mut sink = |ev: StreamEvent| match ev {
                StreamEvent::Text(t) => {
                    if round_text.is_empty() && !before.trim().is_empty() {
                        emit(EventBody::Delta { text: "\n\n".into() });
                    }
                    round_text.push_str(&t);
                    emit(EventBody::Delta { text: t });
                }
                StreamEvent::Reset => {
                    round_text.clear();
                    emit(EventBody::Replace { text: before.clone() });
                }
                StreamEvent::Notice(n) => emit(EventBody::Notice { message: n.message() }),
            };
            session.complete(client, &req, cancel, Some(&mut sink)).await
        };
        let reply = match reply {
            Ok(r) => r,
            Err(e) => {
                *text = join_text(&before, &round_text);
                return Err(e);
            }
        };
        add_usage(&mut out.usage, reply.usage);
        out.model = Some(reply.model.clone());
        for n in &reply.notices {
            let m = n.message();
            if !out.notices.contains(&m) {
                out.notices.push(m);
            }
        }
        *text = join_text(&before, &reply.text);
        if reply.stop == StopReason::MaxTokens {
            let m = "The answer reached the length limit and was cut off. Ask the model to continue.".to_string();
            emit(EventBody::Notice { message: m.clone() });
            out.notices.push(m);
        }
        if reply.tool_calls.is_empty() {
            break;
        }
        if last {
            let m = format!("Stopped looking things up after {} steps.", cfg.max_rounds);
            emit(EventBody::Notice { message: m.clone() });
            out.notices.push(m);
            break;
        }
        msgs.push(reply.to_msg());
        for call in &reply.tool_calls {
            cancel.check()?;
            let started = tool_started_summary(&call.name, &call.arguments);
            emit(EventBody::ToolStarted { name: call.name.clone(), summary: started });
            let (r, saved) = tools::run_guarded(&env, call, &mut outside_text).await;
            let used = ToolUse { name: call.name.clone(), summary: r.summary.clone(), ok: r.ok, ms: r.ms };
            emit(EventBody::ToolFinished { tool: used.clone() });
            out.tools.push(used);
            if let Some(m) = saved {
                emit(EventBody::Notice { message: m.clone() });
                out.notices.push(m);
            }
            if let Some(task) = r.proposed {
                emit(EventBody::ProposedTask { task: task.clone() });
                out.proposed_task = Some(task);
            }
            msgs.push(Msg::tool_result(call, r.content, !r.ok));
        }
        shrink_tool_results(&mut msgs, budget.saturating_sub(RESERVE + system.len()));
    }
    Ok(())
}

/// What the UI shows while a tool runs.
fn tool_started_summary(name: &str, args: &serde_json::Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|v| clip_line(v, 60)).unwrap_or_default();
    match name {
        "read_file" => format!("Reading {}", s("path")),
        "list_files" => "Listing the project's files".into(),
        "search" => format!("Searching for \u{201c}{}\u{201d}", s("pattern")),
        "search_papers" => format!("Looking for papers: \u{201c}{}\u{201d}", s("query")),
        "get_bibtex" => format!("Getting BibTeX for {}", s("id")),
        "fetch_url" => format!("Opening {}", s("url")),
        "web_search" => format!("Searching the web: \u{201c}{}\u{201d}", s("query")),
        "read_memory" => "Reading the project's notes".into(),
        "remember" => "Saving a note".into(),
        "propose_task" => "Preparing a task".into(),
        other => format!("Using {}", clip_line(other, 40)),
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
