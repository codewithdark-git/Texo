//! Gathers what the model gets to see: the compile errors, a log excerpt and
//! small excerpts of the project's own files. Everything is capped; files
//! outside the project and binary files are never read, and the whole project
//! is never sent.

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::validate::{normalize_rel, read_project_text};
use crate::project::{self, META_DIR};

/// Lines shown before and after an error line.
pub const LINES_AROUND: usize = 40;
const MAX_LOCATIONS: usize = 4;
const MAX_ISSUES: usize = 15;
const MAX_MESSAGE: usize = 600;
const MAX_EXCERPT: usize = 9_000;
const MAX_FILES_TOTAL: usize = 40_000;
const PREAMBLE_LINES: usize = 150;
const NAMED_FILE_LINES: usize = 60;
const MAX_NAMED_FILES: usize = 3;
const MAX_BIB_KEYS: usize = 8;
const MAX_BIB_ENTRY: usize = 1_500;
const MAX_BIB_FILE_BYTES: u64 = 3 * 1024 * 1024;
const MAX_LOG: usize = 10_000;
const MAX_PREVIOUS: usize = 6_000;
/// Hard cap on everything sent, whatever the parts add up to.
pub const MAX_TOTAL: usize = 80_000;

/// The compile result as the UI has it (`CompileResult` in api.ts). Every
/// field is optional so a partial result still works.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompileInput {
    pub status: String,
    pub engine: Option<String>,
    pub issues: Vec<IssueInput>,
    pub hints: Vec<String>,
    pub log: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IssueInput {
    pub severity: String,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub context: Option<String>,
    pub citation: Option<String>,
}

/// An earlier round of the fix loop, so the model doesn't repeat itself.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PreviousAttempt {
    pub summary: String,
    pub edits: Vec<super::validate::EditInput>,
    /// Whether the user applied the edits.
    pub applied: bool,
    /// The first errors of the compile that followed.
    pub remaining_errors: Vec<String>,
}

/// One excerpt that will be sent, for the privacy notice and the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SentExcerpt {
    pub file: String,
    pub from_line: usize,
    pub to_line: usize,
    /// "error", "preamble", "named", or "bibliography".
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummary {
    pub excerpts: Vec<SentExcerpt>,
    pub issue_count: usize,
    pub log_lines: usize,
    /// Characters of project text, log and messages in the request.
    pub chars: usize,
    /// Something was shortened to fit the limits.
    pub truncated: bool,
}

pub struct Gathered {
    /// The user message body (without the instructions).
    pub text: String,
    pub summary: ContextSummary,
}

/// What Texo knows about the machine, to tailor install advice.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    pub distribution: Option<String>,
    pub os: &'static str,
}

/// Cuts `text` to at most `max` bytes on a character boundary, with a marker.
pub fn cap(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}\n[... {} more characters cut ...]", &text[..end], text.len() - end), true)
}

fn strip_fix_marker(hint: &str) -> &str {
    if hint.starts_with("[fix:") {
        if let Some(end) = hint.find(']') {
            return hint[end + 1..].trim_start();
        }
    }
    hint
}

fn is_error(i: &IssueInput) -> bool {
    i.severity == "error"
}

/// The issues in the order they are sent: the chosen one, then errors, then
/// the rest.
fn ordered_issues(input: &CompileInput, focus: Option<usize>) -> Vec<&IssueInput> {
    let mut out: Vec<&IssueInput> = Vec::new();
    if let Some(i) = focus.and_then(|f| input.issues.get(f)) {
        out.push(i);
    }
    let rest = input.issues.iter().enumerate().filter(|(i, _)| Some(*i) != focus);
    let (errors, others): (Vec<_>, Vec<_>) = rest.partition(|(_, i)| is_error(i));
    out.extend(errors.into_iter().map(|(_, i)| i));
    out.extend(others.into_iter().map(|(_, i)| i));
    out
}

