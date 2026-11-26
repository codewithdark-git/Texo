//! Turns TeX, BibTeX, and Biber log files into a list of issues the UI can
//! show and link to source lines.
//!
//! TeX logs are messy: file names appear as `(./file.tex` when TeX opens a
//! file and `)` when it closes it, and long lines wrap at 79 characters. We
//! track the open-file stack to attribute warnings that only say "on input
//! line N", and rely on `-file-line-error` output (`./file.tex:12: …`) for
//! errors where possible.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    #[default]
    Warning,
    /// Overfull/underfull boxes: layout problems, usually harmless.
    Badbox,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
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
    /// What the error means and how to fix it, in plain words, for errors
    /// Texo recognises.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    /// The error that made TeX give up: this run produced no PDF.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fatal: bool,
    /// An undefined citation or reference that is only undefined because
    /// the compile stopped early, before BibTeX/Biber or the second pass.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub consequence: bool,
    /// The file TeX or BibTeX couldn't find (`x.sty`, `plainnat.bst`), so a
    /// package install can be offered. Not sent to the UI.
    #[serde(skip)]
    pub missing_file: Option<String>,
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

/// TeX's page shipout marker, `[1]` or `[2{…pdftex.map}]`, somewhere on the line.
fn ships_page(line: &str) -> bool {
    line.as_bytes().windows(2).any(|w| w[0] == b'[' && w[1].is_ascii_digit())
}

/// Why an "Emergency stop" happened, from its `*** (…)` line.
#[derive(Debug, PartialEq)]
enum StopCause {
    /// A cause of its own, unrelated to earlier errors: (message, explanation).
    Own(&'static str, &'static str),
    /// TeX couldn't answer the prompt the previous error raised (a missing file).
    PreviousError,
    /// No cause given: blame the previous error only if it came right before.
    Unknown,
}

fn stop_cause(text: &str) -> StopCause {
    if text.contains(r"no legal \end found") {
        return StopCause::Own(
            r"The document ended without \end{document}.",
            r"TeX reached the end of the main file without finding \end{document}, so it stopped and no new PDF was made. Add \end{document} as the last line of the main file. If it is there, something opened earlier and never closed (a \begin{...} with no \end{...}, or a { with no }) may be hiding it.",
        );
    }
    if text.contains(r"cannot \read from terminal") || text.contains("file error in nonstop mode") {
        return StopCause::PreviousError;
    }
    StopCause::Unknown
}

/// A line that starts a new TeX error message.
fn is_error_start(line: &str) -> bool {
    line.starts_with("! ") || line.starts_with("!pdfTeX error") || file_line_error(line).is_some()
}

/// `Package inputenc Error: …` → `inputenc` (also `Class foo Error: …`).
fn error_package(message: &str) -> Option<String> {
    let rest = message.strip_prefix("Package ").or_else(|| message.strip_prefix("Class "))?;
    let (name, _) = rest.split_once(" Error")?;
    (!name.is_empty() && !name.contains(' ')).then(|| name.to_string())
}

/// The text between the first `` ` `` (or `'`) after `after` and the next `'`.
fn quoted_after<'a>(text: &'a str, after: &str) -> Option<&'a str> {
    let rest = text.split_once(after)?.1;
    let rest = rest.strip_prefix('`').or_else(|| rest.strip_prefix('\''))?;
    rest.split_once('\'').map(|(q, _)| q).filter(|q| !q.is_empty())
}

/// `File `x.sty' not found.` → `x.sty`.
fn missing_file(message: &str) -> Option<String> {
    if !message.contains("not found") {
        return None;
    }
    quoted_after(message, "File ").map(str::to_string)
}

/// The command at the end of the first context line of an "Undefined
/// control sequence" error (TeX puts the unknown command there).
fn undefined_command(context: Option<&str>) -> Option<String> {
    let first = context?.lines().next()?.trim_end();
    let at = first.rfind('\\')?;
    let name: String = first[at + 1..].chars().take_while(|c| c.is_ascii_alphabetic() || *c == '@').collect();
    (!name.is_empty()).then(|| format!("\\{name}"))
}

/// Packages that define commands people often use without loading them.
const COMMAND_PACKAGES: &[(&str, &str)] = &[
    ("\\includegraphics", "graphicx"),
    ("\\url", "url"),
    ("\\href", "hyperref"),
    ("\\autoref", "hyperref"),
    ("\\textcolor", "xcolor"),
    ("\\color", "xcolor"),
    ("\\definecolor", "xcolor"),
    ("\\toprule", "booktabs"),
    ("\\midrule", "booktabs"),
    ("\\bottomrule", "booktabs"),
    ("\\multirow", "multirow"),
    ("\\SI", "siunitx"),
    ("\\si", "siunitx"),
    ("\\qty", "siunitx"),
    ("\\num", "siunitx"),
    ("\\citep", "natbib"),
    ("\\citet", "natbib"),
    ("\\cref", "cleveref"),
    ("\\Cref", "cleveref"),
    ("\\mathbb", "amssymb"),
    ("\\checkmark", "amssymb"),
    ("\\text", "amsmath"),
    ("\\eqref", "amsmath"),
    ("\\DeclareMathOperator", "amsmath"),
    ("\\bm", "bm"),
    ("\\hl", "soul"),
    ("\\sout", "ulem"),
    ("\\tikz", "tikz"),
    ("\\ce", "mhchem"),
    ("\\lipsum", "lipsum"),
    ("\\euro", "eurosym"),
    ("\\degree", "gensymb"),
    ("\\algorithmic", "algorithmic"),
    ("\\State", "algpseudocode"),
    ("\\FloatBarrier", "placeins"),
];

