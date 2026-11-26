//! The data shapes of agent runs, shared by the runtime, the journal on disk
//! and the Tauri commands. All serde camelCase (the TS mirror is
//! `src/lib/agentsApi.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `queued → running → (awaiting_review | done | failed | cancelled)`, plus
/// `awaiting_input` (a kind paused for the user) and `interrupted` (the app
/// closed while the run was active; set when the journal is next loaded).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    #[default]
    Queued,
    Running,
    AwaitingInput,
    AwaitingReview,
    Done,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunStatus {
    /// Still owned by a live task.
    pub fn is_active(self) -> bool {
        matches!(self, RunStatus::Queued | RunStatus::Running | RunStatus::AwaitingInput)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    /// Text the model wrote alongside tool calls (its working notes).
    Think,
    ToolCall,
    /// Text for the user: the final answer, a plan, or a notice from Texo
    /// (model switched, retrying …; then `notice` is true).
    Message,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// 1-based, unique within the run (sub-runs share the numbering).
    pub n: u32,
    pub kind: StepKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// The tool arguments, capped (long strings shortened).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    /// One line: what the tool did, or the start of the message.
    pub result_summary: String,
    /// The tool's result as the model saw it, capped at 2000 chars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Message / think text (capped at 8000 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub ok: bool,
    pub ms: u64,
    /// Seconds since 1970.
    pub at: i64,
    /// The sub-run this step belongs to (e.g. a reviewer persona).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    /// A notice from Texo rather than text from the model.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub notice: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Requests sent to the model.
    pub llm_calls: u32,
    pub tool_calls: u32,
}

/// An attachment sent with the request (images already downscaled by the
/// webview; PDFs already turned into text there).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    /// The file's bytes (images, small text files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    /// A file inside the project, `/`-separated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Text the webview already extracted (PDF text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// "Also save into project": a project path for the file. Goes through
    /// the changeset (text files only for now).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_as: Option<String>,
}

/// What the journal keeps of an attachment (never the data).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub name: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// How it was given to the model: "image", "text", "described" or "skipped".
    pub used_as: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// An unsaved editor buffer: the run reads this instead of the disk file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyBuffer {
    pub file: String,
    pub text: String,
}

/// Per-run knobs. Profiles (another module) fill these in; the UI may too.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    /// Shown on the run card; default: the prompt's first line.
    #[serde(default)]
    pub title: Option<String>,
    /// Overrides the model of the chosen provider.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub fallback_models: Option<Vec<String>>,
    #[serde(default)]
    pub thinking: Option<bool>,
    /// The model can see images (a profile's `vision` flag); `None`: from
    /// the known model list. When it can't, the vision fallback describes
    /// them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    #[serde(default)]
    pub max_steps: Option<u32>,
    /// Whole-run time limit in seconds (default 15 min).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Narrow the kind's tools to these names.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Profile instructions, appended to the kind's system prompt.
    #[serde(default)]
    pub instructions: Option<String>,
    /// For the history commit author ("Texo AI · <profile> (<model>)").
    #[serde(default)]
    pub profile_name: Option<String>,
    /// Apply the changeset when the run finishes (only when nothing in it
    /// needs attention).
    #[serde(default)]
    pub auto_apply: bool,
    /// Anything a kind wants (e.g. a ReviewSetup); passed through as is.
    #[serde(default)]
    pub extra: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    /// fixer / reviewer / rebuttal / task / chat (or a registered kind).
    pub kind: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub dirty_buffers: Vec<DirtyBuffer>,
    #[serde(default)]
    pub options: RunOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
}

/// Where a changed file is in review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    #[default]
    Pending,
    Applied,
    Rejected,
    /// Couldn't be merged with your current version; needs a manual pick.
    Conflict,
}

/// One file the run changed, as kept in the journal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub file: String,
    /// The file when the run first touched it (`None`: it didn't exist).
    pub base_text: Option<String>,
    /// FNV-1a 64 of `base_text` as hex ("" when absent).
    pub base_hash: String,
    /// `None`: the run deleted the file.
    pub new_text: Option<String>,
    /// Why, in the agent's words (the last edit's reason, or the tool used).
    pub reason: String,
    #[serde(default)]
    pub state: FileState,
    /// The merge with conflict markers, when `state` is `Conflict`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_text: Option<String>,
    /// Plain-words warnings for review ("needs your attention"); a
    /// changeset with any is never applied automatically.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attention: Vec<String>,
}

/// One block of changed lines (unified-diff numbering, no context lines).
/// `index` is what `Decision::hunks` refers to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub index: usize,
    /// 1-based first base line (for a pure insertion: the line after which
    /// the new lines go, 0 = at the top).
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
}

/// A file of the changeset as the review dialog gets it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesetFile {
    pub file: String,
    pub base_text: Option<String>,
    pub new_text: Option<String>,
    pub status: FileStatus,
    /// Applying now would conflict with your current version.
    pub conflict: bool,
    /// The file on disk changed since the run read it (merged on apply).
    pub changed_on_disk: bool,
    pub base_hash: String,
    pub reason: String,
    pub state: FileState,
    pub hunks: Vec<Hunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attention: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changeset {
    pub run_id: String,
    pub files: Vec<ChangesetFile>,
}

