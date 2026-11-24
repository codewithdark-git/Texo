//! Finds the bibliography databases a document asks for, the way BibTeX and
//! Biber will look for them.
//!
//! The compiler uses this to decide how to run BibTeX (latexmk's own check
//! for missing `.bib` files is unreliable on Windows), and the symbol scan
//! uses it to offer citation keys from the files the document really uses.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::fsops::MAX_TEXT_BYTES;

/// Most `.tex` files followed through `\input` and friends, so a huge or
/// self-including project can't stall a compile.
const MAX_TEX_FILES: usize = 200;

/// Decodes text that may not be UTF-8. Files that aren't valid UTF-8 are
/// almost always Windows-1252 or Latin-1 (old `.bib` exports especially),
/// so each byte is mapped through Windows-1252 instead of being dropped.
pub fn decode_lossy(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    }
}

/// One Windows-1252 byte as a character. Bytes 0x80–0x9F hold curly quotes
/// and dashes there; the rest match Latin-1, which matches Unicode.
fn windows_1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{81}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
        '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{8D}', '\u{017D}', '\u{8F}',
        '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
        '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{9D}', '\u{017E}', '\u{0178}',
    ];
    match b {
        0x80..=0x9F => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

/// Reads a text file of at most [`MAX_TEXT_BYTES`], decoding it lossily.
pub fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_TEXT_BYTES {
        return None;
    }
    fs::read(path).ok().map(|b| decode_lossy(&b))
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

fn without_comments(text: &str) -> String {
    text.lines().map(strip_comment).collect::<Vec<_>>().join("\n")
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

/// Skips an optional `[…]` argument and surrounding whitespace.
fn skip_optional(s: &str) -> &str {
    let s = s.trim_start();
    match s.strip_prefix('[').and_then(|r| r.find(']').map(|end| &r[end + 1..])) {
        Some(rest) => rest.trim_start(),
        None => s,
    }
}

/// The braced arguments of every `\name{…}` (or `\name[…]{…}`) in `text`.
/// `\bibliography` must not match `\bibliographystyle`, so the command name
/// has to end where the letters end.
fn command_args<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    let needle = format!("\\{name}");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find(&needle) {
        rest = &rest[pos + needle.len()..];
        if rest.starts_with(|c: char| c.is_ascii_alphabetic() || c == '@') {
            continue;
        }
        let after = skip_optional(rest.strip_prefix('*').unwrap_or(rest));
        if let Some(arg) = braced(after) {
            out.push(arg);
        }
    }
    out
}

/// Database names exactly as one file's text gives them, with `.bib` added
/// where it's missing: `\bibliography{a,b.bib}` and biblatex's
/// `\addbibresource[…]{x.bib}` / `\addglobalbib{…}`.
pub fn parse_bib_names(text: &str) -> Vec<String> {
    let text = without_comments(text);
    let mut names = Vec::new();
    for arg in command_args(&text, "bibliography") {
        names.extend(arg.split(',').map(str::to_string));
    }
    for cmd in ["addbibresource", "addglobalbib"] {
        names.extend(command_args(&text, cmd).into_iter().map(str::to_string));
    }
    names
        .into_iter()
        .map(|n| n.trim().to_string())
        // Macros such as `\jobname` and remote resources can't be resolved here.
        .filter(|n| !n.is_empty() && !n.contains('\\') && !n.contains("://"))
        .map(|n| if n.to_ascii_lowercase().ends_with(".bib") { n } else { format!("{n}.bib") })
        .collect()
}

/// Files `text` pulls in: `\input{x}`, `\include{x}`, `\subfile{x}`.
fn parse_includes(text: &str) -> Vec<String> {
    let text = without_comments(text);
    ["input", "include", "subfile"]
        .iter()
        .flat_map(|cmd| command_args(&text, cmd))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && !n.contains('\\'))
        .collect()
}

/// Resolves `.` and `..` without touching the disk.
pub fn normalize(path: &Path) -> PathBuf {
    let mut parts: Vec<Component> = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(parts.last(), Some(Component::Normal(_))) {
                    parts.pop();
                } else {
                    parts.push(c);
                }
            }
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

/// Whether `path` lies inside `root`, judged on the normalised paths.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    let norm = |p: &Path| normalize(p).to_string_lossy().replace('\\', "/").to_lowercase();
    let (p, r) = (norm(path), norm(root));
    let r = r.trim_end_matches('/');
    p == r || p.starts_with(&format!("{r}/"))
}

/// Where BibTeX would find `name`: relative to the main file's folder
/// (where TeX runs), then the project root, like a BIBINPUTS search path.
pub fn resolve(name: &str, main_dir: &Path, root: &Path) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() {
        return p.is_file().then(|| normalize(p));
    }
    [main_dir, root].iter().map(|d| normalize(&d.join(p))).find(|c| c.is_file())
}

