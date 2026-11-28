//! Tauri commands for the paper library that use only the local database
//! (`library_*`). Network commands live in `online.rs`. Every database call
//! runs off the async runtime, and no connection is held across an await.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::State;

use super::bibsync::{self, BibSyncReport};
use super::store::{self, LibraryFilters, LibraryPaper, SearchPage, Sort};
use super::{cache, now_ms, status_of, LibError, LibResult, Library, LibraryState, LibraryStatus};
use crate::error::{AppError, AppResult};
use crate::AppState;

type Lib<'a> = State<'a, LibraryState>;
type Shared<'a> = State<'a, Mutex<AppState>>;

fn app_err(e: LibError) -> AppError {
    AppError::msg(e.plain())
}

fn internal_err() -> AppError {
    AppError::msg("Something went wrong inside Texo. Try again.")
}

/// Runs `f` with the library on a blocking thread.
async fn blocking<T: Send + 'static>(lib: &Lib<'_>, f: impl FnOnce(&Library) -> LibResult<T> + Send + 'static) -> AppResult<T> {
    let lib: Arc<Library> = lib.get().map_err(app_err)?;
    tauri::async_runtime::spawn_blocking(move || f(&lib))
        .await
        .map_err(|_| internal_err())?
        .map_err(app_err)
}

fn project_dir(state: &Shared<'_>, project: &str) -> AppResult<PathBuf> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(crate::commands::known_project(&s, project)?.0)
}

#[tauri::command]
pub async fn library_status(lib: Lib<'_>) -> AppResult<LibraryStatus> {
    let (l, warning) = (lib.0.clone(), lib.1.clone());
    tauri::async_runtime::spawn_blocking(move || status_of(l.as_deref(), warning)).await.map_err(|_| internal_err())
}

