//! A Texo project is a plain folder. Texo keeps its own metadata in a hidden
//! `.texo/` subfolder so the LaTeX sources stay untouched and portable.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::templates::Template;

pub const META_DIR: &str = ".texo";
const META_FILE: &str = "project.json";
const FORMAT_VERSION: u32 = 1;
/// Stop walking very large folders; the dashboard only needs rough numbers.
const MAX_SCAN_ENTRIES: usize = 5000;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Pdflatex,
    Xelatex,
    Lualatex,
}

/// Contents of `.texo/project.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub main_document: Option<String>,
    #[serde(default)]
    pub engine: Engine,
    pub created_at: DateTime<Utc>,
    pub format_version: u32,
    /// The PDF Texo saves into the project after each successful compile.
    #[serde(default)]
    pub output_pdf: Option<String>,
}

/// What the dashboard shows for one project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub main_document: Option<String>,
    pub engine: Engine,
    pub created_at: DateTime<Utc>,
    pub last_edited: DateTime<Utc>,
    pub file_count: usize,
    /// True when the folder lives outside the projects folder.
    pub external: bool,
    /// First page of the last PDF, as a PNG data URL.
    pub thumbnail: Option<String>,
    /// Project-relative path of the saved PDF, if Texo has written one.
    pub output_pdf: Option<String>,
    /// The folder is listed but can't be found (moved, renamed, deleted, or
    /// on a drive that isn't connected), or its `.texo` info is gone.
    pub missing: bool,
    /// The folder is there but Texo's project info in it can't be read
    /// (deleted, damaged, or a cloud file that isn't on this PC). Opening it
    /// goes through `open_folder`, which sets it up again or explains why not.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub needs_setup: bool,
    /// Things to tell the user after opening (main document re-detected,
    /// files only in the cloud, a very long path…). Plain sentences.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<String>,
    /// When Texo had to pick the main document and several files could be
    /// it: every likely one, best first, so the user can switch in one click.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub main_candidates: Vec<String>,
}

const THUMBNAIL_FILE: &str = "thumbnail.png";
const MAX_THUMBNAIL_BYTES: usize = 512 * 1024;

fn read_thumbnail(dir: &Path) -> Option<String> {
    use base64::Engine as _;
    let path = dir.join(META_DIR).join(THUMBNAIL_FILE);
    if is_link(&dir.join(META_DIR)) || is_link(&path) {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    (bytes.len() <= MAX_THUMBNAIL_BYTES)
        .then(|| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Stores the dashboard thumbnail the UI rendered from the PDF.
pub fn save_thumbnail(dir: &Path, png: &[u8]) -> AppResult<()> {
    if png.len() > MAX_THUMBNAIL_BYTES || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError::msg("That isn't a small PNG image."));
    }
    write_meta_file(dir, THUMBNAIL_FILE, png)
}

/// True for symbolic links and, on Windows, junctions.
fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// `.texo/` (or a folder inside it) as a real folder in the project, created
/// if needed. A project could ship these as links to somewhere else, which
/// would make Texo's writes land outside the project, so links are refused.
pub fn meta_subdir(dir: &Path, sub: Option<&str>) -> AppResult<PathBuf> {
    let mut path = dir.join(META_DIR);
    for part in std::iter::once(None).chain(sub.map(Some)) {
        if let Some(part) = part {
            path = path.join(part);
        }
        if is_link(&path) {
            return Err(AppError::msg(format!(
                "{} is a link to another location, so Texo won't write to it. Delete it and try again.",
                path.display()
            )));
        }
        fs::create_dir_all(&path)?;
    }
    Ok(path)
}

/// Writes a file in `.texo/` through a temporary file and a rename, which
/// replaces a link at that path instead of writing through it.
fn write_meta_file(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<()> {
    let meta = meta_subdir(dir, None)?;
    let tmp = meta.join(format!(".{name}.tmp"));
    if is_link(&tmp) {
        fs::remove_file(&tmp)?;
    }
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, meta.join(name))?;
    Ok(())
}

/// Removes links inside a build folder before TeX writes there. Removing a
/// link never touches the file it points to.
pub fn remove_links(dir: &Path) -> AppResult<()> {
    for entry in fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        if is_link(&path) {
            // Directory links (junctions) need remove_dir; file links remove_file.
            if fs::remove_file(&path).is_err() {
                fs::remove_dir(&path)?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Path relative to the project folder, always with `/` separators.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join(META_FILE)
}

pub fn read_meta(dir: &Path) -> Option<ProjectMeta> {
    let text = fs::read_to_string(meta_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Moves a `project.json` that can't be parsed aside (keeping it for the
/// user) so fresh metadata can be written. Returns the backup's name.
fn set_aside_damaged_meta(dir: &Path) -> Option<String> {
    let path = meta_path(dir);
    let text = fs::read(&path).ok()?;
    if serde_json::from_slice::<ProjectMeta>(&text).is_ok() {
        return None;
    }
    let name = format!("project.damaged-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    fs::rename(&path, path.with_file_name(&name)).ok()?;
    Some(name)
}

fn write_meta(dir: &Path, meta: &ProjectMeta) -> AppResult<()> {
    write_meta_file(dir, META_FILE, serde_json::to_string_pretty(meta)?.as_bytes())
}

fn new_meta(name: String, main_document: Option<String>) -> ProjectMeta {
    ProjectMeta {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        main_document,
        engine: Engine::default(),
        created_at: Utc::now(),
        format_version: FORMAT_VERSION,
        output_pdf: None,
    }
}

/// Returns the project's metadata, creating it for a plain LaTeX folder.
pub fn ensure_meta(dir: &Path) -> AppResult<ProjectMeta> {
    if let Some(meta) = read_meta(dir) {
        return Ok(meta);
    }
    set_aside_damaged_meta(dir);
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());
    let meta = new_meta(name, detect_main_document(dir));
    write_meta(dir, &meta)?;
    Ok(meta)
}

fn is_tex(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("tex"))
}

/// How a `.tex` file looks as a candidate main document.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MainCandidate {
    /// Relative path with `/` separators.
    pub path: String,
    pub has_documentclass: bool,
    pub has_begin_document: bool,
    /// Loads a bibliography (`\bibliography`, `\addbibresource`, …).
    pub has_bibliography: bool,
    /// Files it pulls in with `\input`, `\include`, `\subfile`…, as written
    /// (without a `.tex` extension, `/` separators).
    pub includes: Vec<String>,
}

const INCLUDE_COMMANDS: [&str; 4] = ["\\input{", "\\include{", "\\subfile{", "\\subfileinclude{"];
const BIB_COMMANDS: [&str; 4] = ["\\bibliography{", "\\addbibresource", "\\printbibliography", "\\begin{thebibliography}"];

impl MainCandidate {
    /// Classifies a file from its text. Comments don't count.
    pub fn from_text(path: String, text: &str) -> Self {
        let mut c = MainCandidate { path, ..Default::default() };
        for line in text.lines().map(strip_comment) {
            let line = line.trim_start();
            if line.is_empty() {
                continue;
            }
            c.has_documentclass |= line.starts_with("\\documentclass");
            c.has_begin_document |= line.contains("\\begin{document}");
            c.has_bibliography |= BIB_COMMANDS.iter().any(|b| line.contains(b));
            for cmd in INCLUDE_COMMANDS {
                for (at, _) in line.match_indices(cmd) {
                    let rest = &line[at + cmd.len()..];
                    if let Some(end) = rest.find('}') {
                        let target = rest[..end].trim().replace('\\', "/");
                        let target = target.strip_suffix(".tex").unwrap_or(&target).to_string();
                        if !target.is_empty() {
                            c.includes.push(target);
                        }
                    }
                }
            }
        }
        c
    }

    fn is_complete(&self) -> bool {
        self.has_documentclass && self.has_begin_document
    }
}

/// The text before an unescaped `%`.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'%' && (i == 0 || bytes[i - 1] != b'\\') {
            return &line[..i];
        }
    }
    line
}

