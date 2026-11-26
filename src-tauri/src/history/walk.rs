//! Which files the history keeps, and a stat cache so unchanged files are
//! not read and hashed again on every snapshot.
//!
//! History never reads `.gitignore`: Texo has its own exclude list, the same
//! on every machine, so a project's history doesn't depend on git settings.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::project::{self, META_DIR, SKIPPED_DIRS};

/// More files than this and history refuses: such a folder is almost
/// certainly not just a paper (a home folder, a code checkout).
pub const MAX_FILES: usize = 20_000;
/// Larger files are left out and listed as "untracked-large" in the note.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// LaTeX build outputs (compared against the end of the lower-cased name).
const BUILD_SUFFIXES: &[&str] = &[
    ".aux", ".log", ".synctex.gz", ".synctex(busy)", ".synctex", ".fdb_latexmk", ".fls", ".toc", ".lof", ".lot",
    ".blg", ".bcf", ".run.xml", ".nav", ".snm", ".vrb", ".xdv", ".dvi",
];

/// Names that are build outputs only when a build left a `.aux` (or a
/// `.blg`) of the same name beside them. Otherwise they belong to the paper:
/// a `.bbl` shipped with an arXiv source, a `.out` data file pgfplots reads.
/// Texo itself builds into `.texo/build`. Same rule as the compiler's
/// shipped-`.bbl` check.
const LEFTOVER_SUFFIXES: &[&str] = &[".bbl", ".out"];

/// Texo's exclude list for one project.
#[derive(Debug, Default, Clone)]
pub struct Excludes {
    /// Lower-cased, `/`-separated paths of the compiled PDF(s) Texo saves
    /// next to the main document.
    pdfs: Vec<String>,
    /// The project folder, to look for build leftovers beside `.bbl` and
    /// `.out` files. Without it they are always left out.
    root: Option<PathBuf>,
}

impl Excludes {
    pub fn for_project(dir: &Path) -> Self {
        let mut pdfs = Vec::new();
        if let Some(meta) = project::read_meta(dir) {
            if let Some(main) = meta.main_document.as_deref() {
                let main = Path::new(main);
                let stem = main.file_stem().unwrap_or_default().to_string_lossy();
                let folder = main.parent().unwrap_or(Path::new(""));
                for name in [format!("{stem}.pdf"), format!("{stem} (compiled).pdf")] {
                    pdfs.push(project::to_slash(&folder.join(name)).to_lowercase());
                }
            }
            if let Some(out) = meta.output_pdf {
                pdfs.push(out.replace('\\', "/").to_lowercase());
            }
        }
        Excludes { pdfs, root: Some(dir.to_path_buf()) }
    }

    #[cfg(test)]
    pub fn with_pdfs(pdfs: &[&str]) -> Self {
        Excludes { pdfs: pdfs.iter().map(|p| p.to_lowercase()).collect(), root: None }
    }

    /// Folders that are never walked (any depth).
    pub fn skip_dir(&self, name: &str) -> bool {
        name.eq_ignore_ascii_case(META_DIR)
            || SKIPPED_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d))
            || name.starts_with(".texo-import-")
    }

    /// `rel` is the `/`-separated path inside the project.
    pub fn skip_file(&self, rel: &str) -> bool {
        let lower = rel.to_lowercase();
        let name = lower.rsplit('/').next().unwrap_or(&lower);
        if name.ends_with(".texo-tmp") || name.starts_with(".texo-import-") {
            return true;
        }
        if BUILD_SUFFIXES.iter().any(|s| name.ends_with(s)) {
            return true;
        }
        if LEFTOVER_SUFFIXES.iter().any(|s| name.ends_with(s)) && self.build_leftover(rel) {
            return true;
        }
        self.pdfs.contains(&lower)
    }

    /// True when a build left `<stem>.aux` or `<stem>.blg` beside `rel`.
    fn build_leftover(&self, rel: &str) -> bool {
        let Some(root) = &self.root else { return true };
        let path = root.join(rel);
        ["aux", "blg"].iter().any(|ext| path.with_extension(ext).is_file())
    }

    /// True when `rel` (a file path) is inside the history at all, checking
    /// every folder on the way. For callers outside the walk (the agents
    /// runtime's shadow copy can use the same rules).
    #[allow(dead_code)]
    pub fn tracks(&self, rel: &str) -> bool {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
            return false;
        }
        let (dirs, _) = parts.split_at(parts.len() - 1);
        !dirs.iter().any(|d| self.skip_dir(d)) && !self.skip_file(rel)
    }
}

/// One file found on disk.
#[derive(Debug, Clone)]
pub struct Found {
    pub rel: String,
    pub size: u64,
    pub mtime_ns: u128,
    /// A OneDrive-style placeholder whose contents aren't on this PC.
    pub placeholder: bool,
}

#[derive(Debug, Default)]
pub struct Scan {
    pub files: Vec<Found>,
    /// Over [`MAX_FILE_BYTES`].
    pub too_large: Vec<String>,
    /// Names that aren't valid Unicode (shown lossily).
    pub bad_names: Vec<String>,
}

