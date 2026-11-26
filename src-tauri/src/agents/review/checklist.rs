//! The reviewer's checklist, run without the AI: page count against the
//! venue's limit, anonymity (double-blind venues only), undefined references
//! and citations, missing figure files, text running into the margin,
//! `.bib` entries without year or venue, leftover TODOs, figures and tables
//! without captions or labels, and labels nothing refers to.
//!
//! Compile-based checks read the last compile's log in `.texo/build` (or next
//! to the main document); nothing here compiles or changes files.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use regex::Regex;

use super::scan::{self, Sources, TexFile};
use super::{pages, Check, CheckStatus, ReviewSetup};
use crate::agents::tools::bibtex;
use crate::texlog::{self, Issue, Severity};

/// Details shown per check; the rest are counted.
const MAX_DETAILS: usize = 12;
/// Overfull boxes up to this wide are invisible in print.
const TINY_OVERFULL_PT: f64 = 1.0;

pub const PAGE_COUNT: &str = "page-count";
pub const ANON_AUTHORS: &str = "anonymity-authors";
pub const ANON_ACK: &str = "anonymity-acknowledgements";
pub const ANON_SELF_CITE: &str = "anonymity-self-citation";
pub const ANON_LINKS: &str = "anonymity-links";
pub const UNDEFINED_REFS: &str = "undefined-references";
pub const UNDEFINED_CITES: &str = "undefined-citations";
pub const MISSING_FIGURES: &str = "missing-figures";
pub const OVERFULL: &str = "overfull-boxes";
pub const BIB_FIELDS: &str = "bib-fields";
pub const LEFTOVERS: &str = "leftovers";
pub const CAPTIONS: &str = "captions-labels";
pub const UNUSED_LABELS: &str = "unreferenced-labels";

const COMPILE_FIRST: &str = "Compile the paper first so Texo can check this.";
const STALE: &str =
    "This comes from the last compile, which is older than your latest changes. Compile again for up-to-date results.";

/// One finding: where, and what.
struct Finding {
    at: Option<(String, u32)>,
    text: String,
}

impl Finding {
    fn at(file: &TexFile, offset: usize, text: impl Into<String>) -> Finding {
        Finding {
            at: Some((file.rel.clone(), file.line_at(offset))),
            text: text.into(),
        }
    }
    fn plain(text: impl Into<String>) -> Finding {
        Finding {
            at: None,
            text: text.into(),
        }
    }
}

fn make(
    id: &str,
    title: &str,
    status: CheckStatus,
    findings: Vec<Finding>,
    notes: Vec<String>,
) -> Check {
    let mut details: Vec<String> = Vec::new();
    let mut first: Option<(String, u32)> = None;
    let total = findings.len();
    for f in findings.into_iter() {
        if first.is_none() {
            first.clone_from(&f.at);
        }
        if details.len() < MAX_DETAILS {
            details.push(match &f.at {
                Some((file, line)) => format!("{file}:{line}: {}", f.text),
                None => f.text,
            });
        }
    }
    if total > MAX_DETAILS {
        details.push(format!("…and {} more.", total - MAX_DETAILS));
    }
    details.extend(notes);
    let (file, line) = match first {
        Some((f, l)) => (Some(f), Some(l)),
        None => (None, None),
    };
    Check {
        id: id.into(),
        title: title.into(),
        status,
        details,
        file,
        line,
    }
}

// ---------------------------------------------------------------------------
// The last compile
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Build {
    log: Option<String>,
    issues: Vec<Issue>,
    stopped_early: bool,
    /// The log is older than a source file.
    stale: bool,
    pages: Option<u32>,
    /// Where the page count came from, in plain words.
    pages_from: String,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn first_file(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.is_file()).cloned()
}

fn load_build(root: &Path, src: &Sources, output_pdf: Option<&str>) -> Build {
    let mut b = Build::default();
    let Some(main) = src.main.as_deref() else {
        return b;
    };
    let stem = Path::new(main)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let main_dir = root.join(&src.main_dir);
    let build = crate::compile::build_dir(root);
    let log_path = first_file(&[
        build.join(format!("{stem}.log")),
        main_dir.join(format!("{stem}.log")),
    ]);
    let mut pdf_candidates = vec![build.join(format!("{stem}.pdf"))];
    if let Some(out) = output_pdf.and_then(scan::normalize_rel) {
        pdf_candidates.push(root.join(out));
    }
    pdf_candidates.push(main_dir.join(format!("{stem}.pdf")));
    let pdf_path = first_file(&pdf_candidates);

    let log_time = log_path.as_deref().and_then(mtime);
    if let Some(lp) = &log_path {
        if let Ok(bytes) = fs::read(lp) {
            let log = String::from_utf8_lossy(&bytes).into_owned();
            let mut issues = texlog::parse_tex_log(&log);
            for issue in &mut issues {
                issue.file = issue
                    .file
                    .as_deref()
                    .and_then(|f| crate::compile::project_relative(root, &main_dir, f));
            }
            let d = texlog::diagnose(&log, &mut issues, None);
            b.stopped_early = d.stopped_early;
            b.issues = issues;
            if let Some(n) = pages::from_log(&log) {
                b.pages = Some(n);
                b.pages_from = "the last compile's log".into();
            }
            b.log = Some(log);
        }
    }
    // The PDF wins when it is newer than the log (compiled outside Texo) or
    // the log has no count.
    if let Some(pp) = &pdf_path {
        let newer = match (mtime(pp), log_time) {
            (Some(p), Some(l)) => p > l + std::time::Duration::from_secs(5),
            _ => true,
        };
        if b.pages.is_none() || newer {
            let small = fs::metadata(pp)
                .map(|m| m.len() <= pages::MAX_PDF_BYTES)
                .unwrap_or(false);
            if let Some(n) = small
                .then(|| fs::read(pp).ok())
                .flatten()
                .and_then(|bytes| pages::from_pdf(&bytes))
            {
                b.pages = Some(n);
                b.pages_from = "the compiled PDF".into();
            }
        }
    }
    let reference = log_time.or_else(|| pdf_path.as_deref().and_then(mtime));
    if let Some(t) = reference {
        b.stale = src
            .tex
            .iter()
            .map(|f| f.rel.as_str())
            .chain(src.bib.iter().map(|f| f.rel.as_str()))
            .filter_map(|rel| mtime(&root.join(rel)))
            .any(|m| m > t + std::time::Duration::from_secs(2));
    }
    b
}

