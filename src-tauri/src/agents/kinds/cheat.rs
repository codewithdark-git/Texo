//! The fixer's guard against "cheat" fixes: changes that make the error go
//! away by hiding it. A file with such a change is flagged "needs your
//! attention" with the reason, and the run is never applied automatically.
//!
//! Flagged (spec, "Guard rails (fixer)"):
//! - removing an `\input`, `\include` (also `\subfile`, `\import`) or
//!   `\includegraphics`, including by commenting it out or wrapping it in
//!   `\iffalse … \fi` / a `comment` environment;
//! - commenting out more than 3 non-blank lines (with `%`, `\iffalse … \fi`,
//!   `\if0`, or a `comment` / `verbatim` environment);
//! - adding `draft` / `draftmode`, `\nonstopmode`, `\batchmode` or
//!   `-interaction` tricks;
//! - deleting more than 20 lines of a `.tex` file (counted from a line
//!   diff, so lines added elsewhere don't offset them);
//! - removing a `\cite` key (checked over the whole changeset, so moving a
//!   citation between files is fine).
//!
//! Also flagged (beyond the spec): redefining LaTeX's error commands
//! (`\errmessage`, `\PackageError`, …) or `\input` / `\include` /
//! `\includegraphics` (so they do nothing), and removing a `\usepackage` (a
//! missing package should be installed, not removed).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::agents::types::ChangeEntry;

/// Comment-out lines allowed before a file is flagged.
pub const MAX_COMMENTED_LINES: usize = 3;
/// Deleted `.tex` lines allowed before a file is flagged.
pub const MAX_DELETED_LINES: usize = 20;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// The text before an unescaped `%` on one line.
fn code_part(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'%' => return &line[..i],
            _ => i += 1,
        }
    }
    line
}

/// The text with comments removed (line structure kept).
pub fn strip_comments(text: &str) -> String {
    text.lines().map(code_part).collect::<Vec<_>>().join("\n")
}

fn hiding_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"\\(?:(iffalse|if0)\b|(if[A-Za-z@]*)|(fi)\b|(else|or)\b)|\\(begin|end)\s*\{(comment|verbatim\*?|Verbatim\*?)\}",
    )
}

/// `code` (comments already removed) with the text TeX skips blanked out:
/// `\iffalse … \fi` (and `\if0`), up to an `\else` / `\or` at the same
/// depth, and `comment` / `verbatim` environments. Line structure is kept.
pub fn hide_skipped(code: &str) -> String {
    enum State {
        Shown,
        If(usize),
        Env(String),
    }
    let mut state = State::Shown;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut from = 0usize;
    for c in hiding_re().captures_iter(code) {
        let m = c.get(0).expect("match");
        match &mut state {
            State::Shown => {
                if c.get(1).is_some() {
                    from = m.start();
                    state = State::If(1);
                } else if c.get(5).is_some_and(|b| b.as_str() == "begin") {
                    from = m.start();
                    state = State::Env(c[6].to_string());
                }
            }
            State::If(depth) => {
                if c.get(1).is_some() || c.get(2).is_some() {
                    *depth += 1;
                } else if c.get(3).is_some() || (c.get(4).is_some() && *depth == 1) {
                    if *depth == 1 || c.get(4).is_some() {
                        ranges.push((from, m.end()));
                        state = State::Shown;
                    } else {
                        *depth -= 1;
                    }
                }
            }
            State::Env(name) => {
                if c.get(5).is_some_and(|b| b.as_str() == "end") && c[6] == **name {
                    ranges.push((from, m.end()));
                    state = State::Shown;
                }
            }
        }
    }
    if !matches!(state, State::Shown) {
        ranges.push((from, code.len()));
    }
    if ranges.is_empty() {
        return code.to_string();
    }
    let mut out = String::with_capacity(code.len());
    let mut pos = 0;
    for (a, b) in ranges {
        out.push_str(&code[pos..a]);
        out.extend(code[a..b].chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }));
        pos = b;
    }
    out.push_str(&code[pos..]);
    out
}

