//! The changeset model: what a run changed, per file and per hunk, and how
//! the user's decisions turn into a history commit.
//!
//! Hunks are computed here (libgit2's diff, no context lines) and sent to
//! the UI with their indices, so "accept hunks 0 and 2" means the same thing
//! on both sides. Applying goes through [`crate::history::apply_changeset`],
//! which three-way merges files that changed on disk since the run read
//! them and makes one AI commit.

use std::collections::BTreeSet;
use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::fsops;
use crate::history::{self, AiAuthor, ApplyOutcome, ApplyRequest, ChangeFile, RunNote};

use super::journal;
use super::types::{AgentRun, ChangeEntry, Changeset, ChangesetFile, Decision, FileState, FileStatus, Hunk, RunStatus};

/// The blocks of changed lines between two texts.
pub fn hunks(base: &str, new: &str) -> Vec<Hunk> {
    if base == new {
        return Vec::new();
    }
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(0).force_text(true);
    let Ok(patch) = git2::Patch::from_buffers(base.as_bytes(), None, new.as_bytes(), None, Some(&mut opts)) else {
        return Vec::new();
    };
    (0..patch.num_hunks())
        .filter_map(|i| patch.hunk(i).ok())
        .enumerate()
        .map(|(index, (h, _))| Hunk {
            index,
            old_start: h.old_start() as usize,
            old_lines: h.old_lines() as usize,
            new_start: h.new_start() as usize,
            new_lines: h.new_lines() as usize,
        })
        .collect()
}

/// `base` with only the `accepted` hunks of `base → new` applied.
pub fn apply_hunks(base: &str, new: &str, accepted: &[usize]) -> String {
    let old: Vec<&str> = base.split_inclusive('\n').collect();
    let newl: Vec<&str> = new.split_inclusive('\n').collect();
    let take: BTreeSet<usize> = accepted.iter().copied().collect();
    let mut out = String::with_capacity(base.len().max(new.len()));
    let mut pos = 0usize;
    for h in hunks(base, new) {
        let start = if h.old_lines == 0 { h.old_start } else { h.old_start.saturating_sub(1) };
        let start = start.min(old.len()).max(pos);
        out.extend(old[pos..start].iter().copied());
        let end = (start + h.old_lines).min(old.len());
        if take.contains(&h.index) {
            if h.new_lines > 0 {
                let ns = h.new_start.saturating_sub(1).min(newl.len());
                let ne = (ns + h.new_lines).min(newl.len());
                out.extend(newl[ns..ne].iter().copied());
            }
        } else {
            out.extend(old[start..end].iter().copied());
        }
        pos = end;
    }
    out.extend(old[pos.min(old.len())..].iter().copied());
    out
}

fn read_disk(dir: &Path, file: &str) -> Option<Option<String>> {
    let path = fsops::resolve(dir, file).ok()?;
    match std::fs::read(&path) {
        Ok(b) => String::from_utf8(b).ok().map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
    }
}

/// Whether applying `entry` now would conflict with the file on disk, and
/// whether the disk changed since the run read it.
fn check_disk(dir: &Path, entry: &ChangeEntry) -> (bool, bool) {
    let Some(disk) = read_disk(dir, &entry.file) else {
        // Unreadable (or no longer text): needs a manual look.
        return (true, true);
    };
    if disk == entry.base_text {
        return (false, false);
    }
    if disk == entry.new_text {
        return (false, true);
    }
    let conflict = match (&entry.base_text, &disk, &entry.new_text) {
        (Some(b), Some(o), Some(n)) => history::merge3(b, o, n).map(|m| m.conflict).unwrap_or(true),
        _ => true,
    };
    (conflict, true)
}

/// The changeset as the review dialog shows it, checked against the disk.
pub fn view(dir: &Path, run: &AgentRun) -> Changeset {
    let files = run
        .changeset
        .iter()
        .map(|c| {
            let status = match (&c.base_text, &c.new_text) {
                (None, _) => FileStatus::Added,
                (_, None) => FileStatus::Deleted,
                _ => FileStatus::Modified,
            };
            let (conflict, changed_on_disk) =
                if matches!(c.state, FileState::Pending | FileState::Conflict) { check_disk(dir, c) } else { (false, false) };
            ChangesetFile {
                file: c.file.clone(),
                base_text: c.base_text.clone(),
                new_text: c.new_text.clone(),
                status,
                conflict: conflict || c.state == FileState::Conflict,
                changed_on_disk,
                base_hash: c.base_hash.clone(),
                reason: c.reason.clone(),
                state: c.state,
                hunks: hunks(c.base_text.as_deref().unwrap_or(""), c.new_text.as_deref().unwrap_or("")),
                merged_text: c.merged_text.clone(),
                attention: c.attention.clone(),
            }
        })
        .collect();
    Changeset { run_id: run.id.clone(), files }
}

