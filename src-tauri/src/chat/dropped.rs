//! Files dropped from the file manager onto the chat composer.
//!
//! Tauri delivers drops as file paths, not file contents, so the composer
//! asks Rust for the bytes. Only paths that were really dropped on the
//! window in the last few minutes can be read: the webview can't use this to
//! read any other file on the computer.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Response;

use crate::ai::error::{AiError, AiResult};

/// How long a dropped path stays readable.
const KEEP: Duration = Duration::from_secs(120);
/// Paths kept at most (the newest win).
const MAX_KEPT: usize = 64;
/// Larger files are refused before reading (pictures are downscaled and
/// PDFs text-extracted in the webview, so this only bounds the transfer).
pub const MAX_DROPPED_BYTES: u64 = 40 * 1024 * 1024;

static DROPPED: LazyLock<Mutex<Vec<(PathBuf, Instant)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn kept() -> std::sync::MutexGuard<'static, Vec<(PathBuf, Instant)>> {
    DROPPED.lock().unwrap_or_else(|e| e.into_inner())
}

/// Records the paths of a drop (called from the window's drag-drop event).
pub fn remember(paths: &[PathBuf]) {
    remember_at(paths, Instant::now());
}

fn remember_at(paths: &[PathBuf], now: Instant) {
    let mut list = kept();
    list.retain(|(_, at)| now.saturating_duration_since(*at) < KEEP);
    for p in paths {
        list.retain(|(q, _)| q != p);
        list.push((p.clone(), now));
    }
    let extra = list.len().saturating_sub(MAX_KEPT);
    list.drain(..extra);
}

fn was_dropped(path: &Path, now: Instant) -> bool {
    kept().iter().any(|(p, at)| p == path && now.saturating_duration_since(*at) < KEEP)
}

fn read_dropped(path: &Path, now: Instant) -> AiResult<Vec<u8>> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !was_dropped(path, now) {
        return Err(AiError::invalid("Drop the file on the chat again, or use the attach button."));
    }
    let meta = std::fs::metadata(path)
        .map_err(|_| AiError::invalid(format!("Texo couldn't open \u{201c}{name}\u{201d}.")))?;
    if meta.is_dir() {
        return Err(AiError::invalid(format!("\u{201c}{name}\u{201d} is a folder. Attach files one by one.")));
    }
    if meta.len() > MAX_DROPPED_BYTES {
        return Err(AiError::invalid(format!("\u{201c}{name}\u{201d} is too large to attach (over 40 MB).")));
    }
    std::fs::read(path).map_err(|_| AiError::invalid(format!("Texo couldn't read \u{201c}{name}\u{201d}.")))
}

/// The bytes of a file just dropped on the window (for chat attachments).
#[tauri::command]
pub async fn ai_chat_read_dropped(path: String) -> AiResult<Response> {
    let path = PathBuf::from(path);
    let bytes = tokio::task::spawn_blocking(move || read_dropped(&path, Instant::now()))
        .await
        .map_err(|_| AiError::invalid("Texo couldn't read that file."))??;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list is global; these tests change it one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn only_recently_dropped_files_are_read() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("figure.png");
        std::fs::write(&file, b"png").unwrap();
        let other = dir.path().join("secret.txt");
        std::fs::write(&other, b"secret").unwrap();
        let now = Instant::now();

        assert!(read_dropped(&file, now).is_err(), "not dropped yet");
        remember_at(&[file.clone(), dir.path().to_path_buf()], now);
        assert_eq!(read_dropped(&file, now).unwrap(), b"png");
        assert!(read_dropped(&other, now).is_err(), "never dropped");
        assert!(read_dropped(dir.path(), now).unwrap_err().message.contains("folder"));
        assert!(read_dropped(&file, now + KEEP + Duration::from_secs(1)).is_err(), "expired");
    }

    #[test]
    fn keeps_a_bounded_list() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let paths: Vec<PathBuf> = (0..MAX_KEPT + 10).map(|i| PathBuf::from(format!("/nowhere/bounded-{i}"))).collect();
        remember_at(&paths, now);
        assert!(!was_dropped(&paths[0], now), "the oldest are dropped");
        assert!(was_dropped(&paths[MAX_KEPT + 9], now));
        assert!(kept().len() <= MAX_KEPT);
    }
}