/// What TeX actually reads: comments removed and skipped text blanked.
pub fn visible(text: &str) -> String {
    hide_skipped(&strip_comments(text))
}

/// The content of a fully commented line (`% foo` → `foo`), if it is one.
fn commented(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = t.strip_prefix('%')?;
    let rest = rest.trim_start_matches('%').trim();
    (!rest.is_empty()).then_some(rest)
}

fn count(re: &Regex, text: &str) -> usize {
    re.find_iter(text).count()
}

fn includes_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\\(input|include|subfile|subimport|import|includegraphics)\b\s*\*?\s*(\[[^\]]*\])?\s*\{")
}

/// `\input` / `\include` / … counts per command.
fn include_counts(code: &str) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for c in includes_re().captures_iter(code) {
        let cmd = match &c[1] {
            "subfile" | "subimport" | "import" => "input".to_string(),
            other => other.to_string(),
        };
        *out.entry(cmd).or_insert(0) += 1;
    }
    out
}

fn cite_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\\[A-Za-z]*cite[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}")
}

/// The citation keys used in `code` (comments already removed).
pub fn cite_keys(code: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for c in cite_re().captures_iter(code) {
        for k in c[1].split(',') {
            let k = k.trim();
            if !k.is_empty() && k != "*" {
                out.insert(k.to_string());
            }
        }
    }
    out
}

fn packages(code: &str) -> BTreeSet<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = re(&R, r"\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}");
    let mut out = BTreeSet::new();
    for c in r.captures_iter(code) {
        for p in c[1].split(',') {
            let p = p.trim();
            if !p.is_empty() {
                out.insert(p.to_string());
            }
        }
    }
    out
}

/// (pattern, plain-words reason) for tricks that hide errors.
fn tricks() -> &'static [(Regex, &'static str)] {
    static T: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    T.get_or_init(|| {
        let r = |p: &str| Regex::new(p).expect("valid regex");
        vec![
            (r(r"\\(nonstopmode|batchmode|scrollmode)\b"), "Adds \\nonstopmode or \\batchmode, which makes TeX skip over errors instead of fixing them."),
            (r(r"-interaction\b|\binteraction\s*="), "Adds an -interaction option, which makes TeX skip over errors instead of fixing them."),
            (r(r"\\?pdfdraftmode\b|\bdraftmode\b"), "Adds draft mode, which hides the real output instead of fixing the problem."),
            (
                r(r"\[[^\]\n]*\bdraft\b[^\]\n]*\]|\\setkeys\s*\{Gin\}\s*\{[^}]*\bdraft\b|\bdraft\s*=\s*true\b"),
                "Adds the draft option, which hides figures and problems instead of fixing them.",
            ),
            (
                r(r"\\(?:let|def|gdef|renewcommand\*?|providecommand\*?)\s*\{?\s*\\(?:errmessage|PackageError|ClassError|GenericError|@latex@error|@latexerr)\b"),
                "Redefines LaTeX's error messages, which hides errors instead of fixing them.",
            ),
            (
                r(r"\\(?:let|def|gdef|edef|xdef|renewcommand\*?|providecommand\*?|RenewDocumentCommand|DeclareDocumentCommand|RenewExpandableDocumentCommand)\s*\{?\s*\\(?:input|include|includegraphics|subfile|import|subimport|includeonly)\b"),
                "Redefines \\input, \\include or \\includegraphics, which hides parts of the document instead of fixing them.",
            ),
        ]
    })
}

fn non_blank(text: &str) -> usize {
    text.lines().filter(|l| !l.trim().is_empty()).count()
}

/// Non-blank lines of `base` that a line diff removes. Lines rewritten in
/// place count only beyond the lines that replace them, and lines added
/// elsewhere in the file don't offset a deletion.
fn deleted_lines(base: &str, new: &str) -> usize {
    let squash = |t: &str| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(|l| format!("{l}\n")).collect::<String>();
    crate::agents::changeset::hunks(&squash(base), &squash(new))
        .iter()
        .map(|h| h.old_lines.saturating_sub(h.new_lines))
        .sum()
}

