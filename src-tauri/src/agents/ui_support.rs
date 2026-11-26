//! Small commands behind Settings ▸ AI ▸ Agents and the Review view.
//!
//! - `agent_kind_tools`: the tools each agent kind can use (the profile
//!   editor's "Tools" checkboxes).
//! - `review_render`: a review report as Markdown or LaTeX (the same text
//!   the reviewer writes as `review.md` / `review.tex`).
//! - `review_save_as`: writes that text to a file the user picked in a save
//!   dialog (only `.md`, `.markdown`, `.txt` or `.tex`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::kinds::reviewer::{render_markdown, render_tex};
use super::profiles::{self, BUILTIN_IDS};
use super::review::ReviewReport;
use crate::error::{AppError, AppResult};

/// Kind id → the tool names a profile of that kind can pick from.
#[tauri::command]
pub fn agent_kind_tools() -> BTreeMap<String, Vec<String>> {
    BUILTIN_IDS.iter().filter_map(|id| profiles::kind_tools(id).map(|t| (id.to_string(), t))).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Md,
    Tex,
}

/// The report text in a format (the report is read leniently).
pub fn render(report: &Value, format: ExportFormat) -> String {
    let r = ReviewReport::from_value(report);
    match format {
        ExportFormat::Md => render_markdown(&r),
        ExportFormat::Tex => render_tex(&r),
    }
}

#[tauri::command]
pub fn review_render(report: Value, format: ExportFormat) -> String {
    render(&report, format)
}

const SAVE_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "tex"];

fn check_dest(dest: &Path) -> AppResult<()> {
    let ext = dest.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !SAVE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::msg("Choose a file name that ends in .md or .tex."));
    }
    if !dest.is_absolute() {
        return Err(AppError::msg("Choose where to save the file."));
    }
    if dest.is_dir() {
        return Err(AppError::msg("That is a folder. Choose a file name."));
    }
    match dest.parent() {
        Some(p) if p.is_dir() => Ok(()),
        _ => Err(AppError::msg("That folder doesn't exist any more. Choose another place.")),
    }
}

/// Writes through a temporary file next to `dest`, then renames it.
pub fn save_text(dest: &Path, text: &str) -> AppResult<()> {
    check_dest(dest)?;
    let mut tmp: PathBuf = dest.to_path_buf();
    tmp.set_extension(format!("{}.texo-tmp", dest.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()));
    fs::write(&tmp, text).map_err(|e| AppError::msg(format!("The file couldn't be saved ({e}).")))?;
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::msg(format!("The file couldn't be saved ({e}).")));
    }
    Ok(())
}

/// Renders the report and saves it where the user chose (save dialog).
#[tauri::command]
pub async fn review_save_as(report: Value, format: ExportFormat, dest: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || save_text(Path::new(&dest), &render(&report, format)))
        .await
        .map_err(|_| AppError::msg("Something went wrong inside Texo. Try again."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report() -> Value {
        json!({
            "kind": "review",
            "venue": "neurips",
            "checklist": [],
            "reviews": [{
                "persona": "Methods",
                "summary": "A clear paper.",
                "strengths": ["Good baselines"],
                "weaknesses": [{"text": "No error bars", "file": "main.tex", "line": 12, "severity": "major"}],
                "questions": ["Why 3 seeds?"],
                "scores": {"overall": 4},
                "confidence": 3
            }],
            "meta": {"summary": "Borderline.", "decision": "Weak accept", "mustFix": ["Add error bars"], "niceToFix": []},
            "references": []
        })
    }

    #[test]
    fn every_kind_lists_its_tools() {
        let t = agent_kind_tools();
        assert_eq!(t.len(), BUILTIN_IDS.len());
        assert!(t["fixer"].contains(&"edit_file".to_string()));
        assert!(!t["reviewer"].contains(&"edit_file".to_string()));
        assert!(t["chat"].contains(&"read_file".to_string()));
    }

    #[test]
    fn renders_both_formats() {
        let md = render(&report(), ExportFormat::Md);
        assert!(md.contains("No error bars"), "{md}");
        let tex = render(&report(), ExportFormat::Tex);
        assert!(tex.contains("\\documentclass") || tex.contains("\\section"), "{tex}");
        assert!(tex.contains("No error bars"));
    }

    #[test]
    fn saves_only_text_files_in_existing_folders() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("review.md");
        save_text(&ok, "hello").unwrap();
        assert_eq!(fs::read_to_string(&ok).unwrap(), "hello");
        save_text(&ok, "again").unwrap();
        assert_eq!(fs::read_to_string(&ok).unwrap(), "again");
        assert!(save_text(&dir.path().join("x.exe"), "no").is_err());
        assert!(save_text(&dir.path().join("missing").join("r.md"), "no").is_err());
        assert!(save_text(Path::new("relative.md"), "no").is_err());
        assert!(save_text(dir.path(), "no").is_err());
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(leftovers.len(), 1);
    }
}
