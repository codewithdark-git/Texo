use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::fsops::{self, FileContent};
use crate::project::{self, FileEntry, ProjectSummary};
use crate::symbols::{self, Symbols};
use crate::settings::Settings;
use crate::templates::Template;
use crate::{watcher, AppState};

type Shared<'a> = State<'a, Mutex<AppState>>;

fn lock<'a>(state: &'a Shared<'_>) -> std::sync::MutexGuard<'a, AppState> {
    // A panic in another command shouldn't lock the user out of the app.
    state.lock().unwrap_or_else(|e| e.into_inner())
}

/// Only act on folders Texo already knows about, so a bad path from the UI
/// can never rename or delete an arbitrary folder.
fn known_project(state: &AppState, path: &str) -> AppResult<(PathBuf, bool)> {
    let dir = PathBuf::from(path);
    let in_root = dir
        .parent()
        .is_some_and(|p| project::same_path(p, &state.settings.projects_root));
    let external = state
        .settings
        .external_projects
        .iter()
        .any(|p| project::same_path(p, &dir));
    if !(in_root || external) || project::read_meta(&dir).is_none() {
        return Err(AppError::msg("That folder isn't a Texo project."));
    }
    Ok((dir, external && !in_root))
}

#[tauri::command]
pub async fn get_settings(state: Shared<'_>) -> AppResult<Settings> {
    Ok(lock(&state).settings.clone())
}

#[tauri::command]
pub async fn set_projects_root(state: Shared<'_>, path: String) -> AppResult<Settings> {
    let root = PathBuf::from(path);
    std::fs::create_dir_all(&root)?;
    let mut s = lock(&state);
    s.settings.projects_root = root;
    s.settings.save(&s.settings_path)?;
    Ok(s.settings.clone())
}

#[tauri::command]
pub async fn list_projects(state: Shared<'_>) -> AppResult<Vec<ProjectSummary>> {
    let s = lock(&state);
    Ok(project::list(&s.settings.projects_root, &s.settings.external_projects))
}

#[tauri::command]
pub async fn create_project(
    state: Shared<'_>,
    name: String,
    template: Template,
) -> AppResult<ProjectSummary> {
    let s = lock(&state);
    std::fs::create_dir_all(&s.settings.projects_root)?;
    project::create(&s.settings.projects_root, &name, template)
}

/// Opens any folder as a project. Folders outside the projects folder are
/// remembered so they show up on the dashboard.
#[tauri::command]
pub async fn open_folder(state: Shared<'_>, path: String) -> AppResult<ProjectSummary> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err(AppError::msg("That folder doesn't exist."));
    }
    let mut s = lock(&state);
    if project::same_path(&dir, &s.settings.projects_root) {
        return Err(AppError::msg(
            "That's your projects folder. Pick one of the project folders inside it.",
        ));
    }
    project::ensure_meta(&dir)?;
    let in_root = dir
        .parent()
        .is_some_and(|p| project::same_path(p, &s.settings.projects_root));
    let known = s
        .settings
        .external_projects
        .iter()
        .any(|p| project::same_path(p, &dir));
    if !in_root && !known {
        s.settings.external_projects.push(dir.clone());
        s.settings.save(&s.settings_path)?;
    }
    project::summarize(&dir, !in_root).ok_or_else(|| AppError::msg("Couldn't read that project."))
}

#[tauri::command]
pub async fn rename_project(
    state: Shared<'_>,
    path: String,
    name: String,
) -> AppResult<ProjectSummary> {
    let s = lock(&state);
    let (dir, external) = known_project(&s, &path)?;
    // External folders keep their folder name; only the display name changes.
    let new_dir = project::rename(&dir, &name, !external)?;
    project::summarize(&new_dir, external).ok_or_else(|| AppError::msg("Couldn't read that project."))
}

