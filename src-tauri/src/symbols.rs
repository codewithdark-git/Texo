//! Scans a project's `.tex` and `.bib` files for things the editor can
//! complete: labels for `\ref`, citation keys for `\cite`, and user-defined
//! commands.

#[cfg(test)]
use std::fs;
use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

use crate::bibinputs;
use crate::project::META_DIR;

const MAX_FILES: usize = 2000;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbols {
    pub labels: Vec<Label>,
    pub citations: Vec<Citation>,
    pub commands: Vec<String>,
    /// Argument-free macros whose definition is short text, such as
    /// `\newcommand{\numRuns}{5}`, so Visual mode can show what they print.
    pub text_macros: Vec<TextMacro>,
}

#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextMacro {
    pub name: String,
    pub body: String,
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
    /// The main document names this entry's database; those entries come first.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub referenced: bool,
}

pub fn scan(root: &Path) -> Symbols {
    let mut out = Symbols::default();
    // Only source files count toward the cap, so figures, data and a .git
    // folder can't crowd out the project's .tex and .bib files.
    let sources = WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.file_name() != META_DIR)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| source_ext(e.path()).map(|ext| (e, ext)))
        .take(MAX_FILES);
    let mut parsed_bibs: Vec<String> = Vec::new();
    let mut macros: Vec<(TextMacro, bool)> = Vec::new();
    for (entry, ext) in sources {
        let path = entry.path();
        // Size-limited, and not UTF-8 is fine: old .bib files are often Latin-1.
        let Some(text) = bibinputs::read_text(path) else { continue };
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if ext == "bib" {
            out.citations.extend(parse_bib(&text, &rel));
            parsed_bibs.push(rel);
        } else {
            out.labels.extend(parse_labels(&text, &rel));
            out.commands.extend(parse_commands(&text));
            macros.extend(parse_text_macros(&text));
        }
    }
    out.text_macros = choose_text_macros(macros);
    add_referenced_bibs(root, &mut out.citations, &parsed_bibs);
    out.commands.sort();
    out.commands.dedup();
    out
}

/// The file kinds the scan reads, by lowercase extension.
fn source_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    matches!(ext.as_str(), "tex" | "bib" | "sty" | "cls").then_some(ext)
}

/// Most databases outside the project folder read for one scan.
const MAX_EXTERNAL_BIBS: usize = 20;

/// Marks the citations from databases the main document names, puts them
/// first (in the order the document names them), and adds the ones it
/// reaches outside the project, like `\bibliography{../refs}`, or that the
/// scan never reached (`parsed` lists the ones it read). Only explicitly
/// named `.bib` files are read from outside.
fn add_referenced_bibs(root: &Path, citations: &mut Vec<Citation>, parsed: &[String]) {
    let main = crate::project::read_meta(root)
        .and_then(|m| m.main_document)
        .or_else(|| crate::project::detect_main_document(root));
    let Some(main) = main else { return };
    let main_path = root.join(main);
    let inputs = bibinputs::BibInputs::find(root, &main_path);
    let mut order: Vec<String> = Vec::new();
    let mut external = 0;
    for path in inputs.entries.into_iter().filter_map(|(_, p)| p) {
        let rel = relative_path(root, &path);
        if order.contains(&rel) {
            continue;
        }
        if !parsed.contains(&rel) {
            if !bibinputs::is_inside(root, &path) {
                if external >= MAX_EXTERNAL_BIBS {
                    continue;
                }
                external += 1;
            }
            if let Some(text) = bibinputs::read_text(&path) {
                citations.extend(parse_bib(&text, &rel));
            }
        }
        order.push(rel);
    }
    for c in citations.iter_mut() {
        c.referenced = order.contains(&c.file);
    }
    // A stable sort keeps each file's entries in file order.
    citations.sort_by_key(|c| order.iter().position(|f| *f == c.file).unwrap_or(usize::MAX));
}

