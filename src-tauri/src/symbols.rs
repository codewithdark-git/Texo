//! Scans a project's `.tex` and `.bib` files for things the editor can
//! complete: labels for `\ref`, citation keys for `\cite`, and user-defined
//! commands.

use std::fs;
use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

use crate::fsops::MAX_TEXT_BYTES;
use crate::project::META_DIR;

const MAX_FILES: usize = 2000;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbols {
    pub labels: Vec<Label>,
    pub citations: Vec<Citation>,
    pub commands: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub key: String,
    pub entry_type: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub year: Option<String>,
    pub file: String,
}

pub fn scan(root: &Path) -> Symbols {
    let mut out = Symbols::default();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.file_name() != META_DIR)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .take(MAX_FILES)
    {
        let path = entry.path();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "tex" | "bib" | "sty" | "cls") {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_TEXT_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(path) else { continue };
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if ext == "bib" {
            out.citations.extend(parse_bib(&text, &rel));
        } else {
            out.labels.extend(parse_labels(&text, &rel));
            out.commands.extend(parse_commands(&text));
        }
    }
    out.commands.sort();
    out.commands.dedup();
    out
}

/// Text before a `%` that isn't escaped as `\%`.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'%' && (i == 0 || bytes[i - 1] != b'\\') {
            return &line[..i];
        }
    }
    line
}

/// The text inside the braces that start at `s`, if `s` starts with `{`.
fn braced(s: &str) -> Option<&str> {
    let rest = s.strip_prefix('{')?;
    let mut depth = 1;
    for (i, c) in rest.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&rest[..i]);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn parse_labels(text: &str, file: &str) -> Vec<Label> {
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = strip_comment(line);
        let mut rest = line;
        while let Some(pos) = rest.find("\\label") {
            rest = &rest[pos + "\\label".len()..];
            if let Some(name) = braced(rest.trim_start()) {
                let name = name.trim();
                if !name.is_empty() {
                    out.push(Label {
                        name: name.to_string(),
                        file: file.to_string(),
                        line: n + 1,
                    });
                }
            }
        }
    }
    out
}

/// Names (without the backslash) from `\newcommand`, `\renewcommand`,
/// `\providecommand`, `\DeclareMathOperator`, and `\def`.
pub fn parse_commands(text: &str) -> Vec<String> {
    const DEFINERS: &[&str] = &[
        "\\newcommand*",
        "\\newcommand",
        "\\renewcommand*",
        "\\renewcommand",
        "\\providecommand*",
        "\\providecommand",
        "\\DeclareMathOperator*",
        "\\DeclareMathOperator",
        "\\def",
    ];
    let mut out = Vec::new();
    for line in text.lines() {
        let line = strip_comment(line);
        for definer in DEFINERS {
            let mut rest = line;
            while let Some(pos) = rest.find(definer) {
                rest = &rest[pos + definer.len()..];
                // `\newcommand{\foo}` or `\newcommand\foo`; skip `\newcommandx`.
                let after = rest.trim_start();
                let target = braced(after).unwrap_or(after).trim_start();
                if let Some(name) = target.strip_prefix('\\') {
                    let name: String = name.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '@').collect();
                    if !name.is_empty() && !rest.starts_with(|c: char| c.is_ascii_alphabetic()) {
                        out.push(name);
                    }
                }
            }
        }
    }
    out
}

/// Reads entry keys and a few display fields from a `.bib` file. This is a
/// forgiving scan, not a full BibTeX parser.
pub fn parse_bib(text: &str, file: &str) -> Vec<Citation> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        rest = &rest[at + 1..];
        let type_end = rest.find(['{', '(']).unwrap_or(0);
        let entry_type = rest[..type_end].trim().to_lowercase();
        if entry_type.is_empty()
            || !entry_type.chars().all(|c| c.is_ascii_alphabetic())
            || matches!(entry_type.as_str(), "comment" | "string" | "preamble")
        {
            continue;
        }
        let body = &rest[type_end + 1..];
        let Some(comma) = body.find(',') else { continue };
        let key = body[..comma].trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            continue;
        }
        let end = body.find("\n@").unwrap_or(body.len());
        let fields = &body[comma + 1..end];
        out.push(Citation {
            key: key.to_string(),
            entry_type,
            title: bib_field(fields, "title"),
            author: bib_field(fields, "author"),
            year: bib_field(fields, "year"),
            file: file.to_string(),
        });
    }
    out
}

fn bib_field(fields: &str, name: &str) -> Option<String> {
    // ASCII lowercasing keeps byte offsets identical to `fields`.
    let lower = fields.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let start = from + pos;
        from = start + name.len();
        // Must be a whole field name: preceded by a separator, followed by `=`.
        let before_ok = start == 0
            || lower[..start].ends_with(|c: char| c.is_whitespace() || c == ',');
        let after = fields[from..].trim_start();
        if !before_ok || !after.starts_with('=') {
            continue;
        }
        let value = after[1..].trim_start();
        let raw = if value.starts_with('{') {
            braced(value)?
        } else if let Some(v) = value.strip_prefix('"') {
            &v[..v.find('"')?]
        } else {
            value.split([',', '\n', '}']).next()?.trim()
        };
        let cleaned: String = raw
            .chars()
            .filter(|c| *c != '{' && *c != '}')
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return (!cleaned.is_empty()).then_some(cleaned);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_labels_skipping_comments() {
        let tex = "\\section{A}\\label{sec:a}\n% \\label{gone}\n50\\% done \\label{ fig:x }\n";
        let labels = parse_labels(tex, "main.tex");
        let names: Vec<_> = labels.iter().map(|l| (l.name.as_str(), l.line)).collect();
        assert_eq!(names, vec![("sec:a", 1), ("fig:x", 3)]);
    }

    #[test]
    fn finds_user_commands() {
        let tex = "\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand*\\vect[1]{#1}\n\
                   \\DeclareMathOperator{\\argmax}{arg\\,max}\n\\def\\eps{\\epsilon}\n\
                   \\newcommandx\\no{}\n% \\newcommand{\\hidden}{}";
        assert_eq!(parse_commands(tex), vec!["R", "vect", "argmax", "eps"]);
    }

    #[test]
    fn parses_bib_entries() {
        let bib = "@comment{ignore}\n@Book{knuth1984,\n  author = {Donald E. Knuth},\n  \
                   title = {The {\\TeX}book},\n  year = 1984\n}\n\
                   @article{ smith2020 ,\n booktitle = \"Not this\",\n title = \"Deep {Nets}\"\n}\n";
        let c = parse_bib(bib, "refs.bib");
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].key, "knuth1984");
        assert_eq!(c[0].entry_type, "book");
        assert_eq!(c[0].title.as_deref(), Some("The \\TeXbook"));
        assert_eq!(c[0].author.as_deref(), Some("Donald E. Knuth"));
        assert_eq!(c[0].year.as_deref(), Some("1984"));
        assert_eq!(c[1].key, "smith2020");
        assert_eq!(c[1].title.as_deref(), Some("Deep Nets"));
    }

    #[test]
    fn scans_a_project_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.tex"), "\\label{eq:1}\\newcommand{\\N}{}").unwrap();
        fs::write(dir.path().join("refs.bib"), "@misc{k1, title={T}}").unwrap();
        fs::create_dir_all(dir.path().join(".texo")).unwrap();
        fs::write(dir.path().join(".texo/x.tex"), "\\label{hidden}").unwrap();
        let s = scan(dir.path());
        assert_eq!(s.labels.len(), 1);
        assert_eq!(s.citations[0].key, "k1");
        assert_eq!(s.commands, vec!["N"]);
    }
}