// ---------------------------------------------------------------------------
// Running the checklist
// ---------------------------------------------------------------------------

/// Runs every check that applies to the setup's venue, in a fixed order.
/// Never fails: problems reading the project show up as warnings.
pub fn run(root: &Path, setup: &ReviewSetup) -> Vec<Check> {
    let meta = crate::project::read_meta(root);
    let main = meta
        .as_ref()
        .and_then(|m| m.main_document.clone())
        .filter(|m| root.join(m).is_file())
        .or_else(|| crate::project::detect_main_document(root));
    let src = scan::load(root, main.as_deref());
    let build = load_build(
        root,
        &src,
        meta.as_ref().and_then(|m| m.output_pdf.as_deref()),
    );
    run_on(root, setup, &src, &build)
}

fn run_on(root: &Path, setup: &ReviewSetup, src: &Sources, build: &Build) -> Vec<Check> {
    let mut out = vec![page_count(setup, src, build)];
    if setup.anonymous() {
        let style = ReviewStyle::detect(src);
        out.push(anon_authors(src, &style));
        out.push(anon_ack(src, &style));
        out.push(anon_self_citation(src));
        out.push(anon_links(src));
    }
    out.push(undefined_refs(build));
    out.push(undefined_cites(build));
    out.push(missing_figures(root, src, build));
    out.push(overfull(build));
    out.push(bib_fields(src));
    out.push(leftovers(src));
    out.push(captions(src));
    out.push(unused_labels(src));
    if !src.cloud_only.is_empty() {
        let note = format!(
            "{} file(s) are kept only online (OneDrive) and weren't checked: {}.",
            src.cloud_only.len(),
            src.cloud_only
                .iter()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
        for c in out.iter_mut().filter(|c| c.id != PAGE_COUNT) {
            c.details.push(note.clone());
        }
    }
    out
}

/// The checklist as text for the reviewers' prompt.
pub fn prompt_text(checks: &[Check]) -> String {
    let mut s = String::from(
        "Automatic checklist (already checked by Texo, don't repeat these as your own findings):\n",
    );
    for c in checks {
        let status = match c.status {
            CheckStatus::Pass => "pass",
            CheckStatus::Warn => "warning",
            CheckStatus::Fail => "FAIL",
        };
        s.push_str(&format!("- [{status}] {}", c.title));
        if c.status != CheckStatus::Pass {
            let shown: Vec<&str> = c.details.iter().take(5).map(String::as_str).collect();
            if !shown.is_empty() {
                s.push_str(": ");
                s.push_str(&shown.join("; "));
            }
        }
        s.push('\n');
    }
    s
}

// ---------------------------------------------------------------------------
// Page count
// ---------------------------------------------------------------------------

fn has_bibliography_or_appendix(src: &Sources) -> bool {
    let re = Regex::new(
        r"\\(appendix\b|bibliography\s*\{|printbibliography\b|begin\s*\{thebibliography\})",
    )
    .expect("regex");
    src.tex.iter().any(|f| re.is_match(&f.code))
}

fn page_count(setup: &ReviewSetup, src: &Sources, build: &Build) -> Check {
    let title = "Page count";
    let preset = setup.preset();
    let mut notes = Vec::new();
    if build.stale {
        notes.push(STALE.to_string());
    }
    let Some(n) = build.pages else {
        let msg = if src.main.is_none() {
            "Texo couldn't tell which file is the main document, so the pages weren't counted."
                .to_string()
        } else {
            "No compiled PDF yet. Compile the paper first so Texo can count its pages.".to_string()
        };
        return make(
            PAGE_COUNT,
            title,
            CheckStatus::Warn,
            vec![Finding::plain(msg)],
            notes,
        );
    };
    if n == 0 {
        return make(
            PAGE_COUNT,
            title,
            CheckStatus::Fail,
            vec![Finding::plain(
                "The last compile produced no pages. Fix the compile errors first.",
            )],
            notes,
        );
    }
    let pages = if n == 1 {
        "1 page".to_string()
    } else {
        format!("{n} pages")
    };
    let Some(limit) = setup.page_limit() else {
        let msg = format!(
            "The PDF has {pages} (from {}). {} has no fixed page limit. {}",
            build.pages_from, preset.name, preset.page_limit_note
        );
        return make(
            PAGE_COUNT,
            title,
            CheckStatus::Pass,
            vec![Finding::plain(msg)],
            notes,
        );
    };
    if n <= limit {
        let msg = format!(
            "The PDF has {pages}, within {}'s limit of {limit} pages.",
            preset.name
        );
        return make(
            PAGE_COUNT,
            title,
            CheckStatus::Pass,
            vec![Finding::plain(msg)],
            notes,
        );
    }
    if has_bibliography_or_appendix(src) {
        let msg = format!(
            "The PDF has {pages} in total; {} allows {limit} pages of main text. {} Check that the main text ends by page {limit}.",
            preset.name, preset.page_limit_note
        );
        make(
            PAGE_COUNT,
            title,
            CheckStatus::Warn,
            vec![Finding::plain(msg)],
            notes,
        )
    } else {
        let msg = format!(
            "The PDF has {pages}, over {}'s limit of {limit} pages, and has no references or appendix that wouldn't count.",
            preset.name
        );
        make(
            PAGE_COUNT,
            title,
            CheckStatus::Fail,
            vec![Finding::plain(msg)],
            notes,
        )
    }
}

// ---------------------------------------------------------------------------
// Anonymity
// ---------------------------------------------------------------------------

/// Whether the paper's style hides the authors itself (review mode).
#[derive(Debug, Default)]
struct ReviewStyle {
    /// e.g. "NeurIPS".
    name: Option<String>,
    /// In review mode: names, affiliations and `\thanks` aren't printed.
    hides_authors: bool,
    /// The style's own acknowledgements environment is hidden too.
    hidden_ack_env: Option<&'static str>,
    /// The style is in camera-ready mode, which prints the names.
    final_mode: Option<String>,
}

impl ReviewStyle {
    fn detect(src: &Sources) -> ReviewStyle {
        let code: String = src
            .tex
            .iter()
            .map(|f| f.code.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let pkg = Regex::new(r"\\(usepackage|documentclass)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}")
            .expect("regex");
        let mut s = ReviewStyle::default();
        for c in pkg.captures_iter(&code) {
            let opts: Vec<String> = c
                .get(2)
                .map(|o| o.as_str())
                .unwrap_or("")
                .split(',')
                .map(|o| o.trim().to_lowercase())
                .collect();
            let has = |o: &str| opts.iter().any(|x| x == o);
            for name in c[3].split(',').map(|n| n.trim().to_lowercase()) {
                let (label, hides, ack, fin): (&str, bool, Option<&'static str>, Option<&str>) =
                    if name.starts_with("neurips") {
                        let fin = if has("final") {
                            Some("final")
                        } else if has("preprint") {
                            Some("preprint")
                        } else {
                            None
                        };
                        ("NeurIPS", fin.is_none(), Some("ack"), fin)
                    } else if name.starts_with("icml") {
                        (
                            "ICML",
                            !has("accepted"),
                            None,
                            has("accepted").then_some("accepted"),
                        )
                    } else if name.starts_with("iclr") {
                        let fin = code.contains("\\iclrfinalcopy");
                        ("ICLR", !fin, None, fin.then_some("\\iclrfinalcopy"))
                    } else if name == "acl"
                        || name == "acl2023"
                        || name == "acl2024"
                        || name == "acl2025"
                    {
                        (
                            "ACL",
                            has("review"),
                            None,
                            (!has("review")).then_some(if has("final") {
                                "final"
                            } else {
                                "no review option"
                            }),
                        )
                    } else if name == "cvpr" || name == "iccv" || name == "wacv" {
                        let fin = code.contains("finalcopy") || has("final") || has("pagenumbers");
                        let review = has("review") || (!fin && code.contains("PaperID"));
                        ("CVPR/ICCV", review, None, (!review).then_some("final"))
                    } else if name == "acmart" && &c[1] == "documentclass" {
                        ("ACM", has("anonymous"), Some("acks"), None)
                    } else {
                        continue;
                    };
                s.name = Some(label.to_string());
                s.hides_authors = hides;
                s.hidden_ack_env = if hides { ack } else { None };
                s.final_mode = fin.map(str::to_string);
            }
        }
        s
    }
}

/// Text left after removing commands, braces and placeholder words.
fn identifying_text(content: &str) -> String {
    let cmd = Regex::new(r"\\[A-Za-z@]+\*?|\\.").expect("regex");
    let text = cmd.replace_all(content, " ");
    let placeholders = [
        "anonymous",
        "anonymized",
        "anonymised",
        "author",
        "authors",
        "submission",
        "paper",
        "id",
        "and",
        "affiliation",
        "affiliations",
        "institution",
        "address",
        "email",
        "the",
        "of",
        "n/a",
        "xxx",
        "hidden",
        "for",
        "review",
        "blind",
        "double",
        "withheld",
        "names",
        "name",
        "s",
    ];
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_string)
        .filter(|w| w.chars().any(char::is_alphabetic))
        .filter(|w| !placeholders.contains(&w.to_lowercase().as_str()))
        .collect();
    words.join(" ")
}

fn anon_authors(src: &Sources, style: &ReviewStyle) -> Check {
    let title = "Anonymity: author names";
    let mut findings = Vec::new();
    let pdfauthor = Regex::new(r"pdfauthor\s*=\s*").expect("regex");
    for f in &src.tex {
        for m in pdfauthor.find_iter(&f.code) {
            let rest = &f.code[m.end()..];
            let value = match scan::group_after(&f.code, m.end(), 0) {
                Some((a, b)) if rest.trim_start().starts_with('{') => f.code[a..b].to_string(),
                _ => rest
                    .split([',', '}', '\n'])
                    .next()
                    .unwrap_or("")
                    .to_string(),
            };
            if !identifying_text(&value).is_empty() {
                findings.push(Finding::at(
                    f,
                    m.start(),
                    "The PDF's properties name the authors (pdfauthor). Remove it for review.",
                ));
            }
        }
    }
    if style.hides_authors {
        let name = style.name.as_deref().unwrap_or("Your");
        let note = format!("The {name} style is in review mode, so it hides author names and affiliations in the PDF.");
        let status = if findings.is_empty() {
            CheckStatus::Pass
        } else {
            CheckStatus::Fail
        };
        return make(ANON_AUTHORS, title, status, findings, vec![note]);
    }
    let cmds = Regex::new(
        r"\\(author|icmlauthor|icmlaffiliation|icmlcorrespondingauthor|IEEEauthorblockN|IEEEauthorblockA|affiliation|affil|institute|email|thanks|address)\*?(?:[^A-Za-z]|$)",
    )
    .expect("regex");
    for f in &src.tex {
        for m in cmds.captures_iter(&f.code) {
            let whole = m.get(0).expect("match");
            let start = m.get(1).expect("cmd").end();
            if let Some((a, b)) = scan::group_after(&f.code, start, 2) {
                let left = identifying_text(&f.code[a..b]);
                if !left.is_empty() {
                    let snippet: String = left.chars().take(60).collect();
                    findings.push(Finding::at(
                        f,
                        whole.start(),
                        format!(
                            "\\{} shows \"{snippet}\". Replace it with \"Anonymous\" for review.",
                            &m[1]
                        ),
                    ));
                }
            }
        }
    }
    let mut notes = Vec::new();
    if let (Some(name), Some(mode)) = (&style.name, &style.final_mode) {
        notes.push(format!(
            "The {name} style is in camera-ready mode ({mode}), which prints the author names. Use its review mode for submission."
        ));
    }
    let status = if findings.is_empty() && notes.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Fail
    };
    if status == CheckStatus::Pass {
        notes.push("No author names found.".into());
    }
    make(ANON_AUTHORS, title, status, findings, notes)
}

fn anon_ack(src: &Sources, style: &ReviewStyle) -> Check {
    let title = "Anonymity: acknowledgements";
    let heading = Regex::new(r"(?i)\\(?:section|subsection|subsubsection|paragraph|chapter)\*?\s*\{\s*acknowledge?ments?\s*\.?\s*\}").expect("regex");
    let env = Regex::new(r"(?i)\\begin\s*\{(ack|acks|acknowledge?ments?)\}").expect("regex");
    let cmd =
        Regex::new(r"(?i)\\(?:acknowledge?ments?|section\*?\s*\{\s*funding\s*\})(?:[^A-Za-z]|$)")
            .expect("regex");
    let mut findings = Vec::new();
    let mut hidden = Vec::new();
    for f in &src.tex {
        for m in heading.find_iter(&f.code).chain(cmd.find_iter(&f.code)) {
            findings.push(Finding::at(
                f,
                m.start(),
                "An acknowledgements section can reveal who wrote the paper. Remove it for review.",
            ));
        }
        for c in env.captures_iter(&f.code) {
            let at = c.get(0).expect("m").start();
            if style
                .hidden_ack_env
                .is_some_and(|e| c[1].eq_ignore_ascii_case(e))
            {
                hidden.push(format!(
                    "{}: the {} style hides this acknowledgements block in review mode.",
                    f.at(at),
                    style.name.as_deref().unwrap_or("")
                ));
            } else {
                findings.push(Finding::at(f, at, "An acknowledgements block can reveal who wrote the paper. Remove it for review."));
            }
        }
    }
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Fail
    };
    if status == CheckStatus::Pass && hidden.is_empty() {
        hidden.push("No acknowledgements found.".into());
    }
    make(ANON_ACK, title, status, findings, hidden)
}