/// The code of a line TeX doesn't read: a `%` comment line, or a line
/// whose code is blanked by [`hide_skipped`] (`shown` is the same line of
/// [`visible`]).
fn hidden_content<'a>(line: &'a str, shown: &str) -> Option<&'a str> {
    if let Some(c) = commented(line) {
        return Some(c);
    }
    let code = code_part(line).trim();
    (!code.is_empty() && shown.trim().is_empty()).then_some(code)
}

fn is_tex(file: &str) -> bool {
    let f = file.to_ascii_lowercase();
    [".tex", ".ltx", ".sty", ".cls"].iter().any(|e| f.ends_with(e))
}

/// The reasons one file's change looks like a cheat (citations are checked
/// over the whole changeset by [`check`]).
pub fn file_reasons(file: &str, base: Option<&str>, new: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if !is_tex(file) {
        return out;
    }
    let base = base.unwrap_or("");
    let new_text = new.unwrap_or("");
    // What TeX reads: no comments, no `\iffalse … \fi` or comment blocks.
    let (bc, nc) = (visible(base), visible(new_text));

    // Removed \input / \include / \includegraphics.
    let (bi, ni) = (include_counts(&bc), include_counts(&nc));
    for (cmd, n) in &bi {
        let left = ni.get(cmd).copied().unwrap_or(0);
        if left < *n {
            let what = if cmd == "includegraphics" { "a figure" } else { "a part of the document" };
            out.push(format!("Removes or comments out {} \\{cmd} ({what}), which hides the problem instead of fixing it.", n - left));
        }
    }

    // Newly commented-out (or skipped) code lines.
    let (base_hidden, base_code) = {
        let mut hidden: BTreeMap<&str, usize> = BTreeMap::new();
        let mut code: BTreeSet<&str> = BTreeSet::new();
        for (l, shown) in base.lines().zip(bc.lines().chain(std::iter::repeat(""))) {
            match hidden_content(l, shown) {
                Some(_) => *hidden.entry(l.trim()).or_insert(0) += 1,
                None => {
                    let c = code_part(l).trim();
                    if !c.is_empty() {
                        code.insert(c);
                    }
                }
            }
        }
        (hidden, code)
    };
    let mut base_hidden = base_hidden;
    let mut newly = 0;
    for (l, shown) in new_text.lines().zip(nc.lines().chain(std::iter::repeat(""))) {
        let Some(content) = hidden_content(l, shown) else { continue };
        if let Some(n) = base_hidden.get_mut(l.trim()).filter(|n| **n > 0) {
            *n -= 1;
            continue;
        }
        if base_code.contains(content) {
            newly += 1;
        }
    }
    if newly > MAX_COMMENTED_LINES {
        out.push(format!("Comments out {newly} lines, which hides them instead of fixing them."));
    }

    // Tricks that hide errors.
    for (r, why) in tricks() {
        if count(r, &nc) > count(r, &bc) {
            out.push((*why).to_string());
        }
    }

    // Big deletions.
    let deleted = deleted_lines(base, new_text);
    if new.is_none() && non_blank(base) > MAX_DELETED_LINES {
        out.push(format!("Deletes the whole file ({} lines).", non_blank(base)));
    } else if deleted > MAX_DELETED_LINES {
        out.push(format!("Deletes {deleted} lines of the document."));
    }

    // Removed packages.
    let gone: Vec<String> = packages(&bc).difference(&packages(&nc)).cloned().collect();
    if !gone.is_empty() {
        out.push(format!(
            "Removes the package(s) {}. If a package is missing, install it instead (Texo offers a one-click install).",
            gone.join(", ")
        ));
    }
    out
}

