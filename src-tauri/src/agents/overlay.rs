//! A run's copy-on-write view of the project.
//!
//! Reads fall through to the unsaved editor buffers the UI sent at start,
//! then to the files on disk. Writes and deletes stay in memory; at the end
//! they become the run's changeset. The project on disk is never written.
//!
//! Paths are checked with [`fsops::resolve`] (nothing outside the project,
//! nothing in `.texo/`), and binary files, images and files over 5 MiB are
//! refused with a plain message the model can act on. Writes, edits and
//! deletes are also limited to the files [`super::safety::may_change`]
//! allows (no `latexmkrc`, no scripts).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::fsops::{self, FileContent};
use crate::history::walk::{self, Excludes};

use super::types::{text_hash, ChangeEntry, FileState};

const BOM: char = '\u{feff}';

/// Most entries `list_files` returns.
pub const MAX_LIST: usize = 500;

/// The run's view of the project.
pub struct Overlay {
    root: PathBuf,
    buffers: HashMap<String, String>,
    /// Each touched file as the run first saw it (`None`: it didn't exist).
    base: BTreeMap<String, Option<String>>,
    /// `Some(text)`: written; `None`: deleted.
    writes: BTreeMap<String, Option<String>>,
    reasons: BTreeMap<String, String>,
    /// Touched files whose disk copy starts with a UTF-8 BOM. Reads strip
    /// it (the model never sees it); [`Overlay::changes`] puts it back on
    /// both sides, so the base matches the raw disk bytes the apply step
    /// compares against and the saved file keeps its BOM.
    bom: BTreeSet<String>,
}

/// What a successful `edit_file` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edited {
    /// 1-based line where the replaced text started.
    pub line: usize,
    pub removed_lines: usize,
    pub added_lines: usize,
}

/// `rel` as a clean `/`-separated project path, or an error for paths
/// outside the project or inside `.texo/`.
pub fn clean_path(root: &Path, rel: &str) -> AppResult<String> {
    let mut s = rel.trim().replace('\\', "/");
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    let s = s.trim_matches('/').to_string();
    fsops::resolve(root, &s)?;
    Ok(s)
}

fn not_text(rel: &str, what: &str) -> AppError {
    AppError::msg(format!("{rel} is {what}, so it can't be read or edited as text."))
}

impl Overlay {
    pub fn new(root: &Path, dirty: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut buffers = HashMap::new();
        for (file, text) in dirty {
            if let Ok(key) = clean_path(root, &file) {
                buffers.insert(key, text);
            }
        }
        Overlay {
            root: root.to_path_buf(),
            buffers,
            base: BTreeMap::new(),
            writes: BTreeMap::new(),
            reasons: BTreeMap::new(),
            bom: BTreeSet::new(),
        }
    }

    /// The text the run started from: the editor buffer, else the disk file.
    /// `Ok(None)`: no such file.
    fn original(&self, key: &str) -> AppResult<Option<String>> {
        if let Some(t) = self.buffers.get(key) {
            return Ok(Some(t.clone()));
        }
        let path = fsops::resolve(&self.root, key)?;
        if !path.exists() {
            return Ok(None);
        }
        if path.is_dir() {
            return Err(AppError::msg(format!("{key} is a folder, not a file.")));
        }
        match fsops::read(&self.root, key)? {
            FileContent::Text { content } => Ok(Some(content)),
            FileContent::Image { .. } => Err(not_text(key, "an image")),
            FileContent::Binary { .. } => Err(not_text(key, "a binary file")),
            FileContent::TooLarge { size } => {
                Err(AppError::msg(format!("{key} is too large to work with ({} MB; the limit is 5 MB).", size / 1_000_000)))
            }
        }
    }

    /// The file's current text in this run, without recording it as a base.
    pub fn peek(&self, rel: &str) -> AppResult<Option<String>> {
        let key = clean_path(&self.root, rel)?;
        match self.writes.get(&key) {
            Some(v) => Ok(v.clone()),
            None => self.original(&key),
        }
    }

