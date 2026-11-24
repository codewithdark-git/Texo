//! Turns TeX, BibTeX, and Biber log files into a list of issues the UI can
//! show and link to source lines.
//!
//! TeX logs are messy: file names appear as `(./file.tex` when TeX opens a
//! file and `)` when it closes it, and long lines wrap at 79 characters. We
//! track the open-file stack to attribute warnings that only say "on input
//! line N", and rely on `-file-line-error` output (`./file.tex:12: …`) for
//! errors where possible.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    /// Overfull/underfull boxes: layout problems, usually harmless.
    Badbox,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub severity: Severity,
    pub message: String,
    /// Path as written in the log, e.g. `./sections/intro.tex`.
    pub file: Option<String>,
    pub line: Option<u32>,
    /// Extra lines from the log, such as TeX's `l.12 \foo` context.
    pub context: Option<String>,
    /// For "Citation `key' undefined" warnings: the key that wasn't found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
}

const MAX_ISSUES: usize = 500;

/// TeX wraps log lines at this width, splitting long messages and paths.
const WRAP: usize = 79;

/// Joins lines TeX broke at exactly 79 characters back together.
fn unwrap_lines(log: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut joining = false;
    for raw in log.lines() {
        let line = raw.trim_end_matches('\r');
        if joining {
            if let Some(last) = out.last_mut() {
                last.push_str(line);
            }
        } else {
            out.push(line.to_string());
        }
        joining = line.chars().count() == WRAP;
    }
    out
}

/// Tracks which file TeX is reading, from `(file` and `)` in the log.
#[derive(Default)]
struct FileStack {
    stack: Vec<Option<String>>,
}

impl FileStack {
    fn current(&self) -> Option<String> {
        self.stack.iter().rev().flatten().next().cloned()
    }

    fn feed(&mut self, line: &str) {
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '(' => {
                    let rest: String = chars[i + 1..].iter().collect();
                    let name = file_token(&rest);
                    // Skip the name as written in the log (`.tex` may have been added).
                    let written = rest.chars().take_while(|c| !c.is_whitespace() && !matches!(c, '(' | ')' | '[' | '{' | '"')).count();
                    i += 1 + if name.is_some() { written } else { 0 };
                    self.stack.push(name);
                }
                ')' => {
                    self.stack.pop();
                    i += 1;
                }
                _ => i += 1,
            }
        }
    }
}

/// A path at the start of `s` if it looks like a file TeX opened.
fn file_token(s: &str) -> Option<String> {
    let token: String = s
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '(' && *c != ')' && *c != '[' && *c != '{' && *c != '"')
        .collect();
    let looks_like_path = token.starts_with("./")
        || token.starts_with("../")
        || token.starts_with('/')
        || token.chars().nth(1) == Some(':')
        || token.contains('/');
    let has_ext = token
        .rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && (1..=4).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()));
    if has_ext {
        return (looks_like_path || token.ends_with(".tex")).then_some(token);
    }
    // Tectonic logs an `\input{sections/intro}` as `(sections/intro)`, without
    // the `.tex` that \input adds, so a bare relative path still counts.
    let last = token.rsplit('/').next().unwrap_or("");
    let bare_path = looks_like_path
        && !token.ends_with('/')
        && !last.is_empty()
        && !last.contains('.')
        && token.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '\\'));
    bare_path.then(|| format!("{token}.tex"))
}

/// Parses `./file.tex:12: message` (from `-file-line-error`).
fn file_line_error(line: &str) -> Option<(String, u32, String)> {
    // Skip a Windows drive letter so its colon isn't taken as the separator.
    let search_from = if line.chars().nth(1) == Some(':') { 2 } else { 0 };
    let mut parts = line[search_from..].splitn(3, ':');
    let file_tail = parts.next()?;
    let num = parts.next()?;
    let msg = parts.next()?;
    let file = format!("{}{}", &line[..search_from], file_tail);
    let line_no: u32 = num.trim().parse().ok()?;
    if file.is_empty() || !file.contains('.') || file.contains(' ') && !file.contains('/') {
        return None;
    }
    Some((file, line_no, msg.trim().to_string()))
}

