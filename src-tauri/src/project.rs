//! A Texo project is a plain folder. Texo keeps its own metadata in a hidden
//! `.texo/` subfolder so the LaTeX sources stay untouched and portable.

use std::fs;
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

fn has_documentclass(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|text| {
        text.lines()
            .any(|l| l.trim_start().starts_with("\\documentclass"))
    })
}

/// Picks the file to compile: `main.tex` at the top level, otherwise the first
/// `.tex` file (top level first, then up to three folders deep) that contains
/// `\documentclass`.
pub fn detect_main_document(dir: &Path) -> Option<String> {
    if dir.join("main.tex").is_file() {
        return Some("main.tex".into());
    }
    let mut candidates: Vec<PathBuf> = WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| e.file_name() != META_DIR)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_tex(e.path()))
        .map(|e| e.into_path())
        .collect();
    candidates.sort_by_key(|p| (p.components().count(), p.clone()));
    candidates
        .into_iter()
        .find(|p| has_documentclass(p))
        .and_then(|p| p.strip_prefix(dir).ok().map(to_slash))
}

fn to_slash(path: &Path) -> String {
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
    })
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
    out.extend(external.iter().filter_map(|p| summarize(p, true)));
    out
}

const RESERVED_NAMES: &[&str] = &[
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
fn unique_dir(root: &Path, name: &str) -> PathBuf {
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

/// Copies the project into `root` as "Copy of …", with a fresh id. Version
/// history is not copied.
pub fn duplicate(dir: &Path, root: &Path) -> AppResult<ProjectSummary> {
    let source = ensure_meta(dir)?;
    let name = format!("Copy of {}", source.name);
    let target = unique_dir(root, &name);
    let history = Path::new(META_DIR).join("history");

    for entry in WalkDir::new(dir).min_depth(1) {
        let entry = entry.map_err(|e| AppError::msg(e.to_string()))?;
        let rel = entry
            .path()
            .strip_prefix(dir)
            .map_err(|e| AppError::msg(e.to_string()))?;
        if rel.starts_with(&history) {
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
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    out
}

/// Compares paths the way Windows does: case-insensitive, ignoring a
/// trailing separator and the separator style.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        to_slash(p)
            .trim_end_matches('/')
            .to_lowercase()
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

        fs::write(dir.path().join("main.tex"), "").unwrap();
        assert_eq!(detect_main_document(dir.path()).as_deref(), Some("main.tex"));
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
        fs::create_dir_all(src.join("figures")).unwrap();

        let copy = duplicate(&src, root.path()).unwrap();
        let dst = PathBuf::from(&copy.path);
        assert_eq!(copy.name, "Copy of Paper");
        assert_ne!(copy.id, p.id);
        assert!(dst.join("references.bib").is_file());
        assert!(dst.join("figures").is_dir());
        assert!(!dst.join(META_DIR).join("history").exists());
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

    #[test]
    fn compares_paths_like_windows() {
        assert!(same_path(Path::new("C:\\Users\\A\\Texo\\"), Path::new("c:/users/a/texo")));
        assert!(!same_path(Path::new("C:\\a"), Path::new("C:\\b")));
    }
}
