//! File operations inside a project. Every path from the UI is relative to
//! the project folder and is checked so it can never escape it or touch
//! Texo's own `.texo/` metadata.

use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::project::META_DIR;

/// Same limit as most web editors: larger files open read-only.
pub const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 15 * 1024 * 1024;

const TEXT_EXTENSIONS: &[&str] = &[
    "tex", "ltx", "sty", "cls", "bib", "bst", "bbx", "cbx", "dtx", "ins", "txt", "md", "csv",
    "tsv", "json", "yaml", "yml", "xml", "tikz", "pgf", "latexmkrc", "cfg", "def", "clo", "fd",
    "lua", "py", "r", "m", "sh", "bat", "ps1", "gitignore", "log",
];

const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
];

/// Resolves `rel` inside `root`, rejecting anything that could escape it.
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = rel.trim().replace('\\', "/");
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Err(AppError::msg("A file name is required."));
    }
    let rel_path = Path::new(rel);
    let mut first = true;
    for c in rel_path.components() {
        match c {
            Component::Normal(name) => {
                if first && name.eq_ignore_ascii_case(META_DIR) {
                    return Err(AppError::msg("That folder is reserved for Texo."));
                }
                first = false;
            }
            _ => return Err(AppError::msg("That path is outside the project.")),
        }
    }
    Ok(root.join(rel_path))
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .or_else(|| {
            // Dotfiles like `.latexmkrc` have no extension, only a name.
            path.file_name()
                .map(|n| n.to_string_lossy().trim_start_matches('.').to_lowercase())
        })
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum FileContent {
    Text { content: String },
    Image { data_url: String, size: u64 },
    TooLarge { size: u64 },
    Binary { size: u64 },
}

pub fn read(root: &Path, rel: &str) -> AppResult<FileContent> {
    let path = resolve(root, rel)?;
    let size = fs::metadata(&path)?.len();
    let ext = extension(&path);

    if let Some((_, mime)) = IMAGE_EXTENSIONS.iter().find(|(e, _)| *e == ext) {
        if size > MAX_PREVIEW_BYTES {
            return Ok(FileContent::TooLarge { size });
        }
        let data = base64::engine::general_purpose::STANDARD.encode(fs::read(&path)?);
        return Ok(FileContent::Image {
            data_url: format!("data:{mime};base64,{data}"),
            size,
        });
    }
    if size > MAX_TEXT_BYTES {
        return Ok(FileContent::TooLarge { size });
    }
    let bytes = fs::read(&path)?;
    let looks_text = TEXT_EXTENSIONS.contains(&ext.as_str()) || !bytes.contains(&0);
    match String::from_utf8(bytes) {
        Ok(content) if looks_text => Ok(FileContent::Text {
            content: content.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(content),
        }),
        // Older LaTeX files are sometimes Latin-1; show them rather than refuse.
        Err(err) if TEXT_EXTENSIONS.contains(&ext.as_str()) => Ok(FileContent::Text {
            content: err.into_bytes().iter().map(|&b| b as char).collect(),
        }),
        _ => Ok(FileContent::Binary { size }),
    }
}

