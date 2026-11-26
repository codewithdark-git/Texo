//! Reading the history: the timeline, what changed in a commit, the text of
//! a file on both sides for a diff, and labels.

use std::collections::HashMap;
use std::path::Path;

use git2::{Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

use super::repo::{self, Ctx, Entries};
use super::snapshot::{AI_EMAIL, YOU_NAME};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorFilter {
    You,
    Ai,
    #[default]
    All,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogFilter {
    pub author: AuthorFilter,
    pub run_id: Option<String>,
    /// Only commits that changed this file.
    pub path: Option<String>,
    /// A commit id: list the commits older than it (paging).
    pub before: Option<String>,
    /// Default 200, at most 1000.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// True for the automatic `compiled-ok` labels.
    pub auto: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub short_id: String,
    /// Seconds since 1970 (UTC).
    pub time: i64,
    pub summary: String,
    /// `Texo-Reason`: idle, before-compile, before-run, close, manual,
    /// agent-apply, restore, undo, start.
    pub reason: Option<String>,
    /// "you" or "ai".
    pub author: String,
    pub author_name: String,
    pub run_id: Option<String>,
    pub step: Option<u32>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub kind: Option<String>,
    pub undo_of: Option<String>,
    pub parent_id: Option<String>,
    pub labels: Vec<Label>,
    /// The git note (JSON), when there is one.
    pub note: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub file: String,
    /// added / modified / deleted
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffText {
    pub file: String,
    /// `None` when the file doesn't exist on that side.
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    /// Either side isn't text; the texts are left out.
    pub binary: bool,
}

pub fn trailers(msg: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(t) = git2::message_trailers_strs(msg) {
        for (k, v) in t.iter() {
            out.insert(k.to_ascii_lowercase(), v.trim().to_string());
        }
    }
    out
}

/// Labels by commit id.
pub fn labels(repo: &Repository) -> HashMap<Oid, Vec<Label>> {
    let mut out: HashMap<Oid, Vec<Label>> = HashMap::new();
    let Ok(refs) = repo.references_glob("refs/tags/*") else { return out };
    for r in refs.flatten() {
        let Ok(name) = r.name().map(str::to_string) else { continue };
        let Ok(obj) = r.peel(git2::ObjectType::Commit) else { continue };
        let auto = name.starts_with("refs/tags/compiled-ok/");
        let label = if auto {
            "Compiled OK".to_string()
        } else {
            match r.peel_to_tag() {
                Ok(t) => t.message().ok().flatten().unwrap_or("").trim().to_string(),
                Err(_) => r.shorthand().unwrap_or_default().to_string(),
            }
        };
        out.entry(obj.id()).or_default().push(Label { name: label, auto });
    }
    out
}

fn is_ai(c: &git2::Commit<'_>) -> bool {
    c.author().email().ok() == Some(AI_EMAIL)
}

fn changed_path(repo: &Repository, c: &git2::Commit<'_>, path: &str) -> bool {
    let id_at = |tree: Option<git2::Tree<'_>>| tree.and_then(|t| t.get_path(Path::new(path)).ok()).map(|e| e.id());
    let now = id_at(c.tree().ok());
    let before = id_at(c.parent(0).ok().and_then(|p| p.tree().ok()));
    let _ = repo;
    now != before
}

pub fn log(ctx: &Ctx, filter: &LogFilter) -> AppResult<Vec<LogEntry>> {
    let repo = &ctx.repo;
    let limit = filter.limit.unwrap_or(200).clamp(1, 1000);
    let Some(head) = repo::head_commit(repo)? else { return Ok(Vec::new()) };
    let mut walk = repo.revwalk().map_err(repo::g)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(repo::g)?;
    let mut skip_first = false;
    match filter.before.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(b) => {
            walk.push(repo::parse_oid(repo, b)?).map_err(repo::g)?;
            skip_first = true;
        }
        None => walk.push(head.id()).map_err(repo::g)?,
    }
    let path = filter.path.as_deref().map(|p| p.trim().replace('\\', "/")).filter(|p| !p.is_empty());
    let all_labels = labels(repo);
    let mut out = Vec::new();
    for id in walk {
        let id = id.map_err(repo::g)?;
        if skip_first {
            skip_first = false;
            continue;
        }
        let c = repo.find_commit(id).map_err(repo::g)?;
        let ai = is_ai(&c);
        match filter.author {
            AuthorFilter::You if ai => continue,
            AuthorFilter::Ai if !ai => continue,
            _ => {}
        }
        let msg = c.message().unwrap_or_default();
        let t = trailers(msg);
        if let Some(run) = &filter.run_id {
            if t.get("texo-run") != Some(run) {
                continue;
            }
        }
        if let Some(p) = &path {
            if !changed_path(repo, &c, p) {
                continue;
            }
        }
        out.push(entry(repo, &c, &t, ai, all_labels.get(&id).cloned().unwrap_or_default()));
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn entry(repo: &Repository, c: &git2::Commit<'_>, t: &HashMap<String, String>, ai: bool, labels: Vec<Label>) -> LogEntry {
    let id = c.id().to_string();
    let note = repo
        .find_note(Some(repo::NOTES_REF), c.id())
        .ok()
        .and_then(|n| n.message().ok().and_then(|m| serde_json::from_str(m).ok()));
    LogEntry {
        short_id: id[..8].to_string(),
        id,
        time: c.time().seconds(),
        summary: c.summary().ok().flatten().unwrap_or("").to_string(),
        reason: t.get("texo-reason").cloned(),
        author: if ai { "ai" } else { "you" }.to_string(),
        author_name: c.author().name().unwrap_or(YOU_NAME).to_string(),
        run_id: t.get("texo-run").cloned(),
        step: t.get("texo-step").and_then(|s| s.parse().ok()),
        agent: t.get("texo-agent").cloned(),
        model: t.get("texo-model").cloned(),
        kind: t.get("texo-kind").cloned(),
        undo_of: t.get("texo-undo").cloned(),
        parent_id: c.parent_id(0).ok().map(|p| p.to_string()),
        labels,
        note,
    }
}

fn is_binary(b: &[u8]) -> bool {
    b.iter().take(8000).any(|&c| c == 0) || std::str::from_utf8(b).is_err()
}

/// Files changed by `commit` (against its first parent), with line counts.
pub fn changes(ctx: &Ctx, commit: &str) -> AppResult<Vec<FileChange>> {
    let repo = &ctx.repo;
    let c = repo.find_commit(repo::parse_oid(repo, commit)?).map_err(repo::g)?;
    let new = repo::flatten(Some(&c.tree().map_err(repo::g)?))?;
    let old = match c.parent(0) {
        Ok(p) => repo::flatten(Some(&p.tree().map_err(repo::g)?))?,
        Err(_) => Entries::new(),
    };
    let blob = |id: Option<Oid>| -> AppResult<Vec<u8>> {
        match id {
            Some(id) => Ok(repo.find_blob(id).map_err(repo::g)?.content().to_vec()),
            None => Ok(Vec::new()),
        }
    };
    let mut paths: Vec<&String> = new.keys().chain(old.keys()).collect();
    paths.sort();
    paths.dedup();
    let mut out = Vec::new();
    for p in paths {
        let (a, b) = (old.get(p).map(|e| e.0), new.get(p).map(|e| e.0));
        if a == b {
            continue;
        }
        let status = match (a, b) {
            (None, _) => "added",
            (_, None) => "deleted",
            _ => "modified",
        };
        let (ab, bb) = (blob(a)?, blob(b)?);
        let binary = is_binary(&ab) || is_binary(&bb);
        let (additions, deletions) = if binary {
            (0, 0)
        } else {
            let patch = git2::Patch::from_buffers(&ab, Some(Path::new(p)), &bb, Some(Path::new(p)), None).map_err(repo::g)?;
            let (_, add, del) = patch.line_stats().map_err(repo::g)?;
            (add, del)
        };
        out.push(FileChange { file: p.clone(), status: status.into(), additions, deletions, binary });
    }
    Ok(out)
}

/// The special `to` value for the files on disk now.
pub const DISK: &str = "disk";

/// Old and new text of `file` for a Monaco diff. `from` empty means the
/// parent of `to`; `to` may be [`DISK`].
pub fn diff(ctx: &Ctx, from: Option<&str>, to: &str, file: &str) -> AppResult<DiffText> {
    let repo = &ctx.repo;
    let file = file.trim().replace('\\', "/");
    crate::fsops::resolve(&ctx.dir, &file)?;
    let at = |commit: Oid| -> AppResult<Option<Vec<u8>>> {
        let c = repo.find_commit(commit).map_err(repo::g)?;
        let tree = c.tree().map_err(repo::g)?;
        match tree.get_path(Path::new(&file)) {
            Ok(e) => Ok(Some(repo.find_blob(e.id()).map_err(repo::g)?.content().to_vec())),
            Err(_) => Ok(None),
        }
    };
    let (new, to_id) = if to.eq_ignore_ascii_case(DISK) {
        let bytes = match std::fs::read(ctx.dir.join(&file)) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        (bytes, repo::head_commit(repo)?.map(|c| c.id()))
    } else {
        let id = repo::parse_oid(repo, to)?;
        (at(id)?, Some(id))
    };
    let old = match from.map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => at(repo::parse_oid(repo, f)?)?,
        None => match to_id {
            Some(id) if to.eq_ignore_ascii_case(DISK) => at(id)?,
            Some(id) => match repo.find_commit(id).map_err(repo::g)?.parent_id(0) {
                Ok(p) => at(p)?,
                Err(_) => None,
            },
            None => None,
        },
    };
    let binary = old.as_deref().is_some_and(is_binary) || new.as_deref().is_some_and(is_binary);
    let text = |b: Option<Vec<u8>>| if binary { None } else { b.map(|b| String::from_utf8_lossy(&b).into_owned()) };
    Ok(DiffText { file, old_text: text(old), new_text: text(new), binary })
}

// ---------------------------------------------------------------------------
// Labels

pub const COMPILED_OK_EVERY_SECS: i64 = 10 * 60;

/// Adds a user label ("Submitted to NeurIPS") as an annotated tag.
pub fn add_label(ctx: &Ctx, commit: &str, name: &str) -> AppResult<()> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::msg("Give the label a name."));
    }
    if name.chars().count() > 80 {
        return Err(AppError::msg("Keep the label under 80 characters."));
    }
    let repo = &ctx.repo;
    let id = repo::parse_oid(repo, commit)?;
    let obj = repo.find_object(id, None).map_err(repo::g)?;
    let tagger = git2::Signature::now(YOU_NAME, super::snapshot::YOU_EMAIL).map_err(repo::g)?;
    let base = format!("label/{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let mut tag = base.clone();
    let mut n = 1;
    while repo.find_reference(&format!("refs/tags/{tag}")).is_ok() {
        n += 1;
        tag = format!("{base}-{n}");
    }
    repo.tag(&tag, &obj, &tagger, &name, false).map_err(repo::g)?;
    Ok(())
}

/// Tags `commit` as compiled OK, at most once per 10 minutes.
pub fn mark_compiled_ok(ctx: &Ctx, commit: Oid) -> AppResult<bool> {
    let repo = &ctx.repo;
    let now = chrono::Utc::now().timestamp();
    let mut latest = 0i64;
    if let Ok(names) = repo.tag_names(Some("compiled-ok/*")) {
        for n in names.iter().filter_map(|n| n.ok().flatten()) {
            if let Some(ts) = n.strip_prefix("compiled-ok/").and_then(|s| s.split('-').next()).and_then(|s| s.parse::<i64>().ok()) {
                latest = latest.max(ts);
            }
            if repo.refname_to_id(&format!("refs/tags/{n}")).ok() == Some(commit) {
                return Ok(false);
            }
        }
    }
    if now - latest < COMPILED_OK_EVERY_SECS {
        return Ok(false);
    }
    let obj = repo.find_object(commit, None).map_err(repo::g)?;
    repo.tag_lightweight(&format!("compiled-ok/{now}"), &obj, false).map_err(repo::g)?;
    Ok(true)
}