    /// Reads a file (overlay, then buffer, then disk).
    pub fn read(&mut self, rel: &str) -> AppResult<String> {
        let key = clean_path(&self.root, rel)?;
        if let Some(v) = self.writes.get(&key) {
            return v.clone().ok_or_else(|| AppError::msg(format!("{key} was deleted earlier in this run.")));
        }
        let text = self.original(&key)?;
        if !self.base.contains_key(&key) {
            self.set_base(&key, text.clone());
        }
        text.ok_or_else(|| AppError::msg(format!("There is no file named {key}. Use list_files to see the project's files.")))
    }

    fn ensure_base(&mut self, key: &str) -> AppResult<()> {
        if !self.base.contains_key(key) {
            let text = self.original(key)?;
            self.set_base(key, text);
        }
        Ok(())
    }

    /// Records the text the run first saw (and whether the disk file has a BOM).
    fn set_base(&mut self, key: &str, text: Option<String>) {
        if text.is_some() && !self.buffers.contains_key(key) && self.disk_has_bom(key) {
            self.bom.insert(key.to_string());
        }
        self.base.insert(key.to_string(), text);
    }

    fn disk_has_bom(&self, key: &str) -> bool {
        use std::io::Read;
        let Ok(path) = fsops::resolve(&self.root, key) else { return false };
        let mut head = [0u8; 3];
        std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head == [0xEF, 0xBB, 0xBF]
    }

    /// Writes (creates or replaces) a file in the overlay.
    pub fn write(&mut self, rel: &str, text: &str, reason: &str) -> AppResult<String> {
        let key = clean_path(&self.root, rel)?;
        super::safety::may_change(&key).map_err(AppError::msg)?;
        if text.len() as u64 > fsops::MAX_TEXT_BYTES {
            return Err(AppError::msg("That text is larger than 5 MB, which is too large for a project file."));
        }
        if !self.writes.contains_key(&key) {
            // Refuses binary files and folders.
            self.ensure_base(&key)?;
        }
        self.writes.insert(key.clone(), Some(text.to_string()));
        self.reasons.insert(key.clone(), reason.to_string());
        Ok(key)
    }

    /// Deletes a file in the overlay (shown in review; nothing on disk changes).
    pub fn delete(&mut self, rel: &str, reason: &str) -> AppResult<String> {
        let key = clean_path(&self.root, rel)?;
        super::safety::may_change(&key).map_err(AppError::msg)?;
        match self.writes.get(&key) {
            Some(None) => return Err(AppError::msg(format!("{key} was already deleted in this run."))),
            Some(Some(_)) => {}
            None => {
                self.ensure_base(&key)?;
                if self.base.get(&key).is_some_and(Option::is_none) {
                    return Err(AppError::msg(format!("There is no file named {key}.")));
                }
            }
        }
        self.writes.insert(key.clone(), None);
        self.reasons.insert(key.clone(), reason.to_string());
        Ok(key)
    }

    /// Replaces `old` with `new` in a file; `old` must occur exactly once.
    pub fn edit(&mut self, rel: &str, old: &str, new: &str, reason: &str) -> AppResult<Edited> {
        if old.is_empty() {
            return Err(AppError::msg(
                "`old` is empty. Put the exact text to replace in `old` (or use write_file for a new file).",
            ));
        }
        super::safety::may_change(&clean_path(&self.root, rel)?).map_err(AppError::msg)?;
        let text = self.read(rel)?;
        let (old, new) = match_line_endings(&text, old, new);
        let count = text.matches(old.as_str()).count();
        if count == 0 {
            let hint = if loose_count(&text, &old) > 0 {
                " The text is there, but spaces or line breaks differ. Read the file again and copy the lines exactly."
            } else {
                " Read the file again and copy the text exactly as it is now."
            };
            return Err(AppError::msg(format!("`old` was not found in {}.{hint}", rel.trim())));
        }
        if count > 1 {
            return Err(AppError::msg(format!(
                "`old` matches {count} places in {}. Include more of the surrounding lines so it matches exactly once.",
                rel.trim()
            )));
        }
        let at = text.find(old.as_str()).unwrap_or(0);
        let line = text[..at].matches('\n').count() + 1;
        let updated = format!("{}{}{}", &text[..at], new, &text[at + old.len()..]);
        self.write(rel, &updated, reason)?;
        Ok(Edited { line, removed_lines: old.lines().count().max(1), added_lines: new.lines().count() })
    }

