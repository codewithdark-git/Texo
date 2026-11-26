//! Snapshots: the project's files (by Texo's exclude list) become one commit,
//! with who made it, why, trailers and an optional git note.

use std::path::Path;

use git2::{Oid, Repository, Signature};
use serde::{Deserialize, Serialize};

use super::repo::{self, Ctx, Entries, BLOB_MODE, NOTES_REF};
use super::walk::{self, Excludes, StatCache};
use crate::error::AppResult;

pub const YOU_NAME: &str = "You";
pub const YOU_EMAIL: &str = "you@texo.invalid";
pub const AI_EMAIL: &str = "agent@texo.invalid";
pub const COMMITTER: &str = "Texo";
pub const COMMITTER_EMAIL: &str = "texo@texo.invalid";

/// Why a commit was made (`Texo-Reason` trailer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// 30 s after the last save.
    Idle,
    BeforeCompile,
    BeforeRun,
    Close,
    /// `history_snapshot` from the UI.
    Manual,
    /// An accepted AI changeset.
    AgentApply,
    Restore,
    Undo,
    /// First snapshot after history was turned on or recreated.
    Start,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Idle => "idle",
            Reason::BeforeCompile => "before-compile",
            Reason::BeforeRun => "before-run",
            Reason::Close => "close",
            Reason::Manual => "manual",
            Reason::AgentApply => "agent-apply",
            Reason::Restore => "restore",
            Reason::Undo => "undo",
            Reason::Start => "start",
        }
    }

    #[allow(dead_code)]
    pub fn parse(s: &str) -> Option<Reason> {
        serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
    }

    /// The commit's first line when nothing more specific is given.
    pub fn summary(self) -> &'static str {
        match self {
            Reason::Idle => "Your edits",
            Reason::BeforeCompile => "Your edits (before compiling)",
            Reason::BeforeRun => "Your edits (before an AI run)",
            Reason::Close => "Your edits (project closed)",
            Reason::Manual => "Saved a version",
            Reason::AgentApply => "AI changes",
            Reason::Restore => "Restored an earlier version",
            Reason::Undo => "Undid an AI run",
            Reason::Start => "History started",
        }
    }
}

/// The AI side of an AI commit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuthor {
    /// Profile name, e.g. "Fix compile errors".
    pub profile_name: String,
    pub model: String,
    /// fixer / reviewer / rebuttal / task / chat.
    pub kind: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // `Ai` is built by `apply` for the agents runtime.
pub enum Who {
    You,
    Ai(AiAuthor),
}

impl Who {
    fn signature(&self) -> AppResult<Signature<'static>> {
        let (name, email) = match self {
            Who::You => (YOU_NAME.to_string(), YOU_EMAIL),
            Who::Ai(a) => (ai_name(a), AI_EMAIL),
        };
        Signature::now(&name, email).map_err(repo::g)
    }
}

pub fn ai_name(a: &AiAuthor) -> String {
    let clean = |s: &str| s.replace(['<', '>', '\n', '\r'], " ").trim().to_string();
    let profile = if a.profile_name.trim().is_empty() { "Agent".to_string() } else { clean(&a.profile_name) };
    if a.model.trim().is_empty() {
        format!("Texo AI · {profile}")
    } else {
        format!("Texo AI · {profile} ({})", clean(&a.model))
    }
}

/// Everything that goes into one commit besides the tree.
#[derive(Debug, Clone)]
pub struct Meta {
    pub who: Who,
    pub reason: Reason,
    /// First line; [`Reason::summary`] when empty.
    pub summary: String,
    pub run_id: Option<String>,
    pub step: Option<u32>,
    /// `Texo-Undo: <run>` on the commit that undid a run.
    pub undo_of: Option<String>,
    /// JSON for `refs/notes/texo`.
    pub note: Option<serde_json::Value>,
}