#[tauri::command]
pub async fn duplicate_project(state: Shared<'_>, path: String) -> AppResult<ProjectSummary> {
    let s = lock(&state);
    let (dir, _) = known_project(&s, &path)?;
    project::duplicate(&dir, &s.settings.projects_root)
}

/// Moves the project folder to the Recycle Bin.
#[tauri::command]
pub async fn delete_project(state: Shared<'_>, path: String) -> AppResult<()> {
    let mut s = lock(&state);
    let (dir, external) = known_project(&s, &path)?;
    project::delete(&dir)?;
    if external {
        forget(&mut s, &dir)?;
    }
    Ok(())
}

/// Removes an external project from the dashboard without touching its files.
#[tauri::command]
pub async fn forget_project(state: Shared<'_>, path: String) -> AppResult<()> {
    let mut s = lock(&state);
    forget(&mut s, Path::new(&path))
}

fn forget(s: &mut AppState, dir: &Path) -> AppResult<()> {
    s.settings
        .external_projects
        .retain(|p| !project::same_path(p, dir));
    s.settings.save(&s.settings_path)
}

#[tauri::command]
pub async fn list_project_files(state: Shared<'_>, path: String) -> AppResult<Vec<FileEntry>> {
    let s = lock(&state);
    let (dir, _) = known_project(&s, &path)?;
    Ok(project::list_files(&dir))
}

#[tauri::command]
pub async fn set_main_document(
    state: Shared<'_>,
    path: String,
    file: String,
) -> AppResult<ProjectSummary> {
    let s = lock(&state);
    let (dir, external) = known_project(&s, &path)?;
    fsops::resolve(&dir, &file)?;
    project::set_main_document(&dir, &file)?;
    project::summarize(&dir, external).ok_or_else(|| AppError::msg("Couldn't read that project."))
}

#[tauri::command]
pub async fn read_file(state: Shared<'_>, path: String, file: String) -> AppResult<FileContent> {
    let dir = known_project(&lock(&state), &path)?.0;
    fsops::read(&dir, &file)
}

#[tauri::command]
pub async fn write_file(
    state: Shared<'_>,
    path: String,
    file: String,
    content: String,
) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    fsops::write(&dir, &file, &content)
}

#[tauri::command]
pub async fn create_file(state: Shared<'_>, path: String, file: String) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    fsops::create_file(&dir, &file)
}

#[tauri::command]
pub async fn create_folder(state: Shared<'_>, path: String, folder: String) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    fsops::create_folder(&dir, &folder)
}

#[tauri::command]
pub async fn rename_path(
    state: Shared<'_>,
    path: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    fsops::rename(&dir, &from, &to)
}

/// Moves a file or folder inside the project to the Recycle Bin.
#[tauri::command]
pub async fn delete_path(state: Shared<'_>, path: String, file: String) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    fsops::delete(&dir, &file)
}

/// Copies files from elsewhere on disk into the project.
#[tauri::command]
pub async fn import_files(
    state: Shared<'_>,
    path: String,
    dest: String,
    sources: Vec<String>,
) -> AppResult<Vec<String>> {
    let dir = known_project(&lock(&state), &path)?.0;
    let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    fsops::import(&dir, &dest, &sources)
}

#[tauri::command]
pub async fn project_symbols(state: Shared<'_>, path: String) -> AppResult<Symbols> {
    let dir = known_project(&lock(&state), &path)?.0;
    Ok(symbols::scan(&dir))
}

/// Starts watching the project folder, replacing any previous watch.
#[tauri::command]
pub async fn watch_project(app: AppHandle, state: Shared<'_>, path: String) -> AppResult<()> {
    let mut s = lock(&state);
    let dir = known_project(&s, &path)?.0;
    if s.watcher.as_ref().is_some_and(|w| project::same_path(&w.root, &dir)) {
        return Ok(());
    }
    s.watcher = None;
    s.watcher = Some(watcher::watch(app, dir)?);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_project(state: Shared<'_>) -> AppResult<()> {
    lock(&state).watcher = None;
    Ok(())
}
