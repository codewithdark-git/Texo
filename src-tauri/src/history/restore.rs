//! Going back: restore one file or the whole project to an earlier commit,
//! and undo an AI run. Each first saves the current files and then makes a
//! new commit; history is never rewritten.

use std::collections::HashSet;
use std::fs;

use git2::{Oid, Repository};
use serde::Serialize;

use super::apply::{run_ref, valid_run_id};
use super::repo::{self, Ctx, Entries};
use super::snapshot::{self, Meta, Reason};
use crate::error::{AppError, AppResult};
use crate::fsops;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// The new commit (`None` when the files already matched).
    pub commit: Option<String>,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    /// Files that couldn't be written (open in another app, read-only).
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub ok: bool,
    pub commit: Option<String>,
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    /// Files you changed after the AI did; they were left as they are.
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
}

fn short(id: Oid) -> String {
    id.to_string()[..8].to_string()
}

fn tree_entries(repo: &Repository, id: Oid) -> AppResult<Entries> {
    let c = repo.find_commit(id).map_err(repo::g)?;
    repo::flatten(Some(&c.tree().map_err(repo::g)?))
}

/// File names that differ only in case are the same file on Windows and
/// macOS.
const CASE_INSENSITIVE_FS: bool = cfg!(any(windows, target_os = "macos"));

