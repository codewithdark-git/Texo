//! Tauri commands of the chat: `ai_chat_list`, `ai_chat_get`, `ai_chat_new`,
//! `ai_chat_rename`, `ai_chat_delete`, `ai_chat_send`, `ai_chat_cancel`.
//! Event: `ai-chat-message` ([`ChatEvent`]). Errors reject with the AI
//! error shape `{kind, message, retryAfterSecs?}`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter, Manager as _, State};

use super::engine::{self, ChatEvent, ChatSendRequest, EventBody, TurnConfig, VisionHelper};
use super::store::{self, Chat, ChatMessage, ChatSummary};
use super::CHAT_EVENT;
use crate::agents::tools::net::NetCtx;
use crate::agents::tools::web_settings;
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::Cancel;
use crate::ai::llm::{ProviderId, NVIDIA_CHAT, NVIDIA_VISION};
use crate::ai::AiState;
use crate::AppState;

type Shared<'a> = State<'a, Mutex<AppState>>;

/// Answers being written: request id → (chat key, cancel).
static RUNNING: LazyLock<Mutex<HashMap<String, (String, Cancel)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn running() -> std::sync::MutexGuard<'static, HashMap<String, (String, Cancel)>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Removes a request from the running list however the send ends.
struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        running().remove(&self.0);
    }
}

fn chat_key(dir: &std::path::Path, id: &str) -> String {
    format!("{}|{id}", crate::project::to_slash(dir).to_lowercase())
}

/// Registers a send; one answer at a time per chat.
fn begin(key: &str, request_id: &str, cancel: &Cancel) -> AiResult<RunGuard> {
    let mut r = running();
    if r.values().any(|(k, _)| k == key) {
        return Err(AiError::invalid("This chat is still answering. Wait for it, or press stop first."));
    }
    if r.contains_key(request_id) {
        return Err(AiError::invalid("That request is already running."));
    }
    r.insert(request_id.to_string(), (key.to_string(), cancel.clone()));
    Ok(RunGuard(request_id.to_string()))
}

/// Stops every answer of one chat (before deleting it).
fn cancel_chat(key: &str) {
    for (k, c) in running().values() {
        if k == key {
            c.cancel();
        }
    }
}

fn project_dir(state: &Shared<'_>, path: &str) -> AiResult<PathBuf> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(crate::commands::known_project(&s, path)?.0)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AiResult<T> + Send + 'static) -> AiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| AiError::new(Kind::Other, "Something went wrong inside Texo. Try again."))?
}

/// The model, fallbacks and thinking switch for a chat turn: an explicit
/// choice wins; with NVIDIA the spec's fast chat model (the model picked in
/// Settings joins its fallbacks); otherwise the provider's picked model.
pub(crate) fn chat_model(
    provider: ProviderId,
    explicit: Option<&str>,
    picked: Option<&str>,
) -> (Option<String>, Vec<String>, bool) {
    let claude = provider == ProviderId::Anthropic;
    if let Some(m) = explicit.map(str::trim).filter(|m| !m.is_empty()) {
        return (Some(m.to_string()), Vec::new(), claude);
    }
    if provider == ProviderId::Nvidia {
        let mut fallbacks: Vec<String> = NVIDIA_CHAT.fallbacks.iter().map(|s| s.to_string()).collect();
        if let Some(p) = picked.filter(|p| *p != NVIDIA_CHAT.model && !fallbacks.iter().any(|f| f == p)) {
            fallbacks.push(p.to_string());
        }
        return (Some(NVIDIA_CHAT.model.to_string()), fallbacks, NVIDIA_CHAT.thinking);
    }
    (None, Vec::new(), claude)
}

fn vision_helper(provider: ProviderId) -> Option<VisionHelper> {
    (provider == ProviderId::Nvidia).then(|| VisionHelper {
        model: NVIDIA_VISION.model.to_string(),
        fallbacks: NVIDIA_VISION.fallbacks.iter().map(|s| s.to_string()).collect(),
    })
}

#[tauri::command]
pub async fn ai_chat_list(state: Shared<'_>, project: String) -> AiResult<Vec<ChatSummary>> {
    let dir = project_dir(&state, &project)?;
    blocking(move || store::list(&dir)).await
}

#[tauri::command]
pub async fn ai_chat_get(state: Shared<'_>, project: String, chat_id: String) -> AiResult<Chat> {
    let dir = project_dir(&state, &project)?;
    blocking(move || store::get(&dir, &chat_id)).await
}

#[tauri::command]
pub async fn ai_chat_new(state: Shared<'_>, project: String, model: Option<String>) -> AiResult<Chat> {
    let dir = project_dir(&state, &project)?;
    blocking(move || store::create(&dir, model)).await
}

#[tauri::command]
pub async fn ai_chat_rename(state: Shared<'_>, project: String, chat_id: String, title: String) -> AiResult<ChatSummary> {
    let dir = project_dir(&state, &project)?;
    blocking(move || store::rename(&dir, &chat_id, &title)).await
}

/// Deletes a chat (the UI asks first). A running answer is stopped.
#[tauri::command]
pub async fn ai_chat_delete(state: Shared<'_>, project: String, chat_id: String) -> AiResult<()> {
    let dir = project_dir(&state, &project)?;
    cancel_chat(&chat_key(&dir, &chat_id));
    blocking(move || store::delete(&dir, &chat_id)).await
}

