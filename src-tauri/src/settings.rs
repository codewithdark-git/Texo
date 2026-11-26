//! App-wide settings, kept as JSON in the app config directory.
//!
//! Every running Texo process shares one `settings.json`, so the file is never
//! simply overwritten with what this process happens to hold in memory. Each
//! change goes through [`SettingsFile::update`], which takes a lock file,
//! re-reads the file, applies just that change (add one project, set the
//! compiler…) to the latest contents and writes the result atomically. A
//! damaged file is kept aside and replaced by the last good copy.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::compile::Compiler;
use crate::error::{AppError, AppResult};
use crate::project::same_path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Folder where new projects are created and scanned for.
    pub projects_root: PathBuf,
    /// Project folders opened from outside `projects_root`.
    pub external_projects: Vec<PathBuf>,
    /// Which TeX toolchain compiles projects.
    pub compiler: Compiler,
    /// Projects allowed to run their own latexmk config (Perl code).
    pub trusted_projects: Vec<PathBuf>,
    /// Something the user should hear about the settings file itself (it was
    /// damaged and restored). Shown once; never written to disk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// Fields this version doesn't know, written by a newer Texo. Kept so
    /// running two versions side by side doesn't drop them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Settings {
    pub fn defaults(projects_root: PathBuf) -> Settings {
        Settings {
            projects_root,
            external_projects: Vec::new(),
            compiler: Compiler::default(),
            trusted_projects: Vec::new(),
            notice: None,
            extra: Map::new(),
        }
    }

    /// Reads settings leniently: a field with the wrong shape falls back to
    /// its default instead of discarding the whole file. `None` when the
    /// text isn't a JSON object at all.
    fn parse(text: &str, default_root: &Path) -> Option<Settings> {
        let Value::Object(mut map) = serde_json::from_str::<Value>(text).ok()? else {
            return None;
        };
        let paths = |v: Option<Value>| -> Vec<PathBuf> {
            let mut out: Vec<PathBuf> = Vec::new();
            for p in v.and_then(|v| v.as_array().cloned()).unwrap_or_default() {
                if let Some(p) = p.as_str().filter(|p| !p.trim().is_empty()) {
                    let p = PathBuf::from(p);
                    if !out.iter().any(|q| same_path(q, &p)) {
                        out.push(p);
                    }
                }
            }
            out
        };
        let projects_root = map
            .remove("projectsRoot")
            .and_then(|v| v.as_str().filter(|s| !s.trim().is_empty()).map(PathBuf::from))
            .unwrap_or_else(|| default_root.to_path_buf());
        let compiler = map
            .remove("compiler")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let external_projects = paths(map.remove("externalProjects"));
        let trusted_projects = paths(map.remove("trustedProjects"));
        map.remove("notice");
        Some(Settings { projects_root, external_projects, compiler, trusted_projects, notice: None, extra: map })
    }

    fn to_disk(&self) -> AppResult<String> {
        let mut copy = self.clone();
        copy.notice = None;
        Ok(serde_json::to_string_pretty(&copy)?)
    }

    /// Adds `dir` to the external projects; false if it is already there.
    pub fn add_external(&mut self, dir: &Path) -> bool {
        add_path(&mut self.external_projects, dir)
    }

    /// Removes `dir` from the external projects; false if it wasn't there.
    pub fn remove_external(&mut self, dir: &Path) -> bool {
        let before = self.external_projects.len();
        self.external_projects.retain(|p| !same_path(p, dir));
        before != self.external_projects.len()
    }

    /// Lets `dir` run its latexmk config; false if it already could.
    pub fn add_trusted(&mut self, dir: &Path) -> bool {
        add_path(&mut self.trusted_projects, dir)
    }
}

fn add_path(list: &mut Vec<PathBuf>, dir: &Path) -> bool {
    if list.iter().any(|p| same_path(p, dir)) {
        return false;
    }
    list.push(dir.to_path_buf());
    true
}

/// How long a writer waits for another process to finish with the file.
const LOCK_TIMEOUT: Duration = Duration::from_secs(15);
const LOCK_POLL: Duration = Duration::from_millis(15);

/// When the file last changed, to notice another process's writes cheaply.
type Stamp = (Option<SystemTime>, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let m = fs::metadata(path).ok()?;
    Some((m.modified().ok(), m.len()))
}