/// `path` relative to `root` with forward slashes, using `..` for files
/// outside it (`../shared/refs.bib`). A path that shares no start with the
/// root (another drive on Windows) stays absolute: `C:/refs/lib.bib`.
fn relative_path(root: &Path, path: &Path) -> String {
    let key = |c: &std::path::Component| {
        let s = c.as_os_str().to_string_lossy().into_owned();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    let root = bibinputs::normalize(root);
    let path = bibinputs::normalize(path);
    let (r, p): (Vec<_>, Vec<_>) = (root.components().collect(), path.components().collect());
    let common = r.iter().zip(&p).take_while(|(a, b)| key(a) == key(b)).count();
    // On Windows the first component is the drive prefix, so `common == 0`
    // means another drive; a `..` path can't reach it.
    if common == 0 {
        return path.to_string_lossy().replace('\\', "/");
    }
    let mut parts: Vec<String> = vec!["..".to_string(); r.len() - common];
    parts.extend(p[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
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

/// One definition per name. A `\providecommand` (weak) only counts when
/// nothing else defines the name; otherwise the last definition wins.
fn choose_text_macros(defs: Vec<(TextMacro, bool)>) -> Vec<TextMacro> {
    let mut chosen: std::collections::BTreeMap<String, (String, bool)> = std::collections::BTreeMap::new();
    for (def, weak) in defs {
        let keep_existing = weak && chosen.contains_key(&def.name);
        let existing_strong = chosen.get(&def.name).is_some_and(|(_, w)| !w);
        if keep_existing || (existing_strong && weak) {
            continue;
        }
        chosen.insert(def.name, (def.body, weak));
    }
    chosen.into_iter().map(|(name, (body, _))| TextMacro { name, body }).collect()
}

/// Argument-free definitions with a short body: `\newcommand{\x}{5}`,
/// `\renewcommand\x{..}`, `\def\x{..}`, and `\providecommand` (flagged weak,
/// since it gives way to any other definition). Ones with parameters are skipped.
pub fn parse_text_macros(text: &str) -> Vec<(TextMacro, bool)> {
    const DEFINERS: &[(&str, bool)] = &[
        ("\\newcommand*", false),
        ("\\newcommand", false),
        ("\\renewcommand*", false),
        ("\\renewcommand", false),
        ("\\providecommand*", true),
        ("\\providecommand", true),
        ("\\def", false),
    ];
    let mut out = Vec::new();
    for line in text.lines() {
        let mut rest = strip_comment(line);
        while let Some(pos) = rest.find('\\') {
            rest = &rest[pos..];
            let Some(&(definer, weak)) = DEFINERS
                .iter()
                .find(|(d, _)| rest.starts_with(d) && !rest[d.len()..].starts_with(|c: char| c.is_ascii_alphabetic()))
            else {
                rest = &rest[1..];
                continue;
            };
            rest = rest[definer.len()..].trim_start();
            // `{\name}` or `\name`.
            let (target, tail) = match braced(rest) {
                Some(inner) => (inner.trim(), &rest[inner.len() + 2..]),
                None => (rest, ""),
            };
            let Some(name) = target.strip_prefix('\\') else { continue };
            let name: String = name.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '@').collect();
            if name.is_empty() {
                continue;
            }
            let tail = if tail.is_empty() && target.len() == rest.len() { &rest[1 + name.len()..] } else { tail };
            let tail = tail.trim_start();
            rest = tail;
            // `[1]` or `#1`: it takes arguments, so it isn't plain text.
            if tail.starts_with('[') || tail.starts_with('#') {
                continue;
            }
            if let Some(body) = braced(tail) {
                if !body.contains('#') && body.len() <= 200 {
                    out.push((TextMacro { name, body: body.trim().to_string() }, weak));
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
            referenced: false,
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
    fn finds_text_macros() {
        let tex = "\\providecommand{\\runs}{0}\n\\newcommand{\\runs}{5}\n\\newcommand\\acc{$0.72 \\pm 0.01$}\n\
                   \\newcommand{\\vect}[1]{#1}\n\\def\\x#1{#1}\n\\def\\y{why}\n% \\newcommand{\\hidden}{no}";
        let got: Vec<(String, String, bool)> = parse_text_macros(tex).into_iter().map(|(m, w)| (m.name, m.body, w)).collect();
        assert_eq!(
            got,
            vec![
                ("runs".into(), "0".into(), true),
                ("runs".into(), "5".into(), false),
                ("acc".into(), "$0.72 \\pm 0.01$".into(), false),
                ("y".into(), "why".into(), false),
            ]
        );
    }

    #[test]
    fn a_real_definition_beats_a_providecommand() {
        let both = |first: (&str, bool), second: (&str, bool)| {
            let m = |(body, weak): (&str, bool)| (TextMacro { name: "runs".into(), body: body.into() }, weak);
            choose_text_macros(vec![m(first), m(second)])[0].body.clone()
        };
        assert_eq!(both(("0", true), ("5", false)), "5");
        assert_eq!(both(("5", false), ("0", true)), "5");
        assert_eq!(both(("1", false), ("2", false)), "2");
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

    #[test]
    fn reads_latin1_bib_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.tex"), "\\bibliography{refs}").unwrap();
        fs::write(dir.path().join("refs.bib"), b"@book{mueller, author={J. M\xfcller}, title={T}}".as_slice()).unwrap();
        let s = scan(dir.path());
        assert_eq!(s.citations.len(), 1);
        assert_eq!(s.citations[0].key, "mueller");
        assert_eq!(s.citations[0].author.as_deref(), Some("J. M\u{fc}ller"));
    }

    #[test]
    fn referenced_databases_come_first_and_may_live_outside() {
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("paper");
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("main.tex"), "\\documentclass{article}\\begin{document}\n\\bibliography{refs,../shared}\n\\end{document}").unwrap();
        fs::write(root.join("old/unused.bib"), "@misc{a_unused, title={U}}").unwrap();
        fs::write(root.join("refs.bib"), "@misc{z_main, title={M}}").unwrap();
        fs::write(outer.path().join("shared.bib"), "@misc{m_shared, title={S}}").unwrap();
        // An unreferenced file outside the project is never read.
        fs::write(outer.path().join("other.bib"), "@misc{secret, title={X}}").unwrap();

        let s = scan(&root);
        let got: Vec<_> = s.citations.iter().map(|c| (c.key.as_str(), c.file.as_str(), c.referenced)).collect();
        assert_eq!(
            got,
            vec![("z_main", "refs.bib", true), ("m_shared", "../shared.bib", true), ("a_unused", "old/unused.bib", false)]
        );
        // Unreferenced entries keep the old JSON shape.
        let json = serde_json::to_value(&s.citations[2]).unwrap();
        assert!(json.get("referenced").is_none());
    }

    #[test]
    fn reads_a_referenced_database_the_scan_never_reached() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("main.tex"), "\\documentclass{article}\\begin{document}\n\\bibliography{refs}\n\\end{document}").unwrap();
        fs::write(root.join("refs.bib"), "@misc{k1, title={T}}").unwrap();
        // As if the walk hit its cap before refs.bib.
        let mut citations = Vec::new();
        add_referenced_bibs(root, &mut citations, &[]);
        assert_eq!(citations.len(), 1);
        assert_eq!((citations[0].key.as_str(), citations[0].file.as_str(), citations[0].referenced), ("k1", "refs.bib", true));
        // Already parsed: not read twice.
        let mut citations = Vec::new();
        add_referenced_bibs(root, &mut citations, &["refs.bib".to_string()]);
        assert!(citations.is_empty());
    }

    #[test]
    fn non_source_files_dont_count_toward_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("aa_figures")).unwrap();
        for i in 0..MAX_FILES + 5 {
            fs::write(root.join(format!("aa_figures/f{i}.png")), "").unwrap();
        }
        fs::write(root.join("zz.bib"), "@misc{late, title={T}}").unwrap();
        assert!(scan(root).citations.iter().any(|c| c.key == "late"));
    }

    #[cfg(windows)]
    #[test]
    fn a_database_on_another_drive_keeps_its_absolute_path() {
        assert_eq!(relative_path(Path::new("D:\\work\\paper"), Path::new("C:\\refs\\lib.bib")), "C:/refs/lib.bib");
        assert_eq!(relative_path(Path::new("D:\\work\\paper"), Path::new("D:\\work\\shared.bib")), "../shared.bib");
    }
}
