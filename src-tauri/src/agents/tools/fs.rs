//! File tools over the run's overlay: `list_files`, `read_file`, `search`,
//! `edit_file`, `write_file`, `delete_file`. Results are plain text for the
//! model, capped.

use regex::RegexBuilder;

use crate::agents::overlay::{Glob, Overlay};
use crate::error::{AppError, AppResult};

/// Tool results are capped at about this many characters.
pub const MAX_RESULT_CHARS: usize = 12_000;
const MAX_HITS: usize = 100;
/// `write_file` won't replace an existing file larger than this.
const MAX_REPLACE_CHARS: usize = 40_000;
const SEARCH_EXTENSIONS: &[&str] =
    &["tex", "ltx", "sty", "cls", "bib", "bbx", "cbx", "txt", "md", "csv", "tsv", "tikz", "pgf", "cfg", "def", "dtx", "ins", "bst"];

pub fn list_files(o: &Overlay, glob: Option<&str>) -> AppResult<String> {
    let (files, more) = o.list(glob)?;
    if files.is_empty() {
        return Ok(match glob {
            Some(g) => format!("No files match \"{g}\"."),
            None => "The project has no files.".into(),
        });
    }
    let mut out = String::new();
    for (path, size) in &files {
        out.push_str(&format!("{path} ({})\n", human_size(*size)));
    }
    if more {
        out.push_str("… more files not shown; narrow the list with a glob such as \"sections/*.tex\".\n");
    }
    Ok(out)
}

fn human_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

/// Numbered lines `start..=end` (1-based), capped at [`MAX_RESULT_CHARS`].
pub fn read_file(o: &mut Overlay, path: &str, start: Option<u64>, end: Option<u64>) -> AppResult<String> {
    let text = o.read(path)?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    if total == 0 {
        return Ok(format!("{} is empty.", path.trim()));
    }
    let start = start.unwrap_or(1).max(1) as usize;
    if start > total {
        return Err(AppError::msg(format!("{} has only {total} lines.", path.trim())));
    }
    let end = end.map(|e| e as usize).unwrap_or(total).clamp(start, total);
    let width = end.to_string().len();
    let mut out = String::new();
    let mut last = start - 1;
    for (i, line) in lines[start - 1..end].iter().enumerate() {
        let n = start + i;
        let row = format!("{n:>width$}| {line}\n");
        if out.len() + row.len() > MAX_RESULT_CHARS && n > start {
            break;
        }
        out.push_str(&row);
        last = n;
    }
    if last < end {
        out.push_str(&format!(
            "… shown lines {start}–{last} of {total}. Call read_file again with start_line {} to read on.\n",
            last + 1
        ));
    } else if start > 1 || end < total {
        out.push_str(&format!("(lines {start}–{end} of {total})\n"));
    }
    Ok(out)
}

/// Regex search (an invalid regex is searched as plain text) over the
/// project's text files.
pub fn search(o: &Overlay, pattern: &str, glob: Option<&str>) -> AppResult<String> {
    if pattern.trim().is_empty() {
        return Err(AppError::msg("Give a pattern to search for."));
    }
    let re = RegexBuilder::new(pattern)
        .case_insensitive(!pattern.chars().any(char::is_uppercase))
        .size_limit(1 << 20)
        .build()
        .or_else(|_| RegexBuilder::new(&regex::escape(pattern)).case_insensitive(true).build())
        .map_err(|_| AppError::msg("That search pattern isn't valid."))?;
    let matcher = glob.map(str::trim).filter(|g| !g.is_empty()).map(Glob::new).transpose()?;
    let (files, _) = o.list(None)?;
    let mut hits = Vec::new();
    let mut total = 0usize;
    for (path, size) in files {
        if size > 2 * 1024 * 1024 || matcher.as_ref().is_some_and(|m| !m.matches(&path)) {
            continue;
        }
        let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !SEARCH_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(Some(text)) = o.peek(&path) else { continue };
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                total += 1;
                if hits.len() < MAX_HITS {
                    let shown: String = line.trim().chars().take(200).collect();
                    hits.push(format!("{path}:{}: {shown}", i + 1));
                }
            }
        }
    }
    if hits.is_empty() {
        return Ok(format!("No matches for \"{pattern}\"."));
    }
    let mut out = hits.join("\n");
    if total > hits.len() {
        out.push_str(&format!("\n… {total} matches in all; showing the first {}. Narrow the pattern or the glob.", hits.len()));
    }
    Ok(crate::agents::types::cap(&out, MAX_RESULT_CHARS))
}