impl Meta {
    pub fn you(reason: Reason) -> Self {
        Meta { who: Who::You, reason, summary: String::new(), run_id: None, step: None, undo_of: None, note: None }
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()
}

pub fn message(meta: &Meta) -> String {
    let summary = if meta.summary.trim().is_empty() { meta.reason.summary().to_string() } else { one_line(&meta.summary) };
    let mut trailers = vec![format!("Texo-Reason: {}", meta.reason.as_str())];
    if let Some(run) = &meta.run_id {
        trailers.push(format!("Texo-Run: {}", one_line(run)));
    }
    if let Some(step) = meta.step {
        trailers.push(format!("Texo-Step: {step}"));
    }
    if let Who::Ai(a) = &meta.who {
        if !a.profile_name.trim().is_empty() {
            trailers.push(format!("Texo-Agent: {}", one_line(&a.profile_name)));
        }
        if !a.model.trim().is_empty() {
            trailers.push(format!("Texo-Model: {}", one_line(&a.model)));
        }
        if !a.kind.trim().is_empty() {
            trailers.push(format!("Texo-Kind: {}", one_line(&a.kind)));
        }
    }
    if let Some(run) = &meta.undo_of {
        trailers.push(format!("Texo-Undo: {}", one_line(run)));
    }
    format!("{summary}\n\n{}\n", trailers.join("\n"))
}

/// Commits `tree` on top of HEAD and attaches the note. Returns the new id.
pub fn commit(ctx: &Ctx, tree: Oid, meta: &Meta) -> AppResult<Oid> {
    let repo = &ctx.repo;
    let tree = repo.find_tree(tree).map_err(repo::g)?;
    let parent = repo::head_commit(repo)?;
    let author = meta.who.signature()?;
    let committer = Signature::now(COMMITTER, COMMITTER_EMAIL).map_err(repo::g)?;
    let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
    let id = repo
        .commit(Some("HEAD"), &author, &committer, &message(meta), &tree, &parents)
        .map_err(repo::g)?;
    if let Some(note) = &meta.note {
        let text = serde_json::to_string_pretty(note).unwrap_or_default();
        if let Err(e) = repo.note(&committer, &committer, Some(NOTES_REF), id, &text, true) {
            eprintln!("[history] note failed: {e}");
        }
    }
    repo::count_commit(ctx);
    Ok(id)
}

/// What a scan of the disk produced.
pub struct Scanned {
    pub entries: Entries,
    pub too_large: Vec<String>,
    pub bad_names: Vec<String>,
    /// Cloud-only files whose previous version was carried over.
    pub placeholders: Vec<String>,
    /// Files that couldn't be read just now (locked, access denied); their
    /// previous version, if any, was carried over.
    pub unreadable: Vec<String>,
}

impl Scanned {
    /// Files on disk whose current contents are not in the commit this scan
    /// makes (too large, cloud-only, unreadable). Overwriting or deleting
    /// them would lose that version for good.
    pub fn not_recorded(&self) -> Vec<String> {
        self.too_large.iter().chain(&self.placeholders).chain(&self.unreadable).cloned().collect()
    }
}

/// Hashes the project's files into blobs, reusing the stat cache and
/// carrying over the last version of files that can't be read right now.
pub fn scan_disk(ctx: &Ctx, base: &Entries) -> AppResult<Scanned> {
    let ex = Excludes::for_project(&ctx.dir);
    let scan = walk::scan(&ctx.dir, &ex)?;
    let mut cache = StatCache::load(&ctx.git_dir);
    let mut entries = Entries::new();
    let mut placeholders = Vec::new();
    let mut unreadable = Vec::new();
    let odb = ctx.repo.odb().map_err(repo::g)?;
    for f in &scan.files {
        if f.placeholder {
            // Reading would download the file from the cloud.
            if let Some(prev) = base.get(&f.rel) {
                entries.insert(f.rel.clone(), *prev);
            }
            placeholders.push(f.rel.clone());
            continue;
        }
        if let Some(oid) = cache.hit(f).and_then(|s| Oid::from_str(s).ok()) {
            if odb.exists(oid) {
                entries.insert(f.rel.clone(), (oid, BLOB_MODE));
                continue;
            }
        }
        match walk::read_with_retry(&ctx.dir.join(&f.rel)) {
            Ok(bytes) => {
                let oid = ctx.repo.blob(&bytes).map_err(repo::g)?;
                cache.record(f, oid.to_string());
                entries.insert(f.rel.clone(), (oid, BLOB_MODE));
            }
            Err(e) => {
                eprintln!("[history] can't read {}: {e}", f.rel);
                if let Some(prev) = base.get(&f.rel) {
                    entries.insert(f.rel.clone(), *prev);
                }
                unreadable.push(f.rel.clone());
            }
        }
    }
    cache.files.retain(|k, _| entries.contains_key(k));
    cache.save(&ctx.git_dir);
    if !scan.bad_names.is_empty() {
        eprintln!("[history] skipped {} file(s) with names that aren't valid Unicode", scan.bad_names.len());
    }
    Ok(Scanned { entries, too_large: scan.too_large, bad_names: scan.bad_names, placeholders, unreadable })
}

/// Commits the files on disk when they differ from HEAD (or when there is
/// no commit yet). Returns the new commit, or `None` when nothing changed.
pub fn snapshot(ctx: &Ctx, meta: Meta) -> AppResult<Option<Oid>> {
    snapshot_scanned(ctx, meta).map(|(id, _)| id)
}

/// [`snapshot`], also returning the files whose current contents couldn't
/// be recorded ([`Scanned::not_recorded`]).
pub fn snapshot_scanned(ctx: &Ctx, mut meta: Meta) -> AppResult<(Option<Oid>, Vec<String>)> {
    let head = repo::head_commit(&ctx.repo)?;
    let head_tree = match &head {
        Some(c) => Some(c.tree().map_err(repo::g)?),
        None => None,
    };
    let base = repo::flatten(head_tree.as_ref())?;
    let scanned = scan_disk(ctx, &base)?;
    let tree = repo::write_tree(&ctx.repo, &scanned.entries)?;
    if head_tree.as_ref().is_some_and(|t| t.id() == tree) {
        return Ok((None, scanned.not_recorded()));
    }
    if !scanned.too_large.is_empty() || !scanned.bad_names.is_empty() || !scanned.placeholders.is_empty() {
        let mut note = match meta.note.take() {
            Some(serde_json::Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        if !scanned.too_large.is_empty() {
            note.insert("untrackedLarge".into(), scanned.too_large.clone().into());
        }
        if !scanned.bad_names.is_empty() {
            note.insert("skippedNames".into(), scanned.bad_names.clone().into());
        }
        if !scanned.placeholders.is_empty() {
            // Cloud-only (OneDrive) files: their last known version was kept.
            note.insert("cloudOnly".into(), scanned.placeholders.clone().into());
        }
        meta.note = Some(serde_json::Value::Object(note));
    }
    let id = commit(ctx, tree, &meta)?;
    Ok((Some(id), scanned.not_recorded()))
}

/// The tree of HEAD, flattened.
pub fn head_entries(repo: &Repository) -> AppResult<Entries> {
    match repo::head_commit(repo)? {
        Some(c) => repo::flatten(Some(&c.tree().map_err(repo::g)?)),
        None => Ok(Entries::new()),
    }
}

/// Writes bytes through a temporary file, like the editor's save.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(".{}.texo-tmp", path.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::write(&tmp, bytes)?;
    let mut last = None;
    for attempt in 0..4u64 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            // Another app has the file open (Windows).
            Err(e) if attempt < 3 && matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33)) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(100 * (attempt + 1)));
            }
            Err(e) => {
                last = Some(e);
                break;
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}