/// `… on input line 42.` → 42
fn input_line(text: &str) -> Option<u32> {
    let pos = text.rfind("on input line ")?;
    text[pos + "on input line ".len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// The key in an undefined-citation warning, from LaTeX and natbib
/// (``Citation `key' on page 1 undefined``, also with straight quotes as
/// newer biblatex writes it) and biblatex's "The following entry could not
/// be found in the database: key Please verify…" (continuation lines joined).
fn undefined_citation(text: &str) -> Option<String> {
    if let Some(rest) = text.strip_prefix("Citation ").or_else(|| text.split_once(" Citation ").map(|(_, r)| r)) {
        let rest = rest.strip_prefix('`').or_else(|| rest.strip_prefix('\''))?;
        let (key, tail) = rest.split_once('\'')?;
        return (tail.contains("undefined") && !key.is_empty()).then(|| key.to_string());
    }
    let rest = text.split_once("could not be found in the database:")?.1.trim_start();
    let key = rest.split_whitespace().next()?;
    Some(key.to_string())
}

/// `… at lines 10--12` → 10, `… at line 7` → 7
fn badbox_line(text: &str) -> Option<u32> {
    let pos = text.rfind(" at line")?;
    text[pos..]
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())?
        .parse()
        .ok()
}

/// `l.12 \foo` → 12
fn context_line(text: &str) -> Option<u32> {
    let rest = text.strip_prefix("l.")?;
    rest.chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
}

pub fn parse_tex_log(log: &str) -> Vec<Issue> {
    let lines = unwrap_lines(log);
    let mut issues: Vec<Issue> = Vec::new();
    let mut files = FileStack::default();
    let mut i = 0;

    while i < lines.len() && issues.len() < MAX_ISSUES {
        let line = &lines[i];

        // Errors: `./main.tex:12: Undefined control sequence.` or `! LaTeX Error: …`
        let fle = file_line_error(line);
        if fle.is_some() || line.starts_with("! ") {
            let (file, mut line_no, mut message) = match fle {
                Some((f, n, m)) => (Some(f), Some(n), m),
                None => (files.current(), None, line[2..].trim().to_string()),
            };
            // Gather the context TeX prints after an error, up to `l.N …`.
            let mut context = Vec::new();
            let mut j = i + 1;
            while j < lines.len() && j <= i + 12 {
                let next = &lines[j];
                if next.starts_with("! ") || file_line_error(next).is_some() {
                    break;
                }
                if let Some(n) = context_line(next) {
                    line_no = line_no.or(Some(n));
                    context.push(next.clone());
                    // The text after the error point is on the next line.
                    if j + 1 < lines.len() && !lines[j + 1].trim().is_empty() {
                        context.push(lines[j + 1].clone());
                        j += 1;
                    }
                    j += 1;
                    break;
                }
                if !next.trim().is_empty() && context.len() < 4 {
                    context.push(next.clone());
                }
                j += 1;
            }
            // `LaTeX Error: File `x.sty' not found.` reads better without the prefix.
            if let Some(rest) = message.strip_prefix("LaTeX Error: ") {
                message = rest.to_string();
            }
            // "Emergency stop" just repeats the previous error; give that
            // error the line number it carries instead of listing it twice.
            if message.starts_with("Emergency stop") {
                if let Some(prev) = issues.last_mut().filter(|p| p.severity == Severity::Error) {
                    prev.line = prev.line.or(line_no);
                    i = j;
                    continue;
                }
            }
            issues.push(Issue {
                severity: Severity::Error,
                message,
                file,
                line: line_no,
                context: (!context.is_empty()).then(|| context.join("\n")),
                citation: None,
            });
            i = j;
            continue;
        }

        // Warnings: `LaTeX Warning: …`, `Package foo Warning: …`, `Class bar Warning: …`.
        if let Some(pos) = line.find("Warning: ") {
            let head = &line[..pos];
            let is_tex_warning = head.ends_with("LaTeX ")
                || head.starts_with("Package ")
                || head.starts_with("Class ")
                || head.starts_with("LaTeX Font ")
                || head.starts_with("pdfTeX ");
            if is_tex_warning {
                let mut text = line[pos + "Warning: ".len()..].trim().to_string();
                // Continuation lines are indented or start with `(package)`.
                let package = head
                    .strip_prefix("Package ")
                    .or_else(|| head.strip_prefix("Class "))
                    .map(|p| p.trim().to_string());
                let mut j = i + 1;
                while j < lines.len() {
                    let next = lines[j].trim_start();
                    let cont = package
                        .as_ref()
                        .and_then(|p| next.strip_prefix(&format!("({p})")))
                        .or_else(|| (lines[j].starts_with("  ") && !next.is_empty()).then_some(next));
                    match cont {
                        Some(c) => {
                            text.push(' ');
                            text.push_str(c.trim());
                            j += 1;
                        }
                        None => break,
                    }
                }
                let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                let citation = undefined_citation(&text);
                issues.push(Issue {
                    severity: Severity::Warning,
                    line: input_line(&text),
                    file: files.current(),
                    message: match &package {
                        Some(p) => format!("{p}: {text}"),
                        None => text,
                    },
                    context: None,
                    citation,
                });
                files.feed(line);
                i = j;
                continue;
            }
        }

        // Layout problems.
        if line.starts_with("Overfull \\") || line.starts_with("Underfull \\") {
            issues.push(Issue {
                severity: Severity::Badbox,
                message: line.trim().to_string(),
                file: files.current(),
                line: badbox_line(line),
                context: None,
                citation: None,
            });
        }

        files.feed(line);
        i += 1;
    }
    issues
}

/// A plain-English message for the BibTeX errors people hit most, which
/// BibTeX itself words cryptically.
fn bibtex_message(line: &str) -> String {
    let line = line.trim();
    if let Some(name) = line.strip_prefix("I couldn't open database file ") {
        return format!(
            r"BibTeX couldn't open the bibliography file {}. Check the name in \bibliography{{...}} and that the file is in the project.",
            name.trim()
        );
    }
    if let Some(name) = line.strip_prefix("I couldn't open style file ") {
        return format!(
            r"BibTeX couldn't find the bibliography style {}. Check \bibliographystyle{{...}}, or add the .bst file to the project.",
            name.trim()
        );
    }
    if line.starts_with(r"I found no \bibdata command") {
        return r"BibTeX found no bibliography file to read. Add \bibliography{yourfile} where the references should appear.".into();
    }
    if line.starts_with(r"I found no \bibstyle command") {
        return r"BibTeX found no bibliography style. Add \bibliographystyle{plain} (or another style) next to \bibliography.".into();
    }
    if line.starts_with(r"I found no \citation commands") {
        return r"BibTeX found no citations. Cite something with \cite{key}, or use \nocite{*} to list every entry.".into();
    }
    format!("BibTeX: {}", line.split("---").next().unwrap_or(line).trim())
}

/// `---line 5 of file refs.bib` → (refs.bib, 5)
fn bibtex_location(text: &str) -> Option<(String, u32)> {
    let tail = text.split_once("---line ")?.1;
    let (n, file) = tail.split_once(" of file ")?;
    Some((file.trim().to_string(), n.trim().parse().ok()?))
}

/// BibTeX (`.blg`): missing entries, unreadable databases, syntax errors.
pub fn parse_bibtex_log(log: &str) -> Vec<Issue> {
    let mut issues: Vec<Issue> = Vec::new();
    let lines: Vec<&str> = log.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some(rest) = line.strip_prefix("Warning--") {
            // `Warning--I didn't find a database entry for "smith"`
            let citation = rest
                .strip_prefix("I didn't find a database entry for ")
                .map(|k| k.trim().trim_matches('"').to_string());
            issues.push(Issue {
                severity: Severity::Warning,
                message: format!("BibTeX: {}", rest.trim()),
                file: None,
                line: None,
                context: None,
                citation,
            });
        } else if line.starts_with("---line ") {
            // Where the previous error happened, on a line of its own. A
            // location in the build folder's .aux isn't worth linking to.
            if let (Some(prev), Some((file, n))) = (issues.last_mut(), bibtex_location(line)) {
                if prev.severity == Severity::Error && prev.line.is_none() && !file.ends_with(".aux") {
                    prev.file = Some(file);
                    prev.line = Some(n);
                }
            }
        } else if line.starts_with("I couldn't open")
            || line.starts_with("I found no")
            || line.contains("---line ")
        {
            // `I was expecting a `,' or a `}'---line 5 of file refs.bib`
            let (file, line_no) = bibtex_location(line).map_or((None, None), |(f, n)| (Some(f), Some(n)));
            let detail = lines
                .get(i + 1)
                .map(|l| l.trim())
                .filter(|l| !l.is_empty() && !l.starts_with(':') && !l.starts_with("---"));
            issues.push(Issue {
                severity: Severity::Error,
                message: bibtex_message(line),
                file,
                line: line_no,
                context: detail.map(str::to_string),
                citation: None,
            });
        }
    }
    issues
}

