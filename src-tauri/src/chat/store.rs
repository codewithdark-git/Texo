//! Chat conversations on disk: `.texo/ai/chats/<id>.json`, one file per
//! chat, always replaced through a temporary file and a rename so a crash
//! never leaves half a chat.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::llm::Usage;
use crate::project;

pub const DEFAULT_TITLE: &str = "New chat";
const FORMAT_VERSION: u32 = 1;
const MAX_TITLE_CHARS: usize = 80;
const AUTO_TITLE_CHARS: usize = 48;
const PREVIEW_CHARS: usize = 120;

/// Load-modify-save of chat files happens under this lock, so a rename
/// while an answer streams can't be lost when the answer is saved.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    #[serde(default = "format_version")]
    pub version: u32,
    pub id: String,
    pub title: String,
    /// The title still follows the first message (the user never renamed it).
    #[serde(default)]
    pub auto_title: bool,
    /// Unix milliseconds.
    pub created: i64,
    pub updated: i64,
    /// The model picked for this chat; `None` uses the default chat model.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

fn format_version() -> u32 {
    FORMAT_VERSION
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub text: String,
    pub created: i64,
    /// User messages: what was attached.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<StoredAttachment>,
    /// User messages: the files and selection sent along, for the UI.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<ContextItem>,
    /// User messages: the context text the model saw with this message
    /// (files, selection, text attachments), so later turns see it too.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub context_text: String,
    /// Assistant messages: the tools used for this answer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolUse>,
    /// Assistant messages: a task the model suggests running ("Run as task").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_task: Option<ProposedTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Plain-words notes (model switched, answer cut off, …).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<String>,
    /// The answer failed; `text` holds whatever arrived before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ChatError>,
    /// The user pressed stop.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
}

impl ChatMessage {
    pub fn new(role: ChatRole, text: impl Into<String>) -> Self {
        ChatMessage {
            id: new_id(),
            role,
            text: text.into(),
            created: now_ms(),
            attachments: Vec::new(),
            context: Vec::new(),
            context_text: String::new(),
            tools: Vec::new(),
            proposed_task: None,
            model: None,
            usage: None,
            notices: Vec::new(),
            error: None,
            stopped: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    Text,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub name: String,
    pub mime: String,
    pub kind: AttachmentKind,
    /// Characters for text, bytes of the data URL for images.
    pub size: u64,
    /// Images: kept so the chat can show them again (the webview already
    /// shrank them to well under 200 KB).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    /// Text was shortened to fit.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextKind {
    /// The file open in the editor.
    CurrentFile,
    /// The selection in the editor.
    Selection,
    /// An `@file` mention.
    Mention,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub kind: ContextKind,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub name: String,
    /// Plain words: "Read main.tex (lines 1-40)".
    pub summary: String,
    pub ok: bool,
    pub ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedTask {
    pub prompt: String,
    /// Project files the task is about.
    #[serde(default)]
    pub files: Vec<String>,
}

/// An error as stored with a message: `kind` is the `AiError` kind name
/// ("rateLimited", "offline", …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatError {
    pub kind: String,
    pub message: String,
}

impl From<&AiError> for ChatError {
    fn from(e: &AiError) -> Self {
        let kind = serde_json::to_value(e.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "other".into());
        ChatError { kind, message: e.message.clone() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created: i64,
    pub updated: i64,
    pub model: Option<String>,
    pub message_count: usize,
    /// The start of the last message.
    pub preview: String,
}

impl Chat {
    pub fn summary(&self) -> ChatSummary {
        let preview = self.messages.last().map(|m| clip_line(&m.text, PREVIEW_CHARS)).unwrap_or_default();
        ChatSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            created: self.created,
            updated: self.updated,
            model: self.model.clone(),
            message_count: self.messages.len(),
            preview,
        }
    }

    /// Titles the chat after its first message, unless the user named it.
    pub fn auto_title_from(&mut self, text: &str) {
        if self.auto_title && self.messages.iter().all(|m| m.role != ChatRole::User) {
            let t = clip_line(text, AUTO_TITLE_CHARS);
            if !t.is_empty() {
                self.title = t;
            }
        }
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Chat ids become file names, so only plain ids are accepted.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check_id(id: &str) -> AiResult<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AiError::invalid("That chat doesn't exist."))
    }
}

/// One line, at most `max` characters, with "…" when shortened.
pub fn clip_line(text: &str, max: usize) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        one
    } else {
        let mut s: String = one.chars().take(max.saturating_sub(1)).collect();
        s = s.trim_end().to_string();
        s.push('…');
        s
    }
}

