//! Tauri commands for the History panel (`history_*`). Every command checks
//! that `project` is a folder Texo knows, then does the git work off the UI
//! thread.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

use super::query::{DiffText, FileChange, LogEntry, LogFilter};
use super::restore::{RestoreResult, UndoResult};
use super::{repo, HistoryStatus};
use crate::error::{AppError, AppResult};
use crate::AppState;

type Shared<'a> = State<'a, Mutex<AppState>>;

fn project_dir(state: &Shared<'_>, project: &str) -> AppResult<PathBuf> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(crate::commands::known_project(&s, project)?.0)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::msg(e.to_string()))?
}

fn with<T: Send + 'static>(dir: PathBuf, f: impl FnOnce(&repo::Ctx) -> AppResult<T> + Send + 'static) -> impl FnOnce() -> AppResult<T> + Send + 'static {
    move || repo::with_repo(Path::new(&dir), repo::WAIT, f)
}

#[tauri::command]
pub async fn history_status(state: Shared<'_>, project: String) -> AppResult<HistoryStatus> {
    let dir = project_dir(&state, &project)?;
    blocking(move || Ok(super::status(&dir))).await
}

#[tauri::command]
pub async fn history_log(state: Shared<'_>, project: String, filter: Option<LogFilter>) -> AppResult<Vec<LogEntry>> {
    let dir = project_dir(&state, &project)?;
    let filter = filter.unwrap_or_default();
    blocking(with(dir, move |ctx| super::query::log(ctx, &filter))).await
}

#[tauri::command]
pub async fn history_changes(state: Shared<'_>, project: String, commit: String) -> AppResult<Vec<FileChange>> {
    let dir = project_dir(&state, &project)?;
    blocking(with(dir, move |ctx| super::query::changes(ctx, &commit))).await
}

/// `from`: a commit, or null for the parent of `to` (for `to: "disk"`: HEAD).
/// `to`: a commit or `"disk"`.
#[tauri::command]
pub async fn history_diff(
    state: Shared<'_>,
    project: String,
    from: Option<String>,
    to: String,
    file: String,
) -> AppResult<DiffText> {
    let dir = project_dir(&state, &project)?;
    blocking(with(dir, move |ctx| super::query::diff(ctx, from.as_deref(), &to, &file))).await
}

#[tauri::command]
pub async fn history_restore_file(
    state: Shared<'_>,
    project: String,
    commit: String,
    file: String,
) -> AppResult<RestoreResult> {
    let dir = project_dir(&state, &project)?;
    super::ensure_enabled(&dir)?;
    blocking(with(dir, move |ctx| super::restore::restore_file(ctx, &commit, &file))).await
}

#[tauri::command]
pub async fn history_restore_all(state: Shared<'_>, project: String, commit: String) -> AppResult<RestoreResult> {
    let dir = project_dir(&state, &project)?;
    super::ensure_enabled(&dir)?;
    blocking(with(dir, move |ctx| super::restore::restore_all(ctx, &commit))).await
}

#[tauri::command]
pub async fn history_undo_run(state: Shared<'_>, project: String, run_id: String) -> AppResult<UndoResult> {
    let dir = project_dir(&state, &project)?;
    super::ensure_enabled(&dir)?;
    blocking(with(dir, move |ctx| super::restore::undo_run(ctx, &run_id))).await
}

#[tauri::command]
pub async fn history_label(state: Shared<'_>, project: String, commit: String, name: String) -> AppResult<()> {
    let dir = project_dir(&state, &project)?;
    blocking(with(dir, move |ctx| super::query::add_label(ctx, &commit, &name))).await
}

/// Saves a version now. Returns the new commit, or null when nothing changed.
#[tauri::command]
pub async fn history_snapshot(state: Shared<'_>, project: String, reason: Option<String>) -> AppResult<Option<String>> {
    let dir = project_dir(&state, &project)?;
    blocking(move || super::snapshot_now(&dir, reason.as_deref().unwrap_or(""))).await
}

#[tauri::command]
pub async fn history_set_enabled(state: Shared<'_>, project: String, enabled: bool) -> AppResult<HistoryStatus> {
    let dir = project_dir(&state, &project)?;
    blocking(move || super::set_enabled(&dir, enabled)).await
}

/// The answer to "Add .texo/ to this git repo's exclude list?".
#[tauri::command]
pub async fn history_git_exclude(state: Shared<'_>, project: String, add: bool) -> AppResult<HistoryStatus> {
    let dir = project_dir(&state, &project)?;
    blocking(move || super::answer_git_exclude(&dir, add)).await
}