/// Biber (`.blg`): lines like `[123] Utils.pm:465> WARN - …` or `ERROR - …`.
pub fn parse_biber_log(log: &str) -> Vec<Issue> {
    log.lines()
        .filter_map(|line| {
            let (severity, rest) = if let Some((_, r)) = line.split_once("> ERROR - ") {
                (Severity::Error, r)
            } else if let Some((_, r)) = line.split_once("> WARN - ") {
                (Severity::Warning, r)
            } else {
                return None;
            };
            Some(Issue {
                severity,
                message: format!("Biber: {}", rest.trim()),
                file: None,
                line: None,
                context: None,
                citation: None,
            })
        })
        .collect()
}

/// Hint for a biblatex project Tectonic can't build. The marker at the start
/// lets the UI offer a one-click switch to biblatex's BibTeX backend.
pub const BIBLATEX_BIBTEX_HINT: &str = "[fix:biblatex-bibtex] This project uses biblatex with Biber, which the built-in engine can't run. Switch biblatex to its BibTeX backend (backend=bibtex), or install MiKTeX/TeX Live.";

/// What went wrong with Biber under Tectonic.
#[derive(Debug)]
pub struct TectonicBiberFailure {
    pub issue: Issue,
    /// The failure comes from the engine itself (Biber missing, or a Biber
    /// that doesn't match Tectonic's biblatex), so switching biblatex to its
    /// BibTeX backend is the fix. False when Biber ran and reported an error
    /// of its own, such as a missing or broken `.bib`: the backend is fine
    /// and the user needs to see Biber's message instead.
    pub backend_problem: bool,
}

