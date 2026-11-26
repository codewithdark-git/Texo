//! Change history (v1.2): a private git repo per project in
//! `.texo/history` (bare, git2 with vendored libgit2). It never touches the
//! user's own `.git`, never reads `.gitignore` and never uses an index file.
//! See `internal/v1.2-agents-spec.md`, "History".
//!
//! Automatic snapshots (all by "You", all best effort: a failure is logged
//! and never fails the save, compile or run that triggered it):
//! - after saves: `write_file` calls [`auto::note_save`]; the snapshot is
//!   taken in Rust 30 s after the last save (no frontend timer needed);
//! - before every compile: `compile_project` calls [`snapshot_quietly`] on
//!   a side thread and tags the result `compiled-ok` on success;
//! - before an agent run: the agents runtime calls [`start_run`];
//! - when the project closes or another opens: [`auto::flush`].
//!
//! For the agents runtime: [`start_run`], [`apply_changeset`] (three-way
//! merge per file, returns conflicts) and [`merge3`].

// Until the agents runtime (a parallel 1.2 workstream) calls in, only tests
// reach these.
#[allow(dead_code)]
pub mod apply;
pub mod auto;
pub mod commands;
pub mod lock;
pub mod query;
pub mod repo;
pub mod restore;
pub mod snapshot;
pub mod walk;

#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;

// The agents runtime's entry points.
#[allow(unused_imports)]
pub use apply::{apply_changeset, merge3, start_run, ApplyOutcome, ApplyRequest, ChangeFile, MergeConflict, Merged, RunNote};
#[allow(unused_imports)]
pub use snapshot::{AiAuthor, Reason};

use crate::error::{AppError, AppResult};
use repo::Prefs;
use snapshot::Meta;

/// What the History panel and the status bar show.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    /// The user's on/off switch for this project.
    pub enabled: bool,
    /// History is on and working.
    pub active: bool,
    /// The folder can't be written to (history is off; show a banner).
    pub read_only: bool,
    /// Why history isn't working, in plain words.
    pub error: Option<String>,
    /// A one-time message (e.g. a damaged history was replaced).
    pub notice: Option<String>,
    pub size_bytes: u64,
    /// Commits on the timeline.
    pub count: usize,
    /// The project is a git repo whose `.git/info/exclude` doesn't list
    /// `.texo/` yet, and the user wasn't asked: offer it once.
    pub offer_git_exclude: bool,
}

/// Takes a "You" snapshot if history is on. Returns HEAD afterwards (also
/// when nothing changed), or `None` when history is off or failed (logged).
pub fn snapshot_quietly(dir: &Path, reason: Reason) -> Option<String> {
    if !Prefs::load(dir).enabled || !dir.is_dir() {
        return None;
    }
    let res = repo::with_repo(dir, repo::AUTO_WAIT, |ctx| {
        snapshot::snapshot(ctx, Meta::you(reason))?;
        Ok(repo::head_commit(&ctx.repo)?.map(|c| c.id().to_string()))
    });
    match res {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[history] {} snapshot skipped: {e}", reason.as_str());
            None
        }
    }
}

/// Tags `commit` (the before-compile snapshot) `compiled-ok`, throttled.
pub fn mark_compiled_ok_quietly(dir: &Path, commit: Option<&str>) {
    let Some(commit) = commit else { return };
    let res = repo::with_repo(dir, repo::AUTO_WAIT, |ctx| {
        let id = repo::parse_oid(&ctx.repo, commit)?;
        query::mark_compiled_ok(ctx, id)
    });
    if let Err(e) = res {
        eprintln!("[history] compiled-ok label skipped: {e}");
    }
}

/// A user-requested snapshot. `label` (optional) becomes the commit title.
pub fn snapshot_now(dir: &Path, label: &str) -> AppResult<Option<String>> {
    ensure_enabled(dir)?;
    repo::with_repo(dir, repo::WAIT, |ctx| {
        let mut meta = Meta::you(Reason::Manual);
        meta.summary = label.to_string();
        Ok(snapshot::snapshot(ctx, meta)?.map(|i| i.to_string()))
    })
}

pub fn ensure_enabled(dir: &Path) -> AppResult<()> {
    if Prefs::load(dir).enabled {
        Ok(())
    } else {
        Err(AppError::msg("History is turned off for this project. Turn it on in the History panel."))
    }
}

fn git_dir_of_project(dir: &Path) -> Option<std::path::PathBuf> {
    let g = dir.join(".git");
    g.is_dir().then_some(g)
}

fn excludes_texo(git: &Path) -> bool {
    std::fs::read_to_string(git.join("info").join("exclude"))
        .map(|s| {
            s.lines()
                .map(str::trim)
                .any(|l| matches!(l, ".texo" | ".texo/" | "/.texo" | "/.texo/" | ".texo/*" | "/.texo/*"))
        })
        .unwrap_or(false)
}

pub fn status(dir: &Path) -> HistoryStatus {
    let mut prefs = Prefs::load(dir);
    let mut st = HistoryStatus { enabled: prefs.enabled, ..Default::default() };
    st.offer_git_exclude =
        !prefs.git_exclude_answered && git_dir_of_project(dir).is_some_and(|g| !excludes_texo(&g));
    if prefs.enabled {
        let res = repo::with_repo(dir, repo::WAIT, |ctx| {
            // First use: record the starting point right away.
            if repo::head_commit(&ctx.repo)?.is_none() {
                snapshot::snapshot(ctx, Meta::you(Reason::Start))?;
            }
            let mut count = 0;
            if let Some(h) = repo::head_commit(&ctx.repo)? {
                let mut walk = ctx.repo.revwalk().map_err(repo::g)?;
                walk.push(h.id()).map_err(repo::g)?;
                count = walk.count();
            }
            Ok(count)
        });
        match res {
            Ok(count) => {
                st.active = true;
                st.count = count;
            }
            Err(e) => {
                let msg = e.to_string();
                st.read_only = msg == repo::READ_ONLY_MSG;
                st.error = Some(msg);
            }
        }
        st.size_bytes = repo::size_on_disk(&repo::git_dir(dir));
    }
    // Re-read: recovery may have just written a notice.
    prefs = Prefs::load(dir);
    if let Some(n) = prefs.notice.take() {
        st.notice = Some(n);
        let _ = prefs.save(dir);
    }
    st
}

pub fn set_enabled(dir: &Path, enabled: bool) -> AppResult<HistoryStatus> {
    Prefs::update(dir, |p| p.enabled = enabled)?;
    if enabled {
        if let Err(e) = repo::with_repo(dir, repo::WAIT, |ctx| snapshot::snapshot(ctx, Meta::you(Reason::Start))) {
            eprintln!("[history] first snapshot failed: {e}");
        }
    } else {
        auto::cancel(dir);
    }
    Ok(status(dir))
}

/// Answers the one-time offer; `add` appends `.texo/` to `.git/info/exclude`.
pub fn answer_git_exclude(dir: &Path, add: bool) -> AppResult<HistoryStatus> {
    if add {
        if let Some(git) = git_dir_of_project(dir) {
            if !excludes_texo(&git) {
                let info = git.join("info");
                std::fs::create_dir_all(&info)?;
                let path = info.join("exclude");
                let mut text = std::fs::read_to_string(&path).unwrap_or_default();
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str("# Texo's own files (history, settings)\n.texo/\n");
                std::fs::write(&path, text).map_err(|e| crate::project::explain_io(e, true))?;
            }
        }
    }
    Prefs::update(dir, |p| p.git_exclude_answered = true)?;
    Ok(status(dir))
}
