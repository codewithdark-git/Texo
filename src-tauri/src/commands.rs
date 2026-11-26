use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use crate::archive::{self, ArchivePreview};
use crate::compile::{self, CompileResult, Compiler, Toolchains};
use crate::engine::{self, EngineStatus};
use crate::error::{AppError, AppResult};
use crate::fsops::{self, FileContent};
use crate::project::{self, Engine, FileEntry, ProjectSummary};
use crate::symbols::{self, Symbols};
use crate::synctex::{ForwardResult, InverseResult, SyncTex};
use crate::settings::Settings;
use crate::templates::Template;
use crate::{watcher, AppState};

type Shared<'a> = State<'a, Mutex<AppState>>;

fn lock<'a>(state: &'a Shared<'_>) -> std::sync::MutexGuard<'a, AppState> {
    // A panic in another command shouldn't lock the user out of the app.
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    // Another Texo window may have saved settings since (a project opened
    // there, a compiler change); a cheap file-time check picks that up.
    let s = &mut *guard;
    s.settings_file.refresh(&mut s.settings);
    guard
}

/// Saves one change to the settings. The change is applied to what is on
/// disk right now (another Texo window may have changed it), never to this
/// window's possibly outdated copy. `change` returns false when there was
/// nothing to do.
fn update_settings(s: &mut AppState, change: impl FnOnce(&mut Settings) -> bool) -> AppResult<()> {
    let notice = s.settings.notice.take();
    s.settings = s.settings_file.update(change)?;
    s.settings.notice = s.settings.notice.take().or(notice);
    Ok(())
}

/// Only act on folders Texo already knows about, so a bad path from the UI
/// can never rename or delete an arbitrary folder.
pub(crate) fn known_project(state: &AppState, path: &str) -> AppResult<(PathBuf, bool)> {
    let dir = PathBuf::from(path);
    let in_root = dir
        .parent()
        .is_some_and(|p| project::same_path(p, &state.settings.projects_root));
    let external = state
        .settings
        .external_projects
        .iter()
        .any(|p| project::same_path(p, &dir));
    if !(in_root || external) {
        return Err(AppError::msg("That folder isn't a Texo project."));
    }
    if !dir.is_dir() {
        return Err(AppError::msg(
            "This project's folder can't be found. It may have been moved, renamed or deleted, or it's on a drive that isn't connected.",
        ));
    }
    if project::read_meta(&dir).is_none() {
        return Err(AppError::msg(
            "Texo's project info in this folder is missing or damaged. Open the folder again from the dashboard with “Open folder” to set it up.",
        ));
    }
    Ok((dir, external && !in_root))
}

#[tauri::command]
pub async fn get_settings(state: Shared<'_>) -> AppResult<Settings> {
    let mut s = lock(&state);
    let settings = s.settings.clone();
    // A notice about the settings file is shown once.
    s.settings.notice = None;
    Ok(settings)
}

#[tauri::command]
pub async fn set_projects_root(state: Shared<'_>, path: String) -> AppResult<Settings> {
    let root = PathBuf::from(path);
    std::fs::create_dir_all(&root)?;
    let mut s = lock(&state);
    update_settings(&mut s, |st| {
        st.projects_root = root;
        true
    })?;
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
    let dir = PathBuf::from(&created.path);
    update_settings(&mut s, |st| st.add_trusted(&dir))?;
    Ok(created)
}

/// Opens a folder, or the folder of a `.tex` file, as a project. Folders
/// outside the projects folder are remembered so they show up on the
/// dashboard; opening one again always re-registers it, even if another
/// Texo window dropped it from the list.
#[tauri::command]
pub async fn open_folder(state: Shared<'_>, path: String) -> AppResult<ProjectSummary> {
    let (dir, file) = project::resolve_open_target(Path::new(&path), dirs::home_dir().as_deref())?;
    let root = lock(&state).settings.projects_root.clone();
    if project::same_path(&dir, &root) {
        return Err(AppError::msg(
            "That's your projects folder. Pick one of the project folders inside it.",
        ));
    }
    let in_root = dir.parent().is_some_and(|p| project::same_path(p, &root));
    // Scanning a big folder takes a moment; don't hold up other commands.
    let scan_dir = dir.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || project::open(&scan_dir, file.as_deref(), !in_root))
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
    if !in_root {
        // Checked against the file on disk, not this window's copy.
        update_settings(&mut lock(&state), |st| st.add_external(&dir))?;
    }
    Ok(opened)
}