/// The user's choice for one file in `agent_apply`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub file: String,
    pub accept: bool,
    /// Accept only these hunks (indices from the changeset). `None`: all.
    #[serde(default)]
    pub hunks: Option<Vec<usize>>,
    /// The user's own final text (edited in the diff, or a conflict
    /// resolution). Wins over `hunks`.
    #[serde(default)]
    pub edited_text: Option<String>,
    /// Why the user rejected it (offered as a memory note by the UI).
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// The AI commit in the project history, when one was made.
    pub commit: Option<String>,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    pub rejected: Vec<String>,
    pub conflicts: Vec<crate::history::MergeConflict>,
    /// Files were written but history couldn't record them.
    pub history_error: Option<String>,
    pub run: RunSummary,
}

/// The structured result of a run (reviewer, rebuttal …). `kind` names the
/// schema; the rest is the kind's own fields, flattened (e.g. a review's
/// `venue`, `checklist`, `reviews`, `meta`, `references`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub kind: String,
    #[serde(flatten)]
    pub data: serde_json::Map<String, Value>,
}

/// A run, as stored in `.texo/ai/runs/<id>.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    /// Journal format version.
    #[serde(default)]
    pub version: u32,
    pub id: String,
    pub project: String,
    pub kind: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_name: Option<String>,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInfo>,
    pub status: RunStatus,
    /// The model that answered last (after any fallback switch).
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub changeset: Vec<ChangeEntry>,
    #[serde(default)]
    pub report: Option<Report>,
    /// The agent's final message.
    #[serde(default)]
    pub final_message: Option<String>,
    #[serde(default)]
    pub usage: RunUsage,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    /// Plain-words reason the run failed or stopped early.
    #[serde(default)]
    pub error: Option<String>,
    /// What the run waits for in `awaiting_input` (the kind's payload).
    #[serde(default)]
    pub awaiting: Option<Value>,
    /// The "before run" snapshot in the project history.
    #[serde(default)]
    pub start_commit: Option<String>,
    /// The AI commit(s) made when the changeset was applied.
    #[serde(default)]
    pub apply_commits: Vec<String>,
    #[serde(default)]
    pub options: RunOptions,
}

/// The run without big blobs: for lists and the `agent-run-updated` event.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub project: String,
    pub kind: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub title: String,
    pub status: RunStatus,
    pub model: String,
    pub step_count: usize,
    /// The latest step's one-line summary.
    pub last_step: Option<String>,
    /// Files in the changeset still waiting for a decision.
    pub pending_files: usize,
    pub changed_files: usize,
    pub conflict_files: usize,
    pub needs_attention: bool,
    pub has_report: bool,
    pub usage: RunUsage,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    pub awaiting: Option<Value>,
}

impl AgentRun {
    pub fn summary(&self) -> RunSummary {
        RunSummary {
            id: self.id.clone(),
            project: self.project.clone(),
            kind: self.kind.clone(),
            profile_id: self.profile_id.clone(),
            profile_name: self.profile_name.clone(),
            title: self.title.clone(),
            status: self.status,
            model: self.model.clone(),
            step_count: self.steps.len(),
            last_step: self.steps.last().map(|s| s.result_summary.clone()),
            pending_files: self.changeset.iter().filter(|c| c.state == FileState::Pending).count(),
            changed_files: self.changeset.len(),
            conflict_files: self.changeset.iter().filter(|c| c.state == FileState::Conflict).count(),
            needs_attention: self.changeset.iter().any(|c| !c.attention.is_empty()),
            has_report: self.report.is_some(),
            usage: self.usage,
            started_at: self.started_at,
            finished_at: self.finished_at,
            error: self.error.clone(),
            awaiting: self.awaiting.clone(),
        }
    }
}

/// Payload of `agent-step`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepEvent {
    pub run_id: String,
    pub step: Step,
}

/// Payload of `agent-message`: streamed assistant text. `reset` means
/// "forget the text streamed so far for this run (and sub-run)".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEvent {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    pub text: String,
    pub reset: bool,
}

pub const RUN_UPDATED_EVENT: &str = "agent-run-updated";
pub const STEP_EVENT: &str = "agent-step";
pub const MESSAGE_EVENT: &str = "agent-message";

/// FNV-1a 64-bit, hex. Stable across platforms and versions (for base hashes).
pub fn text_hash(text: Option<&str>) -> String {
    let Some(text) = text else { return String::new() };
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// `text` shortened to `max` chars (on a char boundary) with a note.
pub fn cap(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}\n… [shortened: {} more characters]", text.chars().count() - max)
}

/// The first non-empty line, shortened to `max` chars.
pub fn one_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() <= max {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(max).collect::<String>())
    }
}

/// Tool arguments for the journal: long strings shortened.
pub fn cap_args(v: &Value) -> Value {
    match v {
        Value::String(s) if s.chars().count() > 400 => Value::String(cap(s, 400)),
        Value::Array(a) => Value::Array(a.iter().take(50).map(cap_args).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), cap_args(v))).collect()),
        other => other.clone(),
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