fn anon_self_citation(src: &Sources) -> Check {
    let title = "Anonymity: citing your own work";
    let patterns = [
        r"(?i)\b(?:our|my)\s+(?:own\s+)?(?:previous|prior|earlier|recent|past|preliminary|former)\s+(?:work|works|paper|papers|study|studies|research|publication|publications|approach|method|results?|findings|version)\b",
        r"(?i)\bwe\s+(?:have\s+)?(?:previously|earlier|recently|already|first)\s+(?:shown|showed|proposed|presented|introduced|reported|demonstrated|developed|described|published|studied)\b",
        r"(?i)\b(?:in|from|of)\s+our\s+(?:group|lab|team)\b",
        r"(?i)\bextends?\s+our\b",
    ];
    let res: Vec<Regex> = patterns
        .iter()
        .map(|p| Regex::new(p).expect("regex"))
        .collect();
    let mut findings = Vec::new();
    for f in &src.tex {
        let mut seen_lines = HashSet::new();
        for re in &res {
            for m in re.find_iter(&f.code) {
                if seen_lines.insert(f.line_at(m.start())) {
                    let phrase = m.as_str().split_whitespace().collect::<Vec<_>>().join(" ");
                    findings.push(Finding::at(
                        f,
                        m.start(),
                        format!("\"{phrase}\" tells reviewers who you are. Cite your own work in the third person (\"Smith et al. showed\")."),
                    ));
                }
            }
        }
    }
    findings.sort_by(|a, b| a.at.cmp(&b.at));
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Warn
    };
    let notes = if findings.is_empty() {
        vec!["No first-person self-citations found.".to_string()]
    } else {
        Vec::new()
    };
    make(ANON_SELF_CITE, title, status, findings, notes)
}