fn chats_dir_path(project: &Path) -> PathBuf {
    project.join(project::META_DIR).join("ai").join("chats")
}

/// The chats folder, created if needed (links are refused, as for the rest
/// of `.texo/`).
fn chats_dir(project_dir: &Path) -> AiResult<PathBuf> {
    let ai = project::meta_subdir(project_dir, Some("ai"))?;
    let dir = ai.join("chats");
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AiError::new(
            Kind::Other,
            "The project's chat folder is a link to another location, so Texo won't write to it.",
        ));
    }
    fs::create_dir_all(&dir).map_err(|e| io_err(e, true))?;
    Ok(dir)
}

fn io_err(e: std::io::Error, writing: bool) -> AiError {
    AiError::from(project::explain_io(e, writing))
}

fn chat_path(project_dir: &Path, id: &str) -> PathBuf {
    chats_dir_path(project_dir).join(format!("{id}.json"))
}

fn not_found() -> AiError {
    AiError::new(Kind::NotFound, "That chat doesn't exist any more. It may have been deleted.")
}

fn read_chat(project_dir: &Path, id: &str) -> AiResult<Chat> {
    check_id(id)?;
    let path = chat_path(project_dir, id);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
        Err(e) => return Err(io_err(e, false)),
    };
    let mut chat: Chat = serde_json::from_slice(&bytes)
        .map_err(|_| AiError::new(Kind::Other, "This chat couldn't be read: its file is damaged."))?;
    // The file name is the id.
    chat.id = id.to_string();
    Ok(chat)
}

fn write_chat(project_dir: &Path, chat: &Chat) -> AiResult<()> {
    check_id(&chat.id)?;
    let dir = chats_dir(project_dir)?;
    let path = dir.join(format!("{}.json", chat.id));
    let tmp = dir.join(format!(".{}.json.tmp", chat.id));
    let bytes = serde_json::to_vec_pretty(chat).map_err(|_| AiError::new(Kind::Other, "Texo couldn't save the chat."))?;
    fs::write(&tmp, bytes).map_err(|e| io_err(e, true))?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(e, true));
    }
    Ok(())
}

/// Every chat of the project, most recently used first. Damaged files are
/// skipped (and logged) so one bad file never hides the others.
pub fn list(project_dir: &Path) -> AiResult<Vec<ChatSummary>> {
    let dir = chats_dir_path(project_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err(e, false)),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if !valid_id(id) {
            continue;
        }
        match read_chat(project_dir, id) {
            Ok(chat) => out.push(chat.summary()),
            Err(e) => eprintln!("[chat] skipped {name}: {}", e.message),
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| b.created.cmp(&a.created)));
    Ok(out)
}

pub fn get(project_dir: &Path, id: &str) -> AiResult<Chat> {
    read_chat(project_dir, id)
}

pub fn create(project_dir: &Path, model: Option<String>) -> AiResult<Chat> {
    let now = now_ms();
    let chat = Chat {
        version: FORMAT_VERSION,
        id: new_id(),
        title: DEFAULT_TITLE.into(),
        auto_title: true,
        created: now,
        updated: now,
        model: model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
        messages: Vec::new(),
    };
    let _g = lock();
    write_chat(project_dir, &chat)?;
    Ok(chat)
}

pub fn rename(project_dir: &Path, id: &str, title: &str) -> AiResult<ChatSummary> {
    let title = clip_line(title, MAX_TITLE_CHARS);
    if title.is_empty() {
        return Err(AiError::invalid("Type a name for the chat."));
    }
    update(project_dir, id, |chat| {
        chat.title = title.clone();
        chat.auto_title = false;
    })
    .map(|c| c.summary())
}

pub fn delete(project_dir: &Path, id: &str) -> AiResult<()> {
    check_id(id)?;
    let _g = lock();
    match fs::remove_file(chat_path(project_dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e, true)),
    }
}