/// Folder or file names that usually hold samples rather than the paper.
const EXAMPLE_WORDS: [&str; 10] =
    ["example", "examples", "sample", "samples", "template", "templates", "demo", "test", "tests", "skeleton"];

fn looks_like_example(path: &str) -> bool {
    path.to_lowercase()
        .split('/')
        .flat_map(|part| part.trim_end_matches(".tex").split(|c: char| !c.is_alphanumeric()))
        .any(|word| EXAMPLE_WORDS.contains(&word))
}

/// Letters and digits only, lowercased: "My_Paper" and "my-paper" match.
fn loose(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// `\input{x}` written in `from` names `x.tex` next to the main document;
/// the project root and `from`'s own folder are both tried.
fn included_paths(c: &MainCandidate) -> Vec<String> {
    let dir = c.path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    c.includes
        .iter()
        .flat_map(|t| {
            let t = t.trim_start_matches("./").to_lowercase();
            let mut out = vec![format!("{t}.tex"), t.clone()];
            if !dir.is_empty() {
                out.push(format!("{}/{t}.tex", dir.to_lowercase()));
                out.push(format!("{}/{t}", dir.to_lowercase()));
            }
            out
        })
        .collect()
}

/// Orders likely main documents, best first. Only files with
/// `\documentclass` are returned. `folder` is the project folder's name; a
/// file named like it is probably the paper.
///
/// What counts, roughly in this order: a complete document (class and
/// `\begin{document}`); not being `\input` by another file; not looking like
/// a sample (`example_*.tex`, `templates/`); being `main.tex` or named like
/// the folder; loading a bibliography and pulling in other files; being
/// near the top of the folder.
pub fn rank_main_candidates_in(candidates: &[MainCandidate], folder: Option<&str>) -> Vec<String> {
    let included: std::collections::HashSet<String> = candidates.iter().flat_map(included_paths).collect();
    let folder = folder.map(loose).filter(|f| !f.is_empty());
    let score = |c: &MainCandidate| -> i64 {
        let file = c.path.rsplit('/').next().unwrap_or("");
        let stem = file.strip_suffix(".tex").or_else(|| file.strip_suffix(".TEX")).unwrap_or(file);
        let mut s = 0;
        if c.is_complete() {
            s += 1000;
        }
        if included.contains(&c.path.to_lowercase()) {
            s -= 500;
        }
        if looks_like_example(&c.path) {
            s -= 200;
        }
        if stem.eq_ignore_ascii_case("main") {
            s += 60;
        } else if folder.as_deref().is_some_and(|f| *f == loose(stem)) {
            s += 50;
        } else if ["paper", "thesis", "manuscript", "article", "report", "ms", "dissertation"]
            .contains(&stem.to_lowercase().as_str())
        {
            s += 30;
        }
        if c.has_bibliography {
            s += 25;
        }
        s += 3 * c.includes.len().min(10) as i64;
        s -= 10 * c.path.matches('/').count() as i64;
        s
    };
    let mut ranked: Vec<(&MainCandidate, i64)> =
        candidates.iter().filter(|c| c.has_documentclass).map(|c| (c, score(c))).collect();
    ranked.sort_by(|(a, sa), (b, sb)| sb.cmp(sa).then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase())));
    ranked.into_iter().map(|(c, _)| c.path.clone()).collect()
}

/// The best main document of [`rank_main_candidates_in`], or failing that
/// any `main.tex`, or `None`.
pub fn rank_main_candidates(candidates: &[MainCandidate]) -> Option<String> {
    rank_main_candidates_in(candidates, None).into_iter().next().or_else(|| {
        candidates
            .iter()
            .filter(|c| c.path.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case("main.tex")))
            .min_by_key(|c| c.path.matches('/').count())
            .map(|c| c.path.clone())
    })
}

/// Largest `.tex` file read when ranking main documents.
pub const MAX_RANKED_TEX_BYTES: u64 = 2 * 1024 * 1024;
/// How deep a paper may sit in a folder (`repo/paper/conference/main.tex`
/// is three folders down).
const MAX_SCAN_DEPTH: usize = 10;
/// Stop after this many entries, so opening a huge folder stays quick.
const MAX_RANK_ENTRIES: usize = 30_000;
/// At most this many `.tex` files are read.
const MAX_RANKED_FILES: usize = 400;
/// Folders that never hold the paper and can be huge.
pub(crate) const SKIPPED_DIRS: [&str; 10] =
    [META_DIR, ".git", ".hg", ".svn", "node_modules", "target", "__pycache__", ".venv", "venv", ".idea"];

/// What scanning a folder for main documents found.
#[derive(Debug, Default)]
pub struct MainScan {
    pub candidates: Vec<MainCandidate>,
    /// `.tex` files kept only in the cloud (OneDrive and similar), whose
    /// text couldn't be read.
    pub cloud_only: usize,
}

fn skipped_dir(e: &walkdir::DirEntry) -> bool {
    e.depth() > 0 && e.file_type().is_dir() && SKIPPED_DIRS.iter().any(|d| e.file_name() == *d)
}

/// True for OneDrive-style placeholders whose contents aren't on this PC.
#[cfg(windows)]
pub(crate) fn is_cloud_placeholder(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x1000;
    const RECALL_ON_OPEN: u32 = 0x4_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
    meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(not(windows))]
pub(crate) fn is_cloud_placeholder(_meta: &fs::Metadata) -> bool {
    false
}

/// Reads every `.tex` file (up to the limits above) as a main candidate.
pub fn scan_main_candidates(dir: &Path) -> MainScan {
    let mut scan = MainScan::default();
    for e in WalkDir::new(dir)
        .max_depth(MAX_SCAN_DEPTH)
        .into_iter()
        .filter_entry(|e| !skipped_dir(e))
        .filter_map(Result::ok)
        .take(MAX_RANK_ENTRIES)
        .filter(|e| e.file_type().is_file() && is_tex(e.path()))
        .take(MAX_RANKED_FILES)
    {
        let Ok(rel) = e.path().strip_prefix(dir) else { continue };
        let meta = e.metadata().ok();
        let small = meta.as_ref().is_some_and(|m| m.len() <= MAX_RANKED_TEX_BYTES);
        // Reading a placeholder downloads it, which is what compiling needs
        // anyway; when that fails (offline), rank by name alone.
        let bytes = if small { fs::read(e.path()).ok() } else { Some(Vec::new()) };
        if bytes.is_none() && meta.as_ref().is_some_and(is_cloud_placeholder) {
            scan.cloud_only += 1;
        }
        let text = String::from_utf8_lossy(bytes.as_deref().unwrap_or_default()).into_owned();
        scan.candidates.push(MainCandidate::from_text(to_slash(rel), &text));
    }
    scan
}