fn anon_links(src: &Sources) -> Check {
    let title = "Anonymity: links to your code or pages";
    let host = Regex::new(r"(?i)\b(github\.com|gitlab\.com|bitbucket\.org|huggingface\.co|sourceforge\.net|codeberg\.org)/([A-Za-z0-9_.-]+)").expect("regex");
    let home = Regex::new(r"(?i)https?://[^\s{}\\]+/~[A-Za-z][A-Za-z0-9_.-]*").expect("regex");
    let safe = [
        "anonymous",
        "anon",
        "anonymized",
        "anonymised",
        "xxx",
        "username",
        "user",
        "yourname",
        "your-name",
        "author",
        "authors",
        "orgs",
        "topics",
        "features",
        "about",
        "login",
        "join",
        "settings",
    ];
    let mut findings = Vec::new();
    for f in &src.tex {
        for c in host.captures_iter(&f.code) {
            let user = c[2].to_lowercase();
            if safe
                .iter()
                .any(|s| user == *s || user.starts_with("anonymous"))
            {
                continue;
            }
            findings.push(Finding::at(
                f,
                c.get(0).expect("m").start(),
                format!("A link to {}/{} shows whose code it is. Use an anonymous link (e.g. anonymous.4open.science) for review.", &c[1], &c[2]),
            ));
        }
        for m in home.find_iter(&f.code) {
            findings.push(Finding::at(
                f,
                m.start(),
                format!(
                    "{} looks like a personal page. Remove it for review.",
                    m.as_str()
                ),
            ));
        }
    }
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Fail
    };
    let notes = if findings.is_empty() {
        vec!["No identifying links found.".to_string()]
    } else {
        Vec::new()
    };
    make(ANON_LINKS, title, status, findings, notes)
}

