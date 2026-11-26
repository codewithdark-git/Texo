//! Reads the paper's sources for the checklist: the main document and the
//! files it `\input`s / `\include`s (or every `.tex` file when there is no
//! main document), the `.bib` files it uses, with comments blanked out so
//! line numbers stay right.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path};

use regex::Regex;
use walkdir::WalkDir;

use crate::project::{to_slash, SKIPPED_DIRS};

/// At most this many `.tex` files are read.
pub const MAX_TEX_FILES: usize = 300;
const MAX_BIB_FILES: usize = 30;
/// Bigger files are skipped (generated tables, data dumps).
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WALK: usize = 30_000;

pub struct TexFile {
    /// Project-relative, `/`-separated.
    pub rel: String,
    /// The text with comments (and `comment` environments) replaced by
    /// spaces, so offsets and line numbers match the file.
    pub code: String,
    line_starts: Vec<usize>,
}

impl TexFile {
    pub fn new(rel: String, raw: &str) -> TexFile {
        let code = strip_comments(raw);
        let mut line_starts = vec![0];
        line_starts.extend(code.match_indices('\n').map(|(i, _)| i + 1));
        TexFile {
            rel,
            code,
            line_starts,
        }
    }

    /// 1-based line of a byte offset into `code`.
    pub fn line_at(&self, offset: usize) -> u32 {
        match self.line_starts.binary_search(&offset) {
            Ok(i) => i as u32 + 1,
            Err(i) => i as u32,
        }
    }

    /// `file:line`.
    pub fn at(&self, offset: usize) -> String {
        format!("{}:{}", self.rel, self.line_at(offset))
    }
}

pub struct BibFile {
    pub rel: String,
    pub text: String,
}

#[derive(Default)]
pub struct Sources {
    /// The main document (project-relative), when known.
    pub main: Option<String>,
    /// The main document's folder (project-relative, `""` for the root):
    /// TeX resolves `\input` and figures from there.
    pub main_dir: String,
    /// Main document first.
    pub tex: Vec<TexFile>,
    pub bib: Vec<BibFile>,
    /// Files kept only in the cloud (OneDrive), not read.
    pub cloud_only: Vec<String>,
    /// Included files that don't exist.
    pub missing_inputs: Vec<(String, String)>,
}

/// Replaces `%` comments and `\begin{comment}…\end{comment}` with spaces
/// (newlines kept). `\%` is not a comment.
pub fn strip_comments(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for line in raw.split_inclusive('\n') {
        let bytes = line.as_bytes();
        let mut cut = None;
        let mut backslashes = 0;
        for (i, b) in bytes.iter().enumerate() {
            match b {
                b'\\' => backslashes += 1,
                b'%' if backslashes % 2 == 0 => {
                    cut = Some(i);
                    break;
                }
                _ => backslashes = 0,
            }
        }
        match cut {
            Some(i) => {
                out.push_str(&line[..i]);
                for c in line[i..].chars() {
                    out.push(if c == '\n' || c == '\r' { c } else { ' ' });
                }
            }
            None => out.push_str(line),
        }
    }
    // `comment` environments (verbatim-like, from the comment package).
    let mut result = out.clone();
    let begin = "\\begin{comment}";
    let end = "\\end{comment}";
    let mut from = 0;
    while let Some(b) = out[from..].find(begin).map(|i| i + from) {
        let e = out[b..]
            .find(end)
            .map(|i| i + b + end.len())
            .unwrap_or(out.len());
        let blank: String = out[b..e]
            .chars()
            .map(|c| if c == '\n' || c == '\r' { c } else { ' ' })
            .collect();
        result.replace_range(b..e, &blank);
        from = e;
    }
    result
}

