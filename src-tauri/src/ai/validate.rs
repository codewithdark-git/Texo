//! Checks what the model proposed before the UI may use it:
//! - an edit's file must be an existing LaTeX/BibTeX text file inside the
//!   project (no `..`, absolute paths, symlinks out, `.texo/`, binaries);
//! - the text it replaces must occur exactly once in the file as it is now;
//! - package names must be plain names (`^[A-Za-z0-9._-]+$`, not starting
//!   with `-` or `.`, so they can't be read as a command-line option).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsops::{self, FileContent};

/// Files an edit may change. `.latexmkrc` is left out on purpose: it is Perl
/// code that runs on compile.
const EDITABLE: &[&str] = &[
    "tex", "ltx", "sty", "cls", "bib", "bbx", "cbx", "bst", "cfg", "def", "clo", "fd", "dtx",
    "ins", "tikz", "pgf", "txt", "md",
];
pub const MAX_EDIT_TEXT: usize = 20_000;

/// An edit as the model (or the UI, at apply time) sends it.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditInput {
    pub file: String,
    pub find: String,
    pub replace: String,
    pub why: String,
}

/// An edit after checking. When `ok`, replacing the `lengthUtf16` UTF-16
/// code units at `offsetUtf16` (Monaco's offsets) with `replace` applies it;
/// `find` and `replace` use the file's own line endings.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckedEdit {
    pub file: String,
    pub find: String,
    pub replace: String,
    pub why: String,
    pub ok: bool,
    /// Why the edit can't be applied, in plain words.
    pub reason: Option<String>,
    /// 1-based line where the change starts.
    pub line: Option<u32>,
    pub offset_utf16: Option<u32>,
    pub length_utf16: Option<u32>,
}

impl CheckedEdit {
    fn rejected(edit: &EditInput, file: String, reason: impl Into<String>) -> Self {
        CheckedEdit {
            file,
            find: edit.find.clone(),
            replace: edit.replace.clone(),
            why: edit.why.clone(),
            ok: false,
            reason: Some(reason.into()),
            line: None,
            offset_utf16: None,
            length_utf16: None,
        }
    }
}

/// Normalizes a project-relative path from the model or the log
/// (`./sections\intro.tex` → `sections/intro.tex`).
pub fn normalize_rel(path: &str) -> String {
    let mut p = path.trim().replace('\\', "/");
    while let Some(rest) = p.strip_prefix("./") {
        p = rest.to_string();
    }
    p
}

/// Resolves a project-relative path to a file that really is inside the
/// project, following symlinks. `None` for anything else.
pub fn project_file(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = normalize_rel(rel);
    if rel.starts_with('/') || rel.contains(':') || rel.is_empty() {
        return None;
    }
    let path = fsops::resolve(root, &rel).ok()?;
    let real = fs::canonicalize(&path).ok()?;
    let real_root = fs::canonicalize(root).ok()?;
    (real.starts_with(&real_root) && real.is_file()).then_some(path)
}

/// Reads a project text file the way the editor does (same decoding).
/// `None` for missing, outside, binary, image or very large files.
pub fn read_project_text(root: &Path, rel: &str) -> Option<String> {
    project_file(root, rel)?;
    match fsops::read(root, &normalize_rel(rel)).ok()? {
        // A NUL byte means binary data, whatever the extension says.
        FileContent::Text { content } if !content.contains('\0') => Some(content),
        _ => None,
    }
}

fn editable(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && EDITABLE.contains(&ext))
}

