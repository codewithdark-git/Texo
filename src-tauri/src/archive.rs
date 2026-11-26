//! Moving projects in and out of Texo as archives: importing a `.zip` or
//! `.tar.gz` someone downloaded, exporting a project as a clean `.zip`, and
//! saving a copy of the latest PDF.
//!
//! Archives come from anywhere, so nothing in them is trusted. Names are
//! checked before anything is written, links and special files are skipped,
//! sizes are counted from the bytes actually written rather than the
//! headers, and everything is extracted into a hidden staging folder that is
//! removed if anything goes wrong.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use serde::Serialize;
use walkdir::WalkDir;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;

use crate::compile;
use crate::error::{AppError, AppResult};
use crate::project::{self, Engine, ProjectSummary, META_DIR};

const MIB: u64 = 1024 * 1024;

/// Most entries (files, folders, links…) an archive may hold.
pub const MAX_ENTRIES: usize = 10_000;
/// Largest single file, once extracted.
pub const MAX_FILE_BYTES: u64 = 100 * MIB;
/// Largest total of all files, once extracted.
pub const MAX_TOTAL_BYTES: u64 = 1024 * MIB;
/// Largest archive file on disk.
pub const MAX_ARCHIVE_BYTES: u64 = 2048 * MIB;
/// A zip entry larger than [`RATIO_MIN_BYTES`] may expand at most this much.
pub const MAX_ENTRY_RATIO: u64 = 200;
/// The whole archive may expand at most this much (once past [`RATIO_MIN_BYTES`]).
pub const MAX_TOTAL_RATIO: u64 = 100;
/// Small files compress very well (a page of spaces), so ratios only count above this.
pub const RATIO_MIN_BYTES: u64 = MIB;

/// Event with [`Progress`] payloads while an import or export runs.
pub const PROGRESS_EVENT: &str = "import-progress";

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

/// Archive files are never kept whole in memory, but the text of `.tex`
/// files is read for the preview, up to this much in all.
const MAX_PREVIEW_TEXT_BYTES: usize = 32 * 1024 * 1024;

const GIT_WARNING: &str = "Git history wasn't imported.";
const BOMB_MESSAGE: &str =
    "This archive expands far more than a normal project would, so it wasn't imported. It may be damaged or built to fill your disk.";
const ENCRYPTED_MESSAGE: &str =
    "This archive is password-protected. Extract it with your archive tool, then open the folder in Texo.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveKind {
    Zip,
    TarGz,
}

/// What the import dialog shows before anything is extracted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreview {
    pub kind: ArchiveKind,
    pub file_count: usize,
    pub total_bytes: u64,
    /// The single top folder that will be removed, if the archive has one.
    pub strip_prefix: Option<String>,
    /// Every `.tex` file, as it will be named in the project.
    pub tex_files: Vec<String>,
    pub suggested_main: Option<String>,
    pub suggested_name: String,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Names

/// Turns an archive entry name into a safe relative path, or `None` if it
/// must be skipped. Rejects absolute paths, drive letters, UNC paths, `..`,
/// NUL and `:`, and names Windows can't store (ending in a dot or space).
/// Windows device names such as `con` get `_` added to the name.
pub fn safe_rel(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.is_empty() || name.contains('\0') || name.contains(':') || name.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            _ => {}
        }
        if part.ends_with('.') || part.ends_with(' ') || part.chars().any(char::is_control) {
            return None;
        }
        // Characters Windows refuses in file names.
        let part: String = part
            .chars()
            .map(|c| if matches!(c, '<' | '>' | '"' | '|' | '?' | '*') { '_' } else { c })
            .collect();
        out.push(not_reserved(&part));
    }
    let normal = out.components().all(|c| matches!(c, Component::Normal(_)));
    (normal && !out.as_os_str().is_empty()).then_some(out)
}

/// `con.tex` → `con_.tex`: Windows treats device names as devices, whatever
/// the extension.
fn not_reserved(part: &str) -> String {
    let (stem, rest) = part.split_once('.').map_or((part, ""), |(s, _)| (s, &part[s.len()..]));
    if project::RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str()) {
        format!("{stem}_{rest}")
    } else {
        part.to_string()
    }
}

/// Why an entry with a safe name is still left out.
enum Skip {
    Git,
    Junk,
}

fn skip_reason(rel: &Path) -> Option<Skip> {
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    if parts.iter().any(|p| p == ".git") {
        return Some(Skip::Git);
    }
    let junk_dir = parts.iter().any(|p| p == "__macosx" || p == META_DIR);
    let junk_file = parts.last().is_some_and(|n| matches!(n.as_str(), ".ds_store" | "thumbs.db" | "desktop.ini"));
    (junk_dir || junk_file).then_some(Skip::Junk)
}

/// `name (2).ext`, `name (3).ext`…
fn numbered(name: &str, n: usize) -> String {
    let p = Path::new(name);
    match (p.file_stem(), p.extension()) {
        (Some(stem), Some(ext)) => format!("{} ({n}).{}", stem.to_string_lossy(), ext.to_string_lossy()),
        _ => format!("{name} ({n})"),
    }
}

/// Gives every entry a name that is unique without regard to case, so a
/// project extracts the same way on Windows, macOS and Linux. Folders that
/// differ only in case are merged; files get a numbered name.
#[derive(Default)]
struct Namer {
    dirs: HashMap<String, PathBuf>,
    files: HashSet<String>,
    renamed: usize,
}

fn key(path: &Path) -> String {
    project::to_slash(path).to_lowercase()
}

impl Namer {
    fn dir(&mut self, rel: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for part in rel.components() {
            let name = part.as_os_str().to_string_lossy().into_owned();
            let wanted = out.join(&name);
            if let Some(existing) = self.dirs.get(&key(&wanted)) {
                out = existing.clone();
                continue;
            }
            let mut chosen = wanted.clone();
            let mut n = 2;
            while self.files.contains(&key(&chosen)) || (n > 2 && self.dirs.contains_key(&key(&chosen))) {
                chosen = out.join(numbered(&name, n));
                n += 1;
            }
            if chosen != wanted {
                self.renamed += 1;
            }
            self.dirs.insert(key(&wanted), chosen.clone());
            self.dirs.insert(key(&chosen), chosen.clone());
            out = chosen;
        }
        out
    }

    fn file(&mut self, rel: &Path) -> PathBuf {
        let parent = rel.parent().map(|p| self.dir(p)).unwrap_or_default();
        let name = rel.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let mut chosen = parent.join(&name);
        let mut n = 2;
        while self.files.contains(&key(&chosen)) || self.dirs.contains_key(&key(&chosen)) {
            chosen = parent.join(numbered(&name, n));
            n += 1;
        }
        if n > 2 {
            self.renamed += 1;
        }
        self.files.insert(key(&chosen));
        chosen
    }
}