/// The text after `ERROR - ` on Biber's console lines, which may carry the
/// `[123] Utils.pm:465> ` prefix the `.blg` uses.
fn biber_errors(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|l| l.split_once("ERROR - ").map(|(_, rest)| rest.trim().to_string()))
        .filter(|e| !e.is_empty())
        .collect()
}

/// Tectonic runs `biber` from PATH; it doesn't ship one, and a TeX
/// distribution's Biber usually doesn't match Tectonic's biblatex ("Found
/// biblatex control file version 3.8, expected version 3.11"). Tectonic then
/// carries on and reports success with every citation undefined, so this
/// spots the failure in its console output. A Biber run that worked prints
/// none of these.
pub fn tectonic_biber_failure(output: &str) -> Option<TectonicBiberFailure> {
    let ran_biber = output.contains("Running external tool biber");
    let lower = output.to_lowercase();
    let mismatch = output.contains("control file version");
    let tool_failed = output.contains("external tool exited with an error");
    // Biber missing: Tectonic's own `error:` lines name the tool or the
    // missing program ("program not found", "os error 2").
    let missing = ran_biber
        && lower.lines().any(|l| {
            let l = l.trim_start();
            l.starts_with("error:")
                && (l.contains("biber") || l.contains("external tool"))
                && (l.contains("not found") || l.contains("os error 2") || l.contains("cannot find") || l.contains("failed to execute"))
        });
    if !(mismatch || tool_failed || missing) || !(ran_biber || mismatch) {
        return None;
    }
    let issue = |message: &str, context: Option<String>| Issue {
        severity: Severity::Error,
        message: message.into(),
        file: None,
        line: None,
        context,
        citation: None,
    };
    if mismatch {
        let detail = output.lines().map(str::trim).find(|l| l.contains("control file version")).map(str::to_string);
        return Some(TectonicBiberFailure {
            issue: issue(
                "Biber couldn't build the bibliography: the Biber on this computer doesn't match the built-in engine's biblatex, so every citation is undefined.",
                detail,
            ),
            backend_problem: true,
        });
    }
    let errors = biber_errors(output);
    if missing && errors.is_empty() {
        let detail = output.lines().map(str::trim).find(|l| l.to_lowercase().starts_with("error:")).map(str::to_string);
        return Some(TectonicBiberFailure {
            issue: issue("Biber isn't installed, so the bibliography couldn't be built and every citation is undefined.", detail),
            backend_problem: true,
        });
    }
    // Biber ran and stopped on an error of its own (a missing or broken
    // .bib, say). Show what Biber said; switching backend wouldn't help.
    let message = match errors.first() {
        Some(first) => format!("Biber couldn't build the bibliography, so every citation is undefined: {first}"),
        None => "Biber failed, so the bibliography couldn't be built and every citation is undefined.".to_string(),
    };
    let context = if errors.len() > 1 { Some(errors[1..].join("\n")) } else { None };
    Some(TectonicBiberFailure { issue: issue(&message, context), backend_problem: false })
}

