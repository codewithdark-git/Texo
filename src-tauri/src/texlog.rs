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
                    i += 1 + name.as_ref().map_or(0, |n| n.chars().count());
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
    (has_ext && (looks_like_path || token.ends_with(".tex"))).then_some(token)
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
                issues.push(Issue {
                    severity: Severity::Warning,
                    line: input_line(&text),
                    file: files.current(),
                    message: match &package {
                        Some(p) => format!("{p}: {text}"),
                        None => text,
                    },
                    context: None,
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
            });
        }

        files.feed(line);
        i += 1;
    }
    issues
}

/// BibTeX (`.blg`): missing entries, unreadable databases, syntax errors.
pub fn parse_bibtex_log(log: &str) -> Vec<Issue> {
    let mut issues = Vec::new();
    let lines: Vec<&str> = log.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some(rest) = line.strip_prefix("Warning--") {
            issues.push(Issue {
                severity: Severity::Warning,
                message: format!("BibTeX: {}", rest.trim()),
                file: None,
                line: None,
                context: None,
            });
        } else if line.starts_with("I couldn't open")
            || line.starts_with("I found no")
            || line.contains("---line ")
        {
            // `I was expecting a `,' or a `}'---line 5 of file refs.bib`
            let (file, line_no) = match line.split_once("---line ") {
                Some((_, tail)) => {
                    let mut it = tail.splitn(2, " of file ");
                    let n = it.next().and_then(|n| n.trim().parse().ok());
                    (it.next().map(|f| f.trim().to_string()), n)
                }
                None => (None, None),
            };
            let detail = lines.get(i + 1).map(|l| l.trim()).filter(|l| !l.is_empty() && !l.starts_with(':'));
            issues.push(Issue {
                severity: Severity::Error,
                message: format!("BibTeX: {}", line.split("---").next().unwrap_or(line).trim()),
                file,
                line: line_no,
                context: detail.map(str::to_string),
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
            })
        })
        .collect()
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
    fn gives_hints_for_common_failures() {
        let log = "! Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.";
        assert!(hints(log, &[])[0].contains("XeLaTeX"));
        assert!(hints("clean log", &[]).is_empty());
    }
}