/// Copies a folder Texo can't write to (read-only, or on a locked drive)
/// into the projects folder as a new project. The UI asks first.
#[tauri::command]
pub async fn copy_folder_to_projects(state: Shared<'_>, path: String) -> AppResult<ProjectSummary> {
    let root = lock(&state).settings.projects_root.clone();
    // The same checks as opening (never a whole drive or the home folder);
    // a .tex file copies its folder and keeps that file as the main one.
    let (src, file) = project::resolve_open_target(Path::new(&path), dirs::home_dir().as_deref())?;
    if project::same_path(&src, &root) || root.starts_with(&src) {
        return Err(AppError::msg("That folder holds your projects folder, so Texo can't copy it into itself."));
    }
    tauri::async_runtime::spawn_blocking(move || project::copy_into(&src, file.as_deref(), &root))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
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
    update_settings(s, |st| st.remove_external(dir))
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
    fsops::write(&dir, &file, &content)?;
    // History snapshot 30 s after the last save (background, never fails the save).
    crate::history::auto::note_save(&dir);
    Ok(())
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
    if let Some(old) = s.watcher.as_ref() {
        crate::history::auto::flush(&old.root);
    }
    s.watcher = None;
    s.watcher = Some(watcher::watch(app, dir)?);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_project(state: Shared<'_>) -> AppResult<()> {
    // The project is closing: snapshot it in the background.
    if let Some(old) = lock(&state).watcher.take() {
        crate::history::auto::flush(&old.root);
    }
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
    update_settings(&mut s, |st| {
        let changed = st.compiler != compiler;
        st.compiler = compiler;
        changed
    })?;
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
    // The main document may have been renamed or deleted outside Texo.
    let (meta, main_note) = project::repair_main_document(&dir)?;
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
        // History: snapshot the user's files on a side thread while TeX runs
        // (best effort; it never fails or delays the compile beyond a few s).
        let snap_dir = dir.clone();
        let snapshot = std::thread::spawn(move || {
            crate::history::snapshot_quietly(&snap_dir, crate::history::Reason::BeforeCompile)
        });
        let mut result = compile::compile(&compile::Job {
            root: &dir,
            main: &main,
            engine: meta.engine,
            compiler,
            tools: &tools,
            cancel: worker_cancel,
            trusted,
            on_output: &emit,
        });
        // Keep the latest good PDF in the project folder; a failed compile
        // never replaces it.
        if result.status == compile::Status::Success {
            if let Some(built) = result.pdf_path.as_deref() {
                match project::save_output_pdf(&dir, &main, Path::new(built)) {
                    Ok(saved) => result.saved_pdf = saved,
                    Err(e) => result.hints.push(format!("The PDF couldn't be saved into the project folder: {e}")),
                }
            }
        }
        let snap = snapshot.join().ok().flatten();
        if result.status == compile::Status::Success {
            crate::history::mark_compiled_ok_quietly(&dir, snap.as_deref());
        }
        result
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?;

    let mut result = result;
    if let Some(note) = main_note {
        result.hints.insert(0, note);
    }
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
        saved_pdf: None,
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
    update_settings(&mut s, |st| st.add_trusted(&dir))
}

#[tauri::command]
pub async fn abort_compile(running: State<'_, compile::Running>, path: String) -> AppResult<()> {
    if let Some(flag) = running.0.lock().unwrap_or_else(|e| e.into_inner()).get(&path) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// The compiled PDF's bytes, for the built-in viewer. Only PDFs in the
/// project's build folder can be read.
#[tauri::command]
pub async fn read_pdf(state: Shared<'_>, path: String, pdf: String) -> AppResult<Response> {
    let dir = known_project(&lock(&state), &path)?.0;
    let pdf = PathBuf::from(pdf);
    let in_build = pdf.parent().is_some_and(|p| project::same_path(p, &compile::build_dir(&dir)));
    let is_pdf = pdf.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !in_build || !is_pdf {
        return Err(AppError::msg("Only the project's compiled PDF can be opened."));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(pdf))
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
    Ok(Response::new(bytes))
}

/// The parsed SyncTeX data of the last build, reused until the file changes.
#[derive(Default)]
pub struct SyncCache(Mutex<Option<(PathBuf, std::time::SystemTime, Arc<SyncTex>)>>);

async fn synctex_for(state: &Shared<'_>, cache: &State<'_, SyncCache>, path: &str) -> AppResult<Option<Arc<SyncTex>>> {
    let dir = known_project(&lock(state), path)?.0;
    let meta = project::ensure_meta(&dir)?;
    let Some(main) = meta.main_document else { return Ok(None) };
    let main_path = dir.join(&main);
    let main_dir = main_path.parent().unwrap_or(&dir).to_path_buf();
    let stem = main_path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let file = compile::build_dir(&dir).join(format!("{stem}.synctex.gz"));
    let Ok(modified) = std::fs::metadata(&file).and_then(|m| m.modified()) else { return Ok(None) };

    if let Some((cached, at, st)) = cache.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if *cached == file && *at == modified {
            return Ok(Some(st.clone()));
        }
    }
    let load_file = file.clone();
    let parsed = tauri::async_runtime::spawn_blocking(move || {
        SyncTex::load(&load_file, |p| compile::project_relative(&dir, &main_dir, p))
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))??;
    let parsed = Arc::new(parsed);
    *cache.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((file, modified, parsed.clone()));
    Ok(Some(parsed))
}

/// Source line → position in the PDF.
#[tauri::command]
pub async fn synctex_forward(
    state: Shared<'_>,
    cache: State<'_, SyncCache>,
    path: String,
    file: String,
    line: u32,
) -> AppResult<Option<ForwardResult>> {
    Ok(synctex_for(&state, &cache, &path).await?.and_then(|st| st.forward(&file, line)))
}

/// Point in the PDF (points from the page's top-left) → source line.
#[tauri::command]
pub async fn synctex_inverse(
    state: Shared<'_>,
    cache: State<'_, SyncCache>,
    path: String,
    page: usize,
    x: f64,
    y: f64,
) -> AppResult<Option<InverseResult>> {
    Ok(synctex_for(&state, &cache, &path).await?.and_then(|st| st.inverse(page, x, y)))
}

/// Saves the dashboard thumbnail (a PNG the viewer rendered from page 1).
#[tauri::command]
pub async fn save_thumbnail(state: Shared<'_>, path: String, png_base64: String) -> AppResult<()> {
    use base64::Engine as _;
    let dir = known_project(&lock(&state), &path)?.0;
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64.trim_start_matches("data:image/png;base64,"))
        .map_err(|_| AppError::msg("That isn't a PNG image."))?;
    project::save_thumbnail(&dir, &png)
}