fn folder_name(dir: &Path) -> Option<String> {
    dir.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// Like [`detect_main_document`], for folders Texo didn't make, such as
/// imported archives.
pub fn detect_main_document_ranked(dir: &Path) -> Option<String> {
    let scan = scan_main_candidates(dir);
    rank_main_candidates_in(&scan.candidates, folder_name(dir).as_deref())
        .into_iter()
        .next()
        .or_else(|| rank_main_candidates(&scan.candidates))
}

/// Picks the file to compile in a folder: see [`rank_main_candidates_in`].
pub fn detect_main_document(dir: &Path) -> Option<String> {
    detect_main_document_ranked(dir)
}

pub fn to_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn summarize(dir: &Path, external: bool) -> Option<ProjectSummary> {
    let meta = read_meta(dir)?;
    let mut file_count = 0;
    let mut newest = SystemTime::UNIX_EPOCH;
    for entry in WalkDir::new(dir)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| e.file_name() != META_DIR)
        .filter_map(Result::ok)
        .take(MAX_SCAN_ENTRIES)
    {
        if entry.file_type().is_file() {
            file_count += 1;
            if let Some(modified) = entry.metadata().ok().and_then(|m| m.modified().ok()) {
                newest = newest.max(modified);
            }
        }
    }
    let last_edited = if newest == SystemTime::UNIX_EPOCH {
        meta.created_at
    } else {
        DateTime::<Utc>::from(newest)
    };
    Some(ProjectSummary {
        id: meta.id,
        name: meta.name,
        path: dir.to_string_lossy().into_owned(),
        main_document: meta.main_document,
        engine: meta.engine,
        created_at: meta.created_at,
        last_edited,
        file_count,
        external,
        thumbnail: read_thumbnail(dir),
        output_pdf: meta.output_pdf.clone(),
        missing: false,
        needs_setup: false,
        notices: Vec::new(),
        main_candidates: Vec::new(),
    })
}

/// A dashboard row for a listed folder that can't be read, so the user can
/// find it again or remove it instead of it silently disappearing.
fn missing_summary(dir: &Path) -> ProjectSummary {
    let epoch = DateTime::<Utc>::from(SystemTime::UNIX_EPOCH);
    ProjectSummary {
        id: format!("missing:{}", to_slash(dir)),
        name: folder_name(dir).unwrap_or_else(|| to_slash(dir)),
        path: dir.to_string_lossy().into_owned(),
        main_document: None,
        engine: Engine::default(),
        created_at: epoch,
        last_edited: epoch,
        file_count: 0,
        external: true,
        thumbnail: None,
        output_pdf: None,
        missing: true,
        needs_setup: false,
        notices: Vec::new(),
        main_candidates: Vec::new(),
    }
}

/// A dashboard row for a listed folder that exists but whose project info
/// can't be read: it opens normally (Texo sets it up again), instead of
/// claiming the folder is gone.
fn unreadable_summary(dir: &Path) -> ProjectSummary {
    let changed = fs::metadata(dir).and_then(|m| m.modified()).map(DateTime::<Utc>::from);
    let mut row = missing_summary(dir);
    row.id = format!("unread:{}", to_slash(dir));
    if let Ok(t) = changed {
        row.created_at = t;
        row.last_edited = t;
    }
    row.missing = false;
    row.needs_setup = true;
    row
}

/// Every project in `root`, plus the external folders that still exist.
pub fn list(root: &Path, external: &[PathBuf]) -> Vec<ProjectSummary> {
    let mut out: Vec<ProjectSummary> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| summarize(&e.path(), false))
        .collect();
    out.extend(external.iter().map(|p| {
        summarize(p, true).unwrap_or_else(|| if p.is_dir() { unreadable_summary(p) } else { missing_summary(p) })
    }));
    out
}

// ---------------------------------------------------------------------------
// Opening a folder (or a .tex file) chosen by the user

/// Marks an error the UI answers by offering an editable copy.
pub const READ_ONLY_MARK: &str = "[read-only] ";

/// Windows' "cloud file" errors (OneDrive and similar not running, file not
/// downloaded, provider busy…).
#[cfg(windows)]
const CLOUD_ERRORS: std::ops::RangeInclusive<i32> = 358..=406;

/// Turns a file-system error from opening a project into a plain sentence.
/// `writing` is true when Texo was saving its own files in the folder.
pub fn explain_io(e: std::io::Error, writing: bool) -> AppError {
    let code = e.raw_os_error();
    #[cfg(windows)]
    {
        if code.is_some_and(|c| CLOUD_ERRORS.contains(&c)) {
            return AppError::msg(
                "This folder is in OneDrive (or another cloud folder) and some of its files aren't on this PC right now. \
                 Check that you're online and OneDrive is running, or in File Explorer right-click the folder and \
                 choose “Always keep on this device”, then try again.",
            );
        }
        if code == Some(206) {
            return AppError::msg(
                "This folder's location is too long for Windows. Move it closer to the top of a drive (for example C:\\Papers) and open it again.",
            );
        }
    }
    // EROFS on Linux and macOS; "write protected" on Windows.
    let read_only_fs = if cfg!(windows) { code == Some(19) } else { code == Some(30) };
    if writing && (read_only_fs || e.kind() == ErrorKind::PermissionDenied) {
        return AppError::msg(format!(
            "{READ_ONLY_MARK}Texo can't save its own files (the hidden .texo folder with the build and the PDF) in this \
             folder, because it is read-only or you aren't allowed to change it. You can make an editable copy in your \
             projects folder."
        ));
    }
    if e.kind() == ErrorKind::PermissionDenied {
        return AppError::msg("You don't have permission to open this folder.");
    }
    e.into()
}

fn explain(e: AppError, writing: bool) -> AppError {
    match e {
        AppError::Io(io) => explain_io(io, writing),
        other => other,
    }
}

/// The folder to open for a path the user picked or dropped, and the file
/// inside it when they picked a `.tex` file rather than a folder.
pub fn resolve_open_target(path: &Path, home: Option<&Path>) -> AppResult<(PathBuf, Option<String>)> {
    let shell = [
        (dirs::desktop_dir(), "Desktop"),
        (dirs::download_dir(), "Downloads"),
        (dirs::document_dir(), "Documents"),
    ];
    let shell: Vec<(PathBuf, &str)> = shell.into_iter().filter_map(|(d, n)| Some((d?, n))).collect();
    resolve_open_target_with(path, home, &shell)
}

/// [`resolve_open_target`] with the user's well-known folders given.
/// Desktop, Downloads and Documents hold many unrelated files, and as a
/// project Texo would keep its files there, scan it and keep its history.
fn resolve_open_target_with(path: &Path, home: Option<&Path>, shell: &[(PathBuf, &str)]) -> AppResult<(PathBuf, Option<String>)> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(AppError::msg(
                "Texo can't find that folder. It may have been moved, renamed or deleted, or it's on a drive that isn't connected.",
            ))
        }
        Err(e) => return Err(explain_io(e, false)),
    };
    let (dir, file) = if meta.is_file() {
        if !is_tex(path) {
            return Err(AppError::msg("Texo opens folders and .tex files. Pick the folder that holds your LaTeX files."));
        }
        let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        (dir.to_path_buf(), path.file_name().map(|n| n.to_string_lossy().into_owned()))
    } else {
        (path.to_path_buf(), None)
    };
    if dir.parent().is_none() {
        return Err(AppError::msg("That's a whole drive. Pick the folder that holds your LaTeX files."));
    }
    if home.is_some_and(|h| same_path(h, &dir)) {
        return Err(AppError::msg("That's your home folder. Pick the folder that holds your LaTeX files."));
    }
    if let Some((_, name)) = shell.iter().find(|(d, _)| same_path(d, &dir)) {
        // A folder that already is a Texo project keeps working.
        if !meta_path(&dir).is_file() {
            let what = if file.is_some() { "That file is right in" } else { "That's" };
            return Err(AppError::msg(format!(
                "{what} your {name} folder, which holds lots of other files. Texo would treat all of them as one project. \
                 Make a new folder for the paper, move the .tex file and its pictures and .bib into it, and open that folder."
            )));
        }
    }
    Ok((dir, file))
}