// ---------------------------------------------------------------------------
// Scanning: headers only, nothing written

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawKind {
    File,
    Dir,
    /// Symbolic and hard links, devices and pipes.
    Special,
    /// Bookkeeping entries such as tar global headers.
    Ignored,
}

struct RawEntry {
    ordinal: usize,
    /// `None` when the name is unsafe.
    rel: Option<PathBuf>,
    kind: RawKind,
    size: u64,
    /// Compressed size, for zip entries.
    compressed: Option<u64>,
    /// The start of a `.tex` file, when the preview asked for it.
    text: Option<Vec<u8>>,
}

/// An entry that will be extracted, with its final project-relative path.
struct Planned {
    ordinal: usize,
    rel: PathBuf,
    is_dir: bool,
    compressed: Option<u64>,
    text: Option<Vec<u8>>,
}

struct Plan {
    kind: ArchiveKind,
    archive_bytes: u64,
    entries: Vec<Planned>,
    file_count: usize,
    total_bytes: u64,
    strip_prefix: Option<String>,
    warnings: Vec<String>,
}

fn detect_kind(path: &Path) -> AppResult<(ArchiveKind, u64)> {
    let len = fs::metadata(path).map_err(|_| AppError::msg("That archive can't be opened."))?.len();
    if len > MAX_ARCHIVE_BYTES {
        return Err(AppError::msg("Archives larger than 2 GiB can't be imported."));
    }
    let mut magic = [0u8; 4];
    let n = File::open(path)?.read(&mut magic)?;
    match &magic[..n] {
        [b'P', b'K', 3, 4] | [b'P', b'K', 5, 6] => Ok((ArchiveKind::Zip, len)),
        [0x1f, 0x8b, ..] => Ok((ArchiveKind::TarGz, len)),
        _ => Err(AppError::msg("Only .zip and .tar.gz archives can be imported.")),
    }
}

fn zip_error(err: ZipError) -> AppError {
    match err {
        ZipError::UnsupportedArchive(m) if m == ZipError::PASSWORD_REQUIRED => AppError::msg(ENCRYPTED_MESSAGE),
        ZipError::Io(e) => AppError::Io(e),
        other => AppError::msg(format!("That archive can't be read: {other}")),
    }
}

fn damaged(err: io::Error) -> AppError {
    AppError::msg(format!("That archive can't be read: {err}"))
}

fn is_tex_name(rel: &Path) -> bool {
    rel.extension().is_some_and(|e| e.eq_ignore_ascii_case("tex"))
}

fn open_zip(path: &Path) -> AppResult<zip::ZipArchive<BufReader<File>>> {
    zip::ZipArchive::new(BufReader::new(File::open(path)?)).map_err(zip_error)
}

fn open_tar(path: &Path) -> AppResult<tar::Archive<GzDecoder<BufReader<File>>>> {
    Ok(tar::Archive::new(GzDecoder::new(BufReader::new(File::open(path)?))))
}

fn scan_zip(path: &Path, read_text: bool) -> AppResult<Vec<RawEntry>> {
    let mut zip = open_zip(path)?;
    if zip.len() > MAX_ENTRIES {
        return Err(too_many());
    }
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(zip_error)?;
        if entry.encrypted() {
            return Err(AppError::msg(ENCRYPTED_MESSAGE));
        }
        // Only regular files and folders: unix mode bits mark links and devices.
        let file_type = entry.unix_mode().map_or(0, |m| m & 0o170000);
        let kind = if entry.is_symlink() || !matches!(file_type, 0 | 0o100000 | 0o040000) {
            RawKind::Special
        } else if entry.is_dir() {
            RawKind::Dir
        } else {
            RawKind::File
        };
        out.push(RawEntry {
            ordinal: i,
            rel: entry.enclosed_name().and_then(|p| safe_rel(&p.to_string_lossy())),
            kind,
            size: entry.size(),
            compressed: Some(entry.compressed_size()),
            text: None,
        });
    }
    if read_text {
        let mut budget = MAX_PREVIEW_TEXT_BYTES;
        for raw in out.iter_mut() {
            let wanted = raw.kind == RawKind::File && raw.rel.as_deref().is_some_and(is_tex_name);
            if !wanted || budget == 0 || raw.size > project::MAX_RANKED_TEX_BYTES {
                continue;
            }
            let mut text = Vec::new();
            let entry = zip.by_index(raw.ordinal).map_err(zip_error)?;
            entry.take(project::MAX_RANKED_TEX_BYTES).read_to_end(&mut text).map_err(damaged)?;
            budget = budget.saturating_sub(text.len());
            raw.text = Some(text);
        }
    }
    Ok(out)
}

fn tar_kind(t: tar::EntryType) -> RawKind {
    use tar::EntryType as T;
    match t {
        T::Regular => RawKind::File,
        T::Directory => RawKind::Dir,
        T::Symlink | T::Link | T::Char | T::Block | T::Fifo => RawKind::Special,
        _ => RawKind::Ignored,
    }
}

fn scan_tar(path: &Path, archive_bytes: u64, read_text: bool) -> AppResult<Vec<RawEntry>> {
    let mut tar = open_tar(path)?;
    let mut out = Vec::new();
    let mut budget = MAX_PREVIEW_TEXT_BYTES;
    let mut total = 0u64;
    for (ordinal, entry) in tar.entries().map_err(damaged)?.enumerate() {
        if ordinal >= MAX_ENTRIES {
            return Err(too_many());
        }
        let mut entry = entry.map_err(damaged)?;
        let kind = tar_kind(entry.header().entry_type());
        let size = entry.size();
        let rel = safe_rel(&String::from_utf8_lossy(&entry.path_bytes()));
        if kind == RawKind::File {
            // Tar has no per-file compression, so only the whole stream can
            // be judged, and that check runs while reading.
            total += size;
            check_sizes(&rel, size, None, total, archive_bytes)?;
        }
        let mut text = None;
        let wanted = kind == RawKind::File && rel.as_deref().is_some_and(is_tex_name);
        if read_text && wanted && budget > 0 && size <= project::MAX_RANKED_TEX_BYTES {
            let mut buf = Vec::new();
            (&mut entry).take(project::MAX_RANKED_TEX_BYTES).read_to_end(&mut buf).map_err(damaged)?;
            budget = budget.saturating_sub(buf.len());
            text = Some(buf);
        }
        out.push(RawEntry { ordinal, rel, kind, size, compressed: None, text });
    }
    Ok(out)
}

fn too_many() -> AppError {
    AppError::msg(format!("This archive has more than {MAX_ENTRIES} entries, so it can't be imported."))
}