/// Checks one edit. `current` is the file's text as the user sees it now
/// (an unsaved editor buffer); without it, the file on disk is used.
pub fn check_edit(root: &Path, edit: &EditInput, current: Option<&str>) -> CheckedEdit {
    let file = normalize_rel(&edit.file);
    if file.is_empty() {
        return CheckedEdit::rejected(edit, file, "The suggestion doesn't say which file to change.");
    }
    if project_file(root, &file).is_none() {
        return CheckedEdit::rejected(
            edit,
            file,
            "That file isn't part of this project, so Texo won't change it.",
        );
    }
    if !editable(&file) {
        return CheckedEdit::rejected(edit, file, "Texo only lets the AI change LaTeX and bibliography files.");
    }
    let disk;
    let content = match current {
        Some(c) => c,
        None => match read_project_text(root, &file) {
            Some(c) => {
                disk = c;
                &disk
            }
            None => return CheckedEdit::rejected(edit, file, "That file isn't a text file Texo can edit."),
        },
    };
    if edit.find.is_empty() {
        return CheckedEdit::rejected(edit, file, "The suggestion doesn't say which text to change.");
    }
    if edit.find.len() > MAX_EDIT_TEXT || edit.replace.len() > MAX_EDIT_TEXT {
        return CheckedEdit::rejected(edit, file, "The suggested change is too large to review safely.");
    }
    if edit.find == edit.replace {
        return CheckedEdit::rejected(edit, file, "The suggestion wouldn't change anything.");
    }

    // The model sees `\n` line endings; match the file's own.
    let crlf = content.contains("\r\n");
    let to_file = |s: &str| {
        if crlf && !s.contains("\r\n") {
            s.replace('\n', "\r\n")
        } else {
            s.to_string()
        }
    };
    let find = to_file(&edit.find);
    let replace = to_file(&edit.replace);
    let hits = occurrences(content, &find);
    match hits.len() {
        0 => CheckedEdit::rejected(
            edit,
            file,
            "The text to change wasn't found in the file (it may have been edited since).",
        ),
        1 => {
            let at = hits[0];
            let before = &content[..at];
            CheckedEdit {
                file,
                line: Some(before.matches('\n').count() as u32 + 1),
                offset_utf16: Some(before.encode_utf16().count() as u32),
                length_utf16: Some(find.encode_utf16().count() as u32),
                find,
                replace,
                why: edit.why.clone(),
                ok: true,
                reason: None,
            }
        }
        n => CheckedEdit::rejected(
            edit,
            file,
            format!("The text to change appears {n} times in the file, so Texo can't tell which one is meant."),
        ),
    }
}

/// Byte offsets of every occurrence, overlapping ones included.
fn occurrences(haystack: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(i) = haystack[start..].find(needle) {
        out.push(start + i);
        // Advance by one character, not one byte, to stay on a boundary.
        let step = haystack[start + i..].chars().next().map_or(1, char::len_utf8);
        start += i + step;
        if start > haystack.len() {
            break;
        }
    }
    out
}

/// Checks several edits; when two edits overlap, the later one is rejected.
pub fn check_edits(
    root: &Path,
    edits: &[EditInput],
    current: &std::collections::HashMap<String, String>,
) -> Vec<CheckedEdit> {
    let mut out: Vec<CheckedEdit> = Vec::new();
    for edit in edits {
        let file = normalize_rel(&edit.file);
        let mut checked = check_edit(root, edit, current.get(&file).map(String::as_str));
        if checked.ok {
            let (a, b) = span(&checked);
            let clash = out.iter().any(|o| {
                o.ok && o.file == checked.file && {
                    let (c, d) = span(o);
                    a < d && c < b
                }
            });
            if clash {
                checked = CheckedEdit::rejected(edit, file, "This change overlaps another suggested change.");
            }
        }
        out.push(checked);
    }
    out
}

fn span(e: &CheckedEdit) -> (u32, u32) {
    let start = e.offset_utf16.unwrap_or(0);
    (start, start + e.length_utf16.unwrap_or(0))
}