/// Numbered lines `from..=to` (1-based) of `content`.
fn numbered(content: &str, from: usize, to: usize) -> String {
    content
        .lines()
        .enumerate()
        .skip(from.saturating_sub(1))
        .take(to + 1 - from)
        .map(|(i, l)| format!("{:>5}| {}\n", i + 1, l))
        .collect()
}

/// Citation keys an issue is about.
fn citation_keys(issue: &IssueInput) -> Vec<String> {
    if let Some(k) = &issue.citation {
        return vec![k.clone()];
    }
    // "Citation `key' on page 1 undefined" / "I didn't find a database entry for "key"".
    let m = &issue.message;
    for (open, close) in [("Citation `", '\''), ("database entry for \"", '"'), ("Citation '", '\'')] {
        if let Some(start) = m.find(open) {
            let rest = &m[start + open.len()..];
            if let Some(end) = rest.find(close) {
                return vec![rest[..end].to_string()];
            }
        }
    }
    Vec::new()
}

/// Project file names mentioned in a message, like `refs.bib` or `intro.tex`.
fn named_files(text: &str) -> Vec<String> {
    const EXTS: &[&str] = &[".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx"];
    text.split(|c: char| c.is_whitespace() || "`'\"(){}<>,;:".contains(c))
        .map(|w| w.trim_end_matches('.'))
        .filter(|w| EXTS.iter().any(|e| w.to_ascii_lowercase().ends_with(e)) && w.len() < 200)
        .map(normalize_rel)
        .collect()
}

/// The `@type{key, ...}` entry for `key`, if it is in `bib`.
fn bib_entry(bib: &str, key: &str) -> Option<String> {
    let mut search = 0;
    while let Some(at) = bib[search..].find('@') {
        let start = search + at;
        search = start + 1;
        let rest = &bib[start..];
        let Some(open) = rest.find(['{', '(']) else { break };
        let after = &rest[open + 1..];
        let entry_key = after.split(',').next().unwrap_or("").trim();
        if entry_key != key {
            continue;
        }
        // Read to the matching close brace.
        let mut depth = 0i32;
        for (i, c) in rest.char_indices() {
            match c {
                '{' | '(' => depth += 1,
                '}' | ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(rest[..=i].to_string());
                    }
                }
                _ => {}
            }
        }
        return Some(rest.to_string());
    }
    None
}

/// `.bib` files in the project (not in `.texo/`), small enough to scan.
fn bib_files(root: &Path) -> Vec<String> {
    WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || e.file_name() != META_DIR)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("bib")))
        .filter(|e| e.metadata().is_ok_and(|m| m.len() <= MAX_BIB_FILE_BYTES))
        .filter_map(|e| e.path().strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/")))
        .take(20)
        .collect()
}

/// The useful part of a TeX log: around the first errors (`! ...`), plus the
/// end of the log.
fn log_excerpt(log: &str) -> (String, usize) {
    let lines: Vec<&str> = log.lines().collect();
    if lines.is_empty() {
        return (String::new(), 0);
    }
    let mut keep = BTreeSet::new();
    for (i, _) in lines.iter().enumerate().filter(|(_, l)| l.starts_with('!')).take(3) {
        keep.extend(i.saturating_sub(5)..(i + 15).min(lines.len()));
    }
    keep.extend(lines.len().saturating_sub(40)..lines.len());
    let mut out = String::new();
    if keep.first().is_some_and(|f| *f > 0) {
        out.push_str("[...]\n");
    }
    let mut last = None;
    for i in &keep {
        if last.is_some_and(|l: usize| *i > l + 1) {
            out.push_str("[...]\n");
        }
        out.push_str(lines[*i]);
        out.push('\n');
        last = Some(*i);
    }
    (out, keep.len())
}

struct Builder {
    text: String,
    summary: ContextSummary,
    file_chars: usize,
    seen: HashSet<(String, usize)>,
}

impl Builder {
    fn push_capped(&mut self, section: &str, max: usize) {
        let (s, cut) = cap(section, max);
        self.summary.truncated |= cut;
        self.text.push_str(&s);
    }