/// The header-based limits. Extraction checks the real sizes again.
fn check_sizes(rel: &Option<PathBuf>, size: u64, compressed: Option<u64>, total: u64, archive_bytes: u64) -> AppResult<()> {
    if let Some(c) = compressed {
        if size > RATIO_MIN_BYTES && size > c.saturating_mul(MAX_ENTRY_RATIO) {
            return Err(AppError::msg(BOMB_MESSAGE));
        }
    }
    if total > RATIO_MIN_BYTES && total > archive_bytes.saturating_mul(MAX_TOTAL_RATIO) {
        return Err(AppError::msg(BOMB_MESSAGE));
    }
    if size > MAX_FILE_BYTES {
        let name = rel.as_deref().map(project::to_slash).unwrap_or_else(|| "A file".into());
        return Err(AppError::msg(format!("“{name}” is larger than 100 MiB, so the archive can't be imported.")));
    }
    if total > MAX_TOTAL_BYTES {
        return Err(AppError::msg("The archive holds more than 1 GiB of files, so it can't be imported."));
    }
    Ok(())
}

/// The folder every kept entry sits in, when there is exactly one and no
/// file sits beside it.
fn shared_top_folder(entries: &[(RawEntry, PathBuf)]) -> Option<PathBuf> {
    let mut top: Option<&std::ffi::OsStr> = None;
    for (raw, rel) in entries {
        let mut parts = rel.components();
        let first = parts.next()?.as_os_str();
        if raw.kind == RawKind::File && parts.next().is_none() {
            return None;
        }
        match top {
            None => top = Some(first),
            Some(t) if t == first => {}
            Some(_) => return None,
        }
    }
    top.map(PathBuf::from)
}

fn plan(path: &Path, read_text: bool) -> AppResult<Plan> {
    let (kind, archive_bytes) = detect_kind(path)?;
    let raw = match kind {
        ArchiveKind::Zip => scan_zip(path, read_text)?,
        ArchiveKind::TarGz => scan_tar(path, archive_bytes, read_text)?,
    };

    let (mut special, mut unsafe_names, mut git) = (0, 0, false);
    let mut kept = Vec::new();
    let mut total = 0u64;
    for entry in raw {
        match entry.kind {
            RawKind::Special => {
                special += 1;
                continue;
            }
            RawKind::Ignored => continue,
            RawKind::File | RawKind::Dir => {}
        }
        let Some(rel) = entry.rel.clone() else {
            unsafe_names += 1;
            continue;
        };
        match skip_reason(&rel) {
            Some(Skip::Git) => {
                git = true;
                continue;
            }
            Some(Skip::Junk) => continue,
            None => {}
        }
        if entry.kind == RawKind::File {
            total += entry.size;
            check_sizes(&entry.rel, entry.size, entry.compressed, total, archive_bytes)?;
        }
        kept.push((entry, rel));
    }

    let strip = shared_top_folder(&kept);
    let mut namer = Namer::default();
    let mut entries = Vec::new();
    let mut file_count = 0;
    for (raw, rel) in kept {
        let rel = match &strip {
            Some(prefix) => rel.strip_prefix(prefix).map(Path::to_path_buf).unwrap_or(rel),
            None => rel,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let is_dir = raw.kind == RawKind::Dir;
        let rel = if is_dir { namer.dir(&rel) } else { namer.file(&rel) };
        file_count += usize::from(!is_dir);
        entries.push(Planned { ordinal: raw.ordinal, rel, is_dir, compressed: raw.compressed, text: raw.text });
    }
    if file_count == 0 {
        return Err(AppError::msg("That archive has no files in it."));
    }

    let mut warnings = Vec::new();
    if git {
        warnings.push(GIT_WARNING.to_string());
    }
    if special > 0 {
        warnings.push(format!("{special} {} skipped.", plural(special, "link or special file was", "links or special files were")));
    }
    if unsafe_names > 0 {
        warnings.push(format!(
            "{unsafe_names} {} skipped because {} point outside the project or can't be used as file names.",
            plural(unsafe_names, "entry was", "entries were"),
            if unsafe_names == 1 { "its name would" } else { "their names would" },
        ));
    }
    if namer.renamed > 0 {
        warnings.push(format!(
            "{} {} only in capital letters, so {} renamed with a number.",
            namer.renamed,
            plural(namer.renamed, "name differed", "names differed"),
            if namer.renamed == 1 { "it was" } else { "they were" },
        ));
    }
    Ok(Plan {
        kind,
        archive_bytes,
        entries,
        file_count,
        total_bytes: total,
        strip_prefix: strip.map(|p| p.to_string_lossy().into_owned()),
        warnings,
    })
}

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 {
        one
    } else {
        many
    }
}

/// The archive's file name without `.zip`, `.tar.gz` or `.tgz`.
fn archive_stem(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let lower = name.to_lowercase();
    let cut = [".tar.gz", ".tgz", ".zip"]
        .iter()
        .find(|ext| lower.ends_with(*ext))
        .map_or(name.len(), |ext| name.len() - ext.len());
    name[..cut].trim().to_string()
}

/// Reads an archive's headers (and the text of its `.tex` files) without
/// extracting anything.
pub fn inspect(path: &Path) -> AppResult<ArchivePreview> {
    let plan = plan(path, true)?;
    let mut candidates = Vec::new();
    let mut tex_files = Vec::new();
    for e in &plan.entries {
        if e.is_dir || !is_tex_name(&e.rel) {
            continue;
        }
        let rel = project::to_slash(&e.rel);
        let text = e.text.as_deref().map(String::from_utf8_lossy).unwrap_or_default();
        candidates.push(project::MainCandidate::from_text(rel.clone(), &text));
        tex_files.push(rel);
    }
    tex_files.sort_by_key(|p| (p.matches('/').count(), p.to_lowercase()));
    let suggested_name = plan
        .strip_prefix
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| archive_stem(path));
    Ok(ArchivePreview {
        kind: plan.kind,
        file_count: plan.file_count,
        total_bytes: plan.total_bytes,
        strip_prefix: plan.strip_prefix,
        suggested_main: project::rank_main_candidates(&candidates),
        tex_files,
        suggested_name: if suggested_name.is_empty() { "Imported project".into() } else { suggested_name },
        warnings: plan.warnings,
    })
}

// ---------------------------------------------------------------------------
// Importing

/// Copies at most `limit` bytes and fails if the source has more, whatever
/// its header claimed. Returns the number of bytes written.
pub fn copy_limited(reader: impl Read, writer: &mut impl Write, limit: u64) -> AppResult<u64> {
    let written = io::copy(&mut reader.take(limit.saturating_add(1)), writer).map_err(damaged)?;
    if written > limit {
        return Err(AppError::msg(BOMB_MESSAGE));
    }
    Ok(written)
}