fn fold(path: &str) -> String {
    if CASE_INSENSITIVE_FS {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

/// Makes the disk match `target` for the files whose entry differs from
/// `current` (HEAD). Paths only in `current` are deleted.
///
/// `not_recorded` lists files whose current contents aren't in `current`
/// (too large, cloud-only, unreadable when the snapshot before this ran):
/// they are never overwritten or deleted, only reported in `failed`, so no
/// version is lost.
fn write_diff(
    ctx: &Ctx,
    current: &Entries,
    target: &Entries,
    not_recorded: &[String],
    out: &mut RestoreResult,
) -> AppResult<()> {
    let keep: HashSet<String> = not_recorded.iter().map(|p| fold(p)).collect();
    let kept = |path: &str, out: &mut RestoreResult| {
        if keep.contains(&fold(path)) {
            eprintln!("[history] restore {path}: left as it is, its current version isn't in the history");
            out.failed.push(path.to_string());
            true
        } else {
            false
        }
    };
    for (path, (id, _)) in target {
        if current.get(path).map(|e| e.0) == Some(*id) {
            continue;
        }
        if kept(path, out) {
            continue;
        }
        let full = fsops::resolve(&ctx.dir, path)?;
        let blob = ctx.repo.find_blob(*id).map_err(repo::g)?;
        match snapshot::write_bytes(&full, blob.content()) {
            Ok(()) => out.written.push(path.clone()),
            Err(e) => {
                eprintln!("[history] restore {path}: {e}");
                out.failed.push(path.clone());
            }
        }
    }
    // After a rename that only changed case (Main.tex -> main.tex), the
    // target's name is the same file as the current one: deleting it would
    // remove the file just written.
    let in_target: HashSet<String> = target.keys().map(|p| fold(p)).collect();
    for path in current.keys().filter(|p| !target.contains_key(*p)) {
        if in_target.contains(&fold(path)) || kept(path, out) {
            continue;
        }
        let full = fsops::resolve(&ctx.dir, path)?;
        match fs::remove_file(&full) {
            Ok(()) => out.deleted.push(path.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                eprintln!("[history] remove {path}: {e}");
                out.failed.push(path.clone());
            }
        }
    }
    Ok(())
}

fn when(repo: &Repository, id: Oid) -> String {
    repo.find_commit(id)
        .ok()
        .and_then(|c| chrono::DateTime::from_timestamp(c.time().seconds(), 0))
        .map(|t| t.with_timezone(&chrono::Local).format("%-d %b %Y, %H:%M").to_string())
        .unwrap_or_else(|| short(id))
}

/// Puts one file back as it was at `commit`.
pub fn restore_file(ctx: &Ctx, commit: &str, file: &str) -> AppResult<RestoreResult> {
    let id = repo::parse_oid(&ctx.repo, commit)?;
    let file = file.trim().replace('\\', "/");
    fsops::resolve(&ctx.dir, &file)?;
    let then = tree_entries(&ctx.repo, id)?;
    let Some(entry) = then.get(&file).copied() else {
        return Err(AppError::msg("This file didn't exist at that point in the history."));
    };
    let (_, not_recorded) = snapshot::snapshot_scanned(ctx, Meta::you(Reason::Restore))?;
    if not_recorded.iter().any(|p| fold(p) == fold(&file)) {
        return Err(AppError::msg(
            "Texo couldn't save a copy of this file as it is now (it's very large, not downloaded to this PC, or open in another app), so it was left as it is. Try again once it can be opened.",
        ));
    }
    let now = snapshot::head_entries(&ctx.repo)?;
    let mut out = RestoreResult::default();
    let mut target = now.clone();
    target.insert(file.clone(), entry);
    write_diff(ctx, &now, &target, &not_recorded, &mut out)?;
    let mut meta = Meta::you(Reason::Restore);
    meta.summary = format!("Restored {file} to the version from {}", when(&ctx.repo, id));
    out.commit = snapshot::snapshot(ctx, meta)?.map(|i| i.to_string());
    Ok(out)
}

/// Puts every tracked file back as it was at `commit`; files added since
/// are removed (they stay in the history).
pub fn restore_all(ctx: &Ctx, commit: &str) -> AppResult<RestoreResult> {
    let id = repo::parse_oid(&ctx.repo, commit)?;
    let target = tree_entries(&ctx.repo, id)?;
    let (_, not_recorded) = snapshot::snapshot_scanned(ctx, Meta::you(Reason::Restore))?;
    let now = snapshot::head_entries(&ctx.repo)?;
    let mut out = RestoreResult::default();
    write_diff(ctx, &now, &target, &not_recorded, &mut out)?;
    let mut meta = Meta::you(Reason::Restore);
    meta.summary = format!("Restored the project to the version from {}", when(&ctx.repo, id));
    out.commit = snapshot::snapshot(ctx, meta)?.map(|i| i.to_string());
    Ok(out)
}

fn trailer(msg: &str, key: &str) -> Option<String> {
    git2::message_trailers_strs(msg)
        .ok()?
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.trim().to_string())
}

/// Commits (newest first) that applied changes from `run_id`, and whether
/// the run was undone already.
fn run_commits(repo: &Repository, run_id: &str) -> AppResult<(Vec<Oid>, bool)> {
    let mut out = Vec::new();
    let Some(head) = repo::head_commit(repo)? else { return Ok((out, false)) };
    let mut walk = repo.revwalk().map_err(repo::g)?;
    walk.push(head.id()).map_err(repo::g)?;
    walk.simplify_first_parent().map_err(repo::g)?;
    let start = repo.refname_to_id(&run_ref(run_id, "start")).ok();
    for id in walk {
        let id = id.map_err(repo::g)?;
        let c = repo.find_commit(id).map_err(repo::g)?;
        let msg = c.message().unwrap_or_default();
        if trailer(msg, "Texo-Undo").as_deref() == Some(run_id) {
            return Ok((out, true));
        }
        if trailer(msg, "Texo-Run").as_deref() == Some(run_id)
            && trailer(msg, "Texo-Reason").as_deref() == Some(Reason::AgentApply.as_str())
        {
            out.push(id);
        }
        if Some(id) == start {
            break;
        }
    }
    Ok((out, false))
}

const STAGE_MASK: u16 = 0x3000;

/// Reverts every change the run made, newest first, with a three-way merge
/// against the current files (`merge_trees`). Files you changed since the
/// AI did are left as they are and listed as conflicts.
pub fn undo_run(ctx: &Ctx, run_id: &str) -> AppResult<UndoResult> {
    valid_run_id(run_id)?;
    let repo = &ctx.repo;
    let (_, not_recorded) = snapshot::snapshot_scanned(ctx, Meta::you(Reason::Undo))?;
    let (commits, undone) = run_commits(repo, run_id)?;
    if undone {
        return Err(AppError::msg("This AI run was already undone."));
    }
    if commits.is_empty() {
        return Err(AppError::msg("This AI run didn't change any files, so there's nothing to undo."));
    }
    let head = repo::head_commit(repo)?.ok_or_else(|| AppError::msg("The history is empty."))?;
    let now = repo::flatten(Some(&head.tree().map_err(repo::g)?))?;
    let mut ours_tree = head.tree().map_err(repo::g)?;
    let mut conflicts: Vec<String> = Vec::new();
    let mut opts = git2::MergeOptions::new();
    opts.find_renames(false);
    for id in commits {
        let c = repo.find_commit(id).map_err(repo::g)?;
        let ancestor = c.tree().map_err(repo::g)?;
        let before = match c.parent(0) {
            Ok(p) => p.tree().map_err(repo::g)?,
            Err(_) => repo.find_tree(repo::write_tree(repo, &Entries::new())?).map_err(repo::g)?,
        };
        let index = repo.merge_trees(&ancestor, &ours_tree, &before, Some(&opts)).map_err(repo::g)?;
        let mut merged = Entries::new();
        for e in index.iter() {
            if e.flags & STAGE_MASK != 0 {
                continue;
            }
            if let Ok(path) = String::from_utf8(e.path.clone()) {
                merged.insert(path, (e.id, e.mode));
            }
        }
        if index.has_conflicts() {
            let ours = repo::flatten(Some(&ours_tree))?;
            for conflict in index.conflicts().map_err(repo::g)?.flatten() {
                let path = conflict
                    .our
                    .as_ref()
                    .or(conflict.their.as_ref())
                    .or(conflict.ancestor.as_ref())
                    .and_then(|e| String::from_utf8(e.path.clone()).ok());
                let Some(path) = path else { continue };
                // Keep the current version.
                match ours.get(&path) {
                    Some(entry) => {
                        merged.insert(path.clone(), *entry);
                    }
                    None => {
                        merged.remove(&path);
                    }
                }
                if !conflicts.contains(&path) {
                    conflicts.push(path);
                }
            }
        }
        ours_tree = repo.find_tree(repo::write_tree(repo, &merged)?).map_err(repo::g)?;
    }
    let target = repo::flatten(Some(&ours_tree))?;
    let mut out = RestoreResult::default();
    write_diff(ctx, &now, &target, &not_recorded, &mut out)?;
    let mut meta = Meta::you(Reason::Undo);
    meta.summary = "Undid an AI run".into();
    meta.undo_of = Some(run_id.to_string());
    meta.note = Some(serde_json::json!({ "undoRun": run_id, "conflicts": conflicts }));
    let commit = snapshot::snapshot(ctx, meta.clone())?;
    // Even when nothing could be reverted, record that the run was undone.
    let commit = match commit {
        Some(c) => Some(c),
        None => {
            let tree = repo::head_commit(repo)?.map(|c| c.tree_id());
            match tree {
                Some(t) => Some(snapshot::commit(ctx, t, &meta)?),
                None => None,
            }
        }
    };
    conflicts.sort();
    Ok(UndoResult {
        ok: conflicts.is_empty() && out.failed.is_empty(),
        commit: commit.map(|c| c.to_string()),
        written: out.written,
        deleted: out.deleted,
        conflicts,
        failed: out.failed,
    })
}

/// For tests and the agents runtime: the path's bytes at a commit.
#[allow(dead_code)]
pub fn file_at(ctx: &Ctx, commit: &str, file: &str) -> AppResult<Option<Vec<u8>>> {
    let id = repo::parse_oid(&ctx.repo, commit)?;
    let then = tree_entries(&ctx.repo, id)?;
    match then.get(file) {
        Some((oid, _)) => Ok(Some(ctx.repo.find_blob(*oid).map_err(repo::g)?.content().to_vec())),
        None => Ok(None),
    }
}