/// Plain-language advice for common failures, shown above the issue list.
pub fn hints(log: &str, issues: &[Issue]) -> Vec<String> {
    let mut out = Vec::new();
    let has = |needle: &str| log.contains(needle);
    if has("fontspec package requires either XeTeX or LuaTeX") || has("requires either XeTeX or LuaTeX") {
        out.push("This document needs XeLaTeX or LuaLaTeX. Switch the engine and compile again.".into());
    }
    if issues.iter().any(|i| i.message.contains("not found") && i.message.contains(".sty")) {
        out.push("A package is missing. Install it with your TeX distribution's package manager (MiKTeX Console or tlmgr), or enable automatic package installation.".into());
    }
    if has("No file") && has(".gls") && has("glossaries") {
        out.push("Your glossary may be missing. Add a .latexmkrc that runs makeglossaries.".into());
    }
    if has("Package nomencl") && has("No file") && has(".nls") {
        out.push("Your nomenclature may be missing. Add a .latexmkrc that runs makeindex for nomencl.".into());
    }
    if has("Rerun to get cross-references right") || has("Label(s) may have changed") {
        out.push("Cross-references may be out of date; compiling again usually fixes this.".into());
    }
    if has("No pages of output") {
        out.push("No pages were produced. Does the document have content between \\begin{document} and \\end{document}?".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = r#"This is pdfTeX, Version 3.141592653-2.6-1.40.26 (MiKTeX 24.1) (preloaded format=pdflatex 2024.5.1)
entering extended mode
(main.tex
LaTeX2e <2023-11-01> patch level 1
(C:\Users\me\AppData\Local\Programs\MiKTeX\tex/latex/base\article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(C:\Users\me\AppData\Local\Programs\MiKTeX\tex/latex/base\size11.clo))
(./sections/intro.tex

LaTeX Warning: Reference `fig:missing' on page 1 undefined on input line 7.

Overfull \hbox (12.0pt too wide) in paragraph at lines 10--12
[]\OT1/cmr/m/n/10.95 A very long line
)
./main.tex:14: Undefined control sequence.
l.14 \foo
          bar
Package natbib Warning: Citation `knuth' on page 1 undefined on input line 20
(natbib)                with extra detail.

! LaTeX Error: File `missing.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
! Emergency stop.
<read *>

l.3 \usepackage
               {missing}^^M
)
Output written on main.pdf (1 page, 1234 bytes).
"#;

    #[test]
    fn tectonic_inputs_without_extension_keep_their_file() {
        let log = "(./main.tex
 (sections/intro)
Package biblatex Warning: Citation 'k' on page 1 undefined on input line 2.

)
";
        let issues = parse_tex_log(log);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].file.as_deref(), Some("./main.tex"));
        let log = "(./main.tex
 (sections/intro
Package biblatex Warning: Citation 'k' on page 1 undefined on input line 2.

)
)
";
        let issues = parse_tex_log(log);
        assert_eq!(issues[0].file.as_deref(), Some("sections/intro.tex"));
        assert_eq!(issues[0].line, Some(2));
    }

    #[test]
    fn parses_errors_warnings_and_badboxes() {
        let issues = parse_tex_log(LOG);
        let summary: Vec<_> = issues
            .iter()
            .map(|i| (i.severity, i.file.as_deref(), i.line, i.message.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (Severity::Warning, Some("./sections/intro.tex"), Some(7), "Reference `fig:missing' on page 1 undefined on input line 7."),
                (Severity::Badbox, Some("./sections/intro.tex"), Some(10), "Overfull \\hbox (12.0pt too wide) in paragraph at lines 10--12"),
                (Severity::Error, Some("./main.tex"), Some(14), "Undefined control sequence."),
                (Severity::Warning, Some("main.tex"), Some(20), "natbib: Citation `knuth' on page 1 undefined on input line 20 with extra detail."),
                (Severity::Error, Some("main.tex"), Some(3), "File `missing.sty' not found."),
            ]
        );
        assert_eq!(issues[2].context.as_deref(), Some("l.14 \\foo\n          bar"));
    }

    #[test]
    fn rejoins_wrapped_lines() {
        let long = format!("LaTeX Warning: Reference `{}' on page 1 undefined on input line 5.", "x".repeat(60));
        let (a, b) = long.split_at(WRAP);
        let issues = parse_tex_log(&format!("(./main.tex\n{a}\n{b}\n)"));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].line, Some(5));
        assert!(issues[0].message.ends_with("input line 5."));
    }

    #[test]
    fn handles_windows_drive_paths_in_errors() {
        let issues = parse_tex_log("C:/proj/main.tex:9: Missing $ inserted.\nl.9 x^2\n");
        assert_eq!(issues[0].file.as_deref(), Some("C:/proj/main.tex"));
        assert_eq!(issues[0].line, Some(9));
    }

    #[test]
    fn parses_bibtex_and_biber_logs() {
        let blg = "Database file #1: refs.bib\nWarning--I didn't find a database entry for \"smith\"\n\
                   I was expecting a `,' or a `}'---line 5 of file refs.bib\n : author = {A}\n";
        let b = parse_bibtex_log(blg);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].severity, Severity::Warning);
        assert_eq!(b[1].file.as_deref(), Some("refs.bib"));
        assert_eq!(b[1].line, Some(5));

        let biber = "[0] Config.pm:307> INFO - This is Biber 2.19\n[57] Biber.pm:131> WARN - I didn't find a database entry for 'x'\n[60] Utils.pm:465> ERROR - BibTeX subsystem: refs.bib, line 4, syntax error";
        let b = parse_biber_log(biber);
        assert_eq!(b.len(), 2);
        assert_eq!(b[1].severity, Severity::Error);
    }

    #[test]
    fn undefined_citations_carry_their_key() {
        let log = "(./main.tex\n\
                   LaTeX Warning: Citation `knuth84' on page 1 undefined on input line 4.\n\
                   \n\
                   Package natbib Warning: Citation `smith:2020' on page 2 undefined on input line 9.\n\
                   \n\
                   LaTeX Warning: Citation 'lamport' on page 1 undefined on input line 12.\n\
                   \n\
                   Package biblatex Warning: The following entry could not be found\n\
                   (biblatex)                in the database:\n\
                   (biblatex)                doe2019\n\
                   (biblatex)                Please verify the spelling and rerun\n\
                   (biblatex)                LaTeX afterwards.\n\
                   \n\
                   LaTeX Warning: Reference `fig:1' on page 1 undefined on input line 3.\n)";
        let keys: Vec<_> = parse_tex_log(log).into_iter().map(|i| i.citation).collect();
        assert_eq!(
            keys,
            vec![
                Some("knuth84".to_string()),
                Some("smith:2020".to_string()),
                Some("lamport".to_string()),
                Some("doe2019".to_string()),
                None
            ]
        );
    }

    #[test]
    fn explains_common_bibtex_errors() {
        let blg = "This is BibTeX, Version 0.99d\n\
                   The top-level auxiliary file: main.aux\n\
                   The style file: plain.bst\n\
                   I couldn't open database file refs.bib\n\
                   ---line 3 of file main.aux\n \
                   : \\bibdata{refs\n \
                   :               }\n\
                   I'm skipping whatever remains of this command\n\
                   Warning--I didn't find a database entry for \"knuth\"\n";
        let b = parse_bibtex_log(blg);
        assert_eq!(b.len(), 2, "{b:?}");
        assert_eq!(b[0].severity, Severity::Error);
        assert!(b[0].message.contains("couldn't open the bibliography file refs.bib"), "{}", b[0].message);
        // The .aux location is build output, not worth a link.
        assert_eq!((b[0].file.as_deref(), b[0].line), (None, None));
        assert_eq!(b[1].citation.as_deref(), Some("knuth"));

        let blg = "The top-level auxiliary file: main.aux\nI found no \\bibdata command---while reading file main.aux\n";
        let b = parse_bibtex_log(blg);
        assert_eq!(b.len(), 1);
        assert!(b[0].message.contains("found no bibliography file"), "{}", b[0].message);
    }

    /// Console output of Tectonic 0.15 compiling a biblatex document with
    /// MiKTeX's Biber on PATH.
    const TECTONIC_BIBER_MISMATCH: &str = "note: Running TeX ...\n\
note: Rerunning TeX because \"main.aux\" changed ...\n\
note: Running external tool biber ...\n\
INFO - This is Biber 2.19\n\
INFO - Logfile is 'main.blg'\n\
INFO - Reading 'main.bcf'\n\
ERROR - Error: Found biblatex control file version 3.8, expected version 3.11.\n\
This means that your biber (2.19) and biblatex (3.17) versions are incompatible.\n\
INFO - ERRORS: 1\n\
error: the external tool exited with an error code; its stdout was:\n\
\n\
===============\n\
===============\n\
\n\
error: its stderr was:\n\
\n\
===============\n\
===============\n\
\n\
warning: main.tex:20: Citation 'knuth' on page 1 undefined\n\
note: Writing `main.pdf` (24.31 KiB)\n";

    #[test]
    fn spots_biber_failing_under_tectonic() {
        let failure = tectonic_biber_failure(TECTONIC_BIBER_MISMATCH).expect("flagged");
        assert_eq!(failure.issue.severity, Severity::Error);
        assert!(failure.backend_problem);
        assert!(failure.issue.context.as_deref().unwrap_or_default().contains("control file version 3.8"));

        let missing = "note: Running external tool biber ...\nerror: failed to execute the external tool \"biber\": program not found (os error 2)\n";
        let failure = tectonic_biber_failure(missing).unwrap();
        assert!(failure.issue.message.contains("isn't installed"));
        assert!(failure.backend_problem);

        // A Biber run that worked, and a document without Biber, aren't flagged.
        let ok = "note: Running TeX ...\nnote: Running external tool biber ...\nnote: Rerunning TeX because \"main.bbl\" changed ...\nnote: Writing `main.pdf` (30 KiB)\n";
        assert!(tectonic_biber_failure(ok).is_none());
        assert!(tectonic_biber_failure("note: Running TeX ...\nnote: Writing `main.pdf`\n").is_none());
        assert!(BIBLATEX_BIBTEX_HINT.starts_with("[fix:biblatex-bibtex] "));
    }

    #[test]
    fn shows_biber_own_errors_without_blaming_the_backend() {
        // A Biber that matches the engine, stopping on a missing database.
        let out = "note: Running external tool biber ...\n\
INFO - This is Biber 2.20\n\
INFO - Reading 'main.bcf'\n\
ERROR - Cannot find 'refs.bib'!\n\
INFO - ERRORS: 1\n\
error: the external tool exited with an error code; its stdout was:\n";
        let failure = tectonic_biber_failure(out).expect("flagged");
        assert!(!failure.backend_problem);
        assert!(failure.issue.message.contains("Cannot find 'refs.bib'!"), "{}", failure.issue.message);
        // The .blg-style prefix is understood too.
        let blg_style = "note: Running external tool biber ...\n[12] Utils.pm:465> ERROR - BibTeX subsystem: refs.bib, line 4, syntax error\nerror: the external tool exited with an error code\n";
        let failure = tectonic_biber_failure(blg_style).unwrap();
        assert!(!failure.backend_problem);
        assert!(failure.issue.message.contains("syntax error"));
    }

    #[test]
    fn gives_hints_for_common_failures() {
        let log = "! Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.";
        assert!(hints(log, &[])[0].contains("XeLaTeX"));
        assert!(hints("clean log", &[]).is_empty());
    }
}