/// Which LaTeX engine Texo will use, and whether it still needs its first-run setup.
#[tauri::command]
pub async fn engine_status(state: Shared<'_>) -> AppResult<EngineStatus> {
    let (tools_dir, pref) = {
        let s = lock(&state);
        (s.tools_dir.clone(), s.settings.compiler)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let tools = compile::detect(&tools_dir);
        engine::status(&tools_dir, &tools, pref)
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))
}

/// Runs the bundled engine's first-time setup (fills its package cache),
/// streaming progress as `engine-setup` events.
#[tauri::command]
pub async fn prepare_engine(app: AppHandle, state: Shared<'_>) -> AppResult<()> {
    let tools_dir = lock(&state).tools_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tools = compile::detect(&tools_dir);
        let emit = |lines: Vec<String>| {
            let _ = app.emit(engine::EVENT, lines);
        };
        engine::prepare(&tools_dir, &tools, &emit)
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}

/// Reads an archive's contents for the import dialog without extracting it.
#[tauri::command]
pub async fn inspect_archive(path: String) -> AppResult<ArchivePreview> {
    tauri::async_runtime::spawn_blocking(move || archive::inspect(Path::new(&path)))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

fn progress_emitter(app: AppHandle) -> impl Fn(u64, u64) {
    move |done, total| {
        let _ = app.emit(archive::PROGRESS_EVENT, archive::Progress { done, total });
    }
}

/// Imports a `.zip` or `.tar.gz` as a new project in the projects folder.
/// Imported projects are not trusted: their latexmk config stays off until
/// the user allows it.
#[tauri::command]
pub async fn import_archive(
    app: AppHandle,
    state: Shared<'_>,
    path: String,
    name: String,
    main: Option<String>,
) -> AppResult<ProjectSummary> {
    let root = lock(&state).settings.projects_root.clone();
    let progress = progress_emitter(app);
    tauri::async_runtime::spawn_blocking(move || {
        archive::import(&root, Path::new(&path), &name, main.as_deref(), &progress)
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}

/// Saves the project's sources as a `.zip` at `dest`.
#[tauri::command]
pub async fn export_project(
    app: AppHandle,
    state: Shared<'_>,
    path: String,
    dest: String,
    include_pdf: bool,
) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    let progress = progress_emitter(app);
    tauri::async_runtime::spawn_blocking(move || archive::export(&dir, Path::new(&dest), include_pdf, &progress))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

/// Copies the project's latest PDF to `dest`.
#[tauri::command]
pub async fn save_pdf_as(state: Shared<'_>, path: String, dest: String) -> AppResult<()> {
    let dir = known_project(&lock(&state), &path)?.0;
    tauri::async_runtime::spawn_blocking(move || archive::save_pdf_as(&dir, Path::new(&dest)))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}

/// Extensions `read_asset` serves: figures the editor previews.
const ASSET_EXTENSIONS: &[&str] = &["pdf", "png", "jpg", "jpeg", "svg", "eps"];
const MAX_ASSET_BYTES: u64 = 15 * 1024 * 1024;

/// A figure's bytes, checked like every other project path.
fn asset_bytes(dir: &Path, file: &str) -> AppResult<Vec<u8>> {
    let path = fsops::resolve(dir, file)?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !ASSET_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::msg("Only PDF, PNG, JPEG, SVG and EPS figures can be previewed."));
    }
    if std::fs::metadata(&path)?.len() > MAX_ASSET_BYTES {
        return Err(AppError::msg("That figure is larger than 15 MiB, so it isn't previewed."));
    }
    Ok(std::fs::read(path)?)
}

/// Raw bytes of a figure in the project (for PDF figure thumbnails).
#[tauri::command]
pub async fn read_asset(state: Shared<'_>, path: String, file: String) -> AppResult<Response> {
    let dir = known_project(&lock(&state), &path)?.0;
    let bytes = tauri::async_runtime::spawn_blocking(move || asset_bytes(&dir, &file))
        .await
        .map_err(|e| AppError::msg(e.to_string()))??;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_asset_serves_figures_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join(".texo")).unwrap();
        std::fs::create_dir_all(root.join("figures")).unwrap();
        std::fs::write(root.join("figures/plot.PDF"), b"%PDF-1.5").unwrap();
        std::fs::write(root.join(".texo/secret.pdf"), b"%PDF").unwrap();
        std::fs::write(root.join("notes.txt"), b"text").unwrap();
        std::fs::write(dir.path().join("outside.pdf"), b"%PDF").unwrap();
        std::fs::write(root.join("huge.png"), vec![0u8; (MAX_ASSET_BYTES + 1) as usize]).unwrap();

        assert_eq!(asset_bytes(&root, "figures/plot.PDF").unwrap(), b"%PDF-1.5");
        assert!(asset_bytes(&root, "../outside.pdf").is_err());
        assert!(asset_bytes(&root, "figures/../../outside.pdf").is_err());
        assert!(asset_bytes(&root, ".texo/secret.pdf").is_err());
        assert!(asset_bytes(&root, "notes.txt").is_err());
        assert!(asset_bytes(&root, "huge.png").is_err());
        assert!(asset_bytes(&root, "missing.pdf").is_err());
    }
}