/// A one-line description of a tool call for the history note.
fn tool_line(step: &super::types::Step) -> Option<String> {
    let tool = step.tool.as_deref()?;
    let target = step
        .args
        .as_ref()
        .and_then(|a| ["path", "query", "url", "id", "key", "pattern"].iter().find_map(|k| a.get(*k).and_then(|v| v.as_str())))
        .map(|s| super::types::one_line(s, 80));
    Some(match target {
        Some(t) => format!("{tool} {t}"),
        None => tool.to_string(),
    })
}

/// What [`plan`] decided: the history request (if anything is to be
/// written) and the files the user rejected.
pub struct Plan {
    pub request: Option<ApplyRequest>,
    pub accepted: Vec<String>,
    pub rejected: Vec<String>,
}

/// Turns the user's decisions into a history request. Files without a
/// decision stay pending.
pub fn plan(dir: &Path, run: &AgentRun, decisions: &[Decision], kind_label: &str) -> AppResult<Plan> {
    let mut files = Vec::new();
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    for d in decisions {
        let key = super::overlay::clean_path(dir, &d.file)?;
        let entry = run
            .changeset
            .iter()
            .find(|c| c.file == key)
            .ok_or_else(|| AppError::msg(format!("{key} isn't part of this run's changes.")))?;
        if entry.state == FileState::Applied || entry.state == FileState::Rejected && !d.accept {
            continue;
        }
        if !d.accept {
            rejected.push(key);
            continue;
        }
        let base = entry.base_text.clone();
        let mut new_text = match (&d.edited_text, &d.hunks, &entry.new_text) {
            (Some(edited), _, _) => Some(edited.clone()),
            (None, Some(sel), Some(n)) => Some(apply_hunks(base.as_deref().unwrap_or(""), n, sel)),
            (None, _, n) => n.clone(),
        };
        // An added file whose hunks were all rejected: nothing to create.
        if base.is_none() && new_text.as_deref() == Some("") && d.edited_text.is_none() && d.hunks.is_some() {
            new_text = None;
        }
        if new_text == base {
            rejected.push(key);
            continue;
        }
        // Resolving a conflict: the user's text replaces what is on disk now.
        let base_text = if entry.state == FileState::Conflict && d.edited_text.is_some() {
            read_disk(dir, &key).ok_or_else(|| AppError::msg(format!("{key} can't be read, so it can't be updated.")))?
        } else {
            base
        };
        accepted.push(key.clone());
        files.push(ChangeFile { file: key, base_text, new_text });
    }
    if files.is_empty() {
        return Ok(Plan { request: None, accepted, rejected });
    }
    let title = super::types::one_line(&run.title, 72);
    let summary = if title.is_empty() { format!("{kind_label}: AI changes") } else { format!("{kind_label}: {title}") };
    let request = ApplyRequest {
        run_id: run.id.clone(),
        author: AiAuthor {
            profile_name: run.profile_name.clone().unwrap_or_else(|| kind_label.to_string()),
            model: run.model.clone(),
            kind: run.kind.clone(),
        },
        step: None,
        summary,
        files,
        note: RunNote {
            prompt: run.prompt.clone(),
            tool_calls: run.steps.iter().filter_map(tool_line).collect(),
            accepted: accepted.clone(),
            rejected: rejected.clone(),
            journal: Some(journal::rel_path(&run.id)),
        },
    };
    Ok(Plan { request: Some(request), accepted, rejected })
}

/// Records the outcome in the run: applied, rejected and conflicting files,
/// the commit, and the status (`done` once nothing is left to decide).
pub fn record(run: &mut AgentRun, plan: &Plan, outcome: Option<&ApplyOutcome>) {
    for c in &mut run.changeset {
        if plan.rejected.contains(&c.file) {
            c.state = FileState::Rejected;
            c.merged_text = None;
        } else if plan.accepted.contains(&c.file) {
            match outcome.and_then(|o| o.conflicts.iter().find(|x| x.file == c.file)) {
                Some(conflict) => {
                    c.state = FileState::Conflict;
                    c.merged_text = conflict.merged_text.clone();
                }
                None => {
                    c.state = FileState::Applied;
                    c.merged_text = None;
                }
            }
        }
    }
    if let Some(commit) = outcome.and_then(|o| o.commit.clone()) {
        run.apply_commits.push(commit);
    }
    if matches!(run.status, RunStatus::AwaitingReview | RunStatus::Done) {
        let open = run.changeset.iter().any(|c| matches!(c.state, FileState::Pending | FileState::Conflict));
        run.status = if open { RunStatus::AwaitingReview } else { RunStatus::Done };
    }
}