/// The shared settings file and what this process last saw of it.
#[derive(Debug)]
pub struct SettingsFile {
    path: PathBuf,
    default_root: PathBuf,
    seen: Option<Stamp>,
}

/// What is on disk right now.
enum OnDisk {
    Missing,
    Good(Settings, String),
    Damaged(String),
    /// Exists but can't be opened right now (another program has it locked).
    Unreadable(std::io::Error),
}

impl SettingsFile {
    pub fn new(path: PathBuf, default_root: PathBuf) -> Self {
        SettingsFile { path, default_root, seen: None }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock_path(&self) -> PathBuf {
        self.path.with_extension("json.lock")
    }

    fn backup_path(&self) -> PathBuf {
        self.path.with_extension("json.bak")
    }

    fn read(&self) -> OnDisk {
        match fs::read(&self.path) {
            Err(e) if e.kind() == ErrorKind::NotFound => OnDisk::Missing,
            Err(e) => OnDisk::Unreadable(e),
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                match Settings::parse(&text, &self.default_root) {
                    Some(s) => OnDisk::Good(s, text),
                    None => OnDisk::Damaged(text),
                }
            }
        }
    }

    /// Reads the settings at startup, repairing a damaged file first.
    pub fn load(&mut self) -> Settings {
        let quick = self.read();
        self.seen = stamp(&self.path);
        match quick {
            OnDisk::Missing => return Settings::defaults(self.default_root.clone()),
            OnDisk::Good(s, _) => return s,
            OnDisk::Damaged(_) | OnDisk::Unreadable(_) => {}
        }
        // Repair under the lock, in case another process is mid-save.
        match self.update(|_| false) {
            Ok(s) => s,
            Err(e) => {
                let mut s = Settings::defaults(self.default_root.clone());
                s.notice = Some(format!("Texo couldn't read its settings file ({e}). It is using default settings for now."));
                s
            }
        }
    }

    /// Picks up changes another Texo process saved since we last looked.
    /// Keeps `current` when the file is missing or can't be read right now.
    pub fn refresh(&mut self, current: &mut Settings) {
        let now = stamp(&self.path);
        if now.is_none() || now == self.seen {
            return;
        }
        if let OnDisk::Good(mut s, _) = self.read() {
            s.notice = current.notice.take();
            *current = s;
            self.seen = now;
        }
    }

    /// Applies `change` to the latest settings on disk and saves them, while
    /// holding the cross-process lock. `change` returns false when it found
    /// nothing to do, which skips the write. Returns the merged settings.
    pub fn update(&mut self, change: impl FnOnce(&mut Settings) -> bool) -> AppResult<Settings> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let _lock = FileLock::acquire(&self.lock_path())?;

        let mut on_disk = self.read();
        for _ in 0..10 {
            // A virus scanner or backup tool may hold the file for a moment.
            if !matches!(on_disk, OnDisk::Unreadable(_)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
            on_disk = self.read();
        }
        let (mut settings, mut dirty, good_text) = match on_disk {
            OnDisk::Missing => (Settings::defaults(self.default_root.clone()), false, None),
            OnDisk::Good(s, text) => (s, false, Some(text)),
            OnDisk::Damaged(text) => (self.recover(&text), true, None),
            // Never replace a file we merely couldn't open: that would lose
            // whatever it holds.
            OnDisk::Unreadable(e) => return Err(e.into()),
        };
        dirty |= change(&mut settings);
        if dirty {
            if let Some(text) = &good_text {
                // The previous good version, for recovery if this one is
                // ever damaged (by a disk problem or a hand edit).
                let _ = fs::write(self.backup_path(), text);
            }
            write_atomic(&self.path, settings.to_disk()?.as_bytes())?;
        }
        self.seen = stamp(&self.path);
        Ok(settings)
    }