/// Database names the main document and the project files it includes ask
/// for, in document order and without repeats.
pub fn referenced_bib_names(root: &Path, main_path: &Path) -> Vec<String> {
    let main_dir = main_path.parent().unwrap_or(root);
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut queue = vec![normalize(main_path)];
    while let Some(file) = queue.pop() {
        if seen.len() >= MAX_TEX_FILES || !seen.insert(file.clone()) {
            continue;
        }
        let Some(text) = read_text(&file) else { continue };
        for name in parse_bib_names(&text) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        // TeX resolves `\input` against the folder it runs in; `\subfile`
        // users often write paths relative to the including file instead.
        let here = file.parent().unwrap_or(main_dir).to_path_buf();
        let mut children = Vec::new();
        for inc in parse_includes(&text) {
            let with_ext = if Path::new(&inc).extension().is_some() { inc.clone() } else { format!("{inc}.tex") };
            let found = [main_dir, here.as_path(), root]
                .iter()
                .flat_map(|d| [d.join(&with_ext), d.join(&inc)])
                .map(|p| normalize(&p))
                .find(|p| p.is_file() && is_inside(root, p));
            children.extend(found);
        }
        // Reverse so the stack visits includes in document order.
        queue.extend(children.into_iter().rev());
    }
    names
}

/// The databases a document uses, each with where it was found (if anywhere).
pub struct BibInputs {
    pub entries: Vec<(String, Option<PathBuf>)>,
}

impl BibInputs {
    pub fn find(root: &Path, main_path: &Path) -> Self {
        let main_dir = main_path.parent().unwrap_or(root);
        let entries = referenced_bib_names(root, main_path)
            .into_iter()
            .map(|n| {
                let found = resolve(&n, main_dir, root);
                (n, found)
            })
            .collect();
        BibInputs { entries }
    }

    #[cfg(test)]
    pub fn all_found(&self) -> bool {
        !self.entries.is_empty() && self.entries.iter().all(|(_, p)| p.is_some())
    }

    pub fn none_found(&self) -> bool {
        self.entries.iter().all(|(_, p)| p.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bibliography_commands() {
        let tex = "\\bibliographystyle{plain}\n\\bibliography{a, b.bib,dir/c}\n\
                   % \\bibliography{commented}\n\\addbibresource[label=x]{refs.bib}\n\
                   \\addbibresource{other}\\bibliography{\\jobname}\n\\addbibresource[location=remote]{http://x.org/y.bib}";
        assert_eq!(parse_bib_names(tex), vec!["a.bib", "b.bib", "dir/c.bib", "refs.bib", "other.bib"]);
    }

    #[test]
    fn decodes_latin1_text() {
        assert_eq!(decode_lossy(b"M\xfcller \x93q\x94"), "M\u{fc}ller \u{201C}q\u{201D}");
        assert_eq!(decode_lossy("Müller".as_bytes()), "Müller");
        assert_eq!(decode_lossy(b"\xEF\xBB\xBF@misc"), "@misc");
    }

    #[test]
    fn follows_inputs_and_resolves_like_bibinputs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("paper/sections")).unwrap();
        fs::create_dir_all(root.join("bib")).unwrap();
        fs::write(
            root.join("paper/main.tex"),
            "\\input{sections/intro}\n%\\include{gone}\n\\bibliography{local,bib/shared,missing}\n",
        )
        .unwrap();
        fs::write(root.join("paper/sections/intro.tex"), "\\addbibresource{extra.bib}\n\\input{sections/intro}").unwrap();
        fs::write(root.join("paper/local.bib"), "").unwrap();
        fs::write(root.join("bib/shared.bib"), "").unwrap();
        fs::write(root.join("paper/extra.bib"), "").unwrap();

        let main = root.join("paper/main.tex");
        assert_eq!(referenced_bib_names(root, &main), vec!["local.bib", "bib/shared.bib", "missing.bib", "extra.bib"]);
        let inputs = BibInputs::find(root, &main);
        let found: Vec<bool> = inputs.entries.iter().map(|(_, p)| p.is_some()).collect();
        // `bib/shared.bib` isn't next to main.tex but is found from the project root.
        assert_eq!(found, vec![true, true, false, true]);
        assert!(!inputs.all_found());
        assert!(!inputs.none_found());
    }

    #[test]
    fn judges_paths_inside_the_root() {
        let root = Path::new("/p/proj");
        assert!(is_inside(root, Path::new("/p/proj/a/../b.bib")));
        assert!(!is_inside(root, Path::new("/p/proj/../refs.bib")));
        assert!(!is_inside(root, Path::new("/p/project2/x.bib")));
    }
}