/// Flags every file of the changeset that looks like a cheat fix (sets
/// `attention`; existing reasons are kept).
pub fn check(changes: &mut [ChangeEntry]) {
    // Citation keys gone from every changed file (moving one is fine).
    let mut before = BTreeSet::new();
    let mut after = BTreeSet::new();
    for c in changes.iter().filter(|c| is_tex(&c.file)) {
        before.extend(cite_keys(&visible(c.base_text.as_deref().unwrap_or(""))));
        after.extend(cite_keys(&visible(c.new_text.as_deref().unwrap_or(""))));
    }
    let removed: BTreeSet<String> = before.difference(&after).cloned().collect();
    for c in changes.iter_mut() {
        let mut reasons = file_reasons(&c.file, c.base_text.as_deref(), c.new_text.as_deref());
        if is_tex(&c.file) && !removed.is_empty() {
            let here: Vec<String> =
                cite_keys(&visible(c.base_text.as_deref().unwrap_or(""))).intersection(&removed).cloned().collect();
            if !here.is_empty() {
                reasons.push(format!("Removes the citation(s) {}, so the paper no longer cites them.", here.join(", ")));
            }
        }
        for r in reasons {
            if !c.attention.contains(&r) {
                c.attention.push(r);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r"\documentclass{article}
\usepackage{graphicx}
\usepackage{amsmath}
\begin{document}
\section{Intro}
As shown by \citet{smith2020} and \cite[p.~4]{jones, lee}, it works.
\input{sections/method}
\includegraphics[width=\linewidth]{figs/plot.pdf}
Line one.
Line two.
Line three.
Line four.
% an old comment
\end{document}
";

    fn reasons(new: &str) -> Vec<String> {
        let mut c = vec![ChangeEntry {
            file: "main.tex".into(),
            base_text: Some(BASE.into()),
            new_text: Some(new.into()),
            ..Default::default()
        }];
        check(&mut c);
        c.remove(0).attention
    }

    #[test]
    fn honest_fixes_are_not_flagged() {
        // Closing a brace, fixing a path, adding a package: fine.
        assert!(reasons(&BASE.replace("\\section{Intro}", "\\section{Introduction}")).is_empty());
        assert!(reasons(&BASE.replace("figs/plot.pdf", "figures/plot.pdf")).is_empty());
        assert!(reasons(&BASE.replace("\\usepackage{amsmath}", "\\usepackage{amsmath}\n\\usepackage{booktabs}")).is_empty());
        // Changing an existing comment, or commenting out 3 lines: fine.
        assert!(reasons(&BASE.replace("% an old comment", "% a newer comment")).is_empty());
        let three = BASE.replace("Line one.", "% Line one.").replace("Line two.", "% Line two.").replace("Line three.", "%Line three.");
        assert!(reasons(&three).is_empty(), "{:?}", reasons(&three));
        // The word "draft" in the text is not an option.
        assert!(reasons(&BASE.replace("it works.", "it works in a draft.")).is_empty());
        // \% is not a comment.
        assert!(reasons(&BASE.replace("Line four.", "Line four is 50\\% done.")).is_empty());
    }

    #[test]
    fn removing_inputs_and_figures_is_flagged() {
        let r = reasons(&BASE.replace("\\input{sections/method}\n", ""));
        assert!(r.iter().any(|x| x.contains("\\input")), "{r:?}");
        let r = reasons(&BASE.replace("\\includegraphics", "%\\includegraphics"));
        assert!(r.iter().any(|x| x.contains("\\includegraphics") && x.contains("figure")), "{r:?}");
        let r = reasons(&BASE.replace("\\input{sections/method}", "\\include{sections/method}"));
        assert!(r.iter().any(|x| x.contains("\\input")), "a swap is counted per command: {r:?}");
    }

    #[test]
    fn commenting_out_more_than_three_lines_is_flagged() {
        let four = BASE
            .replace("Line one.", "% Line one.")
            .replace("Line two.", "% Line two.")
            .replace("Line three.", "% Line three.")
            .replace("Line four.", "%% Line four.");
        let r = reasons(&four);
        assert!(r.iter().any(|x| x.contains("Comments out 4 lines")), "{r:?}");
    }

    #[test]
    fn tricks_are_flagged() {
        for (new, word) in [
            (BASE.replace("\\documentclass{article}", "\\documentclass[draft]{article}"), "draft option"),
            (BASE.replace("\\usepackage{graphicx}", "\\usepackage[draft]{graphicx}"), "draft option"),
            (BASE.replace("\\begin{document}", "\\setkeys{Gin}{draft}\n\\begin{document}"), "draft option"),
            (BASE.replace("\\begin{document}", "\\pdfdraftmode=1\n\\begin{document}"), "draft mode"),
            (BASE.replace("\\documentclass", "\\nonstopmode\n\\documentclass"), "\\nonstopmode"),
            (BASE.replace("\\documentclass", "\\batchmode\n\\documentclass"), "\\batchmode"),
            (BASE.replace("\\documentclass", "% !TEX TS-program = pdflatex -interaction=nonstopmode\n\\documentclass"), ""),
            (BASE.replace("\\begin{document}", "\\renewcommand{\\PackageError}[3]{}\n\\begin{document}"), "error messages"),
        ] {
            let r = reasons(&new);
            if word.is_empty() {
                // Inside a comment: harmless, not flagged.
                assert!(r.is_empty(), "{r:?}");
            } else {
                assert!(r.iter().any(|x| x.contains(word)), "{word}: {r:?}");
            }
        }
        // Already there before: not new, not flagged.
        let mut c = vec![ChangeEntry {
            file: "main.tex".into(),
            base_text: Some(format!("\\batchmode\n{BASE}")),
            new_text: Some(format!("\\batchmode\n{}", BASE.replace("Intro", "Introduction"))),
            ..Default::default()
        }];
        check(&mut c);
        assert!(c[0].attention.is_empty());
    }

    #[test]
    fn big_deletions_and_deleted_files_are_flagged() {
        let long: String = (0..30).map(|i| format!("Sentence {i}.\n")).collect();
        let mut c = vec![
            ChangeEntry { file: "a.tex".into(), base_text: Some(long.clone()), new_text: Some("Sentence 0.\n".into()), ..Default::default() },
            ChangeEntry { file: "b.tex".into(), base_text: Some(long.clone()), new_text: None, ..Default::default() },
            ChangeEntry { file: "c.tex".into(), base_text: Some(long.clone()), new_text: Some(long[..long.len() / 2].into()), ..Default::default() },
            // Not .tex: not checked.
            ChangeEntry { file: "notes.md".into(), base_text: Some(long), new_text: None, ..Default::default() },
        ];
        check(&mut c);
        assert!(c[0].attention.iter().any(|x| x.contains("Deletes 29 lines")), "{:?}", c[0].attention);
        assert!(c[1].attention.iter().any(|x| x.contains("whole file")));
        assert!(c[2].attention.is_empty(), "15 lines is under the limit: {:?}", c[2].attention);
        assert!(c[3].attention.is_empty());
    }

    #[test]
    fn removed_citations_are_flagged_but_moved_ones_are_not() {
        let r = reasons(&BASE.replace("\\cite[p.~4]{jones, lee}", "\\cite[p.~4]{jones}"));
        assert!(r.iter().any(|x| x.contains("citation(s) lee")), "{r:?}");
        let r = reasons(&BASE.replace("\\citet{smith2020}", "Smith"));
        assert!(r.iter().any(|x| x.contains("smith2020")), "{r:?}");
        // Moved to another file in the same changeset: fine.
        let mut c = vec![
            ChangeEntry {
                file: "main.tex".into(),
                base_text: Some(BASE.into()),
                new_text: Some(BASE.replace("\\citet{smith2020}", "Smith")),
                ..Default::default()
            },
            ChangeEntry {
                file: "sections/related.tex".into(),
                base_text: Some(String::new()),
                new_text: Some("See \\citet{smith2020}.\n".into()),
                ..Default::default()
            },
        ];
        check(&mut c);
        assert!(c.iter().all(|x| x.attention.is_empty()), "{:?}", c[0].attention);
        assert_eq!(cite_keys("\\parencite{a,b} \\textcite*{c} \\nocite{*}"), ["a", "b", "c"].iter().map(|s| s.to_string()).collect());
    }

    /// F5: hiding code with `\iffalse … \fi`, `\if0`, a comment environment
    /// or a redefinition counts like commenting it out.
    #[test]
    fn skipped_blocks_and_redefinitions_are_flagged() {
        let wrapped = BASE.replace("\\includegraphics", "\\iffalse\n\\includegraphics").replace("Line one.", "\\fi\nLine one.");
        let r = reasons(&wrapped);
        assert!(r.iter().any(|x| x.contains("\\includegraphics")), "{r:?}");
        let r = reasons(&BASE.replace("\\input{sections/method}", "\\begin{comment}\n\\input{sections/method}\n\\end{comment}"));
        assert!(r.iter().any(|x| x.contains("\\input")), "{r:?}");
        let four = BASE.replace("Line one.", "\\if0\nLine one.").replace("Line four.", "Line four.\n\\fi");
        let r = reasons(&four);
        assert!(r.iter().any(|x| x.contains("Comments out 4 lines")), "{r:?}");
        // The \else branch is read: only the \iffalse part is hidden.
        let both = BASE.replace("Line one.", "\\iffalse\nLine one.\n\\else\nLine one, fixed.\n\\fi");
        assert!(reasons(&both).is_empty(), "{:?}", reasons(&both));
        for redef in [
            "\\renewcommand{\\includegraphics}[2][]{}",
            "\\renewcommand*\\input[1]{}",
            "\\def\\input#1{}",
            "\\let\\includegraphics\\relax",
        ] {
            let r = reasons(&BASE.replace("\\begin{document}", &format!("{redef}\n\\begin{{document}}")));
            assert!(r.iter().any(|x| x.contains("Redefines \\input")), "{redef}: {r:?}");
        }
        // Saving the old command under a new name is fine.
        assert!(reasons(&BASE.replace("\\begin{document}", "\\let\\oldinput\\input\n\\begin{document}")).is_empty());
        // A citation inside a skipped block is gone.
        let r = reasons(&BASE.replace("As shown", "\\iffalse\nAs shown").replace("it works.", "it works.\n\\fi"));
        assert!(r.iter().any(|x| x.contains("smith2020")), "{r:?}");
        // Already skipped in the base: not new.
        let base = BASE.replace("Line one.", "\\iffalse\nLine one.\nLine two.\nLine three.\nLine four.\n\\fi");
        let mut c = vec![ChangeEntry {
            file: "main.tex".into(),
            base_text: Some(base.clone()),
            new_text: Some(base.replace("Intro", "Introduction")),
            ..Default::default()
        }];
        check(&mut c);
        assert!(c[0].attention.is_empty(), "{:?}", c[0].attention);
        // Nested conditionals inside the skipped block close at the right \fi.
        let nested = hide_skipped("a\n\\iffalse\n\\ifx\\a\\b x\\fi\nb\n\\fi\nc");
        assert_eq!(nested.lines().map(str::trim).collect::<Vec<_>>(), ["a", "", "", "", "", "c"]);
    }

    /// F6: deleted lines come from a line diff, not the net line count.
    #[test]
    fn deletions_offset_by_additions_elsewhere_are_flagged() {
        let section: String = (0..40).map(|i| format!("Broken sentence {i}.\n")).collect();
        let filler: String = (0..25).map(|i| format!("Filler {i}.\n")).collect();
        let base = format!("\\section{{A}}\n{section}\\section{{B}}\nEnd.\n");
        let new = format!("\\section{{A}}\n\\section{{B}}\nEnd.\n{filler}");
        let mut c = vec![ChangeEntry { file: "a.tex".into(), base_text: Some(base), new_text: Some(new), ..Default::default() }];
        check(&mut c);
        assert!(c[0].attention.iter().any(|x| x.contains("Deletes 40 lines")), "{:?}", c[0].attention);
        // Rewording 30 lines in place is an edit, not a deletion.
        let a: String = (0..30).map(|i| format!("Sentence {i}.\n")).collect();
        let b: String = (0..30).map(|i| format!("Sentence {i}, reworded.\n")).collect();
        assert_eq!(deleted_lines(&a, &b), 0);
        assert_eq!(deleted_lines(&a, "\n\n"), 30);
    }

    #[test]
    fn removed_packages_are_flagged() {
        let r = reasons(&BASE.replace("\\usepackage{amsmath}\n", ""));
        assert!(r.iter().any(|x| x.contains("amsmath") && x.contains("install")), "{r:?}");
    }
}