/// `project.json`, or `None` when there is none or it is damaged. An error
/// only when the file exists but can't be read (offline cloud file…), so a
/// readable-later project is never replaced.
fn read_meta_strict(dir: &Path) -> AppResult<Option<ProjectMeta>> {
    match fs::read(meta_path(dir)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(explain_io(e, false)),
    }
}

/// Paths longer than this risk failing in TeX tools on Windows once the
/// build folder and file names are added.
const LONG_PATH_WARNING: usize = 200;

/// Opens `dir` as a project: reads (or creates) its metadata, re-detects a
/// main document that no longer exists, and collects what the user should
/// hear about. `file` is a `.tex` file in `dir` the user opened directly; it
/// becomes the main document when it starts a document.
pub fn open(dir: &Path, file: Option<&str>, external: bool) -> AppResult<ProjectSummary> {
    let mut notices = Vec::new();
    let (mut meta, adopted) = match read_meta_strict(dir)? {
        Some(meta) => (meta, false),
        None => {
            if let Some(kept) = set_aside_damaged_meta(dir) {
                notices.push(format!(
                    "Texo's project info in this folder was damaged, so it was set up again (the old file was kept as .texo/{kept}). Your LaTeX files are untouched."
                ));
            }
            (new_meta(folder_name(dir).unwrap_or_else(|| "Untitled".into()), None), true)
        }
    };
    let mut changed = adopted;
    let exists = |m: &Option<String>| m.as_deref().is_some_and(|m| dir.join(m).is_file());

    if let Some(file) = file {
        let text = fs::read(dir.join(file)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        if MainCandidate::from_text(file.to_string(), &text).has_documentclass {
            if meta.main_document.as_deref() != Some(file) {
                if !adopted && exists(&meta.main_document) {
                    notices.push(format!(
                        "Texo will now compile “{file}” (before, it compiled “{}”).",
                        meta.main_document.as_deref().unwrap_or_default()
                    ));
                }
                meta.main_document = Some(file.to_string());
                changed = true;
            }
        } else if exists(&meta.main_document) {
            notices.push(format!(
                "“{file}” is part of this project; Texo compiles “{}”, which includes the rest.",
                meta.main_document.as_deref().unwrap_or_default()
            ));
        }
    }

    let mut candidates = Vec::new();
    if !exists(&meta.main_document) {
        let scan = scan_main_candidates(dir);
        let ranked = rank_main_candidates_in(&scan.candidates, folder_name(dir).as_deref());
        let old = meta.main_document.take();
        meta.main_document = ranked.first().cloned().or_else(|| rank_main_candidates(&scan.candidates));
        changed = true;
        match (&old, &meta.main_document) {
            (Some(old), Some(new)) => notices.push(format!(
                "The main file “{old}” is no longer in this folder, so Texo will compile “{new}” instead."
            )),
            (Some(old), None) => notices.push(format!(
                "The main file “{old}” is no longer in this folder, and no other file starts a LaTeX document \
                 (a .tex file with a \\documentclass line). Add one, or right-click a .tex file and choose “Set as main document”."
            )),
            (None, None) => notices.push(
                "Texo didn't find a LaTeX document here (a .tex file with a \\documentclass line, which starts a document). \
                 Add one, or right-click a .tex file and choose “Set as main document”."
                    .to_string(),
            ),
            (None, Some(_)) => {}
        }
        if scan.cloud_only > 0 {
            notices.push(format!(
                "{} .tex file{} in this folder {} kept only in OneDrive (or another cloud folder) and couldn't be read. \
                 In File Explorer, right-click the folder and choose “Always keep on this device” so Texo can compile it.",
                scan.cloud_only,
                if scan.cloud_only == 1 { "" } else { "s" },
                if scan.cloud_only == 1 { "is" } else { "are" },
            ));
        }
        // Offer a choice only among complete documents when there are any.
        let complete = |p: &String| scan.candidates.iter().any(|c| &c.path == p && c.is_complete());
        candidates = if ranked.iter().any(complete) { ranked.into_iter().filter(complete).collect() } else { ranked };
    }

    if changed {
        write_meta(dir, &meta).map_err(|e| explain(e, true))?;
    }
    let mut summary = summarize(dir, external).ok_or_else(|| AppError::msg("Couldn't read that project."))?;
    if cfg!(windows) && dir.as_os_str().len() > LONG_PATH_WARNING {
        notices.push(
            "This folder's location is very long. If compiling fails with a “file not found” error, move the folder \
             closer to the top of a drive (for example C:\\Papers)."
                .to_string(),
        );
    }
    summary.notices = notices;
    if candidates.len() > 1 {
        candidates.truncate(8);
        summary.main_candidates = candidates;
    }
    Ok(summary)
}

/// Before compiling: if the main document was deleted or renamed since the
/// project was opened, picks another one. Returns what to tell the user.
pub fn repair_main_document(dir: &Path) -> AppResult<(ProjectMeta, Option<String>)> {
    let mut meta = ensure_meta(dir)?;
    let Some(old) = meta.main_document.clone() else { return Ok((meta, None)) };
    if dir.join(&old).is_file() {
        return Ok((meta, None));
    }
    meta.main_document = detect_main_document(dir);
    write_meta(dir, &meta)?;
    let note = match &meta.main_document {
        Some(new) => format!("The main file “{old}” is no longer in the project, so Texo compiled “{new}” instead. Right-click a .tex file and choose “Set as main document” to change it."),
        None => format!("The main file “{old}” is no longer in the project. Right-click a .tex file and choose “Set as main document”."),
    };
    Ok((meta, Some(note)))
}

/// Biggest folder [`copy_into`] copies.
const MAX_COPY_FILES: usize = 20_000;
const MAX_COPY_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Copies a folder Texo can't write to into `root` as a new project (for
/// read-only folders). Version control and Texo's own folders are left out.
/// `file` is a `.tex` file in `src` the user opened directly.
pub fn copy_into(src: &Path, file: Option<&str>, root: &Path) -> AppResult<ProjectSummary> {
    let mut files = Vec::new();
    let mut bytes = 0u64;
    for e in WalkDir::new(src).min_depth(1).into_iter().filter_entry(|e| !skipped_dir(e)) {
        let e = e.map_err(|e| AppError::msg(e.to_string()))?;
        if e.file_type().is_file() {
            bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(e.into_path());
        }
        if files.len() > MAX_COPY_FILES || bytes > MAX_COPY_BYTES {
            return Err(AppError::msg(
                "That folder is too big to copy (over 20,000 files or 2 GB). Copy just the folder with your paper and open that.",
            ));
        }
    }
    let name = folder_name(src).unwrap_or_else(|| "Untitled".into());
    fs::create_dir_all(root)?;
    let target = unique_dir(root, &name);
    let copy = || -> AppResult<()> {
        fs::create_dir_all(&target)?;
        for file in &files {
            let rel = file.strip_prefix(src).map_err(|e| AppError::msg(e.to_string()))?;
            let dest = target.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(file, &dest)?;
        }
        Ok(())
    };
    if let Err(e) = copy() {
        // Only ever the folder this call just created.
        let _ = fs::remove_dir_all(&target);
        return Err(explain(e, false));
    }
    open(&target, file, false)
}

pub const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turns a display name into a folder name Windows will accept.
pub fn sanitize_folder_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let mut cleaned: String = replaced
        .trim()
        .trim_end_matches(['.', ' '])
        .chars()
        .take(80)
        .collect();
    cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        cleaned = "Untitled".into();
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        cleaned.push('_');
    }
    cleaned
}