    /// Keeps a damaged file aside and returns the last good settings.
    fn recover(&self, damaged: &str) -> Settings {
        let kept = if damaged.trim().is_empty() {
            None
        } else {
            let name = format!("settings.damaged-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S"));
            let dest = self.path.with_file_name(name);
            fs::write(&dest, damaged).ok().map(|_| dest)
        };
        let kept_note = kept
            .map(|p| format!(" The damaged file was kept as {}.", p.display()))
            .unwrap_or_default();
        let backup = fs::read_to_string(self.backup_path())
            .ok()
            .and_then(|t| Settings::parse(&t, &self.default_root));
        match backup {
            Some(mut s) => {
                s.notice = Some(format!(
                    "Texo's settings file was damaged, so your settings were restored from the last good copy.{kept_note}"
                ));
                s
            }
            None => {
                let mut s = Settings::defaults(self.default_root.clone());
                s.notice = Some(format!(
                    "Texo's settings file was damaged and no good copy was found, so settings were reset. \
                     Your project files are untouched: projects outside your projects folder can be added \
                     back with “Open folder”.{kept_note}"
                ));
                s
            }
        }
    }
}

/// Writes through a temporary file and a rename, so readers only ever see
/// the old or the new file, never half of one.
fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("json.{}-{}.tmp", std::process::id(), uuid::Uuid::new_v4().simple()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // On Windows a reader holding the file open makes the rename fail for a
    // moment; retry briefly.
    let mut tries = 0;
    loop {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if tries < 40 && e.kind() == ErrorKind::PermissionDenied => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e.into());
            }
        }
    }
}

