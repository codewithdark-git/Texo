//! The "after 30 s idle" snapshot of the user's saves, done in Rust right
//! where `write_file` saves, so it works no matter what the UI does: one
//! sleeping thread per project with pending saves, which snapshots once no
//! save came in for [`IDLE`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::snapshot::Reason;

pub const IDLE: Duration = Duration::from_secs(30);

fn pending() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// Call after every successful save. Never blocks.
pub fn note_save(dir: &Path) {
    note_save_with(dir, IDLE);
}

pub fn note_save_with(dir: &Path, idle: Duration) {
    let dir = dir.to_path_buf();
    {
        let mut map = pending().lock().unwrap_or_else(|e| e.into_inner());
        let had = map.insert(dir.clone(), Instant::now()).is_some();
        if had {
            return;
        }
    }
    let key = dir.clone();
    let spawned = std::thread::Builder::new().name("texo-history-idle".into()).spawn(move || loop {
        let last = {
            let map = pending().lock().unwrap_or_else(|e| e.into_inner());
            match map.get(&dir) {
                Some(t) => *t,
                // Flushed or cancelled meanwhile.
                None => return,
            }
        };
        let since = last.elapsed();
        if since < idle {
            std::thread::sleep(idle - since);
            continue;
        }
        {
            let mut map = pending().lock().unwrap_or_else(|e| e.into_inner());
            if map.get(&dir) != Some(&last) {
                continue;
            }
            map.remove(&dir);
        }
        super::snapshot_quietly(&dir, Reason::Idle);
        return;
    });
    if let Err(e) = spawned {
        eprintln!("[history] can't start the idle snapshot: {e}");
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    }
}

/// True while a save is waiting for its idle snapshot.
#[allow(dead_code)]
pub fn is_pending(dir: &Path) -> bool {
    pending().lock().unwrap_or_else(|e| e.into_inner()).contains_key(dir)
}

/// Drops a pending idle snapshot without taking it.
pub fn cancel(dir: &Path) {
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(dir);
}

/// The project is closing: snapshot now on a background thread (pending
/// idle snapshot included). Never blocks the caller.
pub fn flush(dir: &Path) {
    cancel(dir);
    let dir = dir.to_path_buf();
    let _ = std::thread::Builder::new().name("texo-history-close".into()).spawn(move || {
        super::snapshot_quietly(&dir, Reason::Close);
    });
}