/// Loads, changes and saves one chat under the store lock. `updated` is
/// set to now.
pub fn update(project_dir: &Path, id: &str, f: impl FnOnce(&mut Chat)) -> AiResult<Chat> {
    let _g = lock();
    let mut chat = read_chat(project_dir, id)?;
    f(&mut chat);
    chat.updated = now_ms().max(chat.updated);
    write_chat(project_dir, &chat)?;
    Ok(chat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_list_get_rename_delete() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(dir.path()).unwrap().is_empty(), "no folder yet means no chats");
        let a = create(dir.path(), Some("  m1 ".into())).unwrap();
        assert_eq!(a.title, DEFAULT_TITLE);
        assert_eq!(a.model.as_deref(), Some("m1"));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = create(dir.path(), None).unwrap();
        let ids: Vec<String> = list(dir.path()).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![b.id.clone(), a.id.clone()], "newest first");

        std::thread::sleep(std::time::Duration::from_millis(5));
        let s = rename(dir.path(), &a.id, "  My\nchat  ").unwrap();
        assert_eq!(s.title, "My chat");
        let got = get(dir.path(), &a.id).unwrap();
        assert!(!got.auto_title);
        assert_eq!(list(dir.path()).unwrap()[0].id, a.id, "renaming counts as use");
        assert!(rename(dir.path(), &a.id, "   ").is_err());

        delete(dir.path(), &a.id).unwrap();
        delete(dir.path(), &a.id).unwrap(); // already gone is fine
        assert_eq!(get(dir.path(), &a.id).unwrap_err().kind, Kind::NotFound);
        assert_eq!(list(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let c = create(dir.path(), None).unwrap();
        update(dir.path(), &c.id, |c| c.messages.push(ChatMessage::new(ChatRole::User, "hi"))).unwrap();
        let names: Vec<String> = fs::read_dir(chats_dir_path(dir.path()))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![format!("{}.json", c.id)]);
        let back = get(dir.path(), &c.id).unwrap();
        assert_eq!(back.messages.len(), 1);
        assert_eq!(back.messages[0].text, "hi");
    }

    #[test]
    fn bad_ids_and_damaged_files() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "../x", "a/b", "a\\b", "a.b", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
            assert!(get(dir.path(), bad).is_err());
            assert!(delete(dir.path(), bad).is_err());
        }
        let good = create(dir.path(), None).unwrap();
        fs::write(chats_dir_path(dir.path()).join("broken.json"), "{not json").unwrap();
        let all = list(dir.path()).unwrap();
        assert_eq!(all.len(), 1, "the damaged file is skipped");
        assert_eq!(all[0].id, good.id);
        assert!(get(dir.path(), "broken").unwrap_err().message.contains("damaged"));
    }

    #[test]
    fn auto_title_follows_first_message_until_renamed() {
        let mut c = Chat {
            version: 1,
            id: "x".into(),
            title: DEFAULT_TITLE.into(),
            auto_title: true,
            created: 0,
            updated: 0,
            model: None,
            messages: vec![],
        };
        c.auto_title_from("How do I fix the overfull hbox warnings in chapter two of my thesis please?");
        assert!(c.title.starts_with("How do I fix"));
        assert!(c.title.ends_with('…'));
        assert!(c.title.chars().count() <= AUTO_TITLE_CHARS);
        c.messages.push(ChatMessage::new(ChatRole::User, "first"));
        c.auto_title_from("second question");
        assert!(c.title.starts_with("How do I fix"), "only the first message names the chat");
    }

    #[test]
    fn messages_round_trip_with_camel_case_fields() {
        let mut m = ChatMessage::new(ChatRole::Assistant, "Answer");
        m.proposed_task = Some(ProposedTask { prompt: "Fix it".into(), files: vec!["main.tex".into()] });
        m.error = Some(ChatError::from(&AiError::new(Kind::RateLimited, "Slow down.")));
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["proposedTask"]["prompt"], "Fix it");
        assert_eq!(v["error"]["kind"], "rateLimited");
        assert!(v.get("stopped").is_none(), "false flags are left out");
        let back: ChatMessage = serde_json::from_value(v).unwrap();
        assert_eq!(back, m);
    }
}