/// An exclusive OS lock (LockFileEx / flock) on a lock file beside
/// settings.json, held while one process reads, merges and writes it.
/// The OS releases it when the process ends, crashed or not, so there is
/// no stale lock to break and no window where two processes can both
/// think they broke it. The file itself stays: deleting it would let a
/// waiting process lock the old file while another creates a new one.
struct FileLock(#[allow(dead_code)] Option<fs::File>);

impl FileLock {
    fn acquire(path: &Path) -> AppResult<FileLock> {
        let start = Instant::now();
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(FileLock(Some(file))),
                Err(fs::TryLockError::WouldBlock) => {
                    if start.elapsed() > LOCK_TIMEOUT {
                        return Err(AppError::msg(
                            "Texo couldn't save its settings because another Texo window kept them busy. Try again.",
                        ));
                    }
                    std::thread::sleep(LOCK_POLL);
                }
                // A file system without locks: save anyway, as before locks.
                Err(fs::TryLockError::Error(e)) if e.kind() == ErrorKind::Unsupported => return Ok(FileLock(None)),
                Err(fs::TryLockError::Error(e)) => return Err(e.into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dir: &Path) -> SettingsFile {
        SettingsFile::new(dir.join("cfg").join("settings.json"), dir.join("Texo"))
    }

    #[test]
    fn missing_file_gives_defaults_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = file(dir.path());
        let s = f.load();
        assert_eq!(s.projects_root, dir.path().join("Texo"));
        assert!(s.external_projects.is_empty());
        assert!(!f.path().exists(), "loading alone doesn't create the file");

        let saved = f.update(|s| s.add_external(&dir.path().join("elsewhere"))).unwrap();
        let again = file(dir.path()).load();
        assert_eq!(again.external_projects, saved.external_projects);
        assert_eq!(again.external_projects, vec![dir.path().join("elsewhere")]);
    }

    /// The bug from 1.1: a second process saving its stale copy erased a
    /// project the first had just added.
    #[test]
    fn a_second_process_never_erases_the_firsts_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (mut a, mut b) = (file(dir.path()), file(dir.path()));
        a.load();
        b.load(); // B's in-memory copy is about to be out of date.
        a.update(|s| s.add_external(Path::new("/papers/one"))).unwrap();
        let b_mem = b
            .update(|s| {
                s.compiler = Compiler::Tectonic;
                true
            })
            .unwrap();
        assert_eq!(b_mem.external_projects, vec![PathBuf::from("/papers/one")]);
        let disk = file(dir.path()).load();
        assert_eq!(disk.external_projects, vec![PathBuf::from("/papers/one")]);
        assert_eq!(disk.compiler, Compiler::Tectonic);
    }

    #[test]
    fn refresh_picks_up_another_processes_save() {
        let dir = tempfile::tempdir().unwrap();
        let (mut a, mut b) = (file(dir.path()), file(dir.path()));
        let mut mem = a.load();
        b.update(|s| s.add_trusted(Path::new("/papers/two"))).unwrap();
        a.refresh(&mut mem);
        assert_eq!(mem.trusted_projects, vec![PathBuf::from("/papers/two")]);
    }

    #[test]
    fn concurrent_writers_keep_every_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let root = root.clone();
                std::thread::spawn(move || {
                    // Each thread stands in for a separate Texo process.
                    let mut f = file(&root);
                    f.load();
                    for i in 0..10 {
                        let p = PathBuf::from(format!("/papers/{t}-{i}"));
                        f.update(|s| s.add_external(&p)).unwrap();
                    }
                    f.update(|s| s.remove_external(Path::new(&format!("/papers/{t}-0")))).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let s = file(&root).load();
        assert_eq!(s.external_projects.len(), 8 * 9, "{:?}", s.external_projects);
        assert!(s.notice.is_none());
        let leftovers: Vec<_> = fs::read_dir(root.join("cfg"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_lock_file_left_by_a_crashed_process_does_not_block() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = file(dir.path());
        fs::create_dir_all(dir.path().join("cfg")).unwrap();
        let lock = fs::File::create(f.lock_path()).unwrap();
        lock.set_modified(SystemTime::now() - Duration::from_secs(60)).unwrap();
        drop(lock);
        let started = Instant::now();
        f.update(|s| s.add_external(Path::new("/x"))).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// The old lock was broken by age, so a second writer could delete a
    /// lock another had just taken. A held lock is held, however old its file.
    #[test]
    fn an_old_looking_lock_that_is_held_still_makes_writers_wait() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = file(dir.path());
        fs::create_dir_all(dir.path().join("cfg")).unwrap();
        let held = FileLock::acquire(&f.lock_path()).unwrap();
        fs::File::options()
            .write(true)
            .open(f.lock_path())
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        let started = Instant::now();
        f.update(|s| s.add_external(Path::new("/z"))).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(250));
        releaser.join().unwrap();
    }

    #[test]
    fn a_fresh_lock_makes_writers_wait() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = file(dir.path());
        fs::create_dir_all(dir.path().join("cfg")).unwrap();
        let held = FileLock::acquire(&f.lock_path()).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        let started = Instant::now();
        f.update(|s| s.add_external(Path::new("/y"))).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(250));
        releaser.join().unwrap();
    }

    #[test]
    fn a_damaged_file_is_kept_and_restored_from_the_last_good_copy() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = file(dir.path());
        f.update(|s| s.add_external(Path::new("/papers/kept"))).unwrap();
        f.update(|s| s.add_external(Path::new("/papers/also"))).unwrap();
        fs::write(f.path(), "{ \"externalProjects\": [ \"/papers/kept\", ").unwrap();

        let s = file(dir.path()).load();
        assert_eq!(s.external_projects, vec![PathBuf::from("/papers/kept")]);
        let notice = s.notice.clone().unwrap();
        assert!(notice.contains("restored from the last good copy"), "{notice}");
        let damaged: Vec<_> = fs::read_dir(dir.path().join("cfg"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("settings.damaged-"))
            .collect();
        assert_eq!(damaged.len(), 1);
        // The repaired file is good again and the notice isn't saved.
        let text = fs::read_to_string(f.path()).unwrap();
        assert!(!text.contains("notice"));
        assert!(file(dir.path()).load().notice.is_none());
    }

    #[test]
    fn a_damaged_file_without_backup_resets_but_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let f = file(dir.path());
        fs::create_dir_all(dir.path().join("cfg")).unwrap();
        fs::write(f.path(), "not json").unwrap();
        let s = file(dir.path()).load();
        assert!(s.external_projects.is_empty());
        assert!(s.notice.unwrap().contains("Open folder"));
    }

    #[test]
    fn wrong_fields_fall_back_alone_and_unknown_fields_survive() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = file(dir.path());
        fs::create_dir_all(dir.path().join("cfg")).unwrap();
        fs::write(
            f.path(),
            r#"{"projectsRoot": 5, "externalProjects": ["/a", 3, "/a", ""], "compiler": "nonsense", "futureThing": {"x": 1}}"#,
        )
        .unwrap();
        let s = f.load();
        assert_eq!(s.projects_root, dir.path().join("Texo"));
        assert_eq!(s.external_projects, vec![PathBuf::from("/a")]);
        assert_eq!(s.compiler, Compiler::Auto);
        f.update(|s| s.add_external(Path::new("/b"))).unwrap();
        let text = fs::read_to_string(f.path()).unwrap();
        assert!(text.contains("futureThing"), "{text}");
    }
}