/// `root/name`, or `root/name (2)`, `root/name (3)`… if that is taken.
pub fn unique_dir(root: &Path, name: &str) -> PathBuf {
    let base = sanitize_folder_name(name);
    let mut candidate = root.join(&base);
    let mut n = 2;
    while candidate.exists() {
        candidate = root.join(format!("{base} ({n})"));
        n += 1;
    }
    candidate
}

fn clean_display_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Project name can't be empty."));
    }
    Ok(name.to_string())
}

/// Writes fresh metadata for a folder Texo just filled (an imported archive)
/// and returns its summary.
pub fn adopt(dir: &Path, name: &str, main_document: Option<String>, engine: Engine) -> AppResult<ProjectSummary> {
    let mut meta = new_meta(clean_display_name(name)?, main_document);
    meta.engine = engine;
    write_meta(dir, &meta)?;
    summarize(dir, false).ok_or_else(|| AppError::msg("The project was imported but can't be read."))
}

pub fn create(root: &Path, name: &str, template: Template) -> AppResult<ProjectSummary> {
    let name = clean_display_name(name)?;
    let dir = unique_dir(root, &name);
    fs::create_dir_all(&dir)?;
    for (rel, contents) in template.files() {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, contents)?;
    }
    write_meta(&dir, &new_meta(name, Some("main.tex".into())))?;
    summarize(&dir, false).ok_or_else(|| AppError::msg("Project was created but can't be read."))
}

/// Renames the project. Folders inside the projects folder are renamed too;
/// external folders keep their folder name. Returns the (possibly new) folder.
pub fn rename(dir: &Path, new_name: &str, rename_folder: bool) -> AppResult<PathBuf> {
    let new_name = clean_display_name(new_name)?;
    let mut meta = ensure_meta(dir)?;
    meta.name = new_name.clone();
    write_meta(dir, &meta)?;

    if !rename_folder {
        return Ok(dir.to_path_buf());
    }
    let Some(parent) = dir.parent() else {
        return Ok(dir.to_path_buf());
    };
    let wanted = sanitize_folder_name(&new_name);
    let current = dir.file_name().map(|n| n.to_string_lossy().into_owned());
    // Case-only changes are fine on Windows, so compare exactly.
    if current.as_deref() == Some(wanted.as_str()) {
        return Ok(dir.to_path_buf());
    }
    let target = if current
        .as_deref()
        .is_some_and(|c| c.eq_ignore_ascii_case(&wanted))
    {
        parent.join(&wanted)
    } else {
        unique_dir(parent, &new_name)
    };
    match fs::rename(dir, &target) {
        Ok(()) => Ok(target),
        // The folder may be open in Explorer or another app; keep the old
        // folder name rather than failing the rename.
        Err(_) => Ok(dir.to_path_buf()),
    }
}

/// `.texo/history`, its settings file and any `history.broken-*` folders:
/// a copy starts with a fresh history.
fn is_history_data(rel: &Path) -> bool {
    let mut parts = rel.components();
    parts.next().is_some_and(|c| c.as_os_str() == META_DIR)
        && parts.next().is_some_and(|c| c.as_os_str().to_string_lossy().starts_with("history"))
}

/// Copies the project into `root` as "Copy of …", with a fresh id. Version
/// history and build files are not copied.
pub fn duplicate(dir: &Path, root: &Path) -> AppResult<ProjectSummary> {
    let source = ensure_meta(dir)?;
    let name = format!("Copy of {}", source.name);
    let target = unique_dir(root, &name);
    let build = Path::new(META_DIR).join("build");

    for entry in WalkDir::new(dir).min_depth(1) {
        let entry = entry.map_err(|e| AppError::msg(e.to_string()))?;
        let rel = entry
            .path()
            .strip_prefix(dir)
            .map_err(|e| AppError::msg(e.to_string()))?;
        if is_history_data(rel) || rel.starts_with(&build) {
            continue;
        }
        let dest = target.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &dest)?;
        }
    }
    fs::create_dir_all(&target)?;

    let mut meta = new_meta(name, source.main_document);
    meta.engine = source.engine;
    write_meta(&target, &meta)?;
    summarize(&target, false).ok_or_else(|| AppError::msg("Copy was created but can't be read."))
}

/// Sets the file to compile. `file` is relative, with `/` separators.
pub fn set_main_document(dir: &Path, file: &str) -> AppResult<()> {
    if !dir.join(file).is_file() {
        return Err(AppError::msg("That file doesn't exist."));
    }
    let mut meta = ensure_meta(dir)?;
    meta.main_document = Some(file.replace('\\', "/"));
    write_meta(dir, &meta)
}

pub fn set_engine(dir: &Path, engine: Engine) -> AppResult<()> {
    let mut meta = ensure_meta(dir)?;
    meta.engine = engine;
    write_meta(dir, &meta)
}

/// Copies the compiled PDF next to the main document (`paper/main.tex` →
/// `paper/main.pdf`), so the project folder always holds the latest PDF.
///
/// Texo only ever replaces a PDF it wrote itself: if the user already has a
/// file with that name, the copy goes to `main (compiled).pdf` instead, and
/// if that is taken too, nothing is saved. Returns the project-relative path.
pub fn save_output_pdf(dir: &Path, main: &str, built: &Path) -> AppResult<Option<String>> {
    let mut meta = ensure_meta(dir)?;
    let main_rel = Path::new(main);
    let stem = main_rel.file_stem().unwrap_or_default().to_string_lossy();
    let folder = main_rel.parent().unwrap_or(Path::new(""));
    let candidates = [format!("{stem}.pdf"), format!("{stem} (compiled).pdf")]
        .map(|name| to_slash(&folder.join(name)));
    let Some(target) = candidates
        .into_iter()
        .find(|c| meta.output_pdf.as_deref() == Some(c.as_str()) || !dir.join(c).exists())
    else {
        return Ok(None);
    };

    // Copy through a temporary file (ignored by the folder watcher) and a
    // rename, so a half-written PDF never appears and a link at the target
    // is replaced rather than written through.
    let dest = dir.join(&target);
    let tmp = dest.with_file_name(format!(".{}.texo-tmp", dest.file_name().unwrap_or_default().to_string_lossy()));
    if is_link(&tmp) {
        fs::remove_file(&tmp)?;
    }
    fs::copy(built, &tmp)?;
    if let Err(e) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    if meta.output_pdf.as_deref() != Some(target.as_str()) {
        meta.output_pdf = Some(target.clone());
        write_meta(dir, &meta)?;
    }
    Ok(Some(target))
}

/// Moves the project folder to the Recycle Bin, so it can be recovered.
pub fn delete(dir: &Path) -> AppResult<()> {
    trash::delete(dir)?;
    Ok(())
}