/// Stops an answer. Returns false when it already ended.
#[tauri::command]
pub async fn ai_chat_cancel(request_id: String) -> AiResult<bool> {
    Ok(match running().get(&request_id) {
        Some((_, c)) => {
            c.cancel();
            true
        }
        None => false,
    })
}

/// Sends a message and waits for the answer, streaming it as
/// `ai-chat-message` events. Rejects (before anything is saved) when the
/// message can't be sent: AI off, no key, notice not accepted, a bad
/// attachment, or an answer still running in this chat. Once the message is
/// saved it resolves with the assistant message, whose `error` / `stopped`
/// say how it ended.
#[tauri::command]
pub async fn ai_chat_send(
    app: AppHandle,
    state: Shared<'_>,
    ai: State<'_, AiState>,
    project: String,
    request: ChatSendRequest,
) -> AiResult<ChatMessage> {
    let dir = project_dir(&state, &project)?;
    let chat = {
        let (dir, id) = (dir.clone(), request.chat_id.clone());
        blocking(move || store::get(&dir, &id)).await?
    };
    let request_id =
        if request.request_id.trim().is_empty() { store::new_id() } else { request.request_id.trim().to_string() };
    let cancel = Cancel::default();
    let _guard = begin(&chat_key(&dir, &chat.id), &request_id, &cancel)?;

    let settings = ai.settings();
    let provider = settings.provider;
    let explicit = request.model.clone().filter(|m| !m.trim().is_empty()).or(chat.model.clone());
    let (model, fallbacks, thinking) =
        chat_model(provider, explicit.as_deref(), settings.models.get(&provider).map(String::as_str));
    let (client, ep) = ai.llm_endpoint(model, &cancel).await?;

    let prepared = {
        let (dir, req) = (dir.clone(), request.clone());
        blocking(move || engine::prepare(&dir, &req)).await?
    };

    // Save the user's message first, so it survives whatever happens next.
    let remember_model = request.model.clone().map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let saved = {
        let (dir, id, user) = (dir.clone(), chat.id.clone(), prepared.user.clone());
        blocking(move || {
            store::update(&dir, &id, move |c| {
                c.auto_title_from(&user.text);
                if remember_model.is_some() {
                    c.model = remember_model;
                }
                c.messages.push(user);
            })
        })
        .await?
    };
    let earlier: Vec<ChatMessage> = saved.messages[..saved.messages.len().saturating_sub(1)].to_vec();

    let net = match web_settings::net_ctx(&app, cancel.clone()).await {
        Ok(n) => n,
        Err(_) => {
            let mut n = NetCtx::new(cancel.clone());
            crate::library::pipeline::attach(&mut n, app.try_state::<crate::library::LibraryState>().and_then(|s| s.0.clone()));
            n
        }
    };
    let (chat_id, rid) = (chat.id.clone(), request_id.clone());
    let emitter = app.clone();
    let emit = move |body: EventBody| {
        let _ = emitter.emit(CHAT_EVENT, ChatEvent { chat_id: chat_id.clone(), request_id: rid.clone(), body });
    };
    emit(EventBody::UserMessage { message: prepared.user.clone() });

    let cfg = TurnConfig {
        thinking,
        effort: (provider == ProviderId::Anthropic).then(|| "medium".to_string()),
        fallback_models: fallbacks,
        vision: vision_helper(provider),
        ..Default::default()
    };
    let mut answer = engine::run_turn(&client, ep, &cfg, &dir, &earlier, &prepared, &net, &cancel, &emit).await;

    let result = {
        let (dir, id, msg) = (dir.clone(), chat.id.clone(), answer.clone());
        blocking(move || store::update(&dir, &id, move |c| c.messages.push(msg))).await
    };
    match result {
        Ok(_) => {}
        // Deleted while answering: nothing to save into.
        Err(e) if e.kind == Kind::NotFound => {}
        Err(e) => answer.notices.push(format!("The answer couldn't be saved: {}", e.message)),
    }
    emit(EventBody::Done { message: answer.clone() });
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_choice() {
        let (m, f, t) = chat_model(ProviderId::Nvidia, None, Some("moonshotai/kimi-k3.1-pro"));
        assert_eq!(m.as_deref(), Some(NVIDIA_CHAT.model));
        assert_eq!(f, vec!["nvidia/nemotron-3.5-bolt-e4b".to_string(), "moonshotai/kimi-k3.1-pro".to_string()]);
        assert!(!t);
        let (_, f, _) = chat_model(ProviderId::Nvidia, None, Some(NVIDIA_CHAT.model));
        assert_eq!(f.len(), 1, "the chat model isn't its own fallback");
        let (m, f, _) = chat_model(ProviderId::Nvidia, Some(" my/model "), None);
        assert_eq!(m.as_deref(), Some("my/model"));
        assert!(f.is_empty());
        let (m, _, t) = chat_model(ProviderId::Anthropic, None, None);
        assert_eq!(m, None, "the provider's picked or default model");
        assert!(t);
        assert!(vision_helper(ProviderId::Nvidia).is_some());
        assert!(vision_helper(ProviderId::Groq).is_none());
    }

    #[test]
    fn one_answer_per_chat() {
        let c = Cancel::default();
        let g = begin("p|a", "r1", &c).unwrap();
        assert!(begin("p|a", "r2", &c).is_err());
        let g2 = begin("p|b", "r3", &c).unwrap();
        cancel_chat("p|a");
        assert!(c.is_cancelled());
        drop(g);
        drop(g2);
        assert!(begin("p|a", "r4", &Cancel::default()).is_ok());
        assert!(!running().contains_key("r1"));
    }
}