// ---------------------------------------------------------------------------
// From the compile log
// ---------------------------------------------------------------------------

fn issue_finding(i: &Issue, text: String) -> Finding {
    match (&i.file, i.line) {
        (Some(f), Some(l)) => Finding {
            at: Some((f.clone(), l)),
            text,
        },
        (Some(f), None) => Finding::plain(format!("{f}: {text}")),
        _ => Finding::plain(text),
    }
}

fn quoted_key(message: &str, after: &str) -> Option<String> {
    let rest = &message[message.find(after)? + after.len()..];
    let rest = rest.strip_prefix('`').or_else(|| rest.strip_prefix('\''))?;
    let end = rest.find('\'')?;
    Some(rest[..end].to_string()).filter(|k| !k.is_empty())
}

fn log_notes(build: &Build) -> Vec<String> {
    let mut notes = Vec::new();
    if build.stopped_early {
        notes.push("The last compile stopped early because of an error, so some of these may only be missing because of that. Fix the error and compile again.".into());
    }
    if build.stale {
        notes.push(STALE.into());
    }
    notes
}

fn keyed_check(
    id: &str,
    title: &str,
    build: &Build,
    keys: Vec<(String, &Issue)>,
    what: &str,
    fix: &str,
) -> Check {
    if build.log.is_none() {
        return make(
            id,
            title,
            CheckStatus::Warn,
            vec![Finding::plain(COMPILE_FIRST)],
            Vec::new(),
        );
    }
    let mut by_key: BTreeMap<String, Vec<&Issue>> = BTreeMap::new();
    for (k, i) in keys {
        by_key.entry(k).or_default().push(i);
    }
    let notes = log_notes(build);
    if by_key.is_empty() {
        return make(
            id,
            title,
            CheckStatus::Pass,
            vec![Finding::plain(format!("No undefined {what}."))],
            notes,
        );
    }
    let findings = by_key
        .iter()
        .map(|(k, issues)| {
            let times = if issues.len() > 1 {
                format!(" (used {} times)", issues.len())
            } else {
                String::new()
            };
            issue_finding(issues[0], format!("'{k}' is undefined{times}. {fix}"))
        })
        .collect();
    let status = if build.stopped_early {
        CheckStatus::Warn
    } else {
        CheckStatus::Fail
    };
    make(id, title, status, findings, notes)
}

fn undefined_refs(build: &Build) -> Check {
    let keys = build
        .issues
        .iter()
        .filter(|i| i.severity == Severity::Warning && i.message.contains("undefined"))
        .filter_map(|i| quoted_key(&i.message, "Reference ").map(|k| (k, i)))
        .collect();
    keyed_check(
        UNDEFINED_REFS,
        "Undefined references",
        build,
        keys,
        "references",
        "It shows as ?? in the PDF: add the matching \\label or fix the name.",
    )
}

fn undefined_cites(build: &Build) -> Check {
    let keys = build
        .issues
        .iter()
        .filter_map(|i| i.citation.clone().map(|k| (k, i)))
        .collect();
    keyed_check(
        UNDEFINED_CITES,
        "Undefined citations",
        build,
        keys,
        "citations",
        "It shows as [?] in the PDF: add the entry to your .bib file or fix the key.",
    )
}