    fn excerpt(&mut self, file: &str, content: &str, from: usize, to: usize, reason: &'static str) {
        let total = content.lines().count();
        if total == 0 || from > total || self.file_chars >= MAX_FILES_TOTAL {
            self.summary.truncated |= self.file_chars >= MAX_FILES_TOTAL;
            return;
        }
        let to = to.min(total);
        if !self.seen.insert((file.to_string(), from)) {
            return;
        }
        let body = numbered(content, from, to);
        let room = MAX_EXCERPT.min(MAX_FILES_TOTAL - self.file_chars);
        let (body, cut) = cap(&body, room);
        self.summary.truncated |= cut;
        self.file_chars += body.len();
        self.text.push_str(&format!(
            "=== FILE {file} (lines {from}-{to} of {total}; {reason}) ===\n{body}=== END FILE {file} ===\n\n"
        ));
        self.summary.excerpts.push(SentExcerpt { file: file.to_string(), from_line: from, to_line: to, reason });
    }
}

pub fn gather(
    root: &Path,
    input: &CompileInput,
    focus: Option<usize>,
    previous: &[PreviousAttempt],
    env: &Environment,
) -> Gathered {
    let mut b = Builder { text: String::new(), summary: ContextSummary::default(), file_chars: 0, seen: HashSet::new() };
    let issues = ordered_issues(input, focus);

    // 1. What happened.
    b.text.push_str(&format!("COMPILE STATUS: {}\n", if input.status.is_empty() { "unknown" } else { &input.status }));
    if let Some(engine) = &input.engine {
        b.text.push_str(&format!("ENGINE: {engine}\n"));
    }
    b.text.push_str(&format!(
        "COMPUTER: {} with {}\n",
        env.os,
        env.distribution.as_deref().unwrap_or("no TeX distribution found (or Tectonic)")
    ));
    if focus.is_some_and(|f| f < input.issues.len()) {
        b.text.push_str("The user asked about issue 1 below.\n");
    }
    b.text.push_str(&format!("\nISSUES ({} of {}):\n", issues.len().min(MAX_ISSUES), input.issues.len()));
    for (n, i) in issues.iter().take(MAX_ISSUES).enumerate() {
        let place = match (&i.file, i.line) {
            (Some(f), Some(l)) => format!(" at {}:{l}", normalize_rel(f)),
            (Some(f), None) => format!(" in {}", normalize_rel(f)),
            _ => String::new(),
        };
        let (msg, cut) = cap(i.message.trim(), MAX_MESSAGE);
        b.summary.truncated |= cut;
        b.text.push_str(&format!("{}. [{}]{place}: {msg}\n", n + 1, i.severity));
        if let Some(ctx) = i.context.as_deref().filter(|c| !c.trim().is_empty()) {
            let (ctx, cut) = cap(ctx.trim(), MAX_MESSAGE);
            b.summary.truncated |= cut;
            b.text.push_str(&format!("   log context: {}\n", ctx.replace('\n', "\n   ")));
        }
    }
    b.summary.issue_count = issues.len().min(MAX_ISSUES);
    b.summary.truncated |= issues.len() > MAX_ISSUES;
    let hints: Vec<&str> = input.hints.iter().map(|h| strip_fix_marker(h)).filter(|h| !h.is_empty()).take(8).collect();
    if !hints.is_empty() {
        b.text.push_str("\nTEXO'S OWN HINTS:\n");
        for h in hints {
            let (h, _) = cap(h, MAX_MESSAGE);
            b.text.push_str(&format!("- {h}\n"));
        }
    }

    // 2. The log.
    let (log, lines) = log_excerpt(&input.log);
    if !log.is_empty() {
        b.summary.log_lines = lines;
        b.text.push_str("\n=== LOG EXCERPT ===\n");
        b.push_capped(&log, MAX_LOG);
        b.text.push_str("=== END LOG EXCERPT ===\n");
    }

    // 3. Project files.
    b.text.push_str("\nPROJECT FILES (excerpts; the number before \"| \" is the line number, not part of the file):\n\n");
    let mut locations = 0;
    let mut included: HashSet<String> = HashSet::new();
    for i in issues.iter().filter(|i| i.file.is_some() && i.line.is_some()) {
        if locations >= MAX_LOCATIONS {
            break;
        }
        let file = normalize_rel(i.file.as_deref().unwrap_or_default());
        let Some(content) = read_project_text(root, &file) else { continue };
        let line = i.line.unwrap_or(1).max(1) as usize;
        let from = line.saturating_sub(LINES_AROUND).max(1);
        b.excerpt(&file, &content, from, line + LINES_AROUND, "around an error");
        included.insert(file);
        locations += 1;
    }
    // The main document's preamble: packages and settings explain most errors.
    let main = project::read_meta(root)
        .and_then(|m| m.main_document)
        .or_else(|| project::detect_main_document(root));
    if let Some(main) = main {
        if let Some(content) = read_project_text(root, &main) {
            let end = content
                .lines()
                .position(|l| l.trim_start().starts_with("\\begin{document}"))
                .map(|i| i + 1)
                .unwrap_or(PREAMBLE_LINES)
                .min(PREAMBLE_LINES);
            b.excerpt(&main, &content, 1, end, "preamble of the main document");
            included.insert(main);
        }
    }
    // Files named in the messages (an `\input` file, the .bib file...).
    let mentioned: Vec<String> = issues
        .iter()
        .take(MAX_ISSUES)
        .flat_map(|i| named_files(&i.message))
        .filter(|f| !included.contains(f))
        .collect::<Vec<_>>();
    let mut named = 0;
    for f in mentioned {
        if named >= MAX_NAMED_FILES || included.contains(&f) || f.to_ascii_lowercase().ends_with(".bib") {
            continue;
        }
        if let Some(content) = read_project_text(root, &f) {
            b.excerpt(&f, &content, 1, NAMED_FILE_LINES, "named in an error");
            included.insert(f);
            named += 1;
        }
    }

    // 4. Bibliography entries for undefined citations.
    let mut keys: Vec<String> = Vec::new();
    for i in issues.iter() {
        for k in citation_keys(i) {
            if !keys.contains(&k) && keys.len() < MAX_BIB_KEYS {
                keys.push(k);
            }
        }
    }
    if !keys.is_empty() {
        let bibs = bib_files(root);
        b.text.push_str(&format!(
            "BIBLIOGRAPHY: .bib files in the project: {}\n",
            if bibs.is_empty() { "none".to_string() } else { bibs.join(", ") }
        ));
        let contents: Vec<(String, String)> = bibs
            .iter()
            .filter_map(|f| read_project_text(root, f).map(|c| (f.clone(), c)))
            .collect();
        for key in &keys {
            let found = contents.iter().find_map(|(f, c)| bib_entry(c, key).map(|e| (f, c, e)));
            match found {
                Some((f, c, entry)) => {
                    let start = c.find(&entry).unwrap_or(0);
                    let from = c[..start].matches('\n').count() + 1;
                    let to = from + entry.matches('\n').count();
                    let (entry, cut) = cap(&entry, MAX_BIB_ENTRY);
                    b.summary.truncated |= cut;
                    b.text.push_str(&format!("Entry for \"{key}\" in {f} (line {from}):\n{entry}\n"));
                    b.summary.excerpts.push(SentExcerpt { file: f.clone(), from_line: from, to_line: to, reason: "bibliography" });
                }
                None => b.text.push_str(&format!("Key \"{key}\": not found in any .bib file of the project.\n")),
            }
        }
        b.text.push('\n');
    }

    // 5. Earlier rounds.
    if !previous.is_empty() {
        let mut prev = String::from("PREVIOUS ATTEMPTS (these did not fix everything; do not repeat them):\n");
        for (n, p) in previous.iter().rev().take(3).rev().enumerate() {
            prev.push_str(&format!("Attempt {}: {}\n", n + 1, p.summary.trim()));
            for e in p.edits.iter().take(6) {
                prev.push_str(&format!(
                    "  - {} edit in {}: replace {:?} with {:?}\n",
                    if p.applied { "applied" } else { "not applied" },
                    normalize_rel(&e.file),
                    cap(&e.find, 300).0,
                    cap(&e.replace, 300).0
                ));
            }
            if !p.remaining_errors.is_empty() {
                prev.push_str("  Errors after it:\n");
                for r in p.remaining_errors.iter().take(5) {
                    prev.push_str(&format!("  * {}\n", cap(r, 300).0));
                }
            }
        }
        b.push_capped(&prev, MAX_PREVIOUS);
    }

    let (text, cut) = cap(&b.text, MAX_TOTAL);
    b.summary.truncated |= cut;
    b.summary.chars = text.chars().count();
    Gathered { text, summary: b.summary }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn paper() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut main = String::from("\\documentclass[a4paper]{cas-dc}\n\\usepackage[T1]{fontenc}\n\\usepackage{microtype}\n\\usepackage{natbib}\n\\begin{document}\n");
        for i in 6..=900 {
            main.push_str(&format!("Body line {i} with text.\n"));
        }
        main.push_str("\\bibliography{AHR}\n\\end{document}\n");
        fs::write(dir.path().join("L2R.tex"), main).unwrap();
        fs::write(
            dir.path().join("AHR.bib"),
            "@article{smith2020,\n  title={A {Nested} Title},\n  year={2020}\n}\n\n@book{doe2019, title={B}}\n",
        )
        .unwrap();
        fs::write(dir.path().join("figure.png"), b"\x89PNG\r\n\x1a\n\0\0\0binary").unwrap();
        dir
    }

    fn font_error() -> CompileInput {
        CompileInput {
            status: "failed".into(),
            engine: Some("pdflatex".into()),
            issues: vec![
                IssueInput {
                    severity: "warning".into(),
                    message: "Citation `smith2020' on page 1 undefined".into(),
                    file: Some("L2R.tex".into()),
                    line: Some(120),
                    citation: Some("smith2020".into()),
                    ..Default::default()
                },
                IssueInput {
                    severity: "error".into(),
                    message: "pdfTeX error (font expansion): auto expansion is only possible with scalable fonts.".into(),
                    file: Some("./L2R.tex".into()),
                    line: Some(406),
                    ..Default::default()
                },
                IssueInput {
                    severity: "warning".into(),
                    message: "Citation `ghost' on page 2 undefined".into(),
                    ..Default::default()
                },
            ],
            hints: vec!["[fix:biblatex-bibtex] Switch the backend.".into()],
            log: "This is pdfTeX\n".to_string() + &"filler\n".repeat(500) + "! pdfTeX error (font expansion): auto expansion is only possible with scalable fonts.\n\\AtBegShi@Output ...\nl.406 \\end{figure}\n",
        }
    }

    fn env() -> Environment {
        Environment { distribution: Some("MiKTeX".into()), os: "Windows" }
    }

    #[test]
    fn errors_come_first_with_lines_around_them() {
        let dir = paper();
        let g = gather(dir.path(), &font_error(), None, &[], &env());
        let first_issue = g.text.find("1. [error] at L2R.tex:406").expect(&g.text);
        assert!(first_issue < g.text.find("[warning]").unwrap());
        assert!(g.text.contains("COMPUTER: Windows with MiKTeX"));
        // ±40 lines around 406.
        assert!(g.text.contains("  366| Body line 366"));
        assert!(g.text.contains("  446| Body line 446"));
        assert!(!g.text.contains("  365| "));
        assert!(!g.text.contains("  447| "));
        let ex = &g.summary.excerpts[0];
        assert_eq!((ex.file.as_str(), ex.from_line, ex.to_line), ("L2R.tex", 366, 446));
        // The fix marker is not sent.
        assert!(g.text.contains("- Switch the backend."));
        assert!(!g.text.contains("[fix:"));
    }

    #[test]
    fn preamble_log_and_bib_entries_are_included() {
        let dir = paper();
        let g = gather(dir.path(), &font_error(), None, &[], &env());
        assert!(g.text.contains("preamble of the main document"));
        assert!(g.text.contains("    3| \\usepackage{microtype}"));
        assert!(g.text.contains("! pdfTeX error (font expansion)"));
        assert!(g.text.contains("[...]"));
        assert!(!g.text.contains(&"filler\n".repeat(100)));
        assert!(g.text.contains("Entry for \"smith2020\" in AHR.bib (line 1)"));
        assert!(g.text.contains("title={A {Nested} Title}"));
        assert!(!g.text.contains("doe2019"), "only the entries asked about");
        assert!(g.text.contains("Key \"ghost\": not found"));
        assert!(g.summary.excerpts.iter().any(|e| e.reason == "bibliography"));
    }

    #[test]
    fn focused_issue_is_first() {
        let dir = paper();
        let g = gather(dir.path(), &font_error(), Some(2), &[], &env());
        assert!(g.text.contains("The user asked about issue 1"));
        assert!(g.text.contains("1. [warning]: Citation `ghost'"));
    }

    #[test]
    fn files_outside_the_project_and_binaries_are_never_read() {
        let dir = paper();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.tex"), "TOP SECRET\n").unwrap();
        let mut input = font_error();
        let abs = outside.path().join("secret.tex").to_string_lossy().into_owned();
        input.issues = vec![
            IssueInput { severity: "error".into(), message: "x".into(), file: Some("../secret.tex".into()), line: Some(1), ..Default::default() },
            IssueInput { severity: "error".into(), message: "x".into(), file: Some(abs.clone()), line: Some(1), ..Default::default() },
            IssueInput { severity: "error".into(), message: format!("File {abs} and figure.png broke"), file: Some("figure.png".into()), line: Some(1), ..Default::default() },
        ];
        let g = gather(dir.path(), &input, None, &[], &env());
        assert!(!g.text.contains("TOP SECRET"));
        assert!(!g.text.contains("PNG"));
        assert!(g.summary.excerpts.iter().all(|e| e.file == "L2R.tex"));
    }

    #[test]
    fn everything_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let long_line = "x".repeat(5_000);
        let body: String = (0..200).map(|_| format!("{long_line}\n")).collect();
        for n in 0..6 {
            fs::write(dir.path().join(format!("f{n}.tex")), &body).unwrap();
        }
        let input = CompileInput {
            status: "failed".into(),
            issues: (0..40)
                .map(|n| IssueInput {
                    severity: "error".into(),
                    message: "m".repeat(5_000),
                    file: Some(format!("f{}.tex", n % 6)),
                    line: Some(100),
                    context: Some("c".repeat(5_000)),
                    ..Default::default()
                })
                .collect(),
            hints: vec!["h".repeat(5_000)],
            log: format!("! {}\n", "l".repeat(100_000)).repeat(5),
            ..Default::default()
        };
        let prev: Vec<PreviousAttempt> = (0..10)
            .map(|_| PreviousAttempt { summary: "s".repeat(10_000), ..Default::default() })
            .collect();
        let g = gather(dir.path(), &input, None, &prev, &env());
        assert!(g.text.len() <= MAX_TOTAL + 100, "{}", g.text.len());
        assert!(g.summary.truncated);
        assert!(g.summary.issue_count <= MAX_ISSUES);
        assert!(g.summary.excerpts.len() <= MAX_LOCATIONS + 1);
        assert!(g.text.contains("more characters cut"));
    }

    #[test]
    fn cap_respects_char_boundaries() {
        let (s, cut) = cap("ééé", 3);
        assert!(cut);
        assert!(s.starts_with('é'));
        assert_eq!(cap("abc", 10), ("abc".to_string(), false));
    }

    #[test]
    fn bib_entry_parsing() {
        let bib = "@article{a,\n title={x}}\n@misc{ab, note={y}}\n";
        assert_eq!(bib_entry(bib, "ab").unwrap(), "@misc{ab, note={y}}");
        assert!(bib_entry(bib, "b").is_none());
        let keys = citation_keys(&IssueInput { message: "I didn't find a database entry for \"k1\"".into(), ..Default::default() });
        assert_eq!(keys, vec!["k1"]);
    }
}