const FONT_EXPANSION: &str = r"Your document uses the microtype package, whose font expansion only works with scalable (Type 1) fonts. The fonts it needs aren't installed on this computer, so TeX only found blurry bitmap versions and stopped. Fix it by installing the cm-super font package, or by adding \usepackage{lmodern} right after \usepackage[T1]{fontenc}, or by loading microtype as \usepackage[expansion=false]{microtype}.";

const STOPPED_EXPLANATION: &str = "TeX gave up before the end of the document, so no new PDF was made. The error before this one is usually the real cause; if there is none, the Log tab shows where TeX stopped.";

/// Plain words for a missing file, by kind.
fn explain_missing_file(file: &str, help: &str) -> String {
    let lower = file.to_ascii_lowercase();
    let stem = lower.rsplit(['/', '\\']).next().unwrap_or(&lower).rsplit_once('.').map_or(lower.as_str(), |(s, _)| s).to_string();
    if lower.ends_with(".sty") {
        return format!(
            "The package \u{201c}{stem}\u{201d} ({file}) isn't installed on this computer. Install it with your TeX distribution, or, if the file came with your template, copy it into the project folder."
        );
    }
    if lower.ends_with(".cls") {
        return format!(
            "The document class \u{201c}{stem}\u{201d} ({file}) isn't installed on this computer. Journal templates often come with their own .cls file: copy it into the project folder, or install the class with your TeX distribution."
        );
    }
    if help.contains("could not locate the file with any of these extensions") {
        return format!(
            r"The image {file} wasn't found. Check the file name and folder in \includegraphics{{...}} (capital letters matter), and that the image is in the project. PDF, PNG and JPG images work with pdfLaTeX."
        );
    }
    if lower.ends_with(".tex") || !lower.contains('.') {
        return format!(
            r"The file {file}, which the document includes with \input or \include, wasn't found. Check the file name and folder (capital letters matter), and that the file is in the project."
        );
    }
    format!("TeX couldn't find the file {file}. Check its name, and that it is in the project or installed.")
}