/// Calls `progress` about a hundred times over a run, plus at the end.
struct Ticker<'a> {
    progress: &'a dyn Fn(u64, u64),
    done: u64,
    total: u64,
    step: u64,
}

impl<'a> Ticker<'a> {
    fn new(progress: &'a dyn Fn(u64, u64), total: u64) -> Self {
        progress(0, total);
        Ticker { progress, done: 0, total, step: (total / 100).max(1) }
    }

    fn tick(&mut self) {
        self.done += 1;
        if self.done.is_multiple_of(self.step) || self.done == self.total {
            (self.progress)(self.done, self.total);
        }
    }
}

/// Writes every planned entry into `staging`.
fn extract(path: &Path, plan: &Plan, staging: &Path, progress: &dyn Fn(u64, u64)) -> AppResult<()> {
    let by_ordinal: HashMap<usize, &Planned> = plan.entries.iter().map(|e| (e.ordinal, e)).collect();
    let mut ticker = Ticker::new(progress, plan.file_count as u64);
    let mut total = 0u64;

    let mut write_entry = |entry: &Planned, reader: &mut dyn Read| -> AppResult<()> {
        let out = staging.join(&entry.rel);
        if !out.starts_with(staging) {
            return Err(AppError::msg("That archive has a file outside the project."));
        }
        if entry.is_dir {
            fs::create_dir_all(&out)?;
            return Ok(());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&out)?;
        let limit = MAX_FILE_BYTES.min(MAX_TOTAL_BYTES - total.min(MAX_TOTAL_BYTES));
        let written = copy_limited(reader, &mut file, limit)?;
        total += written;
        if let Some(c) = entry.compressed {
            if written > RATIO_MIN_BYTES && written > c.saturating_mul(MAX_ENTRY_RATIO) {
                return Err(AppError::msg(BOMB_MESSAGE));
            }
        }
        if total > RATIO_MIN_BYTES && total > plan.archive_bytes.saturating_mul(MAX_TOTAL_RATIO) {
            return Err(AppError::msg(BOMB_MESSAGE));
        }
        ticker.tick();
        Ok(())
    };

    match plan.kind {
        ArchiveKind::Zip => {
            let mut zip = open_zip(path)?;
            for entry in &plan.entries {
                if entry.is_dir {
                    write_entry(entry, &mut io::empty())?;
                    continue;
                }
                let mut file = zip.by_index(entry.ordinal).map_err(zip_error)?;
                if file.encrypted() {
                    return Err(AppError::msg(ENCRYPTED_MESSAGE));
                }
                write_entry(entry, &mut file)?;
            }
        }
        ArchiveKind::TarGz => {
            let mut tar = open_tar(path)?;
            for (ordinal, item) in tar.entries().map_err(damaged)?.enumerate() {
                let mut item = item.map_err(damaged)?;
                if let Some(entry) = by_ordinal.get(&ordinal) {
                    write_entry(entry, &mut item)?;
                }
            }
        }
    }
    Ok(())
}

/// XeLaTeX when the project loads a package that needs a Unicode engine.
fn guess_engine(dir: &Path) -> Engine {
    const UNICODE_PACKAGES: [&str; 3] = ["fontspec", "unicode-math", "polyglossia"];
    let unicode = WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_tex_name(e.path()))
        .filter(|e| e.metadata().is_ok_and(|m| m.len() <= project::MAX_RANKED_TEX_BYTES))
        .any(|e| {
            let text = String::from_utf8_lossy(&fs::read(e.path()).unwrap_or_default()).into_owned();
            text.lines()
                .map(|l| l.split('%').next().unwrap_or(""))
                .filter(|l| l.contains("\\usepackage") || l.contains("\\RequirePackage"))
                .any(|l| UNICODE_PACKAGES.iter().any(|p| l.contains(p)))
        });
    if unicode {
        Engine::Xelatex
    } else {
        Engine::Pdflatex
    }
}