pub fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.tex"), "\\documentclass{article}\n\\usepackage{microtype}\n\\begin{document}\nHello \\cite{a}.\nHello again.\n\\end{document}\n").unwrap();
        fs::create_dir_all(dir.path().join("sec")).unwrap();
        fs::write(dir.path().join("sec/intro.tex"), "Intro line\r\nSecond line\r\n").unwrap();
        fs::write(dir.path().join("refs.bib"), "@article{a, title={T}}\n").unwrap();
        fs::write(dir.path().join("fig.pdf"), b"%PDF-1.5\0\0binary").unwrap();
        fs::write(dir.path().join("data.tex"), b"bin\0ary").unwrap();
        fs::write(dir.path().join(".latexmkrc"), "$pdf_mode = 1;\n").unwrap();
        fs::create_dir_all(dir.path().join(".texo")).unwrap();
        fs::write(dir.path().join(".texo/project.json"), "{}").unwrap();
        dir
    }

    fn edit(file: &str, find: &str, replace: &str) -> EditInput {
        EditInput { file: file.into(), find: find.into(), replace: replace.into(), why: "w".into() }
    }

    #[test]
    fn exact_single_match_is_accepted_with_offsets() {
        let dir = project();
        let e = check_edit(dir.path(), &edit("main.tex", "\\usepackage{microtype}", "\\usepackage[expansion=false]{microtype}"), None);
        assert!(e.ok, "{:?}", e.reason);
        assert_eq!(e.line, Some(2));
        assert_eq!(e.offset_utf16, Some("\\documentclass{article}\n".len() as u32));
        assert_eq!(e.length_utf16, Some("\\usepackage{microtype}".len() as u32));
    }

    #[test]
    fn zero_or_many_matches_are_rejected() {
        let dir = project();
        let none = check_edit(dir.path(), &edit("main.tex", "\\usepackage{lmodern}", "x"), None);
        assert!(!none.ok);
        assert!(none.reason.unwrap().contains("wasn't found"));
        let many = check_edit(dir.path(), &edit("main.tex", "Hello", "Hi"), None);
        assert!(!many.ok);
        assert!(many.reason.unwrap().contains("2 times"));
        // Overlapping occurrences count too.
        let dir2 = tempfile::tempdir().unwrap();
        fs::write(dir2.path().join("a.tex"), "aaa").unwrap();
        assert!(!check_edit(dir2.path(), &edit("a.tex", "aa", "b"), None).ok);
    }

    #[test]
    fn current_buffer_wins_over_disk() {
        let dir = project();
        let buffer = "\\documentclass{article}\n\\usepackage{lmodern}\n";
        let e = check_edit(dir.path(), &edit("main.tex", "\\usepackage{lmodern}", "y"), Some(buffer));
        assert!(e.ok);
        let e = check_edit(dir.path(), &edit("main.tex", "\\usepackage{microtype}", "y"), Some(buffer));
        assert!(!e.ok);
    }

    #[test]
    fn paths_outside_or_reserved_are_rejected() {
        let dir = project();
        let outside = dir.path().parent().unwrap().join("outside-texo-test.tex");
        for bad in [
            "../outside.tex",
            "sec/../../x.tex",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            ".texo/project.json",
            "missing.tex",
            "",
            outside.to_str().unwrap(),
        ] {
            let e = check_edit(dir.path(), &edit(bad, "a", "b"), Some("a"));
            assert!(!e.ok, "{bad} should be rejected");
        }
    }

    #[test]
    fn binary_and_non_latex_files_are_rejected() {
        let dir = project();
        assert!(!check_edit(dir.path(), &edit("fig.pdf", "PDF", "x"), None).ok);
        assert!(!check_edit(dir.path(), &edit("data.tex", "bin", "x"), None).ok);
        assert!(!check_edit(dir.path(), &edit(".latexmkrc", "$pdf_mode = 1;", "system('x');"), None).ok);
        assert!(check_edit(dir.path(), &edit("refs.bib", "title={T}", "title={U}"), None).ok);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_project_are_rejected() {
        let dir = project();
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("secret.tex"), "secret").unwrap();
        std::os::unix::fs::symlink(other.path().join("secret.tex"), dir.path().join("link.tex")).unwrap();
        assert!(!check_edit(dir.path(), &edit("link.tex", "secret", "x"), None).ok);
        assert!(read_project_text(dir.path(), "link.tex").is_none());
    }

    #[test]
    fn crlf_files_match_lf_suggestions() {
        let dir = project();
        let e = check_edit(dir.path(), &edit("./sec\\intro.tex", "Intro line\nSecond", "First line\nSecond"), None);
        assert!(e.ok, "{:?}", e.reason);
        assert_eq!(e.file, "sec/intro.tex");
        assert_eq!(e.find, "Intro line\r\nSecond");
        assert_eq!(e.replace, "First line\r\nSecond");
    }

    #[test]
    fn utf16_offsets_count_surrogates() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.tex"), "é😀 target").unwrap();
        let e = check_edit(dir.path(), &edit("a.tex", "target", "x"), None);
        assert_eq!(e.offset_utf16, Some(4)); // é=1, 😀=2, space=1
    }

    #[test]
    fn empty_and_noop_edits_are_rejected() {
        let dir = project();
        assert!(!check_edit(dir.path(), &edit("main.tex", "", "x"), None).ok);
        assert!(!check_edit(dir.path(), &edit("main.tex", "Hello again.", "Hello again."), None).ok);
        let huge = "x".repeat(MAX_EDIT_TEXT + 1);
        assert!(!check_edit(dir.path(), &edit("main.tex", "Hello again.", &huge), None).ok);
    }

    #[test]
    fn overlapping_edits_keep_only_the_first() {
        let dir = project();
        let edits = vec![
            edit("main.tex", "Hello again.", "Bye."),
            edit("main.tex", "again.", "later."),
            edit("refs.bib", "title={T}", "title={U}"),
        ];
        let out = check_edits(dir.path(), &edits, &HashMap::new());
        assert!(out[0].ok);
        assert!(!out[1].ok);
        assert!(out[2].ok);
    }

    #[test]
    fn package_names() {
        for ok in ["cm-super", "lm", "biblatex", "pgf_x.y-2"] {
            assert!(valid_package(ok), "{ok}");
        }
        for bad in ["", "-rf", "--admin", ".hidden", "a b", "a;b", "a/b", "$(x)", "ä", &"a".repeat(65)] {
            assert!(!valid_package(bad), "{bad}");
        }
    }
}