#[tauri::command]
pub async fn library_search(
    lib: Lib<'_>,
    query: String,
    filters: Option<LibraryFilters>,
    sort: Option<Sort>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<SearchPage> {
    let filters = filters.unwrap_or_default();
    blocking(&lib, move |l| {
        l.read(|c| store::search_local(c, &query, &filters, sort.unwrap_or_default(), limit.unwrap_or(25), offset.unwrap_or(0), now_ms()))
    })
    .await
}

/// `id`: a uid, DOI, arXiv id or OpenAlex id.
#[tauri::command]
pub async fn library_get(lib: Lib<'_>, id: String, project: Option<String>) -> AppResult<LibraryPaper> {
    blocking(&lib, move |l| {
        l.read(|c| store::get(c, &id, project.as_deref()))?
            .ok_or_else(|| LibError::msg("That paper isn't in your library any more."))
    })
    .await
}

#[tauri::command]
pub async fn library_save(lib: Lib<'_>, uid: String) -> AppResult<()> {
    blocking(&lib, move |l| l.write(|c| store::save(c, &uid, now_ms()))).await
}

#[tauri::command]
pub async fn library_unsave(lib: Lib<'_>, uid: String) -> AppResult<()> {
    blocking(&lib, move |l| l.write(|c| store::unsave(c, &uid, now_ms()))).await
}

#[tauri::command]
pub async fn library_remove(lib: Lib<'_>, uid: String) -> AppResult<()> {
    blocking(&lib, move |l| l.write(|c| store::remove(c, &uid))).await
}

/// Replaces the paper's tags; returns them as stored.
#[tauri::command]
pub async fn library_tag(lib: Lib<'_>, uid: String, tags: Vec<String>) -> AppResult<Vec<String>> {
    blocking(&lib, move |l| l.write(|c| store::set_tags(c, &uid, &tags, now_ms()))).await
}

/// `note`: null or blank clears it.
#[tauri::command]
pub async fn library_note(lib: Lib<'_>, uid: String, note: Option<String>) -> AppResult<()> {
    blocking(&lib, move |l| l.write(|c| store::set_note(c, &uid, note.as_deref(), now_ms()))).await
}

#[tauri::command]
pub async fn library_project_refs(state: Shared<'_>, lib: Lib<'_>, project: String) -> AppResult<Vec<LibraryPaper>> {
    project_dir(&state, &project)?;
    blocking(&lib, move |l| l.read(|c| store::project_refs(c, &project))).await
}

/// Re-reads the project's `.bib` files and links their entries. The files
/// are found and parsed before the writer is taken.
#[tauri::command]
pub async fn library_sync_bib(state: Shared<'_>, lib: Lib<'_>, project: String) -> AppResult<BibSyncReport> {
    let dir = project_dir(&state, &project)?;
    blocking(&lib, move |l| {
        let scan = bibsync::scan(&dir);
        l.write(|c| bibsync::apply(c, &scan, &project, now_ms()))
    })
    .await
}

#[tauri::command]
pub async fn library_clear_cache(lib: Lib<'_>) -> AppResult<LibraryStatus> {
    let warning = lib.1.clone();
    blocking(&lib, move |l| {
        l.write(|c| cache::clear(c))?;
        Ok(status_of(Some(l), warning))
    })
    .await
}

/// Copies the library into its `backups` folder; returns the file name.
#[tauri::command]
pub async fn library_backup(lib: Lib<'_>) -> AppResult<String> {
    blocking(&lib, |l| {
        let path = l.backup()?;
        Ok(path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
    })
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Bibtex,
    Json,
}

impl ExportFormat {
    fn extensions(self) -> &'static [&'static str] {
        match self {
            ExportFormat::Bibtex => &["bib"],
            ExportFormat::Json => &["json"],
        }
    }
}

fn check_dest(dest: &Path, format: ExportFormat) -> LibResult<()> {
    let ext = dest.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !format.extensions().contains(&ext.as_str()) {
        return Err(LibError::msg(match format {
            ExportFormat::Bibtex => "Choose a file name that ends in .bib.",
            ExportFormat::Json => "Choose a file name that ends in .json.",
        }));
    }
    if !dest.is_absolute() {
        return Err(LibError::msg("Choose where to save the file."));
    }
    if dest.is_dir() {
        return Err(LibError::msg("That is a folder. Choose a file name."));
    }
    match dest.parent() {
        Some(p) if p.is_dir() => Ok(()),
        _ => Err(LibError::msg("That folder doesn't exist any more. Choose another place.")),
    }
}

/// Writes through a temporary file next to `dest`, then renames it.
fn save_text(dest: &Path, text: &str) -> LibResult<()> {
    let mut tmp = dest.to_path_buf();
    tmp.set_extension(format!("{}.texo-tmp", dest.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()));
    let failed = |e: std::io::Error| LibError::msg(format!("The file couldn't be saved ({e})."));
    fs::write(&tmp, text).map_err(failed)?;
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(failed(e));
    }
    Ok(())
}

/// The export text for `papers`.
pub fn export_text(papers: &[LibraryPaper], format: ExportFormat) -> LibResult<String> {
    Ok(match format {
        ExportFormat::Bibtex => bibsync::to_bibtex(papers),
        ExportFormat::Json => {
            let clean: Vec<LibraryPaper> = papers.iter().cloned().map(|mut p| {
                p.snippet = None;
                p
            }).collect();
            serde_json::to_string_pretty(&clean)?
        }
    })
}

/// Asks where to save with the system save dialog (opened here, so the
/// webview never chooses the path), then saves `uids`, or every saved paper
/// when it is missing. Resolves to how many, or `None` when the user cancels.
#[tauri::command]
pub async fn library_export(
    app: tauri::AppHandle,
    lib: Lib<'_>,
    format: ExportFormat,
    uids: Option<Vec<String>>,
) -> AppResult<Option<usize>> {
    use tauri_plugin_dialog::DialogExt;
    let (name, ext) = match format {
        ExportFormat::Bibtex => ("BibTeX", "bib"),
        ExportFormat::Json => ("JSON", "json"),
    };
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(name, &[ext])
            .set_file_name(format!("library.{ext}"))
            .blocking_save_file()
    })
    .await
    .map_err(|_| internal_err())?;
    let Some(dest) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    blocking(&lib, move |l| {
        check_dest(&dest, format)?;
        let papers = l.read(|c| match &uids {
            Some(u) => store::many(c, u),
            None => store::saved(c),
        })?;
        save_text(&dest, &export_text(&papers, format)?)?;
        Ok(Some(papers.len()))
    })
    .await
}