fn overfull(build: &Build) -> Check {
    let title = "Text running into the margin";
    if build.log.is_none() {
        return make(
            OVERFULL,
            title,
            CheckStatus::Warn,
            vec![Finding::plain(COMPILE_FIRST)],
            Vec::new(),
        );
    }
    let width = Regex::new(r"\(([\d.]+)pt too (?:wide|high)\)").expect("regex");
    let mut boxes: Vec<(f64, &Issue)> = build
        .issues
        .iter()
        .filter(|i| i.severity == Severity::Badbox && i.message.starts_with("Overfull"))
        .map(|i| {
            (
                width
                    .captures(&i.message)
                    .and_then(|c| c[1].parse().ok())
                    .unwrap_or(0.0),
                i,
            )
        })
        .collect();
    let mut notes = Vec::new();
    if build.stale {
        notes.push(STALE.to_string());
    }
    let tiny = boxes.iter().filter(|(w, _)| *w <= TINY_OVERFULL_PT).count();
    boxes.retain(|(w, _)| *w > TINY_OVERFULL_PT);
    if tiny > 0 {
        notes.push(format!(
            "{tiny} more stick out by 1pt or less, which you won't see in print."
        ));
    }
    if boxes.is_empty() {
        return make(
            OVERFULL,
            title,
            CheckStatus::Pass,
            vec![Finding::plain("No lines or boxes run into the margin.")],
            notes,
        );
    }
    boxes.sort_by(|a, b| b.0.total_cmp(&a.0));
    let count = boxes.len();
    let findings = boxes
        .iter()
        .map(|(w, i)| {
            issue_finding(
                i,
                format!("a line or box sticks out {w}pt into the margin."),
            )
        })
        .collect();
    notes.insert(0, format!("{count} place(s) in total. Rephrasing, \\linebreak, or resizing the figure or table usually fixes it."));
    make(OVERFULL, title, CheckStatus::Warn, findings, notes)
}

// ---------------------------------------------------------------------------
// From the sources
// ---------------------------------------------------------------------------

const GRAPHIC_EXTS: [&str; 10] = [
    "pdf", "png", "jpg", "jpeg", "eps", "ps", "mps", "jbig2", "jb2", "svg",
];

fn graphics_dirs(src: &Sources) -> Vec<String> {
    let re = Regex::new(r"\\graphicspath\s*").expect("regex");
    let mut dirs = Vec::new();
    for f in &src.tex {
        for m in re.find_iter(&f.code) {
            if let Some((a, b)) = scan::group_after(&f.code, m.end(), 0) {
                let inner = &f.code[a..b];
                let mut pos = 0;
                while let Some((x, y)) = scan::group_after(inner, pos, 0) {
                    dirs.push(inner[x..y].trim().to_string());
                    pos = y + 1;
                }
            }
        }
    }
    dirs
}

fn graphic_exists(root: &Path, bases: &[String], name: &str) -> bool {
    let has_ext = Path::new(name)
        .extension()
        .is_some_and(|e| GRAPHIC_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()));
    for base in bases {
        let Some(rel) = scan::join_rel(base, name) else {
            continue;
        };
        if has_ext && root.join(&rel).is_file() {
            return true;
        }
        if GRAPHIC_EXTS.iter().any(|e| {
            root.join(format!("{rel}.{e}")).is_file()
                || root.join(format!("{rel}.{}", e.to_uppercase())).is_file()
        }) {
            return true;
        }
        if root.join(&rel).is_file() {
            return true;
        }
    }
    false
}

fn missing_figures(root: &Path, src: &Sources, build: &Build) -> Check {
    let title = "Missing figure files";
    let re = Regex::new(r"\\(includegraphics|includesvg|includepdf)\*?").expect("regex");
    let gdirs = graphics_dirs(src);
    let mut findings = Vec::new();
    let mut named: HashSet<String> = HashSet::new();
    for f in &src.tex {
        let file_dir = scan::parent_rel(&f.rel);
        let mut bases = vec![src.main_dir.clone()];
        for d in &gdirs {
            if let Some(j) = scan::join_rel(&src.main_dir, d) {
                bases.push(j);
            }
        }
        bases.push(file_dir);
        for m in re.find_iter(&f.code) {
            let Some((a, b)) = scan::group_after(&f.code, m.end(), 2) else {
                continue;
            };
            let name = f.code[a..b].trim().trim_matches('"');
            if name.is_empty() || name.contains('\\') || name.contains('#') {
                continue;
            }
            named.insert(
                Path::new(name)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            );
            if !graphic_exists(root, &bases, name) {
                findings.push(Finding::at(
                    f,
                    m.start(),
                    format!(
                        "'{name}' can't be found. Add the file to the project or fix the path."
                    ),
                ));
            }
        }
    }
    for (at, name) in &src.missing_inputs {
        findings.push(Finding::plain(format!(
            "{at}: the file '{name}' this line includes can't be found."
        )));
    }
    // Images the log says are missing, if not already reported.
    for i in &build.issues {
        if let Some(file) = &i.missing_file {
            let stem = Path::new(file)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let is_graphic = Path::new(file).extension().is_some_and(|e| {
                GRAPHIC_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str())
            });
            if is_graphic && !named.contains(&stem) {
                findings.push(issue_finding(
                    i,
                    format!("the compile couldn't find '{file}'."),
                ));
            }
        }
    }
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Fail
    };
    let notes = if findings.is_empty() {
        vec!["All figure files are there.".to_string()]
    } else {
        Vec::new()
    };
    make(MISSING_FIGURES, title, status, findings, notes)
}