    /// Project files in this run's view (`/`-separated, sorted), with
    /// sizes, filtered by `glob` (`*`, `**`, `?`; a pattern without `/`
    /// also matches file names in any folder). At most [`MAX_LIST`].
    pub fn list(&self, glob: Option<&str>) -> AppResult<(Vec<(String, u64)>, bool)> {
        let matcher = glob.map(str::trim).filter(|g| !g.is_empty()).map(Glob::new).transpose()?;
        let scan = walk::scan(&self.root, &Excludes::for_project(&self.root))?;
        let mut files: BTreeMap<String, u64> = scan.files.into_iter().map(|f| (f.rel, f.size)).collect();
        for big in scan.too_large {
            files.insert(big, walk::MAX_FILE_BYTES);
        }
        for (k, v) in &self.writes {
            match v {
                Some(t) => {
                    files.insert(k.clone(), t.len() as u64);
                }
                None => {
                    files.remove(k);
                }
            }
        }
        let mut out: Vec<(String, u64)> =
            files.into_iter().filter(|(p, _)| matcher.as_ref().is_none_or(|m| m.matches(p))).collect();
        let more = out.len() > MAX_LIST;
        out.truncate(MAX_LIST);
        Ok((out, more))
    }

    /// The files the run changed (a write back to the original text is no
    /// change), sorted by path.
    pub fn changes(&self) -> Vec<ChangeEntry> {
        self.writes
            .iter()
            .filter_map(|(file, new)| {
                let base = self.base.get(file).cloned().flatten();
                if &base == new {
                    return None;
                }
                let (base, new) = if self.bom.contains(file) {
                    let with = |t: &String| if t.starts_with(BOM) { t.clone() } else { format!("{BOM}{t}") };
                    (base.as_ref().map(with), new.as_ref().map(with))
                } else {
                    (base, new.clone())
                };
                Some(ChangeEntry {
                    file: file.clone(),
                    base_hash: text_hash(base.as_deref()),
                    base_text: base,
                    new_text: new,
                    reason: self.reasons.get(file).cloned().unwrap_or_default(),
                    state: FileState::Pending,
                    merged_text: None,
                    attention: Vec::new(),
                })
            })
            .collect()
    }

    /// Files that differ from the disk in this run's view: editor buffers
    /// and overlay writes (`Some`), deletes (`None`). For the shadow compile.
    pub fn shadow_files(&self) -> Vec<(String, Option<String>)> {
        let mut m: BTreeMap<String, Option<String>> =
            self.buffers.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect();
        for (k, v) in &self.writes {
            m.insert(k.clone(), v.clone());
        }
        m.into_iter().collect()
    }
}

/// When the file uses CRLF and the model sent LF (or the other way round),
/// convert `old`/`new` to the file's line endings.
fn match_line_endings(text: &str, old: &str, new: &str) -> (String, String) {
    let crlf = text.contains("\r\n");
    if crlf && !old.contains("\r\n") && old.contains('\n') && !text.contains(old) {
        return (old.replace('\n', "\r\n"), new.replace("\r\n", "\n").replace('\n', "\r\n"));
    }
    if crlf && !new.contains("\r\n") && new.contains('\n') && old.contains("\r\n") {
        return (old.to_string(), new.replace('\n', "\r\n"));
    }
    (old.to_string(), new.to_string())
}

