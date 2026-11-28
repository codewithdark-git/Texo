//! Writing an accepted AI changeset into the project: a three-way merge per
//! file when the file changed on disk since the run read it, then one AI
//! commit with trailers, a note and the run's `end` ref.
//!
//! The agents runtime calls [`start_run`] before a run and
//! [`apply_changeset`] when the user accepts (or "Apply automatically").

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::repo::{self, Prefs};
use super::snapshot::{self, AiAuthor, Meta, Reason, Who};
use crate::error::{AppError, AppResult};
use crate::fsops;

/// One file of an accepted changeset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFile {
    /// `/`-separated path inside the project.
    pub file: String,
    /// The file as the run first read it; `None` when the run created it.
    pub base_text: Option<String>,
    /// The text to write; `None` deletes the file.
    pub new_text: Option<String>,
}

/// What goes into the git note of the AI commit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunNote {
    /// The user's prompt (capped to 4000 chars in the note).
    pub prompt: String,
    /// One line per tool call, e.g. `edit_file main.tex`.
    pub tool_calls: Vec<String>,
    pub accepted: Vec<String>,
    pub rejected: Vec<String>,
    /// `.texo/ai/runs/<run-id>.json`.
    pub journal: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub run_id: String,
    pub author: AiAuthor,
    /// The step the changeset came from, when it is one step's edit.
    pub step: Option<u32>,
    /// First line of the commit, e.g. "Fixed a missing brace in intro.tex".
    pub summary: String,
    pub files: Vec<ChangeFile>,
    pub note: RunNote,
}

/// A file that couldn't be merged; it was left as it is on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub file: String,
    pub base_text: Option<String>,
    /// What is on disk now (`None`: the file is gone).
    pub ours_text: Option<String>,
    /// What the AI wrote (`None`: the AI deleted it).
    pub theirs_text: Option<String>,
    /// Both versions with `<<<<<<<` markers, when both sides are text.
    pub merged_text: Option<String>,
    /// Plain words for the review dialog.
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// The AI commit, when history is on and something was written.
    pub commit: Option<String>,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    pub conflicts: Vec<MergeConflict>,
    /// Set when the files were written but history couldn't record them.
    pub history_error: Option<String>,
}

/// Result of a text three-way merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub text: String,
    pub conflict: bool,
}

/// Three-way merges text (line based, libgit2's xdiff). On conflict, `text`
/// holds both sides between markers.
pub fn merge3(base: &str, ours: &str, theirs: &str) -> AppResult<Merged> {
    if ours == theirs || base == theirs {
        return Ok(Merged { text: ours.to_string(), conflict: false });
    }
    if base == ours {
        return Ok(Merged { text: theirs.to_string(), conflict: false });
    }
    // `git2::merge_file` doesn't initialize libgit2, and this can be the
    // first git call in the process (the review dialog, before any history).
    repo::init_libgit2();
    let mut b = git2::MergeFileInput::new();
    b.content(base.as_bytes());
    let mut o = git2::MergeFileInput::new();
    o.content(ours.as_bytes());
    let mut t = git2::MergeFileInput::new();
    t.content(theirs.as_bytes());
    let mut opts = git2::MergeFileOptions::new();
    opts.ancestor_label("before the AI run").our_label("your version").their_label("AI version");
    let res = git2::merge_file(&b, &o, &t, Some(&mut opts)).map_err(repo::g)?;
    Ok(Merged { text: String::from_utf8_lossy(res.content()).into_owned(), conflict: !res.is_automergeable() })
}