fn mtime_ns(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

pub fn too_many_files() -> AppError {
    AppError::msg(format!(
        "This folder has more than {} files, so Texo doesn't keep a history for it. Keep the paper in a folder of its own to turn history on.",
        MAX_FILES
    ))
}

/// Walks the project with the exclude list. Symbolic links are skipped.
pub fn scan(dir: &Path, ex: &Excludes) -> AppResult<Scan> {
    scan_capped(dir, ex, MAX_FILES)
}

/// [`scan`] with a different file cap (tests).
pub fn scan_capped(dir: &Path, ex: &Excludes, cap: usize) -> AppResult<Scan> {
    let mut scan = Scan::default();
    let walker = WalkDir::new(dir)
        .min_depth(1)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && e.file_name().to_str().is_some_and(|n| ex.skip_dir(n))));
    for entry in walker {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel_path) = entry.path().strip_prefix(dir) else { continue };
        let Some(rel) = rel_path.to_str().map(|s| s.replace('\\', "/")) else {
            scan.bad_names.push(project::to_slash(rel_path));
            continue;
        };
        if ex.skip_file(&rel) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            scan.too_large.push(rel);
            continue;
        }
        scan.files.push(Found {
            rel,
            size: meta.len(),
            mtime_ns: mtime_ns(&meta),
            placeholder: project::is_cloud_placeholder(&meta),
        });
        if scan.files.len() > cap {
            return Err(too_many_files());
        }
    }
    Ok(scan)
}

/// Reads a file, retrying a few times when another app has it locked
/// (Word, an antivirus scan, OneDrive syncing).
pub fn read_with_retry(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut last = None;
    for attempt in 0..4 {
        match fs::read(path) {
            Ok(bytes) => return Ok(bytes),
            Err(e) if is_locked(&e) && attempt < 3 => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(100 * (attempt + 1)));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("locked")))
}

fn is_locked(e: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION on Windows.
    matches!(e.raw_os_error(), Some(32) | Some(33)) || e.kind() == ErrorKind::WouldBlock
}

// ---------------------------------------------------------------------------
// Stat cache

pub const STAT_FILE: &str = "texo-stat.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stat {
    pub size: u64,
    pub mtime: u128,
    pub oid: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StatCache {
    #[serde(default)]
    pub files: HashMap<String, Stat>,
}

impl StatCache {
    pub fn load(git_dir: &Path) -> Self {
        fs::read(git_dir.join(STAT_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, git_dir: &Path) {
        let Ok(json) = serde_json::to_vec(self) else { return };
        let path = git_dir.join(STAT_FILE);
        let tmp = git_dir.join(format!("{STAT_FILE}.texo-tmp"));
        if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }

    /// The cached blob id when size and modification time still match.
    pub fn hit(&self, f: &Found) -> Option<&str> {
        self.files
            .get(&f.rel)
            .filter(|s| s.size == f.size && s.mtime == f.mtime_ns && f.mtime_ns != 0)
            .map(|s| s.oid.as_str())
    }

    /// Remembers a file's id, unless it changed so recently that a second
    /// write within the clock's resolution could go unnoticed.
    pub fn record(&mut self, f: &Found, oid: String) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        if f.mtime_ns == 0 || now.saturating_sub(f.mtime_ns) < 2_000_000_000 {
            self.files.remove(&f.rel);
            return;
        }
        self.files.insert(f.rel.clone(), Stat { size: f.size, mtime: f.mtime_ns, oid });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_rules() {
        let ex = Excludes::with_pdfs(&["paper/Main.pdf"]);
        assert!(ex.tracks("main.tex"));
        assert!(ex.tracks("figures/plot.pdf"));
        assert!(!ex.tracks("paper/main.pdf"));
        assert!(!ex.tracks("main.AUX"));
        assert!(!ex.tracks("build/x.fdb_latexmk"));
        assert!(!ex.tracks(".texo/history/HEAD"));
        assert!(!ex.tracks("sub/.git/config"));
        assert!(!ex.tracks("node_modules/a.js"));
        assert!(!ex.tracks(".main.tex.texo-tmp"));
        assert!(!ex.tracks(".texo-import-1/a.tex"));
        assert!(!ex.tracks("../escape.tex"));
        assert!(!ex.tracks("a//b.tex"));
        assert!(!ex.tracks("main.bbl"), "no project folder: always a build output");
    }

    #[test]
    fn shipped_bbl_and_out_files_are_kept_unless_a_build_left_them() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        fs::create_dir_all(dir.join("paper")).unwrap();
        for f in ["main.bbl", "data.out", "paper/other.bbl", "paper/other.out"] {
            fs::write(dir.join(f), "x").unwrap();
        }
        fs::write(dir.join("paper/other.aux"), "x").unwrap();
        let ex = Excludes::for_project(dir);
        assert!(ex.tracks("main.bbl"), "shipped with the paper (arXiv source)");
        assert!(ex.tracks("data.out"), "a data file");
        assert!(!ex.tracks("paper/other.bbl"), "left by another editor's build");
        assert!(!ex.tracks("paper/other.out"));
        fs::write(dir.join("main.blg"), "x").unwrap();
        assert!(!ex.tracks("main.bbl"));
    }
}
