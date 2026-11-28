//! The paper library (v1.3): one app-wide SQLite file with every paper the
//! user or an agent found, saved papers, tags and notes, links to the
//! projects that cite them, and a persistent cache for the paper services.
//!
//! Everything lives in `app_data_dir()/library/`: `library.sqlite`, the
//! `.open` marker of a running session, `backups/` and any damaged file set
//! aside. Startup never fails because of the library; when it can't be
//! opened, [`LibraryState`] holds the reason instead.

pub mod bibsafety;
pub mod bibsync;
pub mod cache;
pub mod commands;
pub mod db;
pub mod dedupe;
pub mod fts;
pub mod ids;
pub mod online;
pub mod pipeline;
pub mod store;
#[cfg(test)]
mod tests;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

use rusqlite::{Connection, ErrorCode};
use serde::Serialize;

/// The database file inside the library folder.
pub const FILE: &str = "library.sqlite";
/// Present while Texo has the library open; left behind by a crash.
const OPEN_MARKER: &str = ".open";
pub const BACKUPS: &str = "backups";
/// How often the expired cache and old unsaved papers are purged.
const PURGE_EVERY_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, thiserror::Error)]
pub enum LibError {
    #[error("{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    /// `PRAGMA quick_check` found damage.
    #[error("The paper library file is damaged.")]
    Corrupt,
    #[error("{0}")]
    Msg(String),
}

impl LibError {
    pub fn msg(text: impl Into<String>) -> Self {
        LibError::Msg(text.into())
    }

    /// The file is not a database or is damaged (rather than busy or
    /// unreadable for some other reason).
    fn is_corruption(&self) -> bool {
        match self {
            LibError::Corrupt => true,
            LibError::Sql(e) => matches!(e.sqlite_error_code(), Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)),
            _ => false,
        }
    }

    /// One plain sentence for the UI. SQL details stay out of it.
    pub fn plain(&self) -> String {
        match self {
            LibError::Msg(m) => m.clone(),
            LibError::Corrupt => self.to_string(),
            LibError::Sql(e) => match e.sqlite_error_code() {
                Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => {
                    "The paper library is busy. Try again in a moment.".into()
                }
                Some(ErrorCode::DiskFull) => "The disk is full, so the paper library can't save changes.".into(),
                Some(ErrorCode::ReadOnly | ErrorCode::PermissionDenied | ErrorCode::CannotOpen) => {
                    "Texo can't write to the paper library's folder.".into()
                }
                Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => "The paper library file is damaged.".into(),
                _ => "Something went wrong in the paper library. Try again.".into(),
            },
            LibError::Io(e) => format!("The paper library couldn't use its folder ({e})."),
            LibError::Json(_) => "Something went wrong in the paper library. Try again.".into(),
        }
    }
}

pub type LibResult<T> = Result<T, LibError>;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub struct Library {
    dir: PathBuf,
    path: PathBuf,
    writer: Mutex<Connection>,
    reader: Mutex<Connection>,
    last_purge: AtomicI64,
}

/// Managed app state: the library when it opened, and a warning for the
/// status line (a damaged file set aside, or why the library is missing).
pub struct LibraryState(pub Option<Arc<Library>>, pub Option<String>);

impl LibraryState {
    /// Opens the library in `dir`; never fails.
    pub fn open(dir: &Path) -> Self {
        match Library::open(dir) {
            Ok((lib, warning)) => LibraryState(Some(Arc::new(lib)), warning),
            Err(e) => LibraryState(None, Some(e.plain())),
        }
    }

    pub fn get(&self) -> LibResult<Arc<Library>> {
        match &self.0 {
            Some(lib) => Ok(lib.clone()),
            None => Err(LibError::msg(format!(
                "Library unavailable: {}",
                self.1.as_deref().unwrap_or("it couldn't be opened.")
            ))),
        }
    }

    /// On exit: refresh query statistics and drop the `.open` marker.
    pub fn close(&self) {
        if let Some(lib) = &self.0 {
            lib.close();
        }
    }
}

