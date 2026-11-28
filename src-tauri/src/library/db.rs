//! The SQLite file itself: connection settings, schema migrations, backups,
//! the integrity check and the retention purge.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags};

use super::LibResult;

/// Schema migrations in order; `PRAGMA user_version` is how many have run.
pub const MIGRATIONS: &[&str] = &[include_str!("migrations/0001_init.sql")];

/// Seen-but-unsaved papers nobody uses are forgotten after this long.
pub const UNSAVED_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// Settings every connection gets. WAL lets one writer and many readers work
/// at the same time.
pub fn configure(conn: &Connection) -> LibResult<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

/// Opens the writable connection (creating the file) and switches it to WAL.
pub fn open_writer(path: &Path) -> LibResult<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // The first statement reads the header, so a file that isn't a database
    // fails here.
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(super::LibError::msg("The paper library couldn't switch to its safe write mode."));
    }
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    configure(&conn)?;
    Ok(conn)
}

/// Opens a read-only connection to the same file.
pub fn open_reader(path: &Path) -> LibResult<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    configure(&conn)?;
    Ok(conn)
}

pub fn user_version(conn: &Connection) -> LibResult<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

/// `PRAGMA quick_check`: true when SQLite finds nothing wrong.
pub fn quick_check(conn: &Connection) -> LibResult<bool> {
    let first: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    Ok(first.eq_ignore_ascii_case("ok"))
}

/// A consistent copy of the open database at `dest` (`VACUUM INTO`).
pub fn backup_to(conn: &Connection, dest: &Path) -> LibResult<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if dest.exists() {
        fs::remove_file(dest)?;
    }
    conn.execute("VACUUM INTO ?1", params![dest.to_string_lossy()])?;
    Ok(())
}

/// Runs the migrations the file hasn't had yet, each in one transaction.
/// A database that already holds a schema is copied to
/// `backups/library.pre-v{N}.sqlite` first, where N is the version it is
/// about to get. Returns the version the file is at afterwards.
pub fn migrate(conn: &mut Connection, migrations: &[&str], backups: &Path) -> LibResult<i64> {
    let mut version = user_version(conn)?;
    let target = migrations.len() as i64;
    if version >= target {
        return Ok(version);
    }
    if version > 0 {
        backup_to(conn, &backups.join(format!("library.pre-v{target}.sqlite")))?;
    }
    while version < target {
        let tx = conn.transaction()?;
        tx.execute_batch(migrations[version as usize])?;
        tx.pragma_update(None, "user_version", version + 1)?;
        tx.commit()?;
        version += 1;
    }
    Ok(version)
}

/// Drops expired cache entries and forgets unsaved papers that nothing
/// refers to and nobody has seen for [`UNSAVED_RETENTION_MS`].
pub fn purge(conn: &mut Connection, now: i64) -> LibResult<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM search_cache WHERE expires_at <= ?1", params![now])?;
    let doomed = "SELECT id FROM papers p WHERE saved_at IS NULL AND last_seen_at < ?1 \
                  AND note IS NULL \
                  AND NOT EXISTS (SELECT 1 FROM project_refs r WHERE r.paper_id = p.id) \
                  AND NOT EXISTS (SELECT 1 FROM paper_tags t WHERE t.paper_id = p.id)";
    let cutoff = now - UNSAVED_RETENTION_MS;
    tx.execute(&format!("UPDATE papers SET dup_of = NULL WHERE dup_of IN ({doomed})"), params![cutoff])?;
    tx.execute(&format!("DELETE FROM papers WHERE id IN ({doomed})"), params![cutoff])?;
    tx.commit()?;
    Ok(())
}

/// Where a damaged file is moved: `library.corrupt-<ms>.sqlite` next to it.
pub fn quarantine(path: &Path, now: i64) -> LibResult<PathBuf> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let dest = dir.join(format!("library.corrupt-{now}.sqlite"));
    fs::rename(path, &dest)?;
    // The write-ahead log and shared-memory files belong to the bad file.
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", path.to_string_lossy()));
        if side.exists() {
            let _ = fs::rename(&side, PathBuf::from(format!("{}{ext}", dest.to_string_lossy())));
        }
    }
    Ok(dest)
}

/// Asks SQLite to refresh its query statistics (on close).
pub fn optimize(conn: &Connection) {
    let _ = conn.execute_batch("PRAGMA optimize");
}