/// Citation keys used in the sources; `None` for `\nocite{*}` (all).
fn cited_keys(src: &Sources) -> Option<HashSet<String>> {
    let re = Regex::new(r"\\([A-Za-z]*cite[A-Za-z]*|nocite)\*?").expect("regex");
    let mut keys = HashSet::new();
    for f in &src.tex {
        for c in re.captures_iter(&f.code) {
            let cmd = &c[1];
            if matches!(
                cmd,
                "citestyle" | "bibliographystyle" | "citeoption" | "citesetup"
            ) {
                continue;
            }
            let end = c.get(0).expect("m").end();
            // biblatex's \cites{a}{b} takes several groups.
            let mut pos = end;
            while let Some((a, b)) = scan::group_after(&f.code, pos, 2) {
                for k in f.code[a..b].split(',') {
                    let k = k.trim();
                    if k == "*" && cmd == "nocite" {
                        return None;
                    }
                    if !k.is_empty() {
                        keys.insert(k.to_string());
                    }
                }
                pos = b + 1;
                if !cmd.ends_with("cites") {
                    break;
                }
            }
        }
    }
    Some(keys)
}

fn venue_fields(entry_type: &str) -> &'static [&'static str] {
    match entry_type {
        "article" => &["journal", "journaltitle", "eprint", "archiveprefix"],
        "inproceedings" | "conference" | "incollection" | "inbook" => {
            &["booktitle", "journal", "publisher"]
        }
        "book" | "booklet" | "mvbook" | "collection" | "proceedings" => {
            &["publisher", "organization", "howpublished", "institution"]
        }
        "phdthesis" | "mastersthesis" | "thesis" => &["school", "institution"],
        "techreport" | "report" => &["institution", "publisher", "number"],
        _ => &[
            "journal",
            "journaltitle",
            "booktitle",
            "publisher",
            "school",
            "institution",
            "howpublished",
            "eprint",
            "url",
            "note",
            "organization",
            "doi",
        ],
    }
}

fn bib_fields(src: &Sources) -> Check {
    let title = "Bibliography entries missing a year or venue";
    if src.bib.is_empty() {
        return make(
            BIB_FIELDS,
            title,
            CheckStatus::Pass,
            vec![Finding::plain("No .bib files to check.")],
            Vec::new(),
        );
    }
    let cited = cited_keys(src);
    let mut findings = Vec::new();
    let mut checked = 0;
    for b in &src.bib {
        for rec in bibtex::parse_entries(&b.text) {
            if matches!(
                rec.entry_type.as_str(),
                "string" | "preamble" | "comment" | "set" | "xdata"
            ) {
                continue;
            }
            if let Some(keys) = &cited {
                if !keys.is_empty() && !keys.contains(&rec.key) {
                    continue;
                }
            }
            checked += 1;
            let mut missing = Vec::new();
            if rec.get("year").is_none() && rec.get("date").is_none() {
                missing.push("year");
            }
            if !venue_fields(&rec.entry_type)
                .iter()
                .any(|f| rec.get(f).is_some())
            {
                missing.push(match rec.entry_type.as_str() {
                    "article" => "journal",
                    "inproceedings" | "conference" | "incollection" => "booktitle (the conference)",
                    "book" => "publisher",
                    "phdthesis" | "mastersthesis" | "thesis" => "school",
                    "techreport" | "report" => "institution",
                    _ => "venue (journal, booktitle, publisher or howpublished)",
                });
            }
            if !missing.is_empty() {
                findings.push(Finding {
                    at: Some((b.rel.clone(), rec.line as u32)),
                    text: format!("{} has no {}.", rec.key, missing.join(" and no ")),
                });
            }
        }
    }
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Warn
    };
    let notes = if findings.is_empty() {
        vec![format!(
            "All {checked} cited entries have a year and a venue."
        )]
    } else {
        vec!["Reviewers notice incomplete references. get_bibtex or the publisher's page gives the full entry.".to_string()]
    };
    make(BIB_FIELDS, title, status, findings, notes)
}

fn leftovers(src: &Sources) -> Check {
    let title = "Leftover TODOs and placeholders";
    let re = Regex::new(
        r"\\(?:todo|TODO|fixme|FIXME|listoftodos|missingfigure|lipsum|blindtext|hl)\b|\b(?:TODO|FIXME|TBD|XXX)\b|\?\?\?|(?i:lorem ipsum)|\[TBD",
    )
    .expect("regex");
    let mut findings = Vec::new();
    for f in &src.tex {
        let mut lines = HashSet::new();
        for m in re.find_iter(&f.code) {
            let line = f.line_at(m.start());
            if lines.insert(line) {
                let text: String = f.code[m.start()..]
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(70)
                    .collect();
                findings.push(Finding::at(
                    f,
                    m.start(),
                    format!("\"{text}\" is still in the text."),
                ));
            }
        }
    }
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Warn
    };
    let notes = if findings.is_empty() {
        vec!["No leftover notes found (comments are ignored).".to_string()]
    } else {
        Vec::new()
    };
    make(LEFTOVERS, title, status, findings, notes)
}