/// What a TeX error means and how to fix it, in plain words, for the
/// errors people hit most. `help` is TeX's own help text after the error.
fn explain(message: &str, context: Option<&str>, help: &str) -> Option<String> {
    let has = |s: &str| message.contains(s);
    if has("auto expansion is only possible with scalable fonts") || has("(font expansion)") {
        return Some(FONT_EXPANSION.into());
    }
    if let Some(file) = missing_file(message) {
        return Some(explain_missing_file(&file, help));
    }
    if has("Undefined control sequence") {
        return Some(match undefined_command(context) {
            Some(cmd) => match COMMAND_PACKAGES.iter().find(|(c, _)| *c == cmd) {
                Some((_, pkg)) => format!(
                    r"TeX doesn't know the command {cmd}. It comes from the {pkg} package: add \usepackage{{{pkg}}} to the preamble (before \begin{{document}}), or check the spelling."
                ),
                None => format!(
                    r"TeX doesn't know the command {cmd}. Check its spelling; if it's spelled right, it probably comes from a package the document doesn't load yet (\usepackage{{...}})."
                ),
            },
            None => r"TeX doesn't know a command used on this line. Check the spelling of each \command; if they're right, one probably comes from a package the document doesn't load yet.".into(),
        });
    }
    if has("Missing $ inserted") {
        return Some(r"A math symbol such as ^, _ or a Greek letter (\alpha) is used outside math, or a formula was left open. Put the formula between dollar signs, like $x^2$, and check that every $ has a partner.".into());
    }
    if has("Paragraph ended before") || has("Runaway argument") || has("File ended while scanning") {
        return Some("A closing brace } is probably missing: a command's argument ran into a blank line or the end of the file before it was closed. Check that every { on or before this line has a matching }.".into());
    }
    if has("Too many }'s") || has("Extra }, or forgotten") {
        return Some("There's a closing brace } with no matching opening {. Remove the extra }, or add the missing {.".into());
    }
    if has("Missing } inserted") || has("Missing { inserted") {
        return Some("TeX expected a brace here: a { or } is missing, often inside a formula or a command's argument. Check that the braces on this line are balanced.".into());
    }
    if has("Extra alignment tab") {
        return Some("A table row has more cells (separated by &) than the table has columns. Remove an &, or add a column to the column list, such as {lll}.".into());
    }
    if has("Misplaced alignment tab character") {
        return Some(r"An & appears outside a table or aligned formula. To print an ampersand, write \&.".into());
    }
    if has("Unicode character") && has("not set up for use with LaTeX") {
        let ch = message.split_once("Unicode character ").map(|(_, r)| r.split(" (U+").next().unwrap_or("").trim()).unwrap_or("");
        let code = message.split_once("(U+").and_then(|(_, r)| r.split_once(')')).map(|(c, _)| c).unwrap_or("XXXX");
        return Some(format!(
            r"The character {ch} (U+{code}) can't be printed by pdfLaTeX with the current fonts. Replace it with a LaTeX command, define it in the preamble with \DeclareUnicodeCharacter{{{code}}}{{...}}, or switch the engine to XeLaTeX or LuaLaTeX, which handle such characters directly."
        ));
    }
    if has("Keyboard character used is undefined") || has("Invalid UTF-8") {
        let enc = quoted_after(message, "inputencoding ").unwrap_or("");
        return Some(if enc.is_empty() || enc == "utf8" {
            "The file contains bytes that aren't valid UTF-8 text, often from copying out of a PDF or an old editor. Save the file as UTF-8, or retype the odd characters on this line.".into()
        } else {
            format!(
                r"The file is saved as UTF-8, but the document says it uses the {enc} encoding. Change \usepackage[{enc}]{{inputenc}} to \usepackage[utf8]{{inputenc}}, or remove that line."
            )
        });
    }
    if has("Missing \\begin{document}") {
        return Some(r"Something that prints text appears before \begin{document}, often a stray word or character in the preamble, or \begin{document} is missing. Move it below \begin{document}, or delete it.".into());
    }
    if has(" ended by \\end{") {
        return Some(r"An environment is closed with the wrong name: a \begin{...} is ended by a different \end{...}. Make the names match, or add the missing \end{...}.".into());
    }
    if has("Environment ") && has(" undefined") {
        return Some(r"TeX doesn't know this environment. Check the name in \begin{...}; if it's right, load the package that defines it.".into());
    }
    if has("Too many unprocessed floats") {
        return Some(r"Too many figures and tables are waiting for a place on a page. Add \clearpage after a few of them, allow more positions with [htbp], or load the placeins package and use \FloatBarrier.".into());
    }
    if has("Dimension too large") {
        return Some("A length is bigger than TeX can handle (about 5.7 metres). This usually comes from a size computed from huge numbers, such as an image scaled far too large or a plot with extreme values. Check the sizes used on this line.".into());
    }
    if help.contains("This is a coding error") || message.starts_with("LaTeX3 Error") {
        return Some("This error comes from LaTeX's programming layer: a package, or low-level code in the document, did something LaTeX doesn't allow. If you didn't write such code, a package may be outdated or loaded twice; updating your TeX distribution often fixes it.".into());
    }
    if has("I can't write on file") {
        return Some("TeX couldn't write its output file. If the PDF is open in another program (such as Adobe Reader), close it there and compile again.".into());
    }
    if has("TeX capacity exceeded") {
        return Some(r"TeX ran out of memory. This almost always means a command calls itself without end (for example a \newcommand that uses its own name), or a very large table or plot. Check the code around this line.".into());
    }
    if has("not loadable: Metric (TFM) file not found") {
        return Some("A font the document needs isn't installed. Install the font's package with your TeX distribution (MiKTeX can do it automatically when allowed), or choose another font.".into());
    }
    if has("Option clash for package") {
        return Some(r"A package is loaded twice with different options (possibly once by the document class). Load it once with all the options together, or put \PassOptionsToPackage{...}{package} before \documentclass.".into());
    }
    if has("Can be used only in preamble") {
        return Some(r"This command only works before \begin{document}. Move it into the preamble.".into());
    }
    if has("Lonely \\item") || has("perhaps a missing \\item") {
        return Some(r"A list is used wrongly: \item outside a list, or text before the first \item. Put items inside \begin{itemize}...\end{itemize} (or enumerate), each starting with \item.".into());
    }
    if has("There's no line here to end") {
        return Some(r"A line break (\\) is used where there's no line to end, such as at the start of a paragraph or right after a heading. Remove it, or use \vspace{...} for extra space.".into());
    }
    if has("Missing number, treated as zero") {
        return Some("TeX expected a number or a length (such as 2cm) here but found something else. Check the arguments of the command on this line.".into());
    }
    if has("Illegal unit of measure") {
        return Some(r"A length is missing its unit. Write one after the number, such as 2cm, 10pt or 0.5\textwidth.".into());
    }
    if has("already defined") && has("Command") {
        return Some(r"This command name already exists, perhaps from a package. Pick another name, or use \renewcommand if you mean to replace it.".into());
    }
    None
}

