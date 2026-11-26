//! Keeps two writers out of one project's history at the same time: a
//! mutex per project inside this process, plus a lock file (`texo.lock`,
//! holding the pid and the computer's name) for other Texo windows and
//! processes. A lock whose process has ended on this computer (a crash) is
//! taken over at once.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::error::{AppError, AppResult};

pub const LOCK_FILE: &str = "texo.lock";
/// A lock file older than this was left behind by a crash.
pub const STALE_AFTER: Duration = Duration::from_secs(10 * 60);
/// An empty lock file older than this was left by a crash between creating
/// and writing it.
const EMPTY_STALE_AFTER: Duration = Duration::from_secs(10);

fn key(dir: &Path) -> String {
    let s = dir.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// The in-process mutex for one project.
pub fn project_mutex(dir: &Path) -> Arc<Mutex<()>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = MAP.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key(dir)).or_default().clone()
}

/// Waits up to `timeout` for the project's mutex.
pub fn lock_mutex(m: &Mutex<()>, timeout: Duration) -> AppResult<MutexGuard<'_, ()>> {
    let start = Instant::now();
    loop {
        match m.try_lock() {
            Ok(g) => return Ok(g),
            Err(std::sync::TryLockError::Poisoned(p)) => return Ok(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if start.elapsed() >= timeout {
                    return Err(busy());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

pub fn busy() -> AppError {
    AppError::msg("The history is busy saving a change. Try again in a moment.")
}

/// Removes the lock file when dropped.
#[derive(Debug)]
pub struct FileLock {
    path: PathBuf,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// This computer's name, so a lock synced from another PC (OneDrive) is
/// never judged by a pid that only means something there.
fn host() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

/// Whether process `pid` is running on this computer; `None` when that
/// can't be told.
#[cfg(windows)]
fn pid_alive(pid: u32) -> Option<bool> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // No such process; anything else (access denied) means it exists.
            return match std::io::Error::last_os_error().raw_os_error() {
                Some(ERROR_INVALID_PARAMETER) => Some(false),
                _ => None,
            };
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        if ok == 0 {
            None
        } else {
            Some(code == STILL_ACTIVE)
        }
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> Option<bool> {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let pid = i32::try_from(pid).ok().filter(|p| *p > 0)?;
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { kill(pid, 0) } == 0 {
        return Some(true);
    }
    const ESRCH: i32 = 3;
    match std::io::Error::last_os_error().raw_os_error() {
        Some(ESRCH) => Some(false),
        _ => Some(true),
    }
}

#[cfg(not(any(windows, unix)))]
fn pid_alive(_pid: u32) -> Option<bool> {
    None
}

fn is_stale(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };
    let age = meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok());
    if age.is_some_and(|age| age > STALE_AFTER) {
        return true;
    }
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut lines = text.lines();
    let Some(pid) = lines.next().and_then(|l| l.trim().parse::<u32>().ok()) else {
        // Unreadable or still being written: only age can tell.
        return text.trim().is_empty() && age.is_some_and(|a| a > EMPTY_STALE_AFTER);
    };
    // Our own pid can only be a leftover: inside this process the mutex
    // already keeps writers apart (or the pid was reused after a crash).
    if pid == std::process::id() {
        return true;
    }
    // Line 3 is the computer's name (missing in older lock files, which
    // were written on this computer or never synced).
    let same_host = lines.nth(1).map(|h| h.trim().to_lowercase()).is_none_or(|h| h.is_empty() || h == host());
    same_host && pid_alive(pid) == Some(false)
}

/// Takes `<git_dir>/texo.lock`, waiting up to `timeout` for another process
/// to finish and taking over a stale lock.
pub fn acquire(git_dir: &Path, timeout: Duration) -> AppResult<FileLock> {
    let path = git_dir.join(LOCK_FILE);
    let start = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let _ = writeln!(f, "{}\n{}", std::process::id(), chrono::Utc::now().to_rfc3339());
                return Ok(FileLock { path });
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                if is_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                if start.elapsed() >= timeout {
                    return Err(AppError::msg(
                        "Another Texo window is saving this project's history right now. Try again in a moment.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // Windows reports a file being deleted by another process as
            // access denied for a moment.
            Err(e) if e.kind() == ErrorKind::PermissionDenied && start.elapsed() < timeout && path.exists() => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_file_blocks_a_second_holder_and_is_removed_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let held = acquire(dir.path(), Duration::from_millis(10)).unwrap();
        assert!(dir.path().join(LOCK_FILE).exists());
        // Simulate another process holding it: a fresh lock with another pid.
        drop(held);
        fs::write(dir.path().join(LOCK_FILE), "4000000000\nnow\nanother-pc").unwrap();
        let err = acquire(dir.path(), Duration::from_millis(100)).unwrap_err();
        assert!(err.to_string().contains("Another Texo window"));
        fs::remove_file(dir.path().join(LOCK_FILE)).unwrap();
        let held = acquire(dir.path(), Duration::from_millis(10)).unwrap();
        drop(held);
        assert!(!dir.path().join(LOCK_FILE).exists());
    }

    #[test]
    fn stale_lock_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE);
        fs::write(&path, "4000000000\nlong ago").unwrap();
        let f = fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(11 * 60)).unwrap();
        drop(f);
        assert!(acquire(dir.path(), Duration::from_millis(10)).is_ok());
    }

    #[test]
    fn leftover_lock_with_our_pid_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(LOCK_FILE), format!("{}\n", std::process::id())).unwrap();
        assert!(acquire(dir.path(), Duration::from_millis(10)).is_ok());
    }

    /// A pid no process has: just under i32::MAX, a multiple of 4
    /// (Windows) and far above the pid limit on Linux and macOS.
    const DEAD_PID: u32 = 0x7FFF_FFFC;

    #[test]
    fn crash_leftover_with_a_dead_pid_is_taken_over_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE);
        assert_eq!(pid_alive(DEAD_PID), Some(false));
        fs::write(&path, format!("{DEAD_PID}
now
{}
", host())).unwrap();
        assert!(acquire(dir.path(), Duration::from_millis(10)).is_ok());
        // An old lock file without the computer's name is judged the same way.
        fs::write(&path, format!("{DEAD_PID}
now
")).unwrap();
        assert!(acquire(dir.path(), Duration::from_millis(10)).is_ok());
    }

    #[test]
    fn lock_from_another_computer_or_a_live_process_is_respected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE);
        fs::write(&path, format!("{DEAD_PID}
now
some-other-pc
")).unwrap();
        assert!(acquire(dir.path(), Duration::from_millis(100)).is_err());
        // A running process (a child we start) holds it.
        let mut child = if cfg!(windows) {
            std::process::Command::new("cmd").args(["/C", "ping -n 30 127.0.0.1 >NUL"]).spawn().unwrap()
        } else {
            std::process::Command::new("sleep").arg("30").spawn().unwrap()
        };
        fs::write(&path, format!("{}
now
{}
", child.id(), host())).unwrap();
        assert_eq!(pid_alive(child.id()), Some(true));
        assert!(acquire(dir.path(), Duration::from_millis(100)).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(acquire(dir.path(), Duration::from_millis(500)).is_ok());
    }

    #[test]
    fn empty_lock_file_is_stale_only_after_a_moment() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE);
        fs::write(&path, "").unwrap();
        assert!(!is_stale(&path));
        let f = fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(30)).unwrap();
        drop(f);
        assert!(is_stale(&path));
    }

    #[test]
    fn mutex_times_out_when_held() {
        let m = project_mutex(Path::new("/some/project"));
        let same = project_mutex(Path::new("/some/project/"));
        assert!(Arc::ptr_eq(&m, &same));
        let _g = m.lock().unwrap();
        let other = m.clone();
        let res = std::thread::spawn(move || lock_mutex(&other, Duration::from_millis(50)).map(|_| ()))
            .join()
            .unwrap();
        assert!(res.is_err());
    }
}