/// Imports an archive as a new project in `root`. `main` is the document the
/// user picked in the preview; when it's missing or invalid, Texo picks one.
pub fn import(
    root: &Path,
    path: &Path,
    name: &str,
    main: Option<&str>,
    progress: &dyn Fn(u64, u64),
) -> AppResult<ProjectSummary> {
    if name.trim().is_empty() {
        return Err(AppError::msg("Project name can't be empty."));
    }
    let plan = plan(path, false)?;
    fs::create_dir_all(root)?;
    let staging = root.join(format!(".texo-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;

    let staged = (|| -> AppResult<(Option<String>, Engine)> {
        extract(path, &plan, &staging, progress)?;
        let requested = main
            .filter(|m| is_tex_name(Path::new(m)))
            .and_then(|m| crate::fsops::resolve(&staging, m).ok().filter(|p| p.is_file()).map(|_| m.replace('\\', "/")));
        let main = requested.or_else(|| project::detect_main_document_ranked(&staging));
        Ok((main, guess_engine(&staging)))
    })();
    let (main, engine) = match staged {
        Ok(found) => found,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(err);
        }
    };

    let target = project::unique_dir(root, name);
    if let Err(err) = fs::rename(&staging, &target) {
        let _ = fs::remove_dir_all(&staging);
        return Err(err.into());
    }
    project::adopt(&target, name.trim(), main, engine).inspect_err(|_| {
        let _ = fs::remove_dir_all(&target);
    })
}

// ---------------------------------------------------------------------------
// Exporting

/// Files TeX writes while compiling. `.bbl` is kept: some publishers need it.
const BUILD_EXTENSIONS: &[&str] = &[
    "aux", "log", "out", "toc", "lof", "lot", "fls", "fdb_latexmk", "synctex.gz", "synctex", "bcf", "run.xml", "blg",
    "nav", "snm", "vrb", "xdv", "idx", "ilg", "ind", "glo", "gls", "glg", "ist",
];

fn is_build_file(name: &str) -> bool {
    let name = name.to_lowercase();
    name.ends_with(".texo-tmp")
        || name.ends_with(".synctex(busy)")
        || BUILD_EXTENSIONS.iter().any(|ext| name.ends_with(&format!(".{ext}")))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s: OsString = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// True when `dest` would land inside `dir` (links and `..` resolved).
fn inside(dir: &Path, dest: &Path) -> bool {
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let parent = dest.parent().unwrap_or(Path::new(""));
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    parent.starts_with(&dir) || project::same_path(&parent, &dir)
}

/// Writes to `dest` through a temporary file next to it, so a failed run
/// never leaves a half-written file under the real name.
fn write_atomically(dest: &Path, write: impl FnOnce(File) -> AppResult<()>) -> AppResult<()> {
    let tmp = with_suffix(dest, ".texo-tmp");
    let result = File::create(&tmp).map_err(AppError::from).and_then(write);
    if let Err(err) = result.and_then(|()| fs::rename(&tmp, dest).map_err(AppError::from)) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn zip_time(path: &Path) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let modified: chrono::DateTime<chrono::Local> = fs::metadata(path).ok()?.modified().ok()?.into();
    zip::DateTime::from_date_and_time(
        u16::try_from(modified.year()).ok()?,
        modified.month() as u8,
        modified.day() as u8,
        modified.hour() as u8,
        modified.minute() as u8,
        modified.second().min(58) as u8,
    )
    .ok()
}

/// Exports the project's sources as a `.zip`: no Texo metadata, build files
/// or Git history, and the compiled PDF only when asked for.
pub fn export(dir: &Path, dest: &Path, include_pdf: bool, progress: &dyn Fn(u64, u64)) -> AppResult<()> {
    let is_zip = dest.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Err(AppError::msg("Choose a file name that ends in .zip."));
    }
    if inside(dir, dest) {
        return Err(AppError::msg("Save the .zip outside the project folder."));
    }
    let output_pdf = project::read_meta(dir).and_then(|m| m.output_pdf).map(|p| p.to_lowercase());

    let mut items: Vec<(String, PathBuf, bool)> = Vec::new();
    let walker = WalkDir::new(dir)
        .follow_links(false)
        .min_depth(1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            let meta = e.depth() == 1 && name.eq_ignore_ascii_case(META_DIR);
            let git = e.file_type().is_dir() && name == ".git";
            !meta && !git
        });
    for entry in walker {
        let entry = entry.map_err(|e| AppError::msg(e.to_string()))?;
        let rel = project::to_slash(entry.path().strip_prefix(dir).map_err(|e| AppError::msg(e.to_string()))?);
        let kind = entry.file_type();
        if kind.is_dir() {
            items.push((format!("{rel}/"), entry.into_path(), true));
        } else if kind.is_file() {
            let skip_pdf = !include_pdf && output_pdf.as_deref() == Some(rel.to_lowercase().as_str());
            if !skip_pdf && !is_build_file(&rel) {
                items.push((rel, entry.into_path(), false));
            }
        }
        // Links are never followed or stored.
    }

    let files = items.iter().filter(|(_, _, d)| !d).count() as u64;
    let mut ticker = Ticker::new(progress, files);
    write_atomically(dest, |out| {
        let mut zip = zip::ZipWriter::new(io::BufWriter::new(out));
        for (name, path, is_dir) in &items {
            let mut options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(if *is_dir { 0o755 } else { 0o644 });
            if let Some(time) = zip_time(path) {
                options = options.last_modified_time(time);
            }
            if *is_dir {
                zip.add_directory(name.as_str(), options).map_err(zip_error)?;
                continue;
            }
            let size = fs::metadata(path)?.len();
            zip.start_file(name.as_str(), options.large_file(size >= u32::MAX as u64)).map_err(zip_error)?;
            io::copy(&mut File::open(path)?, &mut zip)?;
            ticker.tick();
        }
        let mut inner = zip.finish().map_err(zip_error)?;
        inner.flush()?;
        inner.into_inner().map_err(|e| AppError::Io(e.into_error()))?.sync_all()?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Save PDF as

/// The project's latest PDF: the copy Texo keeps in the project folder, or
/// failing that the one in the build folder.
pub fn latest_pdf(dir: &Path) -> Option<PathBuf> {
    let meta = project::read_meta(dir)?;
    if let Some(saved) = meta.output_pdf.as_deref().and_then(|p| crate::fsops::resolve(dir, p).ok()) {
        if saved.is_file() {
            return Some(saved);
        }
    }
    let main = meta.main_document?;
    let stem = Path::new(&main).file_stem()?.to_string_lossy().into_owned();
    Some(compile::build_dir(dir).join(format!("{stem}.pdf"))).filter(|p| p.is_file())
}

/// Copies the latest PDF to `dest`.
pub fn save_pdf_as(dir: &Path, dest: &Path) -> AppResult<()> {
    if !dest.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
        return Err(AppError::msg("Choose a file name that ends in .pdf."));
    }
    let source = latest_pdf(dir).ok_or_else(|| AppError::msg("There's no PDF yet. Compile the project first."))?;
    if project::same_path(&source, dest) {
        return Ok(());
    }
    write_atomically(dest, |mut out| {
        io::copy(&mut File::open(&source)?, &mut out)?;
        out.sync_all()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::templates::Template;

    const DOC: &[u8] = b"\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";

    fn deflated() -> SimpleFileOptions {
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
    }

    /// A zip with `(name, contents)` entries; names ending in `/` are folders.
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            if name.ends_with('/') {
                w.add_directory(*name, deflated()).unwrap();
            } else {
                w.start_file(*name, deflated()).unwrap();
                w.write_all(data).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }

    fn save(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(raw).unwrap();
        gz.finish().unwrap()
    }

    fn tar_file(b: &mut tar::Builder<Vec<u8>>, name: &str, data: &[u8]) {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_entry_type(tar::EntryType::Regular);
        b.append_data(&mut h, name, data).unwrap();
    }

    /// A tar entry with an unchecked name, the way a hostile archive is built.
    fn tar_raw(b: &mut tar::Builder<Vec<u8>>, name: &str, kind: tar::EntryType, data: &[u8]) {
        let mut h = tar::Header::new_old();
        h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
        h.set_entry_type(kind);
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        if kind == tar::EntryType::Symlink || kind == tar::EntryType::Link {
            h.set_link_name("main.tex").unwrap();
        }
        h.set_cksum();
        b.append(&h, data).unwrap();
    }

    /// Every file and folder under `dir` except `.texo/`, with file contents.
    fn tree(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
        let mut out: Vec<_> = WalkDir::new(dir)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| e.file_name() != META_DIR)
            .map(|e| e.unwrap())
            .map(|e| {
                let rel = project::to_slash(e.path().strip_prefix(dir).unwrap());
                let data = e.file_type().is_file().then(|| fs::read(e.path()).unwrap());
                (rel, data)
            })
            .collect();
        out.sort();
        out
    }

    fn names(dir: &Path) -> Vec<String> {
        tree(dir).into_iter().map(|(n, _)| n).collect()
    }

    /// No staging folder is ever left in the projects folder.
    fn assert_no_staging(root: &Path) {
        let left: Vec<_> = fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".texo-import-"))
            .collect();
        assert!(left.is_empty(), "staging left behind: {left:?}");
    }

    fn no_progress(_: u64, _: u64) {}

    /// Rewrites header fields of every entry in a zip: `local(offset)` and
    /// `central(offset)` receive each header's start.
    fn patch_zip(bytes: &mut [u8], f: impl Fn(&mut [u8], bool)) {
        let mut i = 0;
        while i + 4 <= bytes.len() {
            match &bytes[i..i + 4] {
                [b'P', b'K', 3, 4] => f(&mut bytes[i..], true),
                [b'P', b'K', 1, 2] => f(&mut bytes[i..], false),
                _ => {}
            }
            i += 1;
        }
    }

    #[test]
    fn safe_rel_rejects_escapes_and_fixes_windows_names() {
        assert_eq!(safe_rel("a/b.tex"), Some(PathBuf::from("a").join("b.tex")));
        assert_eq!(safe_rel("a\\b.tex"), Some(PathBuf::from("a").join("b.tex")));
        assert_eq!(safe_rel("./a//b.tex"), Some(PathBuf::from("a").join("b.tex")));
        for bad in [
            "", "../evil.tex", "/abs.tex", "C:/x.tex", "c:x.tex", "a/../../b", "a/../b", "\\\\server\\share\\x.tex",
            "//server/x", "nul\0.tex", "dir./x.tex", "trailing ", "a/b:c", "tab\there",
        ] {
            assert_eq!(safe_rel(bad), None, "{bad:?}");
        }
        assert_eq!(safe_rel("con.tex"), Some(PathBuf::from("con_.tex")));
        assert_eq!(safe_rel("sub/LPT1"), Some(PathBuf::from("sub").join("LPT1_")));
        assert_eq!(safe_rel("what?.tex"), Some(PathBuf::from("what_.tex")));
        assert_eq!(safe_rel(".latexmkrc"), Some(PathBuf::from(".latexmkrc")));
    }

    #[test]
    fn strips_a_single_top_folder_and_detects_the_main_document() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let zip = save(
            tmp.path(),
            "download.zip",
            &zip_bytes(&[
                ("My Paper/", b""),
                ("My Paper/notes.tex", b"\\section{Notes}"),
                ("My Paper/src/paper.tex", DOC),
                ("My Paper/figs/", b""),
                ("My Paper/.DS_Store", b"junk"),
                ("My Paper/.texo/project.json", b"{\"id\":\"planted\"}"),
                ("__MACOSX/My Paper/._notes.tex", b"junk"),
                ("My Paper/.git/HEAD", b"ref: main"),
            ]),
        );

        let preview = inspect(&zip).unwrap();
        assert_eq!(preview.kind, ArchiveKind::Zip);
        assert_eq!(preview.strip_prefix.as_deref(), Some("My Paper"));
        assert_eq!(preview.suggested_name, "My Paper");
        assert_eq!(preview.suggested_main.as_deref(), Some("src/paper.tex"));
        assert_eq!(preview.tex_files, vec!["notes.tex", "src/paper.tex"]);
        assert_eq!(preview.file_count, 2);
        assert_eq!(preview.warnings, vec![GIT_WARNING.to_string()]);

        let made = import(&root, &zip, "My Paper", None, &no_progress).unwrap();
        let dir = PathBuf::from(&made.path);
        assert!(dir.ends_with("My Paper"));
        assert_eq!(made.main_document.as_deref(), Some("src/paper.tex"));
        assert_eq!(made.engine, Engine::Pdflatex);
        assert_eq!(names(&dir), vec!["figs", "notes.tex", "src", "src/paper.tex"]);
        assert_ne!(made.id, "planted", "planted metadata is never used");
        assert_no_staging(&root);

        // A main document picked in the preview wins; a bad pick is ignored.
        let picked = import(&root, &zip, "Picked", Some("notes.tex"), &no_progress).unwrap();
        assert_eq!(picked.main_document.as_deref(), Some("notes.tex"));
        let bad = import(&root, &zip, "Bad pick", Some("../outside.tex"), &no_progress).unwrap();
        assert_eq!(bad.main_document.as_deref(), Some("src/paper.tex"));
        assert!(import(&root, &zip, "  ", None, &no_progress).is_err());
    }

    #[test]
    fn unsafe_names_are_skipped_or_sanitised_and_nothing_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("deep").join("projects");
        let zip = save(
            tmp.path(),
            "evil.zip",
            &zip_bytes(&[
                ("../evil.tex", b"x"),
                ("/abs.tex", b"x"),
                ("C:/x.tex", b"x"),
                ("a/../../b", b"x"),
                ("..\\win.tex", b"x"),
                ("con.tex", b"x"),
                ("main.tex", DOC),
            ]),
        );
        let preview = inspect(&zip).unwrap();
        assert!(preview.warnings.iter().any(|w| w.contains("skipped because")), "{:?}", preview.warnings);
        assert_eq!(preview.suggested_name, "evil");

        let made = import(&root, &zip, "Evil", None, &no_progress).unwrap();
        let dir = PathBuf::from(&made.path);
        assert_eq!(names(&dir), vec!["con_.tex", "main.tex"]);
        // Nothing was written anywhere above the project.
        for place in [tmp.path(), &tmp.path().join("deep"), &root] {
            let found: Vec<_> = fs::read_dir(place).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert!(found.iter().all(|n| n != "evil.tex" && n != "b" && n != "abs.tex" && n != "win.tex"), "{found:?}");
        }

        // The same names in a tarball.
        let mut b = tar::Builder::new(Vec::new());
        tar_raw(&mut b, "../evil.tex", tar::EntryType::Regular, b"x");
        tar_raw(&mut b, "/abs.tex", tar::EntryType::Regular, b"x");
        tar_raw(&mut b, "a/../../b", tar::EntryType::Regular, b"x");
        tar_file(&mut b, "main.tex", DOC);
        let tgz = save(tmp.path(), "evil.tgz", &gzip(&b.into_inner().unwrap()));
        let made = import(&root, &tgz, "Evil tar", None, &no_progress).unwrap();
        assert_eq!(names(Path::new(&made.path)), vec!["main.tex"]);
        assert!(!tmp.path().join("deep").join("evil.tex").exists());
        assert_no_staging(&root);
    }

    #[test]
    fn links_and_special_files_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");

        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("main.tex", deflated()).unwrap();
        w.write_all(DOC).unwrap();
        w.add_symlink("link.tex", "/etc/passwd", deflated()).unwrap();
        let zip = save(tmp.path(), "links.zip", &w.finish().unwrap().into_inner());
        let preview = inspect(&zip).unwrap();
        assert_eq!(preview.file_count, 1);
        assert!(preview.warnings.iter().any(|w| w.contains("link")), "{:?}", preview.warnings);
        let made = import(&root, &zip, "Zip links", None, &no_progress).unwrap();
        assert_eq!(names(Path::new(&made.path)), vec!["main.tex"]);

        let mut b = tar::Builder::new(Vec::new());
        tar_file(&mut b, "main.tex", DOC);
        tar_raw(&mut b, "soft.tex", tar::EntryType::Symlink, b"");
        tar_raw(&mut b, "hard.tex", tar::EntryType::Link, b"");
        tar_raw(&mut b, "fifo", tar::EntryType::Fifo, b"");
        tar_raw(&mut b, "dev", tar::EntryType::Char, b"");
        let tgz = save(tmp.path(), "links.tar.gz", &gzip(&b.into_inner().unwrap()));
        let preview = inspect(&tgz).unwrap();
        assert_eq!(preview.kind, ArchiveKind::TarGz);
        assert!(preview.warnings.iter().any(|w| w.starts_with("4 links")), "{:?}", preview.warnings);
        let made = import(&root, &tgz, "Tar links", None, &no_progress).unwrap();
        assert_eq!(names(Path::new(&made.path)), vec!["main.tex"]);
    }

    #[test]
    fn zip_bombs_are_rejected_and_staging_is_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        fs::create_dir_all(&root).unwrap();

        // 200 MiB of zeros squeezes into a few hundred KiB.
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("main.tex", deflated()).unwrap();
        w.write_all(DOC).unwrap();
        w.start_file("bomb.bin", deflated().large_file(false)).unwrap();
        let chunk = vec![0u8; MIB as usize];
        for _ in 0..200 {
            w.write_all(&chunk).unwrap();
        }
        let zip = save(tmp.path(), "bomb.zip", &w.finish().unwrap().into_inner());
        assert!(inspect(&zip).unwrap_err().to_string().contains("expands far more"));
        assert!(import(&root, &zip, "Bomb", None, &no_progress).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "nothing is left in the projects folder");

        // A header that lies about the size: the bytes actually written count.
        let mut bytes = zip_bytes(&[("main.tex", DOC), ("liar.bin", &vec![0u8; 3 * MIB as usize])]);
        let real = (3 * MIB) as u32;
        patch_zip(&mut bytes, |h, local| {
            let at = if local { 22 } else { 24 };
            if h[at..at + 4] == real.to_le_bytes() {
                h[at..at + 4].copy_from_slice(&1000u32.to_le_bytes());
            }
        });
        let liar = save(tmp.path(), "liar.zip", &bytes);
        assert!(inspect(&liar).is_ok(), "the headers alone look harmless");
        assert!(import(&root, &liar, "Liar", None, &no_progress).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn copy_limited_counts_real_bytes() {
        let mut out = Vec::new();
        assert_eq!(copy_limited(&[1u8; 10][..], &mut out, 10).unwrap(), 10);
        let mut out = Vec::new();
        assert!(copy_limited(&[1u8; 11][..], &mut out, 10).is_err());
        assert!(out.len() <= 11, "stops reading right after the limit");
    }

    #[test]
    fn limits_have_the_documented_values() {
        assert_eq!(MAX_ENTRIES, 10_000);
        assert_eq!(MAX_FILE_BYTES, 100 * 1024 * 1024);
        assert_eq!(MAX_TOTAL_BYTES, 1024 * 1024 * 1024);
        assert_eq!(MAX_ARCHIVE_BYTES, 2 * 1024 * 1024 * 1024);
        assert_eq!((MAX_ENTRY_RATIO, MAX_TOTAL_RATIO), (200, 100));

        let name = Some(PathBuf::from("big.bin"));
        // One file over the per-file limit (that compresses normally).
        let err = check_sizes(&name, MAX_FILE_BYTES + 1, Some(MAX_FILE_BYTES), MAX_FILE_BYTES + 1, MAX_ARCHIVE_BYTES);
        assert!(err.unwrap_err().to_string().contains("big.bin"));
        // The total over 1 GiB.
        let err = check_sizes(&name, MIB, Some(MIB), MAX_TOTAL_BYTES + 1, MAX_ARCHIVE_BYTES);
        assert!(err.unwrap_err().to_string().contains("1 GiB"));
        // An entry expanding 201:1, and a whole archive expanding 101:1.
        assert!(check_sizes(&name, 201 * MIB / 10, Some(MIB / 10), 0, MAX_ARCHIVE_BYTES).is_err());
        assert!(check_sizes(&name, 2 * MIB, Some(MIB), 101 * MIB, MIB).is_err());
        // Small files may compress as well as they like.
        assert!(check_sizes(&name, 1000, Some(1), 1000, 10).is_ok());
    }

    #[test]
    fn too_many_entries_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for i in 0..=MAX_ENTRIES {
            w.start_file(format!("f{i}.txt"), SimpleFileOptions::default()).unwrap();
        }
        let zip = save(tmp.path(), "many.zip", &w.finish().unwrap().into_inner());
        assert!(inspect(&zip).unwrap_err().to_string().contains("more than 10000"));

        let mut b = tar::Builder::new(Vec::new());
        for i in 0..=MAX_ENTRIES {
            tar_file(&mut b, &format!("f{i}.txt"), b"");
        }
        let tgz = save(tmp.path(), "many.tgz", &gzip(&b.into_inner().unwrap()));
        assert!(inspect(&tgz).unwrap_err().to_string().contains("more than 10000"));
    }

    #[test]
    fn encrypted_entries_give_a_clear_error() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let mut bytes = zip_bytes(&[("main.tex", DOC)]);
        // Set the "encrypted" flag on the entry.
        patch_zip(&mut bytes, |h, local| h[if local { 6 } else { 8 }] |= 1);
        let zip = save(tmp.path(), "locked.zip", &bytes);
        assert!(inspect(&zip).unwrap_err().to_string().contains("password-protected"));
        assert!(import(&root, &zip, "Locked", None, &no_progress).unwrap_err().to_string().contains("password"));
        assert!(!root.exists() || fs::read_dir(&root).unwrap().count() == 0);
    }

    #[test]
    fn names_differing_only_in_case_are_all_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let zip = save(
            tmp.path(),
            "case.zip",
            &zip_bytes(&[("Main.tex", DOC), ("main.tex", b"second"), ("Figs/a.png", b"a"), ("figs/b.png", b"b")]),
        );
        let preview = inspect(&zip).unwrap();
        assert_eq!(preview.tex_files, vec!["main (2).tex", "Main.tex"]);
        assert!(preview.warnings.iter().any(|w| w.contains("capital")), "{:?}", preview.warnings);
        let made = import(&root, &zip, "Case", None, &no_progress).unwrap();
        let dir = PathBuf::from(&made.path);
        assert_eq!(names(&dir), vec!["Figs", "Figs/a.png", "Figs/b.png", "Main.tex", "main (2).tex"]);
        assert_eq!(fs::read(dir.join("main (2).tex")).unwrap(), b"second");
    }

    #[test]
    fn tar_gz_with_long_names_works_and_picks_xelatex() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let long_dir = format!("chapters/{}", "a-very-long-folder-name".repeat(6));
        let pax_name = format!("{long_dir}/pax.tex");
        let gnu_name = format!("{long_dir}/gnu.tex");
        let mut b = tar::Builder::new(Vec::new());
        tar_file(&mut b, "thesis/main.tex", b"\\documentclass{report}\n\\usepackage{fontspec}\n\\begin{document}\n\\end{document}\n");
        // PAX extended header carrying the real (long) path.
        b.append_pax_extensions([("path", format!("thesis/{pax_name}").as_bytes())]).unwrap();
        tar_raw(&mut b, "thesis/short", tar::EntryType::Regular, b"pax");
        // GNU long-name entry (the builder's default for long paths).
        tar_file(&mut b, &format!("thesis/{gnu_name}"), b"gnu");
        let tgz = save(tmp.path(), "thesis.tar.gz", &gzip(&b.into_inner().unwrap()));

        let preview = inspect(&tgz).unwrap();
        assert_eq!(preview.strip_prefix.as_deref(), Some("thesis"));
        assert_eq!(preview.suggested_main.as_deref(), Some("main.tex"));
        let made = import(&root, &tgz, "Thesis", None, &no_progress).unwrap();
        let dir = PathBuf::from(&made.path);
        assert_eq!(fs::read(dir.join(&pax_name)).unwrap(), b"pax");
        assert_eq!(fs::read(dir.join(&gnu_name)).unwrap(), b"gnu");
        assert_eq!(made.engine, Engine::Xelatex);
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let mut zip = open_zip(path).unwrap();
        let mut out: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        out.sort();
        out
    }

    #[test]
    fn export_leaves_out_metadata_build_files_and_the_pdf_unless_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let p = project::create(tmp.path(), "Paper", Template::Example).unwrap();
        let dir = PathBuf::from(&p.path);
        fs::create_dir_all(dir.join(".texo/build")).unwrap();
        fs::write(dir.join(".texo/build/main.pdf"), "%PDF").unwrap();
        for junk in ["main.aux", "main.log", "main.synctex.gz", "main.fdb_latexmk", "main.run.xml", ".main.tex.texo-tmp"] {
            fs::write(dir.join(junk), "x").unwrap();
        }
        fs::write(dir.join("main.bbl"), "kept").unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/HEAD"), "ref").unwrap();
        fs::create_dir_all(dir.join("figures")).unwrap();
        fs::write(dir.join("figures/plot.pdf"), "%PDF figure").unwrap();
        project::save_output_pdf(&dir, "main.tex", &dir.join(".texo/build/main.pdf")).unwrap();

        let calls = std::cell::RefCell::new(Vec::new());
        let dest = tmp.path().join("out.zip");
        export(&dir, &dest, false, &|d, t| calls.borrow_mut().push((d, t))).unwrap();
        assert_eq!(
            zip_names(&dest),
            vec!["figures/", "figures/plot.pdf", "main.bbl", "main.tex", "references.bib"]
        );
        assert_eq!(calls.borrow().last(), Some(&(4, 4)));
        assert!(!tmp.path().join("out.zip.texo-tmp").exists());
        let mut zip = open_zip(&dest).unwrap();
        let entry = zip.by_name("main.tex").unwrap();
        assert_eq!(entry.compression(), zip::CompressionMethod::Deflated);
        assert_eq!(entry.unix_mode().map(|m| m & 0o777), Some(0o644));
        drop(entry);

        export(&dir, &dest, true, &no_progress).unwrap();
        assert!(zip_names(&dest).contains(&"main.pdf".to_string()));
    }

    #[test]
    fn export_refuses_bad_destinations() {
        let tmp = tempfile::tempdir().unwrap();
        let p = project::create(tmp.path(), "Paper", Template::Blank).unwrap();
        let dir = PathBuf::from(&p.path);
        assert!(export(&dir, &dir.join("inside.zip"), false, &no_progress).unwrap_err().to_string().contains("outside"));
        fs::create_dir_all(dir.join("sub")).unwrap();
        assert!(export(&dir, &dir.join("sub").join("deeper.zip"), false, &no_progress).is_err());
        assert!(export(&dir, &tmp.path().join("paper.tar"), false, &no_progress).is_err());
        assert!(!dir.join("inside.zip").exists());
    }

    #[test]
    fn export_then_import_gives_the_same_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projects");
        let p = project::create(&root, "Thesis", Template::Thesis).unwrap();
        let dir = PathBuf::from(&p.path);
        fs::create_dir_all(dir.join("figures/empty")).unwrap();
        fs::write(dir.join("figures/data.csv"), "1,2\n").unwrap();

        let dest = tmp.path().join("Thesis.zip");
        export(&dir, &dest, false, &no_progress).unwrap();
        let back = import(&root, &dest, "Thesis", None, &no_progress).unwrap();
        assert!(back.path.ends_with("Thesis (2)"));
        assert_eq!(back.main_document.as_deref(), Some("main.tex"));
        assert_eq!(tree(Path::new(&back.path)), tree(&dir));
    }

    #[test]
    fn saves_the_latest_pdf_where_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let p = project::create(tmp.path(), "Paper", Template::Blank).unwrap();
        let dir = PathBuf::from(&p.path);
        let dest = tmp.path().join("copy.pdf");
        assert!(save_pdf_as(&dir, &dest).unwrap_err().to_string().contains("Compile"));

        // Only the build folder has a PDF yet.
        fs::create_dir_all(compile::build_dir(&dir)).unwrap();
        fs::write(compile::build_dir(&dir).join("main.pdf"), "%PDF build").unwrap();
        save_pdf_as(&dir, &dest).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "%PDF build");

        // The copy in the project folder is preferred.
        fs::write(tmp.path().join("built.pdf"), "%PDF saved").unwrap();
        project::save_output_pdf(&dir, "main.tex", &tmp.path().join("built.pdf")).unwrap();
        save_pdf_as(&dir, &dest).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "%PDF saved");
        assert!(save_pdf_as(&dir, &tmp.path().join("copy.txt")).is_err());
        assert!(!tmp.path().join("copy.pdf.texo-tmp").exists());
    }

    #[test]
    fn rejects_files_that_are_not_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let not = save(tmp.path(), "notes.zip", b"just text");
        assert!(inspect(&not).unwrap_err().to_string().contains(".zip and .tar.gz"));
        let empty = save(tmp.path(), "empty.zip", &zip_bytes(&[("only/", b"")]));
        assert!(inspect(&empty).unwrap_err().to_string().contains("no files"));
    }
}