/// The project's files and folders, without Texo's own metadata.
pub fn list_files(dir: &Path) -> Vec<FileEntry> {
    let mut out: Vec<FileEntry> = WalkDir::new(dir)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| e.file_name() != META_DIR)
        .filter_map(Result::ok)
        .take(MAX_SCAN_ENTRIES)
        .filter_map(|e| {
            let rel = e.path().strip_prefix(dir).ok()?;
            Some(FileEntry {
                path: to_slash(rel),
                is_dir: e.file_type().is_dir(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
            })
        })
        .collect();
    out.sort_by_key(|e| e.path.to_lowercase());
    out
}

/// Compares paths the way Windows does: case-insensitive, ignoring a
/// trailing separator and the separator style.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = to_slash(p).trim_end_matches('/').to_string();
        // Windows paths are case-insensitive; Linux paths are not.
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_windows_folder_names() {
        assert_eq!(sanitize_folder_name("My: Paper?"), "My- Paper-");
        assert_eq!(sanitize_folder_name("  trailing dots... "), "trailing dots");
        assert_eq!(sanitize_folder_name("con"), "con_");
        assert_eq!(sanitize_folder_name("COM1.tex"), "COM1.tex_");
        assert_eq!(sanitize_folder_name("   "), "Untitled");
        assert_eq!(sanitize_folder_name(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn create_picks_unique_folders_and_lists_them() {
        let root = tempfile::tempdir().unwrap();
        let a = create(root.path(), "Thesis", Template::Blank).unwrap();
        let b = create(root.path(), "Thesis", Template::Example).unwrap();
        assert!(a.path.ends_with("Thesis"));
        assert!(b.path.ends_with("Thesis (2)"));
        assert_eq!(b.file_count, 2);
        assert_ne!(a.id, b.id);
        assert!(create(root.path(), "  ", Template::Blank).is_err());

        let listed = list(root.path(), &[]);
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|p| p.main_document.as_deref() == Some("main.tex")));
    }

    #[test]
    fn detects_main_document_without_main_tex() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("chapter.tex"), "\\section{A}").unwrap();
        fs::create_dir_all(dir.path().join("paper")).unwrap();
        fs::write(
            dir.path().join("paper").join("article.tex"),
            "% comment\n\\documentclass{article}\n",
        )
        .unwrap();
        assert_eq!(detect_main_document(dir.path()).as_deref(), Some("paper/article.tex"));

        // An empty main.tex no longer beats a real document…
        fs::write(dir.path().join("main.tex"), "").unwrap();
        assert_eq!(detect_main_document(dir.path()).as_deref(), Some("paper/article.tex"));
        // …but a main.tex that starts a document does.
        fs::write(dir.path().join("main.tex"), "\\documentclass{article}").unwrap();
        assert_eq!(detect_main_document(dir.path()).as_deref(), Some("main.tex"));
    }

    const FULL: &str = "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn ranks_the_paper_above_template_examples() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("E_L2R");
        // An Elsevier-style folder: the class's sample documents next to the paper.
        write(&root, "cas-dc-template.tex", FULL);
        write(&root, "example_sc.tex", FULL);
        write(&root, "L2R.tex", "\\documentclass{cas-dc}\n\\begin{document}\n\\input{sections/intro}\n\\bibliography{AHR}\n\\end{document}\n");
        write(&root, "sections/intro.tex", "\\section{Intro}");
        assert_eq!(detect_main_document(&root).as_deref(), Some("L2R.tex"));

        // A file named like the folder wins among otherwise equal documents.
        let named = dir.path().join("my-thesis");
        write(&named, "a.tex", FULL);
        write(&named, "My_Thesis.tex", FULL);
        assert_eq!(detect_main_document(&named).as_deref(), Some("My_Thesis.tex"));

        // A complete document that another one \\inputs (a standalone
        // chapter) isn't the main one.
        let c = |path: &str, text: &str| MainCandidate::from_text(path.into(), text);
        let ranked = rank_main_candidates_in(
            &[c("chapters/one.tex", FULL), c("book.tex", &format!("{FULL}\\include{{chapters/one}}"))],
            None,
        );
        assert_eq!(ranked, vec!["book.tex", "chapters/one.tex"]);
        // Comments, including trailing ones, don't count.
        assert!(!c("x.tex", "text % \\documentclass{article}").has_documentclass);
        assert!(c("x.tex", "\\documentclass{article} % main").has_documentclass);
    }

    #[test]
    fn finds_a_paper_nested_deep_in_a_code_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        write(&repo, "src/model/train.py", "print()");
        write(&repo, "node_modules/pkg/docs/sample.tex", FULL);
        write(&repo, "paper/conference/2026/camera-ready/final/main.tex", FULL);
        assert_eq!(
            detect_main_document(&repo).as_deref(),
            Some("paper/conference/2026/camera-ready/final/main.tex")
        );
    }

    #[test]
    fn opening_a_project_whose_main_document_is_gone_re_detects_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Paper");
        write(&root, "main.tex", FULL);
        let first = open(&root, None, true).unwrap();
        assert_eq!(first.main_document.as_deref(), Some("main.tex"));
        assert!(first.notices.is_empty(), "{:?}", first.notices);

        fs::rename(root.join("main.tex"), root.join("paper.tex")).unwrap();
        let again = open(&root, None, true).unwrap();
        assert_eq!(again.main_document.as_deref(), Some("paper.tex"));
        assert!(again.notices[0].contains("“main.tex” is no longer"), "{:?}", again.notices);
        assert_eq!(again.id, first.id, "same project, not a new one");

        // Compiling repairs it too, with a hint for the compile panel.
        fs::rename(root.join("paper.tex"), root.join("renamed.tex")).unwrap();
        let (meta, note) = repair_main_document(&root).unwrap();
        assert_eq!(meta.main_document.as_deref(), Some("renamed.tex"));
        assert!(note.unwrap().contains("renamed.tex"));
        assert!(repair_main_document(&root).unwrap().1.is_none());
    }

    #[test]
    fn opening_offers_a_choice_when_several_files_could_be_the_main_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Talks");
        write(&root, "slides.tex", FULL);
        write(&root, "handout.tex", FULL);
        write(&root, "notes.tex", "\\section{Not a document}");
        let opened = open(&root, None, true).unwrap();
        assert_eq!(opened.main_candidates, vec!["handout.tex", "slides.tex"]);
        // Once chosen, opening again doesn't ask again.
        set_main_document(&root, "slides.tex").unwrap();
        assert!(open(&root, None, true).unwrap().main_candidates.is_empty());
    }

    #[test]
    fn opening_a_tex_file_opens_its_folder_and_compiles_that_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Work");
        write(&root, "main.tex", FULL);
        write(&root, "poster.tex", FULL);
        write(&root, "part.tex", "\\section{A}");

        let (folder, file) = resolve_open_target(&root.join("poster.tex"), None).unwrap();
        assert_eq!(folder, root);
        assert_eq!(file.as_deref(), Some("poster.tex"));
        let opened = open(&folder, file.as_deref(), true).unwrap();
        assert_eq!(opened.main_document.as_deref(), Some("poster.tex"));
        assert!(opened.main_candidates.is_empty(), "the user already chose");

        // A fragment keeps the current main document, and says why.
        let opened = open(&root, Some("part.tex"), true).unwrap();
        assert_eq!(opened.main_document.as_deref(), Some("poster.tex"));
        assert!(opened.notices[0].contains("part.tex"));

        assert!(resolve_open_target(&root.join("notes.pdf"), None).is_err());
        fs::write(root.join("notes.pdf"), "%PDF").unwrap();
        let err = resolve_open_target(&root.join("notes.pdf"), None).unwrap_err().to_string();
        assert!(err.contains(".tex files"), "{err}");
    }

    #[test]
    fn explains_folders_that_cannot_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let gone = resolve_open_target(&dir.path().join("moved away"), None).unwrap_err().to_string();
        assert!(gone.contains("can't find that folder"), "{gone}");
        let home = resolve_open_target(dir.path(), Some(dir.path())).unwrap_err().to_string();
        assert!(home.contains("home folder"), "{home}");
        let drive = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(resolve_open_target(Path::new(drive), None).unwrap_err().to_string().contains("whole drive"));

        // Read-only folders get a plain explanation the UI can act on.
        let denied = std::io::Error::from(ErrorKind::PermissionDenied);
        let text = explain_io(denied, true).to_string();
        assert!(text.starts_with(READ_ONLY_MARK) && text.contains("read-only"), "{text}");
        let text = explain_io(std::io::Error::from(ErrorKind::PermissionDenied), false).to_string();
        assert!(!text.starts_with(READ_ONLY_MARK));
        #[cfg(windows)]
        {
            let cloud = explain_io(std::io::Error::from_raw_os_error(362), false).to_string();
            assert!(cloud.contains("OneDrive"), "{cloud}");
        }
    }

    #[test]
    fn opens_folders_with_awkward_names_and_long_paths() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["My Paper, final (v2)", "Tez çalışması – 論文", "a&b;c'd"] {
            let root = dir.path().join(name);
            write(&root, "main file.tex", FULL);
            let opened = open(&root, None, true).unwrap();
            assert_eq!(opened.name, name);
            assert_eq!(opened.main_document.as_deref(), Some("main file.tex"));
            assert_eq!(list(dir.path().join("none").as_path(), std::slice::from_ref(&root))[0].id, opened.id);
        }
        // Deeper than Windows' classic 260-character limit.
        let mut deep = dir.path().join("long");
        while deep.as_os_str().len() < 300 {
            deep = deep.join("a folder with a fairly long name");
        }
        write(&deep, "main.tex", FULL);
        let opened = open(&deep, None, true).unwrap();
        assert_eq!(opened.main_document.as_deref(), Some("main.tex"));
        if cfg!(windows) {
            assert!(opened.notices.iter().any(|n| n.contains("very long")), "{:?}", opened.notices);
        }
    }

    #[test]
    fn a_damaged_project_file_is_kept_and_the_project_set_up_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Paper");
        write(&root, "main.tex", FULL);
        write(&root, ".texo/project.json", "{ broken");
        let opened = open(&root, None, true).unwrap();
        assert_eq!(opened.main_document.as_deref(), Some("main.tex"));
        assert!(opened.notices[0].contains("damaged"), "{:?}", opened.notices);
        let kept = fs::read_dir(root.join(META_DIR))
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("project.damaged-"))
            .count();
        assert_eq!(kept, 1);
    }

    #[test]
    fn lists_missing_external_folders_instead_of_hiding_them() {
        let root = tempfile::tempdir().unwrap();
        let away = root.path().join("Moved paper");
        let listed = list(&root.path().join("projects"), std::slice::from_ref(&away));
        assert_eq!(listed.len(), 1);
        assert!(listed[0].missing && listed[0].external);
        assert_eq!(listed[0].name, "Moved paper");
        // Back in place, it lists normally again.
        write(&away, "main.tex", FULL);
        open(&away, None, true).unwrap();
        assert!(!list(&root.path().join("projects"), std::slice::from_ref(&away))[0].missing);

        // Its project info deleted or damaged: the folder is still there, so
        // it isn't "not found"; opening it sets it up again.
        fs::remove_file(meta_path(&away)).unwrap();
        let row = &list(&root.path().join("projects"), std::slice::from_ref(&away))[0];
        assert!(!row.missing && row.needs_setup && row.external, "{row:?}");
        assert_eq!(row.name, "Moved paper");
        assert!(open(&away, None, true).is_ok());
        assert!(!list(&root.path().join("projects"), &[away])[0].needs_setup);
    }

    #[test]
    fn refuses_desktop_downloads_and_documents_as_projects() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = dir.path().join("Downloads");
        write(&downloads, "paper.tex", FULL);
        write(&downloads, "setup.exe", "");
        let shell = [(downloads.clone(), "Downloads")];
        let err = resolve_open_target_with(&downloads.join("paper.tex"), None, &shell).unwrap_err().to_string();
        assert!(err.contains("right in your Downloads folder") && err.contains("new folder"), "{err}");
        let err = resolve_open_target_with(&downloads, None, &shell).unwrap_err().to_string();
        assert!(err.starts_with("That's your Downloads folder"), "{err}");
        // A subfolder is fine.
        let paper = downloads.join("paper");
        write(&paper, "main.tex", FULL);
        assert!(resolve_open_target_with(&paper.join("main.tex"), None, &shell).is_ok());
        // One that already is a Texo project keeps opening.
        open(&downloads, None, true).unwrap();
        assert!(resolve_open_target_with(&downloads.join("paper.tex"), None, &shell).is_ok());
    }

    #[test]
    fn copies_a_read_only_folder_into_the_projects_folder() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("Shared paper");
        write(&src, "main.tex", FULL);
        write(&src, "figs/a.png", "png");
        write(&src, ".git/HEAD", "ref");
        write(&src, ".texo/project.json", "{}");
        let projects = dir.path().join("Texo");
        let copy = copy_into(&src, None, &projects).unwrap();
        let target = PathBuf::from(&copy.path);
        assert!(target.starts_with(&projects));
        assert!(target.join("figs/a.png").is_file());
        assert!(!target.join(".git").exists());
        assert_eq!(copy.main_document.as_deref(), Some("main.tex"));
        assert!(!copy.external);

        // A .tex file opened directly stays the main document in the copy.
        write(&src, "poster.tex", FULL);
        let copy = copy_into(&src, Some("poster.tex"), &projects).unwrap();
        assert!(copy.path.ends_with("Shared paper (2)"), "{}", copy.path);
        assert_eq!(copy.main_document.as_deref(), Some("poster.tex"));
    }

    /// Unix only: Windows' read-only attribute doesn't stop new files in a folder.
    #[cfg(unix)]
    #[test]
    fn opening_a_read_only_folder_says_so_and_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Locked");
        write(&root, "main.tex", FULL);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(root.join("probe"), "").is_ok() {
            return; // running as root: permissions aren't enforced
        }
        let err = open(&root, None, true).unwrap_err().to_string();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.starts_with(READ_ONLY_MARK), "{err}");
        assert!(!root.join(META_DIR).exists());
    }

    #[test]
    fn ranks_main_documents_for_imported_folders() {
        let c = |path: &str, text: &str| MainCandidate::from_text(path.into(), text);
        let full = "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";
        // A complete document beats a main.tex that is only a fragment.
        assert_eq!(
            rank_main_candidates(&[c("main.tex", "\\section{A}"), c("paper/paper.tex", full)]).as_deref(),
            Some("paper/paper.tex")
        );
        // Among complete documents, main.tex wins, then the shallowest.
        assert_eq!(rank_main_candidates(&[c("a/z.tex", full), c("b/main.tex", full)]).as_deref(), Some("b/main.tex"));
        assert_eq!(rank_main_candidates(&[c("a/b/x.tex", full), c("y.tex", full)]).as_deref(), Some("y.tex"));
        // A commented-out class doesn't count.
        assert!(!c("x.tex", "% \\documentclass{article}").has_documentclass);
        assert_eq!(rank_main_candidates(&[]), None);

        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("notes.tex"), "\\section{Notes}").unwrap();
        fs::write(dir.path().join("src").join("thesis.tex"), full).unwrap();
        assert_eq!(detect_main_document_ranked(dir.path()).as_deref(), Some("src/thesis.tex"));
    }

    #[test]
    fn ensure_meta_adopts_a_plain_folder() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("Old paper");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("paper.tex"), "\\documentclass{article}").unwrap();
        let meta = ensure_meta(&dir).unwrap();
        assert_eq!(meta.name, "Old paper");
        assert_eq!(meta.main_document.as_deref(), Some("paper.tex"));
        // A second call reads the same metadata back.
        assert_eq!(ensure_meta(&dir).unwrap().id, meta.id);
    }

    #[test]
    fn rename_moves_folder_inside_root_only() {
        let root = tempfile::tempdir().unwrap();
        let p = create(root.path(), "Draft", Template::Blank).unwrap();
        let moved = rename(Path::new(&p.path), "Final: v2", true).unwrap();
        assert!(moved.ends_with("Final- v2"));
        assert_eq!(read_meta(&moved).unwrap().name, "Final: v2");

        let kept = rename(&moved, "Elsewhere", false).unwrap();
        assert_eq!(kept, moved);
        assert_eq!(read_meta(&kept).unwrap().name, "Elsewhere");
    }

    /// Makes a Windows junction (a directory link that needs no admin rights).
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }

    #[cfg(windows)]
    #[test]
    fn never_writes_through_linked_metadata_folders() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dir = root.path().join("Paper");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tex"), "\\documentclass{article}").unwrap();

        // `.texo` itself is a link: metadata and thumbnails are refused.
        junction(&dir.join(META_DIR), outside.path());
        assert!(ensure_meta(&dir).is_err());
        assert!(save_thumbnail(&dir, b"\x89PNG\r\n\x1a\nrest").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0, "wrote outside the project");
        fs::remove_dir(dir.join(META_DIR)).unwrap(); // removes the link only

        // `.texo/build` is a link: the build folder is refused.
        fs::create_dir_all(dir.join(META_DIR)).unwrap();
        junction(&dir.join(META_DIR).join("build"), outside.path());
        assert!(meta_subdir(&dir, Some("build")).is_err());
        fs::remove_dir(dir.join(META_DIR).join("build")).unwrap();

        // A link planted inside the build folder is removed; its target survives.
        let build = meta_subdir(&dir, Some("build")).unwrap();
        fs::write(outside.path().join("keep.txt"), "important").unwrap();
        junction(&build.join("main.log"), outside.path());
        remove_links(&build).unwrap();
        assert!(!build.join("main.log").exists());
        assert_eq!(fs::read_to_string(outside.path().join("keep.txt")).unwrap(), "important");

        // Normal metadata writes still work and leave no temp files.
        assert!(ensure_meta(&dir).is_ok());
        assert!(save_thumbnail(&dir, b"\x89PNG\r\n\x1a\nrest").is_ok());
        let names: Vec<String> = fs::read_dir(dir.join(META_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn saves_the_pdf_next_to_the_main_document_without_clobbering_user_files() {
        let root = tempfile::tempdir().unwrap();
        let p = create(root.path(), "Paper", Template::Blank).unwrap();
        let dir = PathBuf::from(&p.path);
        let built = root.path().join("built.pdf");
        fs::write(&built, "%PDF-1 first").unwrap();

        // First save creates main.pdf and remembers it.
        assert_eq!(save_output_pdf(&dir, "main.tex", &built).unwrap().as_deref(), Some("main.pdf"));
        assert_eq!(read_meta(&dir).unwrap().output_pdf.as_deref(), Some("main.pdf"));
        // Later saves replace it: still one file, now updated.
        fs::write(&built, "%PDF-1 second").unwrap();
        assert_eq!(save_output_pdf(&dir, "main.tex", &built).unwrap().as_deref(), Some("main.pdf"));
        assert_eq!(fs::read_to_string(dir.join("main.pdf")).unwrap(), "%PDF-1 second");
        assert!(!fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".texo-tmp")));

        // A main document in a subfolder gets its PDF beside it.
        fs::create_dir_all(dir.join("thesis")).unwrap();
        assert_eq!(save_output_pdf(&dir, "thesis/book.tex", &built).unwrap().as_deref(), Some("thesis/book.pdf"));

        // The user's own report.pdf is never overwritten.
        fs::write(dir.join("report.pdf"), "mine").unwrap();
        assert_eq!(
            save_output_pdf(&dir, "report.tex", &built).unwrap().as_deref(),
            Some("report (compiled).pdf")
        );
        assert_eq!(fs::read_to_string(dir.join("report.pdf")).unwrap(), "mine");
        // …and when both names belong to the user, nothing is saved.
        fs::write(dir.join("notes.pdf"), "mine").unwrap();
        fs::write(dir.join("notes (compiled).pdf"), "also mine").unwrap();
        assert_eq!(save_output_pdf(&dir, "notes.tex", &built).unwrap(), None);
    }

    #[test]
    fn duplicate_copies_files_but_not_history() {
        let root = tempfile::tempdir().unwrap();
        let p = create(root.path(), "Paper", Template::Example).unwrap();
        let src = PathBuf::from(&p.path);
        fs::create_dir_all(src.join(META_DIR).join("history")).unwrap();
        fs::write(src.join(META_DIR).join("history").join("v1"), "old").unwrap();
        fs::write(src.join(META_DIR).join("history.json"), "{}").unwrap();
        fs::create_dir_all(src.join(META_DIR).join("history.broken-1")).unwrap();
        fs::create_dir_all(src.join(META_DIR).join("build")).unwrap();
        fs::write(src.join(META_DIR).join("build").join("main.aux"), "aux").unwrap();
        fs::create_dir_all(src.join("figures")).unwrap();

        let copy = duplicate(&src, root.path()).unwrap();
        let dst = PathBuf::from(&copy.path);
        assert_eq!(copy.name, "Copy of Paper");
        assert_ne!(copy.id, p.id);
        assert!(dst.join("references.bib").is_file());
        assert!(dst.join("figures").is_dir());
        assert!(!dst.join(META_DIR).join("history").exists());
        assert!(!dst.join(META_DIR).join("history.json").exists());
        assert!(!dst.join(META_DIR).join("history.broken-1").exists());
        assert!(!dst.join(META_DIR).join("build").exists());
    }

    #[test]
    fn list_files_hides_metadata_and_uses_slashes() {
        let root = tempfile::tempdir().unwrap();
        let p = create(root.path(), "Paper", Template::Blank).unwrap();
        let dir = PathBuf::from(&p.path);
        fs::create_dir_all(dir.join("sections")).unwrap();
        fs::write(dir.join("sections").join("intro.tex"), "hi").unwrap();
        let files: Vec<String> = list_files(&dir).into_iter().map(|f| f.path).collect();
        assert_eq!(files, vec!["main.tex", "sections", "sections/intro.tex"]);
    }

    #[cfg(windows)]
    #[test]
    fn compares_paths_like_windows() {
        assert!(same_path(Path::new("C:\\Users\\A\\Texo\\"), Path::new("c:/users/a/texo")));
        assert!(!same_path(Path::new("C:\\a"), Path::new("C:\\b")));
    }
}