fn read_disk(path: &Path) -> AppResult<Option<String>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(String::from_utf8(b).map_err(|_| {
            AppError::msg("This file isn't plain text any more, so the AI's change can't be merged into it.")
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

enum Action {
    Write(String),
    Delete,
    Nothing,
    Conflict(MergeConflict),
}

fn plan(cf: &ChangeFile, ours: Option<String>) -> AppResult<Action> {
    let conflict = |merged: Option<String>, reason: &str| {
        Action::Conflict(MergeConflict {
            file: cf.file.clone(),
            base_text: cf.base_text.clone(),
            ours_text: ours.clone(),
            theirs_text: cf.new_text.clone(),
            merged_text: merged,
            reason: reason.to_string(),
        })
    };
    Ok(match (&cf.base_text, &ours, &cf.new_text) {
        // Already what the AI wanted.
        (_, o, n) if o == n => Action::Nothing,
        // Unchanged since the run read it: take the AI's version.
        (b, o, Some(n)) if b == o => Action::Write(n.clone()),
        (b, o, None) if b == o => Action::Delete,
        (Some(b), Some(o), Some(n)) => {
            let m = merge3(b, o, n)?;
            if m.conflict {
                conflict(Some(m.text), "You and the AI both changed the same lines. Pick what to keep.")
            } else {
                Action::Write(m.text)
            }
        }
        (None, Some(_), Some(_)) => conflict(None, "A file with this name was created while the AI was working."),
        (Some(_), None, Some(_)) => conflict(None, "This file was deleted while the AI was working on it."),
        (Some(_), Some(_), None) => conflict(None, "The AI deleted this file, but you changed it in the meantime."),
        _ => Action::Nothing,
    })
}

/// Writes an accepted changeset. Files that changed on disk since the run
/// read them are three-way merged; conflicting files are left untouched and
/// returned. When history is on, the user's current files are snapshotted
/// first and the result is one AI commit (trailers `Texo-Run`, `Texo-Step`,
/// `Texo-Agent`, `Texo-Model`, `Texo-Kind`; note in `refs/notes/texo`) and
/// `refs/texo/runs/<run>/end` points at it.
///
/// To resolve a conflict, call again with that file only, `base_text` set
/// to the current disk text and `new_text` to the user's resolution.
///
/// History problems never stop the files from being written: they are
/// reported in `history_error`.
pub fn apply_changeset(dir: &Path, req: &ApplyRequest) -> AppResult<ApplyOutcome> {
    valid_run_id(&req.run_id)?;
    for f in &req.files {
        fsops::resolve(dir, &f.file)?;
    }
    let enabled = Prefs::load(dir).enabled;
    if !enabled {
        return write_files(dir, req);
    }
    let mut written = None;
    // Set once the files may have been touched: from then on they are never
    // written a second time outside the history.
    let mut writing = false;
    let res = repo::with_repo(dir, repo::WAIT, |ctx| {
        snapshot::snapshot(ctx, Meta::you(Reason::BeforeRun))?;
        writing = true;
        let out = write_files(dir, req)?;
        let changed = !out.written.is_empty() || !out.deleted.is_empty();
        written = Some(out);
        if !changed {
            return Ok(None);
        }
        let mut accepted = req.note.accepted.clone();
        if accepted.is_empty() {
            accepted = written.as_ref().map(|o| o.written.iter().chain(&o.deleted).cloned().collect()).unwrap_or_default();
        }
        let note = serde_json::json!({
            "runId": req.run_id,
            "prompt": req.note.prompt.chars().take(4000).collect::<String>(),
            "toolCalls": req.note.tool_calls.iter().take(500).collect::<Vec<_>>(),
            "accepted": accepted,
            "rejected": req.note.rejected,
            "conflicts": written.as_ref().map(|o| o.conflicts.iter().map(|c| c.file.clone()).collect::<Vec<_>>()).unwrap_or_default(),
            "journal": req.note.journal,
        });
        let meta = Meta {
            who: Who::Ai(req.author.clone()),
            reason: Reason::AgentApply,
            summary: req.summary.clone(),
            run_id: Some(req.run_id.clone()),
            step: req.step,
            undo_of: None,
            note: Some(note),
        };
        let id = snapshot::snapshot(ctx, meta)?;
        if let Some(id) = id {
            ctx.repo
                .reference(&run_ref(&req.run_id, "end"), id, true, "Texo: AI run applied")
                .map_err(repo::g)?;
        }
        Ok(id)
    });
    match (res, written) {
        (Ok(id), Some(mut out)) => {
            out.commit = id.map(|i| i.to_string());
            Ok(out)
        }
        (Err(e), Some(mut out)) => {
            out.history_error = Some(e.to_string());
            Ok(out)
        }
        // Writing failed partway; don't run it again.
        (Err(e), None) if writing => Err(e),
        // History couldn't even be opened: still write the files.
        (Err(e), None) => {
            let mut out = write_files(dir, req)?;
            out.history_error = Some(e.to_string());
            Ok(out)
        }
        (Ok(_), None) => Err(AppError::msg("Nothing was applied.")),
    }
}

/// Writes each file it can. A file that can't be read, merged, written or
/// deleted is left as it is and reported as a conflict, so one bad file
/// never stops the others (or the AI commit for them).
fn write_files(dir: &Path, req: &ApplyRequest) -> AppResult<ApplyOutcome> {
    // Checked before anything is written.
    let paths = req.files.iter().map(|cf| fsops::resolve(dir, &cf.file)).collect::<AppResult<Vec<_>>>()?;
    let mut out = ApplyOutcome::default();
    for (cf, path) in req.files.iter().zip(paths) {
        let ours = match read_disk(&path) {
            Ok(o) => o,
            Err(e) => {
                out.conflicts.push(MergeConflict {
                    file: cf.file.clone(),
                    base_text: cf.base_text.clone(),
                    ours_text: None,
                    theirs_text: cf.new_text.clone(),
                    merged_text: None,
                    reason: e.to_string(),
                });
                continue;
            }
        };
        let action = match plan(cf, ours.clone()) {
            Ok(a) => a,
            Err(e) => Action::Conflict(MergeConflict {
                file: cf.file.clone(),
                base_text: cf.base_text.clone(),
                ours_text: ours,
                theirs_text: cf.new_text.clone(),
                merged_text: None,
                reason: e.to_string(),
            }),
        };
        match action {
            Action::Write(text) => match snapshot::write_bytes(&path, text.as_bytes()) {
                Ok(()) => out.written.push(cf.file.clone()),
                Err(e) => out.conflicts.push(MergeConflict {
                    file: cf.file.clone(),
                    base_text: cf.base_text.clone(),
                    ours_text: None,
                    theirs_text: cf.new_text.clone(),
                    merged_text: None,
                    reason: crate::project::explain_io(e, true).to_string(),
                }),
            },
            Action::Delete => match fs::remove_file(&path) {
                Ok(()) => out.deleted.push(cf.file.clone()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => out.conflicts.push(MergeConflict {
                    file: cf.file.clone(),
                    base_text: cf.base_text.clone(),
                    ours_text: cf.base_text.clone(),
                    theirs_text: None,
                    merged_text: None,
                    reason: crate::project::explain_io(e, true).to_string(),
                }),
            },
            Action::Nothing => {}
            Action::Conflict(c) => out.conflicts.push(c),
        }
    }
    Ok(out)
}

pub fn run_ref(run_id: &str, which: &str) -> String {
    format!("refs/texo/runs/{run_id}/{which}")
}

pub fn valid_run_id(id: &str) -> AppResult<()> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::msg("That AI run id isn't valid."));
    }
    Ok(())
}

/// The "before run" snapshot: commits the user's current files and points
/// `refs/texo/runs/<run>/start` at HEAD. Returns the commit id, or `None`
/// when history is off or fails (logged; a run never fails because of it).
pub fn start_run(dir: &Path, run_id: &str) -> Option<String> {
    if valid_run_id(run_id).is_err() || !Prefs::load(dir).enabled {
        return None;
    }
    let res = repo::with_repo(dir, repo::AUTO_WAIT, |ctx| {
        snapshot::snapshot(ctx, Meta::you(Reason::BeforeRun))?;
        let head = match repo::head_commit(&ctx.repo)? {
            Some(c) => c.id(),
            // An empty project: record an empty first commit to point at.
            None => {
                let tree = repo::write_tree(&ctx.repo, &Default::default())?;
                snapshot::commit(ctx, tree, &Meta::you(Reason::Start))?
            }
        };
        ctx.repo.reference(&run_ref(run_id, "start"), head, true, "Texo: AI run started").map_err(repo::g)?;
        Ok(head.to_string())
    });
    match res {
        Ok(id) => Some(id),
        Err(e) => {
            eprintln!("[history] before-run snapshot failed: {e}");
            None
        }
    }
}
