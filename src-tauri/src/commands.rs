use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::compile::{self, CompileResult, Compiler, Toolchains};
use crate::error::{AppError, AppResult};
use crate::fsops::{self, FileContent};
use crate::project::{self, Engine, FileEntry, ProjectSummary};
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
    let mut s = lock(&state);
    std::fs::create_dir_all(&s.settings.projects_root)?;
    let created = project::create(&s.settings.projects_root, &name, template)?;
    s.settings.trusted_projects.push(PathBuf::from(&created.path));
    s.settings.save(&s.settings_path)?;
    Ok(created)
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

#[tauri::command]
pub async fn detect_toolchains(state: Shared<'_>) -> AppResult<Toolchains> {
    let tools_dir = lock(&state).tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || compile::detect(&tools_dir))
        .await
        .map_err(|e| AppError::msg(e.to_string()))
}

#[tauri::command]
pub async fn set_compiler(state: Shared<'_>, compiler: Compiler) -> AppResult<Settings> {
    let mut s = lock(&state);
    s.settings.compiler = compiler;
    s.settings.save(&s.settings_path)?;
    Ok(s.settings.clone())
}

#[tauri::command]
pub async fn set_engine(state: Shared<'_>, path: String, engine: Engine) -> AppResult<ProjectSummary> {
    let s = lock(&state);
    let (dir, external) = known_project(&s, &path)?;
    project::set_engine(&dir, engine)?;
    project::summarize(&dir, external).ok_or_else(|| AppError::msg("Couldn't read that project."))
}

/// Compiles the project's main document. Console output streams to the UI as
/// `compile-output` events while it runs.
#[tauri::command]
pub async fn compile_project(
    app: AppHandle,
    state: Shared<'_>,
    running: State<'_, compile::Running>,
    path: String,
) -> AppResult<CompileResult> {
    let (dir, pref, tools_dir, trusted) = {
        let s = lock(&state);
        let dir = known_project(&s, &path)?.0;
        let trusted = is_trusted(&s, &dir);
        (dir, s.settings.compiler, s.tools_dir.clone(), trusted)
    };
    let meta = project::ensure_meta(&dir)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = running.0.lock().unwrap_or_else(|e| e.into_inner());
        // A newer compile replaces an older one for the same project.
        if let Some(old) = map.insert(path.clone(), cancel.clone()) {
            old.store(true, Ordering::SeqCst);
        }
    }

    let project = path.clone();
    let worker_cancel = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let tools = compile::detect(&tools_dir);
        let Some(main) = meta.main_document.clone() else {
            return no_run(compile::Status::NoMainDocument, meta.engine);
        };
        let Some(compiler) = tools.choose(pref, meta.engine) else {
            return no_run(compile::Status::NoEngine, meta.engine);
        };
        let emit = |lines: Vec<String>| {
            let _ = app.emit(
                compile::OUTPUT_EVENT,
                compile::OutputChunk { project: project.clone(), lines },
            );
        };
        compile::compile(&compile::Job {
            root: &dir,
            main: &main,
            engine: meta.engine,
            compiler,
            tools: &tools,
            cancel: worker_cancel,
            trusted,
            on_output: &emit,
        })
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?;

    let mut map = running.0.lock().unwrap_or_else(|e| e.into_inner());
    if map.get(&path).is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
        map.remove(&path);
    }
    Ok(result)
}

fn no_run(status: compile::Status, engine: Engine) -> CompileResult {
    CompileResult {
        status,
        compiler: None,
        engine,
        pdf_path: None,
        duration_ms: 0,
        issues: Vec::new(),
        hints: Vec::new(),
        log: String::new(),
        output: String::new(),
        rc_ignored: false,
    }
}

fn is_trusted(s: &AppState, dir: &Path) -> bool {
    s.settings.trusted_projects.iter().any(|p| project::same_path(p, dir))
}

/// Lets a project run its own latexmk config from now on.
#[tauri::command]
pub async fn trust_project(state: Shared<'_>, path: String) -> AppResult<()> {
    let mut s = lock(&state);
    let dir = known_project(&s, &path)?.0;
    if !is_trusted(&s, &dir) {
        s.settings.trusted_projects.push(dir);
        s.settings.save(&s.settings_path)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn abort_compile(running: State<'_, compile::Running>, path: String) -> AppResult<()> {
    if let Some(flag) = running.0.lock().unwrap_or_else(|e| e.into_inner()).get(&path) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}
