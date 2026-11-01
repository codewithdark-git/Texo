//! Watches the open project folder and tells the UI which files changed, so
//! edits made in other apps show up in the editor.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::project::META_DIR;

pub const EVENT: &str = "project-fs-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed {
    project: String,
    paths: Vec<String>,
}

pub struct ProjectWatcher {
    pub root: PathBuf,
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// Relative, `/`-separated path for a changed file, or `None` for changes the
/// UI doesn't care about (Texo's metadata and its own temp files).
fn relevant(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let first = rel.components().next()?.as_os_str().to_string_lossy().to_lowercase();
    if first == META_DIR {
        return None;
    }
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.ends_with(".texo-tmp") {
        return None;
    }
    Some(rel)
}

pub fn watch(app: AppHandle, root: PathBuf) -> AppResult<ProjectWatcher> {
    let project = root.to_string_lossy().into_owned();
    let cb_root = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<String> = events
            .iter()
            .filter_map(|e| relevant(&cb_root, &e.path))
            .collect();
        paths.sort();
        paths.dedup();
        if !paths.is_empty() {
            let _ = app.emit(
                EVENT,
                Changed {
                    project: project.clone(),
                    paths,
                },
            );
        }
    })
    .map_err(|e| AppError::msg(format!("Couldn't watch the project folder: {e}")))?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::msg(format!("Couldn't watch the project folder: {e}")))?;
    Ok(ProjectWatcher {
        root,
        _debouncer: debouncer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_metadata_and_temp_files() {
        let root = Path::new("C:\\p");
        assert_eq!(relevant(root, Path::new("C:\\p\\sec\\a.tex")).as_deref(), Some("sec/a.tex"));
        assert_eq!(relevant(root, Path::new("C:\\p\\.texo\\project.json")), None);
        assert_eq!(relevant(root, Path::new("C:\\p\\.main.tex.texo-tmp")), None);
        assert_eq!(relevant(root, Path::new("C:\\other\\a.tex")), None);
    }
}