/// Writes through a temporary file so a crash never leaves a half-written file.
pub fn write(root: &Path, rel: &str, content: &str) -> AppResult<()> {
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::msg("Files larger than 5 MiB can't be saved from the editor."));
    }
    let path = resolve(root, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.texo-tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::write(&tmp, content)?;
    if let Err(err) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

pub fn create_file(root: &Path, rel: &str) -> AppResult<()> {
    let path = resolve(root, rel)?;
    if path.exists() {
        return Err(AppError::msg("A file or folder with that name already exists."));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, "")?;
    Ok(())
}

pub fn create_folder(root: &Path, rel: &str) -> AppResult<()> {
    let path = resolve(root, rel)?;
    if path.exists() {
        return Err(AppError::msg("A file or folder with that name already exists."));
    }
    fs::create_dir_all(path)?;
    Ok(())
}

pub fn rename(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if !src.exists() {
        return Err(AppError::msg("That file no longer exists."));
    }
    let case_only = src.to_string_lossy().eq_ignore_ascii_case(&dst.to_string_lossy());
    if dst.exists() && !case_only {
        return Err(AppError::msg("A file or folder with that name already exists."));
    }
    if dst.starts_with(&src) && !case_only {
        return Err(AppError::msg("A folder can't be moved inside itself."));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(src, dst)?;
    Ok(())
}

/// Moves a file or folder to the Recycle Bin.
pub fn delete(root: &Path, rel: &str) -> AppResult<()> {
    let path = resolve(root, rel)?;
    trash::delete(path)?;
    Ok(())
}

/// `dir/name`, or `dir/name (2).ext`, `dir/name (3).ext`… if taken.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .expect("an unused name always exists")
}

/// Copies files or folders from anywhere on disk into `dest_rel` (empty for
/// the project root). Name clashes get a numbered copy rather than
/// overwriting. Returns the new relative paths.
pub fn import(root: &Path, dest_rel: &str, sources: &[PathBuf]) -> AppResult<Vec<String>> {
    let dest = if dest_rel.trim().trim_matches('/').is_empty() {
        root.to_path_buf()
    } else {
        resolve(root, dest_rel)?
    };
    fs::create_dir_all(&dest)?;
    let mut added = Vec::new();
    for src in sources {
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if src.starts_with(root) && dest.starts_with(src) {
            return Err(AppError::msg("A folder can't be copied inside itself."));
        }
        let target = unique_path(&dest, &name);
        if src.is_dir() {
            for entry in WalkDir::new(src) {
                let entry = entry.map_err(|e| AppError::msg(e.to_string()))?;
                let rel = entry.path().strip_prefix(src).map_err(|e| AppError::msg(e.to_string()))?;
                let out = target.join(rel);
                if entry.file_type().is_dir() {
                    fs::create_dir_all(&out)?;
                } else if entry.file_type().is_file() {
                    fs::copy(entry.path(), &out)?;
                }
            }
        } else if src.is_file() {
            fs::copy(src, &target)?;
        } else {
            continue;
        }
        if let Ok(rel) = target.strip_prefix(root) {
            added.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_blocks_escapes_and_metadata() {
        let root = Path::new("C:\\proj");
        assert!(resolve(root, "sections/intro.tex").is_ok());
        assert!(resolve(root, "sections\\intro.tex").is_ok());
        assert!(resolve(root, "../secret.txt").is_err());
        assert!(resolve(root, "a/../../b").is_err());
        #[cfg(windows)]
        assert!(resolve(root, "C:\\Windows\\win.ini").is_err());
        assert!(resolve(root, "/etc/passwd").is_ok_and(|p| p.starts_with(root)));
        assert!(resolve(root, ".texo/project.json").is_err());
        assert!(resolve(root, ".TEXO").is_err());
        assert!(resolve(root, "notes/.texo").is_ok());
        assert!(resolve(root, "  ").is_err());
    }

    #[test]
    fn write_then_read_text_and_strip_bom() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a/b.tex", "\\section{Hi}").unwrap();
        match read(dir.path(), "a/b.tex").unwrap() {
            FileContent::Text { content } => assert_eq!(content, "\\section{Hi}"),
            other => panic!("unexpected {other:?}"),
        }
        fs::write(dir.path().join("bom.tex"), "\u{feff}x").unwrap();
        assert!(matches!(read(dir.path(), "bom.tex").unwrap(), FileContent::Text { content } if content == "x"));
        // No temp file is left behind.
        assert_eq!(fs::read_dir(dir.path().join("a")).unwrap().count(), 1);
    }

    #[test]
    fn classifies_binary_images_and_latin1() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("x.dat"), [0u8, 1, 2]).unwrap();
        fs::write(dir.path().join("p.png"), [137u8, 80, 78, 71]).unwrap();
        fs::write(dir.path().join("old.tex"), [b'c', b'a', b'f', 0xE9]).unwrap();
        assert!(matches!(read(dir.path(), "x.dat").unwrap(), FileContent::Binary { size: 3 }));
        assert!(matches!(read(dir.path(), "p.png").unwrap(), FileContent::Image { .. }));
        assert!(matches!(read(dir.path(), "old.tex").unwrap(), FileContent::Text { content } if content == "café"));
    }

    #[test]
    fn serializes_fields_in_camel_case_for_the_ui() {
        let json = serde_json::to_value(FileContent::Image {
            data_url: "data:x".into(),
            size: 1,
        })
        .unwrap();
        assert_eq!(json["kind"], "image");
        assert_eq!(json["dataUrl"], "data:x");
        let json = serde_json::to_value(FileContent::TooLarge { size: 9 }).unwrap();
        assert_eq!(json["kind"], "tooLarge");
    }

    #[test]
    fn create_rename_and_guard_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        create_file(dir.path(), "intro.tex").unwrap();
        assert!(create_file(dir.path(), "intro.tex").is_err());
        create_folder(dir.path(), "sections").unwrap();
        rename(dir.path(), "intro.tex", "sections/intro.tex").unwrap();
        assert!(dir.path().join("sections/intro.tex").is_file());
        assert!(rename(dir.path(), "sections", "sections/inner").is_err());
        create_file(dir.path(), "a.tex").unwrap();
        rename(dir.path(), "a.tex", "A.tex").unwrap();
        assert!(dir.path().join("A.tex").is_file());
    }

    #[test]
    fn import_copies_with_numbered_names() {
        let proj = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("fig.png"), "x").unwrap();
        fs::create_dir_all(outside.path().join("data/raw")).unwrap();
        fs::write(outside.path().join("data/raw/r.csv"), "1").unwrap();
        let sources = vec![outside.path().join("fig.png"), outside.path().join("data")];

        let first = import(proj.path(), "", &sources).unwrap();
        assert_eq!(first, vec!["fig.png", "data"]);
        let second = import(proj.path(), "", &sources[..1]).unwrap();
        assert_eq!(second, vec!["fig (2).png"]);
        let nested = import(proj.path(), "figures", &sources[..1]).unwrap();
        assert_eq!(nested, vec!["figures/fig.png"]);
        assert!(proj.path().join("data/raw/r.csv").is_file());
    }
}