pub fn parse_tex_log(log: &str) -> Vec<Issue> {
    let lines = unwrap_lines(log);
    let mut issues: Vec<Issue> = Vec::new();
    let mut files = FileStack::default();
    let mut i = 0;
    // Something happened since the last error (a warning, a page shipped),
    // so an "Emergency stop" now isn't simply that error's doing.
    let mut progressed_since_error = false;

    while i < lines.len() && issues.len() < MAX_ISSUES {
        let line = &lines[i];
        if ships_page(line) {
            progressed_since_error = true;
        }

        // Errors: `./main.tex:12: Undefined control sequence.`, `! LaTeX Error: …`,
        // and pdfTeX's own `!pdfTeX error: …` (no space after the `!`).
        let fle = file_line_error(line);
        if fle.is_some() || line.starts_with("! ") || line.starts_with("!pdfTeX error") {
            let (file, mut line_no, mut message) = match fle {
                Some((f, n, m)) => (Some(f), Some(n), m),
                None => (files.current(), None, line[1..].trim().to_string()),
            };
            let mut j = i + 1;
            // Messages that go on over several lines: `(inputenc)  in …` for
            // package errors, indented text for LaTeX errors.
            let package = error_package(&message);
            while j < lines.len() {
                let next = &lines[j];
                let t = next.trim_start();
                let cont = package
                    .as_ref()
                    .and_then(|p| t.strip_prefix(&format!("({p})")))
                    .or_else(|| (message.contains("Error:") && next.starts_with("  ") && !t.is_empty() && !t.starts_with("...")).then_some(t));
                match cont {
                    Some(c) => {
                        message.push(' ');
                        message.push_str(c.trim());
                        j += 1;
                    }
                    None => break,
                }
            }
            // Gather the context TeX prints after an error, up to `l.N …`.
            let mut context = Vec::new();
            let limit = j + 12;
            while j < lines.len() && j <= limit {
                let next = &lines[j];
                if is_error_start(next) {
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
            // TeX's help text follows; only read to recognise the error.
            let help: String = lines[j.min(lines.len())..]
                .iter()
                .take(8)
                .take_while(|l| !is_error_start(l))
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            // `LaTeX Error: File `x.sty' not found.` reads better without the prefix.
            if let Some(rest) = message.strip_prefix("LaTeX Error: ") {
                message = rest.to_string();
            }
            // "Emergency stop" and "==> Fatal error occurred" just say TeX
            // gave up after the previous error: mark that error as the one
            // that stopped the run instead of listing it twice.
            let gave_up = message.starts_with("Emergency stop") || message.starts_with("==> Fatal error occurred");
            if gave_up {
                let already = issues.iter().any(|p| p.fatal);
                // An Emergency stop names its own cause on a `*** (…)` line.
                let cause = message
                    .starts_with("Emergency stop")
                    .then(|| {
                        lines[i + 1..]
                            .iter()
                            .take(16)
                            .take_while(|l| !is_error_start(l))
                            .find_map(|l| l.trim().strip_prefix("*** ("))
                            .map(|c| c.trim_end_matches(')').to_string())
                    })
                    .flatten();
                let stop = if !message.starts_with("Emergency stop") {
                    // pdfTeX's "==> Fatal error occurred" follows its own error.
                    StopCause::PreviousError
                } else {
                    cause.as_deref().map(stop_cause).unwrap_or(StopCause::Unknown)
                };
                // Only blame the previous error when it is what made TeX stop:
                // a prompt it raised (missing file), or nothing happened
                // in between (no warnings, no pages shipped since).
                let prev_index = issues.iter().rposition(|p| p.severity == Severity::Error);
                let prev_is_cause = match stop {
                    StopCause::Own(..) => false,
                    StopCause::PreviousError => prev_index.is_some(),
                    StopCause::Unknown => {
                        prev_index.is_some_and(|p| p + 1 == issues.len()) && !progressed_since_error
                    }
                };
                if let StopCause::Own(own_message, own_explanation) = stop {
                    issues.push(Issue {
                        severity: Severity::Error,
                        message: own_message.into(),
                        file,
                        line: line_no,
                        explanation: Some(own_explanation.into()),
                        fatal: !already,
                        ..Default::default()
                    });
                } else if let (true, Some(p)) = (prev_is_cause, prev_index) {
                    let prev = &mut issues[p];
                    prev.line = prev.line.or(line_no);
                    prev.fatal = prev.fatal || !already;
                } else if already {
                    // A later "Fatal error occurred" after a stop already shown.
                } else {
                    issues.push(Issue {
                        severity: Severity::Error,
                        message: "TeX stopped with a fatal error, so no PDF was produced.".into(),
                        file,
                        line: line_no,
                        explanation: Some(STOPPED_EXPLANATION.into()),
                        fatal: true,
                        ..Default::default()
                    });
                }
                i = j;
                continue;
            }
            let context = (!context.is_empty()).then(|| context.join("\n"));
            progressed_since_error = false;
            issues.push(Issue {
                severity: Severity::Error,
                explanation: explain(&message, context.as_deref(), &help),
                missing_file: missing_file(&message),
                message,
                file,
                line: line_no,
                context,
                ..Default::default()
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
                progressed_since_error = true;
                issues.push(Issue {
                    severity: Severity::Warning,
                    line: input_line(&text),
                    file: files.current(),
                    message: match &package {
                        Some(p) => format!("{p}: {text}"),
                        None => text,
                    },
                    citation,
                    ..Default::default()
                });
                files.feed(line);
                i = j;
                continue;
            }
        }

        // Layout problems.
        if line.starts_with("Overfull \\") || line.starts_with("Underfull \\") {
            progressed_since_error = true;
            issues.push(Issue {
                severity: Severity::Badbox,
                message: line.trim().to_string(),
                file: files.current(),
                line: badbox_line(line),
                ..Default::default()
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
                citation,
                ..Default::default()
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
            let missing_file = line
                .strip_prefix("I couldn't open style file ")
                .map(|n| n.split("---").next().unwrap_or(n).trim().to_string());
            issues.push(Issue {
                severity: Severity::Error,
                message: bibtex_message(line),
                file,
                line: line_no,
                context: detail.map(str::to_string),
                missing_file,
                ..Default::default()
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
                ..Default::default()
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
        context,
        ..Default::default()
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
/// Missing packages get their own hint, with an install button, from
/// [`diagnose`]; `_issues` is kept for callers.
pub fn hints(log: &str, _issues: &[Issue]) -> Vec<String> {
    let mut out = Vec::new();
    let has = |needle: &str| log.contains(needle);
    if has("fontspec package requires either XeTeX or LuaTeX") || has("requires either XeTeX or LuaTeX") {
        out.push("This document needs XeLaTeX or LuaLaTeX. Switch the engine and compile again.".into());
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

/// Fix marker for a hint whose button installs `package` (see `texpkg`).
pub fn install_marker(package: &str) -> Option<String> {
    crate::texpkg::valid_package(package).then(|| format!("[fix:install-package:{package}] "))
}

/// The hints for a compile, most important first, after the issues were
/// put in order by [`diagnose`].
#[derive(Debug, Default)]
pub struct Diagnosis {
    pub hints: Vec<String>,
    /// How many of `hints` are about the error that stopped the run; other
    /// hints (such as a bibliography backend switch) go after these.
    pub primary: usize,
    /// TeX gave up before the end of the document; no new PDF was made.
    pub stopped_early: bool,
}

/// The font-expansion error comes from Computer Modern in T1 encoding (the
/// EC fonts), whose scalable versions are the cm-super package. With Latin
/// Modern or another font family, installing cm-super wouldn't help.
fn needs_cm_super(log: &str) -> bool {
    let lower = log.to_ascii_lowercase();
    let latin_modern = lower.contains("lmodern.sty") || lower.contains("t1/lmr") || lower.contains("mt-lmr.cfg");
    // microtype loads its Computer Modern settings (mt-cmr.cfg) when the
    // document uses it, and show up as ecrm*.pk. (Not "T1/cmr": every LaTeX log
    // names it while checking font defaults.)
    let computer_modern = lower.contains("mt-cmr.cfg") || lower.contains("\\ecrm") || lower.contains("/ecrm");
    computer_modern && !latin_modern
}

/// "Reference `fig:one' on page 1 undefined …" → `fig:one`; the whole
/// message when the label can't be read, so it still counts once.
fn undefined_reference(message: &str) -> String {
    let label = message
        .split_once("Reference `")
        .or_else(|| message.split_once("Reference '"))
        .and_then(|(_, rest)| rest.split_once('\''))
        .map(|(label, _)| label.to_string());
    label.unwrap_or_else(|| message.to_string())
}

fn is_consequence(issue: &Issue) -> Option<&'static str> {
    if issue.severity != Severity::Warning {
        return None;
    }
    let m = &issue.message;
    // BibTeX's and Biber's own "no entry for key" warnings come from the
    // .blg, which may be left over from an earlier run: they mean the key
    // really is missing from the .bib, whether or not TeX stopped this time.
    if m.starts_with("BibTeX:") || m.starts_with("Biber:") {
        return None;
    }
    if issue.citation.is_some() {
        return Some("citation");
    }
    if (m.contains("Reference `") || m.contains("Reference '")) && m.contains("undefined") {
        return Some("reference");
    }
    let summary = ["There were undefined", "Rerun to get", "Label(s) may have changed", "Please (re)run", "Please rerun", "Empty bibliography"];
    summary.iter().any(|s| m.contains(s)).then_some("summary")
}

/// Puts the error that stopped the run first, with a plain explanation and
/// a fix; flags the undefined citations and references that are only
/// undefined because TeX stopped before BibTeX/Biber or the second pass, and
/// moves them to the end. `manager` is the package manager that can install
/// missing packages (None: nothing to offer, as with Tectonic).
pub fn diagnose(log: &str, issues: &mut Vec<Issue>, manager: Option<crate::texpkg::Manager>) -> Diagnosis {
    let log_says_stopped = log.contains("Fatal error occurred") || log.contains("no output PDF file produced");
    if log_says_stopped && !issues.iter().any(|i| i.fatal) {
        match issues.iter_mut().rev().find(|i| i.severity == Severity::Error) {
            Some(last) => last.fatal = true,
            None => issues.insert(
                0,
                Issue {
                    severity: Severity::Error,
                    message: "TeX stopped with a fatal error, so no PDF was produced.".into(),
                    explanation: Some(STOPPED_EXPLANATION.into()),
                    fatal: true,
                    ..Default::default()
                },
            ),
        }
    }
    let stopped_early = issues.iter().any(|i| i.fatal);
    let (mut citations, mut references) = (0usize, 0usize);
    if stopped_early {
        let mut keys = std::collections::HashSet::new();
        let mut labels = std::collections::HashSet::new();
        for issue in issues.iter_mut() {
            if let Some(kind) = is_consequence(issue) {
                issue.consequence = true;
                match kind {
                    "citation" => {
                        if keys.insert(issue.citation.clone()) {
                            citations += 1;
                        }
                    }
                    // Each undefined label once, however often it is used.
                    "reference" if labels.insert(undefined_reference(&issue.message)) => references += 1,
                    _ => {}
                }
            }
        }
        // The stopping error first when Texo can explain it (the last error
        // is sometimes only a follow-on, like a missing .aux), then the
        // other errors, the rest, and the consequences last.
        let rank = |i: &Issue| match (i.severity, i.fatal, i.consequence) {
            (Severity::Error, true, _) if i.explanation.is_some() => 0,
            (Severity::Error, ..) => 1,
            (_, _, false) => 2,
            _ => 3,
        };
        issues.sort_by_key(rank);
    }

    let mut out = Diagnosis { stopped_early, ..Default::default() };
    let mut offered = std::collections::HashSet::new();
    // The error that matters most: the explained stopping error, else the first error.
    let lead = if stopped_early { issues.iter().find(|i| i.severity == Severity::Error) } else { None };
    if let Some(lead) = lead {
        let at = match (&lead.file, lead.line) {
            (Some(f), Some(n)) => format!(" at {f} line {n}"),
            (Some(f), None) => format!(" in {f}"),
            _ => String::new(),
        };
        let what = lead.explanation.clone().unwrap_or_else(|| "The first error below is usually the cause; fix it and compile again.".into());
        let mut marker = String::new();
        if let Some(m) = manager {
            let package = if lead.message.contains("scalable fonts") {
                needs_cm_super(log).then(|| "cm-super".to_string())
            } else {
                lead.missing_file.as_deref().and_then(|f| crate::texpkg::package_for_file(f, m))
            };
            if let Some(p) = package {
                if let Some(mk) = install_marker(&p) {
                    marker = mk;
                    offered.insert(p);
                }
            }
        }
        out.hints.push(format!("{marker}TeX stopped{at} and no new PDF was made. {what}"));
    }
    // Missing packages besides the stopping error (a bibliography style, say).
    if let Some(m) = manager {
        for issue in issues.iter() {
            let Some(file) = issue.missing_file.as_deref() else { continue };
            let Some(p) = crate::texpkg::package_for_file(file, m) else { continue };
            if offered.contains(&p) || offered.len() >= 3 {
                continue;
            }
            if let Some(mk) = install_marker(&p) {
                out.hints.push(format!("{mk}{file} is part of the \u{201c}{p}\u{201d} package, which isn't installed. Install it and compile again."));
                offered.insert(p);
            }
        }
    }
    if citations + references > 0 {
        let mut parts = Vec::new();
        if citations > 0 {
            parts.push(format!("{citations} {}", if citations == 1 { "citation" } else { "citations" }));
        }
        if references > 0 {
            parts.push(format!("{references} cross-{}", if references == 1 { "reference" } else { "references" }));
        }
        let (this, verb) = if citations + references == 1 { ("", "is") } else { ("These ", "are") };
        out.hints.push(format!(
            "{this}{} {verb} undefined only because the compile stopped early, before the bibliography and cross-references could be built. They're not a problem with your .bib file: fix the error above, compile again, and they should resolve.",
            parts.join(" and ")
        ));
    }
    out.primary = out.hints.len();
    for h in hints(log, issues) {
        // "Compile again" advice doesn't help while TeX stops on an error.
        if stopped_early && h.starts_with("Cross-references may be out of date") {
            continue;
        }
        out.hints.push(h);
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

    // Real pdfLaTeX logs (MiKTeX 26.5, pdfTeX 1.40.29, -file-line-error),
    // from small documents compiled outside the repository.
    const FONT_EXPANSION_LOG: &str = include_str!("texlog_fixtures/font_expansion.txt");

    fn fixture(name: &str) -> &'static str {
        match name {
            "missing_sty" => include_str!("texlog_fixtures/missing_sty.txt"),
            "missing_image" => include_str!("texlog_fixtures/missing_image.txt"),
            "missing_input" => include_str!("texlog_fixtures/missing_input.txt"),
            "unicode" => include_str!("texlog_fixtures/unicode.txt"),
            "undefined_command" => include_str!("texlog_fixtures/undefined_command.txt"),
            "missing_dollar" => include_str!("texlog_fixtures/missing_dollar.txt"),
            "runaway" => include_str!("texlog_fixtures/runaway.txt"),
            "missing_begin_document" => include_str!("texlog_fixtures/missing_begin_document.txt"),
            "extra_brace" => include_str!("texlog_fixtures/extra_brace.txt"),
            "dimension_too_large" => include_str!("texlog_fixtures/dimension_too_large.txt"),
            "latex3" => include_str!("texlog_fixtures/latex3.txt"),
            _ => unreachable!("{name}"),
        }
    }

    /// The E_L2R case: microtype's font expansion stops pdfTeX because the
    /// T1 Computer Modern fonts are only there as bitmaps (cm-super is
    /// missing), and the 23 citations look broken only because BibTeX never
    /// ran. The font error must come first with its fix and an install
    /// button for cm-super; the citations are flagged as a consequence.
    #[test]
    fn font_expansion_fatal_comes_before_the_citations_it_caused() {
        let mut issues = parse_tex_log(FONT_EXPANSION_LOG);
        assert_eq!(issues.iter().filter(|i| i.citation.is_some()).count(), 23);
        let d = diagnose(FONT_EXPANSION_LOG, &mut issues, Some(crate::texpkg::Manager::Miktex));
        assert!(d.stopped_early);

        let first = &issues[0];
        assert_eq!(first.severity, Severity::Error);
        assert!(first.fatal);
        assert!(first.message.contains("auto expansion is only possible with scalable fonts"), "{}", first.message);
        assert_eq!((first.file.as_deref(), first.line), (Some("main.tex"), Some(13)));
        let why = first.explanation.as_deref().unwrap();
        assert!(why.contains("cm-super") && why.contains(r"\usepackage{lmodern}") && why.contains("expansion=false"), "{why}");
        // "Emergency stop"/"Fatal error occurred" aren't listed as errors of their own.
        assert_eq!(issues.iter().filter(|i| i.severity == Severity::Error).count(), 1);

        // Every undefined citation and reference is a consequence, after the error.
        let consequences: Vec<_> = issues.iter().filter(|i| i.consequence).collect();
        assert_eq!(consequences.iter().filter(|i| i.citation.is_some()).count(), 23);
        assert!(consequences.iter().any(|i| i.message.contains("Reference `fig:one'")));
        // TeX stopped on page 1, so it never wrote its "There were undefined references" summary.
        assert_eq!(consequences.len(), 24);
        let first_consequence = issues.iter().position(|i| i.consequence).unwrap();
        assert!(issues[first_consequence..].iter().all(|i| i.consequence), "consequences go last");

        // Hints: the stopping error first, with the install button, then the grouping note.
        assert_eq!(d.primary, 2, "{:?}", d.hints);
        assert!(d.hints[0].starts_with("[fix:install-package:cm-super] TeX stopped at main.tex line 13"), "{}", d.hints[0]);
        assert!(d.hints[1].starts_with("These 23 citations and 1 cross-reference are undefined only because the compile stopped early"), "{}", d.hints[1]);
        assert!(d.hints.iter().all(|h| !h.contains("compiling again usually fixes")));
    }

    #[test]
    fn cm_super_is_offered_only_where_it_helps() {
        // Tectonic (no package manager): explained, but no install button.
        let mut issues = parse_tex_log(FONT_EXPANSION_LOG);
        let d = diagnose(FONT_EXPANSION_LOG, &mut issues, None);
        assert!(!d.hints[0].starts_with("[fix:"));
        assert!(d.hints[0].contains("cm-super"));
        // Latin Modern already is scalable: cm-super wouldn't help.
        let lm = FONT_EXPANSION_LOG.replace("mt-cmr.cfg", "mt-lmr.cfg").replacen("(C:", "(C:/x/lmodern.sty)(C:", 1);
        let mut issues = parse_tex_log(&lm);
        let d = diagnose(&lm, &mut issues, Some(crate::texpkg::Manager::Texlive));
        assert!(!d.hints[0].starts_with("[fix:"), "{}", d.hints[0]);
        // Every LaTeX log names T1/cmr while checking defaults; that alone isn't enough.
        assert!(!needs_cm_super("LaTeX Font Info:    Checking defaults for T1/cmr/m/n on input line 5."));
        assert!(needs_cm_super(FONT_EXPANSION_LOG));
    }

    #[test]
    fn missing_package_stops_the_run_and_offers_an_install() {
        let log = fixture("missing_sty");
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, Some(crate::texpkg::Manager::Miktex));
        assert!(d.stopped_early);
        assert_eq!(issues[0].message, "File `texonosuchpkg.sty' not found.");
        assert!(issues[0].fatal);
        assert_eq!(issues[0].line, Some(3));
        assert!(issues[0].explanation.as_deref().unwrap().contains("isn't installed"));
        assert_eq!(issues.iter().filter(|i| i.severity == Severity::Error).count(), 1, "{issues:?}");
        assert!(d.hints[0].starts_with("[fix:install-package:texonosuchpkg] TeX stopped"), "{}", d.hints[0]);
        // The same package isn't offered twice.
        assert_eq!(d.hints.iter().filter(|h| h.contains("[fix:install-package:")).count(), 1);
    }

    #[test]
    fn missing_project_files_are_not_packages() {
        for (name, needle) in [("missing_image", r"\includegraphics"), ("missing_input", r"\input")] {
            let log = fixture(name);
            let mut issues = parse_tex_log(log);
            let d = diagnose(log, &mut issues, Some(crate::texpkg::Manager::Miktex));
            let why = issues[0].explanation.as_deref().unwrap_or_default();
            assert!(why.contains(needle), "{name}: {why}");
            assert!(d.hints.iter().all(|h| !h.contains("[fix:install-package")), "{name}: {:?}", d.hints);
        }
        // The missing image doesn't stop pdfLaTeX: a PDF is made, nothing is fatal.
        let log = fixture("missing_image");
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, None);
        assert!(!d.stopped_early);
        // The \input one does stop it.
        let log = fixture("missing_input");
        let mut issues = parse_tex_log(log);
        assert!(diagnose(log, &mut issues, None).stopped_early);
        assert_eq!(issues[0].message, "File `chapters/missing.tex' not found.");
    }

    #[test]
    fn explains_common_errors_from_real_logs() {
        let cases = [
            ("undefined_command", "Undefined control sequence.", r"\foobarbaz"),
            ("missing_dollar", "Missing $ inserted.", "dollar signs"),
            ("runaway", r"Paragraph ended before \text@command was complete.", "closing brace } is probably missing"),
            ("missing_begin_document", r"Missing \begin{document}.", r"before \begin{document}"),
            ("extra_brace", "Too many }'s.", "no matching opening {"),
            ("dimension_too_large", "Dimension too large.", "bigger than TeX can handle"),
            ("unicode", "Unicode character 中 (U+4E2D) not set up for use with LaTeX.", r"\DeclareUnicodeCharacter{4E2D}"),
            ("latex3", r"Control sequence \texo_foo: already defined.", "programming layer"),
        ];
        for (name, message, needle) in cases {
            let issues = parse_tex_log(fixture(name));
            let first = issues.iter().find(|i| i.severity == Severity::Error).unwrap_or_else(|| panic!("{name}: no error"));
            assert_eq!(first.message, message, "{name}");
            assert_eq!(first.file.as_deref(), Some("main.tex"), "{name}");
            let why = first.explanation.as_deref().unwrap_or_else(|| panic!("{name}: not explained"));
            assert!(why.contains(needle), "{name}: {why}");
        }
    }

    #[test]
    fn explains_errors_without_a_real_log_at_hand() {
        let log = "(./main.tex\n! LaTeX Error: Too many unprocessed floats.\n\nSee the LaTeX manual.\n\nl.80 \\begin{figure}\n\n)";
        let issues = parse_tex_log(log);
        assert!(issues[0].explanation.as_deref().unwrap().contains(r"\clearpage"));
        let log = "(./main.tex\n! Package inputenc Error: Invalid UTF-8 byte 0xE9.\n\nl.4 caf\n\n)";
        assert!(parse_tex_log(log)[0].explanation.as_deref().unwrap().contains("UTF-8"));
        let log = "(./main.tex\n! LaTeX Error: File `IEEEtran.cls' not found.\n\nl.1 \\documentclass{IEEEtran}\n\n! Emergency stop.\n)";
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, Some(crate::texpkg::Manager::Texlive));
        assert!(issues[0].explanation.as_deref().unwrap().contains("document class"));
        assert!(d.hints[0].starts_with("[fix:install-package:ieeetran] "), "{}", d.hints[0]);
    }

    #[test]
    fn a_stop_without_a_readable_error_still_counts_as_failed() {
        let log = "(./main.tex\nsome text\n)\n==> Fatal error occurred, no output PDF file produced!\n";
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, None);
        assert!(d.stopped_early);
        assert!(issues[0].fatal);
        assert_eq!(issues[0].explanation.as_deref(), Some(STOPPED_EXPLANATION));
        assert!(d.hints[0].contains("no new PDF was made"));
    }

    #[test]
    fn a_complete_run_leaves_undefined_citations_alone() {
        let log = "(./main.tex\nLaTeX Warning: Citation `knuth' on page 1 undefined on input line 4.\n\nLaTeX Warning: There were undefined references.\n)\nOutput written on main.pdf (1 page).";
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, Some(crate::texpkg::Manager::Miktex));
        assert!(!d.stopped_early);
        assert!(issues.iter().all(|i| !i.consequence));
        assert_eq!(d.primary, 0);
        assert!(d.hints.is_empty(), "{:?}", d.hints);
        // A single consequence reads in the singular.
        let log = "(./main.tex\nLaTeX Warning: Citation `knuth' on page 1 undefined on input line 4.\n\n./main.tex:9: Undefined control sequence.\nl.9 \\foo\n\n! Emergency stop.\n)";
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, None);
        assert!(d.hints.iter().any(|h| h.starts_with("1 citation is undefined only because")), "{:?}", d.hints);
        assert_eq!(issues.last().unwrap().citation.as_deref(), Some("knuth"));
    }

    #[test]
    fn bibtex_missing_entries_are_not_blamed_on_the_stop() {
        // A .blg left from an earlier run names a key that really is missing.
        let log = "(./main.tex\n./main.tex:9: Undefined control sequence.\nl.9 \\foo\n\n! Emergency stop.\n)";
        let mut issues = parse_tex_log(log);
        issues.extend(parse_bibtex_log("Warning--I didn't find a database entry for \"smith\"\n"));
        let d = diagnose(log, &mut issues, None);
        assert!(d.stopped_early);
        let smith = issues.iter().find(|i| i.citation.as_deref() == Some("smith")).unwrap();
        assert!(!smith.consequence);
        assert!(d.hints.iter().all(|h| !h.contains("not a problem with your .bib")), "{:?}", d.hints);
    }

    #[test]
    fn a_missing_end_document_is_its_own_stop() {
        // \foo on line 5 doesn't stop nonstop mode; the missing \end does.
        let log = "(./main.tex\n./main.tex:5: Undefined control sequence.\nl.5 \\foo\n\n[1{pdftex.map}]\n\
                   LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 7.\n\n\
                   ! Emergency stop.\n<*> main.tex\n\n*** (job aborted, no legal \\end found)\n\n)\n";
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, None);
        assert!(d.stopped_early);
        let foo = issues.iter().find(|i| i.message == "Undefined control sequence.").unwrap();
        assert!(!foo.fatal, "{issues:?}");
        assert!(issues[0].fatal);
        assert!(issues[0].message.contains(r"\end{document}"), "{}", issues[0].message);
        assert!(d.hints[0].contains(r"Add \end{document}"), "{}", d.hints[0]);

        // Even with nothing in between, the missing \end is still the cause.
        let log = "(./main.tex\n./main.tex:5: Undefined control sequence.\nl.5 \\foo\n\n! Emergency stop.\n<*> main.tex\n\n*** (job aborted, no legal \\end found)\n)";
        let issues = parse_tex_log(log);
        assert_eq!(issues.iter().filter(|i| i.fatal).count(), 1);
        assert!(issues.iter().find(|i| i.fatal).unwrap().message.contains(r"\end{document}"));

        // A stop with no stated cause after pages and warnings isn't pinned on line 5.
        let log = "(./main.tex\n./main.tex:5: Undefined control sequence.\nl.5 \\foo\n\n[1] [2]\n! Emergency stop.\n)";
        let mut issues = parse_tex_log(log);
        diagnose(log, &mut issues, None);
        let foo = issues.iter().find(|i| i.message == "Undefined control sequence.").unwrap();
        assert!(!foo.fatal);
        assert_eq!(issues.iter().find(|i| i.fatal).unwrap().explanation.as_deref(), Some(STOPPED_EXPLANATION));
    }

    #[test]
    fn a_missing_file_prompt_still_blames_the_missing_file() {
        for name in ["missing_sty", "missing_input"] {
            let issues = parse_tex_log(fixture(name));
            let fatal: Vec<_> = issues.iter().filter(|i| i.fatal).collect();
            assert_eq!(fatal.len(), 1, "{name}: {issues:?}");
            assert!(fatal[0].message.contains("not found"), "{name}: {}", fatal[0].message);
        }
    }

    #[test]
    fn each_undefined_label_is_counted_once() {
        let log = "(./main.tex\n\
                   LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 3.\n\n\
                   LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 4.\n\n\
                   LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 5.\n\n\
                   LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 6.\n\n\
                   ./main.tex:9: Undefined control sequence.\nl.9 \\foo\n\n! Emergency stop.\n)";
        let mut issues = parse_tex_log(log);
        let d = diagnose(log, &mut issues, None);
        assert!(d.hints.iter().any(|h| h.starts_with("1 cross-reference is undefined only because")), "{:?}", d.hints);
        assert_eq!(undefined_reference("Reference 'sec:a' on page 2 undefined"), "sec:a");
    }

    #[test]
    fn install_markers_only_carry_valid_names() {
        assert_eq!(install_marker("cm-super").as_deref(), Some("[fix:install-package:cm-super] "));
        assert_eq!(install_marker("a b"), None);
        assert_eq!(install_marker("--x"), None);
    }

    #[test]
    fn gives_hints_for_common_failures() {
        let log = "! Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.";
        assert!(hints(log, &[])[0].contains("XeLaTeX"));
        assert!(hints("clean log", &[]).is_empty());
    }
}