/// Matches ignoring runs of whitespace (only to give a better hint).
fn loose_count(text: &str, old: &str) -> usize {
    let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let (t, o) = (squash(text), squash(old));
    if o.is_empty() {
        0
    } else {
        t.matches(o.as_str()).count()
    }
}

/// A small glob matcher (case-insensitive): `**` any folders, `*` any
/// characters but `/`, `?` one character.
pub struct Glob {
    re: regex::Regex,
    name_only: bool,
}

impl Glob {
    pub fn new(pattern: &str) -> AppResult<Glob> {
        let p = pattern.trim().replace('\\', "/");
        let p = p.trim_start_matches("./");
        let name_only = !p.contains('/');
        let mut re = String::from("(?i)^");
        let chars: Vec<char> = p.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '*' if chars.get(i + 1) == Some(&'*') => {
                    i += 1;
                    if chars.get(i + 1) == Some(&'/') {
                        i += 1;
                        re.push_str("(?:.*/)?");
                    } else {
                        re.push_str(".*");
                    }
                }
                '*' => re.push_str("[^/]*"),
                '?' => re.push_str("[^/]"),
                c => re.push_str(&regex::escape(&c.to_string())),
            }
            i += 1;
        }
        re.push('$');
        let re = regex::Regex::new(&re).map_err(|_| AppError::msg("That file pattern isn't valid."))?;
        Ok(Glob { re, name_only })
    }

    pub fn matches(&self, path: &str) -> bool {
        if self.re.is_match(path) {
            return true;
        }
        self.name_only && self.re.is_match(path.rsplit('/').next().unwrap_or(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n").unwrap();
        fs::create_dir_all(d.path().join("sections")).unwrap();
        fs::write(d.path().join("sections/intro.tex"), "Intro text.\nIntro text.\n").unwrap();
        fs::write(d.path().join("fig.png"), [0x89u8, b'P', b'N', b'G', 0, 0, 1, 2]).unwrap();
        fs::write(d.path().join("data.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
        fs::create_dir_all(d.path().join(".texo")).unwrap();
        fs::write(d.path().join(".texo/secret.json"), "{}").unwrap();
        d
    }

    #[test]
    fn reads_fall_through_and_writes_stay_in_memory() {
        let d = project();
        let mut o = Overlay::new(d.path(), vec![("sections\\intro.tex".to_string(), "Unsaved intro.\n".to_string())]);
        assert!(o.read("main.tex").unwrap().contains("Hello"));
        // The dirty buffer wins over the disk file.
        assert_eq!(o.read("./sections/intro.tex").unwrap(), "Unsaved intro.\n");
        o.write("main.tex", "changed\n", "test").unwrap();
        assert_eq!(o.read("main.tex").unwrap(), "changed\n");
        // Disk is untouched.
        assert!(fs::read_to_string(d.path().join("main.tex")).unwrap().contains("Hello"));
        o.write("new/notes.md", "# Notes\n", "new file").unwrap();
        assert!(!d.path().join("new/notes.md").exists());
        o.delete("sections/intro.tex", "gone").unwrap();
        assert!(o.read("sections/intro.tex").unwrap_err().to_string().contains("deleted"));

        let changes = o.changes();
        let files: Vec<&str> = changes.iter().map(|c| c.file.as_str()).collect();
        assert_eq!(files, ["main.tex", "new/notes.md", "sections/intro.tex"]);
        assert!(changes[0].base_text.as_deref().unwrap().contains("Hello"));
        assert_eq!(changes[1].base_text, None);
        assert_eq!(changes[1].base_hash, "");
        // The base of a buffered file is the buffer text the run saw.
        assert_eq!(changes[2].base_text.as_deref(), Some("Unsaved intro.\n"));
        assert_eq!(changes[2].new_text, None);
        assert_eq!(changes[0].base_hash, text_hash(changes[0].base_text.as_deref()));

        let (list, more) = o.list(None).unwrap();
        let names: Vec<&str> = list.iter().map(|(p, _)| p.as_str()).collect();
        assert!(!more);
        assert!(names.contains(&"new/notes.md"));
        assert!(!names.contains(&"sections/intro.tex"));
        assert!(!names.iter().any(|n| n.starts_with(".texo")));
        let (tex, _) = o.list(Some("*.tex")).unwrap();
        assert_eq!(tex.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["main.tex"]);
        let (md, _) = o.list(Some("new/**")).unwrap();
        assert_eq!(md.len(), 1);
    }

    #[test]
    fn writing_back_the_original_is_no_change() {
        let d = project();
        let mut o = Overlay::new(d.path(), Vec::new());
        let orig = o.read("main.tex").unwrap();
        o.write("main.tex", "x", "a").unwrap();
        o.write("main.tex", &orig, "b").unwrap();
        assert!(o.changes().is_empty());
    }

    #[test]
    fn path_safety_and_binary_refusal() {
        let d = project();
        let mut o = Overlay::new(d.path(), Vec::new());
        for bad in ["../outside.tex", ".texo/secret.json", ".TEXO/ai/memory.md", "a/../../b", "sections/../main.tex"] {
            assert!(o.read(bad).is_err(), "{bad}");
            assert!(o.write(bad, "x", "r").is_err(), "{bad}");
        }
        assert!(o.read("fig.png").unwrap_err().to_string().contains("image"));
        assert!(o.read("data.bin").unwrap_err().to_string().contains("binary"));
        assert!(o.write("data.bin", "text", "r").is_err());
        assert!(o.edit("data.bin", "a", "b", "r").is_err());
        assert!(o.read("sections").unwrap_err().to_string().contains("folder"));
        assert!(o.read("missing.tex").unwrap_err().to_string().contains("list_files"));
        assert!(o.delete("missing.tex", "r").is_err());
        assert!(o.changes().is_empty());
    }

    #[test]
    fn build_config_and_scripts_cannot_be_changed() {
        let d = project();
        fs::write(d.path().join("latexmkrc"), "$pdf_mode = 1;
").unwrap();
        let mut o = Overlay::new(d.path(), Vec::new());
        for bad in ["latexmkrc", ".latexmkrc", "sub/.latexmkrc", "Tectonic.toml", "run.bat", "x.ps1", "x.pl", "tool.exe", "x.cmd"] {
            let e = o.write(bad, "system('calc');", "r").unwrap_err().to_string();
            assert!(e.contains("may not change") || e.contains("may only change"), "{bad}: {e}");
        }
        assert!(o.edit("latexmkrc", "$pdf_mode = 1;", "system('x');", "r").is_err());
        assert!(o.delete("latexmkrc", "r").is_err());
        // Reading it is fine (the model may need to know the settings).
        assert!(o.read("latexmkrc").unwrap().contains("pdf_mode"));
        assert!(o.changes().is_empty() && o.shadow_files().is_empty());
    }

    #[test]
    fn edit_file_needs_exactly_one_match() {
        let d = project();
        let mut o = Overlay::new(d.path(), Vec::new());
        let twice = o.edit("sections/intro.tex", "Intro text.", "X", "r").unwrap_err().to_string();
        assert!(twice.contains("matches 2 places"), "{twice}");
        let none = o.edit("main.tex", "Goodbye", "X", "r").unwrap_err().to_string();
        assert!(none.contains("not found"), "{none}");
        let spaced = o.edit("main.tex", "\\begin{document}   Hello", "X", "r").unwrap_err().to_string();
        assert!(spaced.contains("spaces or line breaks"), "{spaced}");
        assert!(o.edit("main.tex", "", "X", "r").is_err());
        assert!(o.changes().is_empty());

        let e = o.edit("main.tex", "Hello", "Hello, world", "greeting").unwrap();
        assert_eq!(e.line, 3);
        assert!(o.read("main.tex").unwrap().contains("Hello, world\n"));
        // Unique once more context is given.
        o.edit("sections/intro.tex", "Intro text.\nIntro text.\n", "Intro text.\n", "dedupe").unwrap();
        assert_eq!(o.read("sections/intro.tex").unwrap(), "Intro text.\n");
        let c = o.changes();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].reason, "greeting");
    }

    #[test]
    fn edit_keeps_crlf_line_endings() {
        let d = project();
        fs::write(d.path().join("w.tex"), "a\r\nb\r\nc\r\n").unwrap();
        let mut o = Overlay::new(d.path(), Vec::new());
        o.edit("w.tex", "a\nb\n", "a\nB\n", "r").unwrap();
        assert_eq!(o.read("w.tex").unwrap(), "a\r\nB\r\nc\r\n");
    }

    /// DS-6: a file saved with a BOM by another editor isn't "changed on
    /// disk": the changeset's base matches the raw bytes, and the BOM stays.
    #[test]
    fn bom_files_keep_their_bom_and_match_the_disk() {
        let d = project();
        let raw = "\u{feff}\\section{Intro}\nText.\n";
        fs::write(d.path().join("bom.tex"), raw).unwrap();
        fs::write(d.path().join("gone.tex"), "\u{feff}old\n").unwrap();
        let mut o = Overlay::new(d.path(), Vec::new());
        assert_eq!(o.read("bom.tex").unwrap(), "\\section{Intro}\nText.\n", "the model never sees the BOM");
        o.edit("bom.tex", "\\section{Intro}", "\\section{Introduction}", "r").unwrap();
        o.delete("gone.tex", "r").unwrap();
        o.write("new.tex", "x\n", "r").unwrap();
        let c = o.changes();
        assert_eq!(c[0].file, "bom.tex");
        assert_eq!(c[0].base_text.as_deref(), Some(raw));
        assert_eq!(c[0].base_hash, text_hash(Some(raw)));
        assert_eq!(c[0].new_text.as_deref(), Some("\u{feff}\\section{Introduction}\nText.\n"));
        assert_eq!(c[1].base_text.as_deref(), Some("\u{feff}old\n"));
        assert_eq!(c[1].new_text, None);
        assert_eq!(c[2].new_text.as_deref(), Some("x\n"), "no BOM on new files");
        // Applying: the disk still equals the base, so no conflict.
        let req = crate::history::ApplyRequest {
            run_id: "20250101-000000-bomtest1".into(),
            files: c
                .iter()
                .map(|e| crate::history::ChangeFile {
                    file: e.file.clone(),
                    base_text: e.base_text.clone(),
                    new_text: e.new_text.clone(),
                })
                .collect(),
            ..Default::default()
        };
        let out = crate::history::apply_changeset(d.path(), &req).unwrap();
        assert!(out.conflicts.is_empty(), "{:?}", out.conflicts.iter().map(|c| &c.reason).collect::<Vec<_>>());
        assert_eq!(fs::read_to_string(d.path().join("bom.tex")).unwrap(), "\u{feff}\\section{Introduction}\nText.\n");
        assert!(!d.path().join("gone.tex").exists());
    }

    #[test]
    fn glob_patterns() {
        let g = Glob::new("*.tex").unwrap();
        assert!(g.matches("main.tex") && g.matches("a/b/c.TEX") && !g.matches("main.bib"));
        let g = Glob::new("sections/*.tex").unwrap();
        assert!(g.matches("sections/a.tex") && !g.matches("sections/x/a.tex") && !g.matches("a.tex"));
        let g = Glob::new("**/*.bib").unwrap();
        assert!(g.matches("refs.bib") && g.matches("x/y/refs.bib"));
        let g = Glob::new("ch?.tex").unwrap();
        assert!(g.matches("ch1.tex") && !g.matches("ch10.tex"));
    }
}