fn captions(src: &Sources) -> Check {
    let title = "Figures and tables without a caption or label";
    let begin = Regex::new(r"\\begin\s*\{(figure\*?|table\*?|wrapfigure|wraptable|sidewaysfigure|sidewaystable|SCfigure)\}").expect("regex");
    let caption = Regex::new(r"\\(?:caption|captionof|subcaption|sidecaption)\b").expect("regex");
    let label = Regex::new(r"\\label\s*\{").expect("regex");
    let mut findings = Vec::new();
    let mut count = 0;
    for f in &src.tex {
        for c in begin.captures_iter(&f.code) {
            let env = &c[1];
            let start = c.get(0).expect("m").end();
            let end_tag = format!("\\end{{{env}}}");
            let end = f.code[start..]
                .find(&end_tag)
                .map(|i| i + start)
                .unwrap_or(f.code.len());
            let body = &f.code[start..end];
            count += 1;
            let what = if env.contains("table") {
                "table"
            } else {
                "figure"
            };
            let has_caption = caption.is_match(body);
            let has_label = label.is_match(body);
            let at = c.get(0).expect("m").start();
            match (has_caption, has_label) {
                (true, true) => {}
                (false, _) => findings.push(Finding::at(
                    f,
                    at,
                    format!("This {what} has no \\caption; readers won't know what it shows."),
                )),
                (true, false) => findings.push(Finding::at(
                    f,
                    at,
                    format!("This {what} has no \\label, so the text can't refer to it by number."),
                )),
            }
        }
    }
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Warn
    };
    let notes = if findings.is_empty() {
        vec![if count == 0 {
            "No figures or tables.".to_string()
        } else {
            format!("All {count} figures and tables have a caption and a label.")
        }]
    } else {
        Vec::new()
    };
    make(CAPTIONS, title, status, findings, notes)
}

fn unused_labels(src: &Sources) -> Check {
    let title = "Labels nothing refers to";
    let label = Regex::new(r"\\label\s*").expect("regex");
    let mut defined: Vec<(String, &TexFile, usize)> = Vec::new();
    for f in &src.tex {
        for m in label.find_iter(&f.code) {
            if let Some((a, b)) = scan::group_after(&f.code, m.end(), 1) {
                let key = f.code[a..b].trim();
                if !key.is_empty() && !key.contains('#') && !key.contains('\\') {
                    defined.push((key.to_string(), f, m.start()));
                }
            }
        }
    }
    if defined.is_empty() {
        return make(
            UNUSED_LABELS,
            title,
            CheckStatus::Pass,
            vec![Finding::plain("No labels.")],
            Vec::new(),
        );
    }
    // Reference commands, plus the paper's own macros that wrap one
    // (\newcommand{\figref}[1]{Figure~\ref{#1}}).
    let wrapper = Regex::new(
        r"\\(?:re)?(?:newcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z]+)\s*\}?[^\n]*?\\[A-Za-z]*ref\*?\s*\{#1\}|\\def\s*\\([A-Za-z]+)\s*#1[^\n]*?\\[A-Za-z]*ref\*?\s*\{#1\}",
    )
    .expect("regex");
    let mut ref_cmds: Vec<String> = Vec::new();
    for f in &src.tex {
        for c in wrapper.captures_iter(&f.code) {
            if let Some(n) = c.get(1).or_else(|| c.get(2)) {
                ref_cmds.push(regex::escape(n.as_str()));
            }
        }
    }
    let extra = if ref_cmds.is_empty() {
        String::new()
    } else {
        format!("|{}", ref_cmds.join("|"))
    };
    let refs = Regex::new(&format!(
        r"\\([A-Za-z]*ref|[cC]refrange|[cC]pagerefrange|hyperref|zcref{extra})\*?"
    ))
    .expect("regex");
    let mut used: HashSet<String> = HashSet::new();
    for f in &src.tex {
        for c in refs.captures_iter(&f.code) {
            let end = c.get(0).expect("m").end();
            let cmd = &c[1];
            if cmd == "hyperref" {
                // \hyperref[label]{text}
                let rest = f.code[end..].trim_start();
                if let Some(inner) = rest.strip_prefix('[') {
                    if let Some(close) = inner.find(']') {
                        used.insert(inner[..close].trim().to_string());
                    }
                }
                continue;
            }
            let groups = if cmd.ends_with("range") { 2 } else { 1 };
            let mut pos = end;
            for _ in 0..groups {
                let Some((a, b)) = scan::group_after(&f.code, pos, 1) else {
                    break;
                };
                for k in f.code[a..b].split(',') {
                    used.insert(k.trim().to_string());
                }
                pos = b + 1;
            }
        }
    }
    let findings: Vec<Finding> = defined
        .iter()
        .filter(|(k, _, _)| !used.contains(k))
        .map(|(k, f, at)| {
            Finding::at(
                f,
                *at,
                format!("'{k}' is never referred to with \\ref or \\cref."),
            )
        })
        .collect();
    let status = if findings.is_empty() {
        CheckStatus::Pass
    } else {
        CheckStatus::Warn
    };
    let notes = if findings.is_empty() {
        vec![format!("All {} labels are referred to.", defined.len())]
    } else {
        vec![
            "A figure, table or section the text never mentions is easy for reviewers to miss."
                .to_string(),
        ]
    };
    make(UNUSED_LABELS, title, status, findings, notes)
}