/// The content of the `{…}` group starting at or after `pos` (skipping
/// spaces and up to `max_opts` `[…]` options): (start, end) of the inside.
pub fn group_after(text: &str, pos: usize, max_opts: usize) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = pos;
    let mut opts = 0;
    loop {
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'[' && opts < max_opts {
            let mut depth = 0;
            while i < bytes.len() {
                match bytes[i] {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            i += 1;
            opts += 1;
            continue;
        }
        break;
    }
    if i >= bytes.len() || bytes[i] != b'{' {
        return None;
    }
    let start = i + 1;
    let mut depth = 0;
    let mut escaped = false;
    for (j, b) in bytes.iter().enumerate().skip(i) {
        if escaped {
            escaped = false;
            continue;
        }
        match b {
            b'\\' => escaped = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((start, j));
                }
            }
            _ => {}
        }
    }
    None
}

/// `a/./b/../c` → `a/c`; `None` when it leaves the project or is absolute.
pub fn normalize_rel(path: &str) -> Option<String> {
    let p = Path::new(path);
    if p.is_absolute() || path.starts_with('/') || path.starts_with('\\') {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

pub fn join_rel(dir: &str, file: &str) -> Option<String> {
    let file = file.trim().replace('\\', "/");
    if dir.is_empty() {
        normalize_rel(&file)
    } else {
        normalize_rel(&format!("{dir}/{file}"))
    }
}

pub fn parent_rel(rel: &str) -> String {
    rel.rsplit_once('/')
        .map(|(d, _)| d.to_string())
        .unwrap_or_default()
}

/// Reads a file's text unless it is a cloud placeholder, too big or missing.
fn read_text(root: &Path, rel: &str, cloud: &mut Vec<String>) -> Option<String> {
    let path = root.join(rel);
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    if crate::project::is_cloud_placeholder(&meta) {
        cloud.push(rel.to_string());
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_file(root: &Path, rel: &str) -> bool {
    root.join(rel).is_file()
}

/// `name` or `name.tex`, whichever exists.
fn resolve_tex(root: &Path, dir: &str, name: &str) -> Option<String> {
    let rel = join_rel(dir, name)?;
    if rel.ends_with(".tex") && is_file(root, &rel) {
        return Some(rel);
    }
    let with = format!("{rel}.tex");
    if is_file(root, &with) {
        return Some(with);
    }
    is_file(root, &rel).then_some(rel)
}

fn walk_files(root: &Path, ext: &str) -> Vec<String> {
    let mut out: Vec<String> = WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            !(e.depth() > 0
                && e.file_type().is_dir()
                && SKIPPED_DIRS.iter().any(|d| e.file_name() == *d))
        })
        .filter_map(Result::ok)
        .take(MAX_WALK)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let rel = e.path().strip_prefix(root).ok()?;
            let name = e.file_name().to_string_lossy().to_lowercase();
            name.ends_with(ext).then(|| to_slash(rel))
        })
        .collect();
    out.sort();
    out
}

/// Loads the sources, following `\input`, `\include`, `\subfile`, `\import`
/// and `\subimport` from the main document. With no main document (or a
/// missing one), every `.tex` file in the project is read.
pub fn load(root: &Path, main: Option<&str>) -> Sources {
    let mut s = Sources::default();
    let main = main.and_then(normalize_rel).filter(|m| is_file(root, m));
    match &main {
        Some(m) => {
            s.main = Some(m.clone());
            s.main_dir = parent_rel(m);
            follow(root, m, &mut s);
        }
        None => {
            let mut cloud = Vec::new();
            for rel in walk_files(root, ".tex").into_iter().take(MAX_TEX_FILES) {
                if let Some(text) = read_text(root, &rel, &mut cloud) {
                    s.tex.push(TexFile::new(rel, &text));
                }
            }
            s.cloud_only.extend(cloud);
        }
    }
    load_bibs(root, &mut s);
    s
}