pub fn edit_file(o: &mut Overlay, path: &str, old: &str, new: &str, reason: &str) -> AppResult<String> {
    let e = o.edit(path, old, new, reason)?;
    let text = o.read(path)?;
    let lines: Vec<&str> = text.lines().collect();
    let from = e.line.saturating_sub(3).max(1);
    let to = (e.line + e.added_lines.max(1) + 2).min(lines.len());
    let mut out = format!(
        "Edited {} at line {} ({} line(s) replaced by {}). The file now reads:\n",
        path.trim(),
        e.line,
        e.removed_lines,
        e.added_lines
    );
    for n in from..=to {
        if let Some(l) = lines.get(n - 1) {
            out.push_str(&format!("{n}| {l}\n"));
        }
    }
    Ok(out)
}

pub fn write_file(o: &mut Overlay, path: &str, text: &str, reason: &str) -> AppResult<String> {
    let existing = o.peek(path)?;
    if let Some(old) = &existing {
        if old.chars().count() > MAX_REPLACE_CHARS {
            return Err(AppError::msg(format!(
                "{} is large; change it with edit_file instead of replacing the whole file.",
                path.trim()
            )));
        }
    }
    let key = o.write(path, text, reason)?;
    Ok(match existing {
        Some(_) => format!("Replaced {key} ({} lines).", text.lines().count()),
        None => format!("Created {key} ({} lines).", text.lines().count()),
    })
}

pub fn delete_file(o: &mut Overlay, path: &str, reason: &str) -> AppResult<String> {
    let key = o.delete(path, reason)?;
    Ok(format!("Deleted {key} (the user reviews this before anything changes on disk)."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn overlay() -> (tempfile::TempDir, Overlay) {
        let d = tempfile::tempdir().unwrap();
        let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        fs::write(d.path().join("main.tex"), &body).unwrap();
        fs::write(d.path().join("refs.bib"), "@article{knuth84,\n  title={Literate Programming}\n}\n").unwrap();
        let o = Overlay::new(d.path(), Vec::new());
        (d, o)
    }

    #[test]
    fn read_file_numbers_lines_and_pages() {
        let (_d, mut o) = overlay();
        let all = read_file(&mut o, "main.tex", None, None).unwrap();
        assert!(all.starts_with(" 1| line 1\n"), "{all}");
        let part = read_file(&mut o, "main.tex", Some(5), Some(6)).unwrap();
        assert!(part.contains("5| line 5") && part.contains("6| line 6") && part.contains("of 30"));
        assert!(read_file(&mut o, "main.tex", Some(99), None).is_err());
    }

    #[test]
    fn search_and_list() {
        let (_d, mut o) = overlay();
        let hits = search(&o, "line 1[0-2]$", None).unwrap();
        assert_eq!(hits.lines().count(), 3, "{hits}");
        assert!(hits.starts_with("main.tex:10: line 10"));
        assert!(search(&o, "literate", Some("*.bib")).unwrap().contains("refs.bib:2:"));
        assert!(search(&o, "(unclosed", None).unwrap().contains("No matches"));
        o.write("extra.tex", "line 10 again\n", "r").unwrap();
        assert!(search(&o, "again", None).unwrap().contains("extra.tex:1:"));
        let list = list_files(&o, Some("*.tex")).unwrap();
        assert!(list.contains("main.tex") && list.contains("extra.tex") && !list.contains("refs.bib"));
    }

    #[test]
    fn write_and_delete_report_what_happened() {
        let (_d, mut o) = overlay();
        assert!(write_file(&mut o, "new.tex", "a\nb\n", "r").unwrap().starts_with("Created new.tex"));
        assert!(write_file(&mut o, "new.tex", "c\n", "r").unwrap().starts_with("Replaced"));
        assert!(delete_file(&mut o, "refs.bib", "r").unwrap().contains("Deleted refs.bib"));
        let e = edit_file(&mut o, "main.tex", "line 7\n", "line seven\n", "r").unwrap();
        assert!(e.contains("at line 7") && e.contains("7| line seven"), "{e}");
    }
}