fn lock(m: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn try_lock(m: &Mutex<Connection>) -> Option<MutexGuard<'_, Connection>> {
    match m.try_lock() {
        Ok(g) => Some(g),
        Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

impl Library {
    /// The open sequence (design B.2): pragmas, an integrity check after an
    /// unclean shutdown, a damaged file set aside for a fresh one, a backup
    /// before migrating, then the purge.
    pub fn open(dir: &Path) -> LibResult<(Library, Option<String>)> {
        Self::open_with(dir, db::MIGRATIONS)
    }

    pub(crate) fn open_with(dir: &Path, migrations: &[&str]) -> LibResult<(Library, Option<String>)> {
        fs::create_dir_all(dir)?;
        let path = dir.join(FILE);
        let marker = dir.join(OPEN_MARKER);
        let unclean = marker.exists();
        let mut warning = None;
        let writer = match Self::open_checked(&path, unclean, migrations, &dir.join(BACKUPS)) {
            Ok(conn) => conn,
            Err(e) if e.is_corruption() => {
                let aside = db::quarantine(&path, now_ms())?;
                warning = Some(format!(
                    "The paper library was damaged, so Texo set it aside ({}) and started a new one.",
                    aside.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                ));
                Self::open_checked(&path, false, migrations, &dir.join(BACKUPS))?
            }
            Err(e) => return Err(e),
        };
        let version = db::user_version(&writer)?;
        if version > migrations.len() as i64 {
            warning = Some("The paper library was made by a newer Texo. Some things may not work until you update.".into());
        }
        let reader = db::open_reader(&path)?;
        fs::write(&marker, b"")?;
        let lib = Library {
            dir: dir.to_path_buf(),
            path,
            writer: Mutex::new(writer),
            reader: Mutex::new(reader),
            last_purge: AtomicI64::new(0),
        };
        lib.purge_now(now_ms())?;
        Ok((lib, warning))
    }

    fn open_checked(path: &Path, check: bool, migrations: &[&str], backups: &Path) -> LibResult<Connection> {
        let mut conn = db::open_writer(path)?;
        if check && !db::quick_check(&conn)? {
            return Err(LibError::Corrupt);
        }
        db::migrate(&mut conn, migrations, backups)?;
        Ok(conn)
    }

    /// Runs `f` on the writable connection.
    pub fn write<T>(&self, f: impl FnOnce(&mut Connection) -> LibResult<T>) -> LibResult<T> {
        self.maybe_purge();
        f(&mut lock(&self.writer))
    }

    /// Runs `f` on the read-only connection; it doesn't wait for a writer.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> LibResult<T>) -> LibResult<T> {
        f(&lock(&self.reader))
    }

    /// Like [`Library::write`], but `None` at once when the writer is busy
    /// (a backup, a sync) instead of waiting, and never purges: for hooks
    /// that run on the async runtime.
    pub fn try_write<T>(&self, f: impl FnOnce(&mut Connection) -> LibResult<T>) -> Option<LibResult<T>> {
        try_lock(&self.writer).map(|mut c| f(&mut c))
    }

    /// Like [`Library::read`], but `None` at once when the reader is busy.
    pub fn try_read<T>(&self, f: impl FnOnce(&Connection) -> LibResult<T>) -> Option<LibResult<T>> {
        try_lock(&self.reader).map(|c| f(&c))
    }

    fn purge_now(&self, now: i64) -> LibResult<()> {
        self.last_purge.store(now, Ordering::Relaxed);
        db::purge(&mut lock(&self.writer), now)
    }

    /// Purges at most once an hour, on the next write after the hour is up.
    fn maybe_purge(&self) {
        let now = now_ms();
        let last = self.last_purge.load(Ordering::Relaxed);
        if now - last >= PURGE_EVERY_MS
            && self.last_purge.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
        {
            let _ = db::purge(&mut lock(&self.writer), now);
        }
    }

    /// A copy of the library in `backups/library-<time>.sqlite`.
    pub fn backup(&self) -> LibResult<PathBuf> {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let dest = self.dir.join(BACKUPS).join(format!("library-{stamp}.sqlite"));
        db::backup_to(&lock(&self.writer), &dest)?;
        Ok(dest)
    }

    pub fn close(&self) {
        db::optimize(&lock(&self.writer));
        let _ = fs::remove_file(self.dir.join(OPEN_MARKER));
    }

    pub fn status(&self, warning: Option<String>) -> LibResult<LibraryStatus> {
        let (papers, saved, (cache_entries, cache_bytes)) = self.read(|c| {
            let papers: i64 = c.query_row("SELECT count(*) FROM papers", [], |r| r.get(0))?;
            let saved: i64 = c.query_row("SELECT count(*) FROM papers WHERE saved_at IS NOT NULL", [], |r| r.get(0))?;
            Ok((papers, saved, cache::size(c)?))
        })?;
        let file_bytes = fs::metadata(&self.path).map(|m| m.len() as i64).unwrap_or(0);
        Ok(LibraryStatus {
            available: true,
            warning,
            papers,
            saved,
            cache_entries,
            cache_bytes,
            file_bytes,
        })
    }
}

/// What the library panel's header and Settings show. Never carries keys,
/// e-mail addresses or file paths.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStatus {
    pub available: bool,
    /// A plain sentence: a damaged file set aside, a newer schema, or why
    /// the library is unavailable.
    pub warning: Option<String>,
    pub papers: i64,
    pub saved: i64,
    pub cache_entries: i64,
    pub cache_bytes: i64,
    pub file_bytes: i64,
}

#[cfg(test)]
impl LibraryState {
    /// Queries the database: call it off the async runtime.
    pub fn status(&self) -> LibraryStatus {
        status_of(self.0.as_deref(), self.1.clone())
    }
}

/// The status of `lib` (or of a library that didn't open) with `warning`.
/// Queries the database: call it off the async runtime.
pub fn status_of(lib: Option<&Library>, warning: Option<String>) -> LibraryStatus {
    match lib {
        Some(lib) => lib.status(warning).unwrap_or_else(|e| LibraryStatus {
            available: true,
            warning: Some(e.plain()),
            ..Default::default()
        }),
        None => LibraryStatus {
            available: false,
            warning: Some(warning.unwrap_or_else(|| "The paper library couldn't be opened.".into())),
            ..Default::default()
        },
    }
}