/// "Discard": every undecided file is rejected.
pub fn discard(run: &mut AgentRun) {
    for c in &mut run.changeset {
        if matches!(c.state, FileState::Pending | FileState::Conflict) {
            c.state = FileState::Rejected;
            c.merged_text = None;
        }
    }
    if run.status == RunStatus::AwaitingReview {
        run.status = RunStatus::Done;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn hunks_and_partial_application() {
        let base = "a\nb\nc\nd\ne\n";
        let new = "a\nB\nc\nd\nE\nf\n";
        let h = hunks(base, new);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].old_start, h[0].old_lines, h[0].new_start, h[0].new_lines), (2, 1, 2, 1));
        assert_eq!(apply_hunks(base, new, &[0, 1]), new);
        assert_eq!(apply_hunks(base, new, &[]), base);
        assert_eq!(apply_hunks(base, new, &[0]), "a\nB\nc\nd\ne\n");
        assert_eq!(apply_hunks(base, new, &[1]), "a\nb\nc\nd\nE\nf\n");
        // Insertions at the top and pure deletions.
        let new2 = "top\na\nc\nd\ne\n";
        let h2 = hunks(base, new2);
        assert_eq!(h2.len(), 2);
        assert_eq!(apply_hunks(base, new2, &[0]), "top\na\nb\nc\nd\ne\n");
        assert_eq!(apply_hunks(base, new2, &[1]), "a\nc\nd\ne\n");
        // No newline at the end, CRLF kept.
        assert_eq!(apply_hunks("x", "x\ny\n", &[0]), "x\ny\n");
        assert_eq!(apply_hunks("a\r\nb\r\n", "a\r\nB\r\n", &[0]), "a\r\nB\r\n");
        assert_eq!(apply_hunks("", "new\n", &[0]), "new\n");
        assert!(hunks("same", "same").is_empty());
    }

    fn entry(file: &str, base: Option<&str>, new: Option<&str>) -> ChangeEntry {
        ChangeEntry {
            file: file.into(),
            base_text: base.map(Into::into),
            base_hash: super::super::types::text_hash(base),
            new_text: new.map(Into::into),
            reason: "r".into(),
            ..Default::default()
        }
    }

    fn run_with(changes: Vec<ChangeEntry>) -> AgentRun {
        AgentRun {
            id: "run-apply".into(),
            kind: "fixer".into(),
            title: "Fix the brace".into(),
            prompt: "Fix it".into(),
            status: RunStatus::AwaitingReview,
            model: "test-model".into(),
            changeset: changes,
            ..Default::default()
        }
    }

    fn apply(dir: &Path, run: &mut AgentRun, decisions: &[Decision]) -> Option<ApplyOutcome> {
        let p = plan(dir, run, decisions, "Fixer").unwrap();
        let out = p.request.as_ref().map(|r| history::apply_changeset(dir, r).unwrap());
        record(run, &p, out.as_ref());
        out
    }

    fn accept(file: &str) -> Decision {
        Decision { file: file.into(), accept: true, ..Default::default() }
    }

    #[test]
    fn apply_merges_changed_files_and_reports_conflicts() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let base = "one\ntwo\nthree\nfour\nfive\n";
        fs::write(dir.join("a.tex"), base).unwrap();
        fs::write(dir.join("b.tex"), "x\ny\n").unwrap();
        fs::write(dir.join("c.tex"), "keep\n").unwrap();
        let mut run = run_with(vec![
            entry("a.tex", Some(base), Some("ONE\ntwo\nthree\nfour\nfive\n")),
            entry("b.tex", Some("x\ny\n"), Some("x\nAI\n")),
            entry("c.tex", Some("keep\n"), Some("keep\nmore\n")),
            entry("new.tex", None, Some("new file\n")),
        ]);
        // While the run waited for review, the user edited a.tex (other
        // lines) and b.tex (the same line).
        fs::write(dir.join("a.tex"), "one\ntwo\nthree\nfour\nFIVE (mine)\n").unwrap();
        fs::write(dir.join("b.tex"), "x\nmine\n").unwrap();

        let view1 = view(dir, &run);
        assert!(!view1.files[0].conflict && view1.files[0].changed_on_disk);
        assert!(view1.files[1].conflict);
        assert!(!view1.files[2].conflict && !view1.files[2].changed_on_disk);
        assert_eq!(view1.files[3].status, FileStatus::Added);

        let out = apply(
            dir,
            &mut run,
            &[accept("a.tex"), accept("b.tex"), Decision { file: "c.tex".into(), accept: false, ..Default::default() }, accept("new.tex")],
        )
        .unwrap();
        assert!(out.commit.is_some(), "{:?}", out.history_error);
        assert_eq!(fs::read_to_string(dir.join("a.tex")).unwrap(), "ONE\ntwo\nthree\nfour\nFIVE (mine)\n");
        assert_eq!(fs::read_to_string(dir.join("b.tex")).unwrap(), "x\nmine\n", "a conflict never overwrites");
        assert_eq!(fs::read_to_string(dir.join("c.tex")).unwrap(), "keep\n");
        assert_eq!(fs::read_to_string(dir.join("new.tex")).unwrap(), "new file\n");
        assert_eq!(out.conflicts.len(), 1);
        let states: Vec<FileState> = run.changeset.iter().map(|c| c.state).collect();
        assert_eq!(states, [FileState::Applied, FileState::Conflict, FileState::Rejected, FileState::Applied]);
        assert!(run.changeset[1].merged_text.as_deref().unwrap().contains("<<<<<<<"));
        assert_eq!(run.status, RunStatus::AwaitingReview);
        assert_eq!(run.apply_commits.len(), 1);

        // The AI commit carries the run's author and trailers.
        let log = history::repo::with_repo(dir, history::repo::WAIT, |ctx| {
            history::query::log(ctx, &history::query::LogFilter { run_id: Some("run-apply".into()), ..Default::default() })
        })
        .unwrap();
        let ai = log.iter().find(|e| e.run_id.as_deref() == Some("run-apply")).expect("AI commit");
        assert!(ai.author_name.contains("Fixer") && ai.author_name.contains("test-model"), "{}", ai.author_name);
        assert_eq!(ai.kind.as_deref(), Some("fixer"));
        assert!(ai.note.as_ref().unwrap().to_string().contains(".texo/ai/runs/run-apply.json"));

        // Resolve the conflict with the user's own text.
        apply(dir, &mut run, &[Decision { file: "b.tex".into(), accept: true, edited_text: Some("x\nmine and AI\n".into()), ..Default::default() }]);
        assert_eq!(fs::read_to_string(dir.join("b.tex")).unwrap(), "x\nmine and AI\n");
        assert_eq!(run.changeset[1].state, FileState::Applied);
        assert_eq!(run.status, RunStatus::Done);

        // Unknown files are refused.
        assert!(plan(dir, &run, &[accept("other.tex")], "Fixer").is_err());
    }

    #[test]
    fn apply_selected_hunks_and_edited_text() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let base = "a\nb\nc\nd\ne\n";
        fs::write(dir.join("m.tex"), base).unwrap();
        fs::write(dir.join("n.tex"), "n\n").unwrap();
        let mut run = run_with(vec![entry("m.tex", Some(base), Some("a\nB\nc\nd\nE\n")), entry("n.tex", Some("n\n"), Some("N\n"))]);
        apply(
            dir,
            &mut run,
            &[
                Decision { file: "m.tex".into(), accept: true, hunks: Some(vec![1]), ..Default::default() },
                Decision { file: "n.tex".into(), accept: true, edited_text: Some("my own\n".into()), ..Default::default() },
            ],
        );
        assert_eq!(fs::read_to_string(dir.join("m.tex")).unwrap(), "a\nb\nc\nd\nE\n");
        assert_eq!(fs::read_to_string(dir.join("n.tex")).unwrap(), "my own\n");
        assert_eq!(run.status, RunStatus::Done);
    }

    #[test]
    fn accepting_no_hunks_is_a_rejection_and_discard_rejects_the_rest() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        fs::write(dir.join("m.tex"), "a\n").unwrap();
        let mut run = run_with(vec![entry("m.tex", Some("a\n"), Some("b\n")), entry("z.tex", None, Some("z\n"))]);
        let out = apply(dir, &mut run, &[Decision { file: "m.tex".into(), accept: true, hunks: Some(vec![]), ..Default::default() }]);
        assert!(out.is_none());
        assert_eq!(run.changeset[0].state, FileState::Rejected);
        assert_eq!(run.status, RunStatus::AwaitingReview);
        discard(&mut run);
        assert_eq!(run.changeset[1].state, FileState::Rejected);
        assert_eq!(run.status, RunStatus::Done);
        assert!(!dir.join("z.tex").exists());
    }
}