fn follow(root: &Path, main: &str, s: &mut Sources) {
    let input =
        Regex::new(r"\\(input|include|subfile|InputIfFileExists|includeonly)\b\s*").expect("regex");
    let bare_input = Regex::new(r"\\input\s+([A-Za-z0-9_./-]+)").expect("regex");
    let import =
        Regex::new(r"\\(import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\*?\s*")
            .expect("regex");
    let mut seen: HashSet<String> = HashSet::new();
    // (file, folder its relative \subimport paths start from)
    let mut queue: Vec<(String, String)> = vec![(main.to_string(), s.main_dir.clone())];
    let mut cloud = Vec::new();
    while let Some((rel, import_dir)) = queue.pop() {
        if !seen.insert(rel.to_lowercase()) || s.tex.len() >= MAX_TEX_FILES {
            continue;
        }
        let Some(text) = read_text(root, &rel, &mut cloud) else {
            continue;
        };
        let file = TexFile::new(rel.clone(), &text);
        let code = file.code.clone();
        let mut found: Vec<(usize, String, String)> = Vec::new();
        for m in input.captures_iter(&code) {
            let whole = m.get(0).expect("match");
            if &m[1] == "includeonly" {
                continue;
            }
            if let Some((a, b)) = group_after(&code, whole.end(), 0) {
                let name = code[a..b].trim().to_string();
                found.push((whole.start(), name, s.main_dir.clone()));
            }
        }
        for m in bare_input.captures_iter(&code) {
            found.push((
                m.get(0).expect("m").start(),
                m[1].to_string(),
                s.main_dir.clone(),
            ));
        }
        for m in import.captures_iter(&code) {
            let whole = m.get(0).expect("match");
            let sub = m[1].starts_with("sub");
            let Some((a, b)) = group_after(&code, whole.end(), 0) else {
                continue;
            };
            let Some((c, d)) = group_after(&code, b + 1, 0) else {
                continue;
            };
            let dir = code[a..b].trim().to_string();
            let base = if sub {
                import_dir.clone()
            } else {
                String::new()
            };
            let Some(folder) = join_rel(&base, &dir) else {
                continue;
            };
            found.push((whole.start(), code[c..d].trim().to_string(), folder));
        }
        found.sort_by_key(|f| std::cmp::Reverse(f.0));
        for (at, name, dir) in found {
            if name.is_empty() || name.contains('\\') || name.contains('#') {
                continue;
            }
            match resolve_tex(root, &dir, &name) {
                Some(r) => queue.push((r.clone(), parent_rel(&r))),
                None => s.missing_inputs.push((file.at(at), name)),
            }
        }
        s.tex.push(file);
    }
    // Keep the main document first, the rest in a stable order.
    if s.tex.len() > 1 {
        let rest = s.tex.split_off(1);
        let mut rest = rest;
        rest.sort_by(|a, b| a.rel.cmp(&b.rel));
        s.tex.extend(rest);
    }
    s.cloud_only.extend(cloud);
}

fn load_bibs(root: &Path, s: &mut Sources) {
    let bib_cmd = Regex::new(
        r"\\(bibliography|addbibresource|addglobalbib|addsectionbib|nobibliography)\b\s*",
    )
    .expect("regex");
    let mut named: Vec<String> = Vec::new();
    for f in &s.tex {
        for m in bib_cmd.captures_iter(&f.code) {
            let whole = m.get(0).expect("match");
            if let Some((a, b)) = group_after(&f.code, whole.end(), 1) {
                for name in f.code[a..b].split(',') {
                    let name = name.trim();
                    if name.is_empty() || name.contains('\\') {
                        continue;
                    }
                    let with_ext = |r: String| {
                        if r.to_lowercase().ends_with(".bib") {
                            r
                        } else {
                            format!("{r}.bib")
                        }
                    };
                    // BibTeX looks in the main document's folder; also try
                    // the project root (Texo adds it to BIBINPUTS).
                    let Some(rel) = join_rel(&s.main_dir, name).map(with_ext) else {
                        continue;
                    };
                    let rel = if is_file(root, &rel) {
                        rel
                    } else {
                        normalize_rel(name)
                            .map(with_ext)
                            .filter(|r| is_file(root, r))
                            .unwrap_or(rel)
                    };
                    if !named.contains(&rel) {
                        named.push(rel);
                    }
                }
            }
        }
    }
    let files = if named.is_empty() {
        walk_files(root, ".bib")
    } else {
        named
    };
    let mut cloud = Vec::new();
    for rel in files.into_iter().take(MAX_BIB_FILES) {
        if let Some(text) = read_text(root, &rel, &mut cloud) {
            s.bib.push(BibFile { rel, text });
        }
    }
    s.cloud_only.extend(cloud);
}
