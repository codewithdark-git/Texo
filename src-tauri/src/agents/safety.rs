//! What agents may change, for every kind.
//!
//! - [`may_change`]: the files an agent may write, edit or delete at all.
//!   Like `ai/validate.rs` for "Explain & fix", it is an allow-list of TeX,
//!   bibliography and plain text/data extensions. Build configuration that
//!   runs code (`latexmkrc`, `.latexmkrc`, `Tectonic.toml`, `texmf.cnf`) and
//!   scripts or programs are refused, so a prompt injection (a fetched page,
//!   a paper's abstract) can't plant code that the next compile runs.
//! - [`check`]: flags a changeset for the user's attention when it adds
//!   shell-escape constructs (`\write18`, `\ShellEscape`, `\input{|…}`,
//!   `\directlua`, …) or touches a file outside the allow-list. A flagged
//!   changeset is never applied automatically.

use std::sync::OnceLock;

use regex::Regex;

use super::kinds::cheat::strip_comments;
use super::types::ChangeEntry;

/// Extensions an agent may create, change or delete (lower case).
const EDITABLE: &[&str] = &[
    "tex", "ltx", "sty", "cls", "bib", "bbx", "cbx", "lbx", "dbx", "bst", "cfg", "def", "clo", "fd", "dtx", "ins", "tikz",
    "pgf", "txt", "md", "csv", "tsv", "dat",
];

/// File names that are build configuration (code that runs on compile),
/// whatever their extension.
const BUILD_CONFIG: &[&str] = &["latexmkrc", ".latexmkrc", "tectonic.toml", "texmf.cnf", "makefile", "arara.yaml", ".arararc.yaml"];

/// `Err(plain words)` when an agent must not write, edit or delete `rel`
/// (a clean `/`-separated project path).
pub fn may_change(rel: &str) -> Result<(), String> {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    if BUILD_CONFIG.contains(&name.as_str()) || name.ends_with("latexmkrc") {
        return Err(format!(
            "{rel} is build configuration that runs as a program when the project compiles, so AI agents may not change it. \
             If it needs a change, tell the user what to change."
        ));
    }
    let ok = name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && EDITABLE.contains(&ext));
    if !ok {
        return Err(format!(
            "AI agents may only change LaTeX, bibliography and plain text files (.tex, .bib, .sty, .md, .txt, .csv, …), not {rel}."
        ));
    }
    Ok(())
}

/// (pattern, plain-words reason) for constructs that run programs.
fn shell_patterns() -> &'static [(Regex, &'static str)] {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        let r = |p: &str| Regex::new(p).expect("valid regex");
        vec![
            (r(r"\\write\s*18\b"), "Adds \\write18, which runs a program on your computer when the project compiles."),
            (
                r(r"\\write\s*\\(?:count|numexpr|number|the|value)\b"),
                "Adds a \\write to a computed stream number, a way to hide \\write18 (which runs programs).",
            ),
            (r(r"\\ShellEscape\b|\\shellescape\b|\\pdfshellescape\b"), "Adds \\ShellEscape, which runs a program on your computer when the project compiles."),
            (r(r#"\\(?:input|include|openin|InputIfFileExists)\s*\{?\s*"?\|"#), "Adds an \\input{|…} pipe, which runs a program on your computer when the project compiles."),
            (
                r(r#"\\(?:immediate\s*)?\\?openout\s*[0-9\\]*\s*=?\s*\{?\s*"?(?:/|~|[A-Za-z]:[\\/]|\.\./)"#),
                "Writes a file outside the project (\\openout), which can change files on your computer.",
            ),
            (
                r(r"\\(?:directlua|luaexec|latelua|luadirect)\b"),
                "Adds Lua code (\\directlua), which can run programs on your computer when the project compiles.",
            ),
            (r(r"\\catcode\s*`?\\?\|"), "Changes how TeX reads |, a common way to hide shell commands."),
        ]
    })
}

/// The reasons the added text could run programs (comments ignored; only
/// constructs that weren't in `base` count).
pub fn shell_reasons(base: Option<&str>, new: Option<&str>) -> Vec<String> {
    let (b, n) = (strip_comments(base.unwrap_or("")), strip_comments(new.unwrap_or("")));
    shell_patterns()
        .iter()
        .filter(|(re, _)| re.find_iter(&n).count() > re.find_iter(&b).count())
        .map(|(_, why)| (*why).to_string())
        .collect()
}

/// Flags changes that need the user's eye before they are saved, for every
/// kind (sets `attention`; existing reasons are kept).
pub fn check(changes: &mut [ChangeEntry]) {
    for c in changes.iter_mut() {
        let mut reasons = Vec::new();
        if let Err(why) = may_change(&c.file) {
            reasons.push(why);
        }
        reasons.extend(shell_reasons(c.base_text.as_deref(), c.new_text.as_deref()));
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

    #[test]
    fn build_config_and_scripts_are_refused() {
        for bad in [
            "latexmkrc",
            ".latexmkrc",
            "sub/LatexMkRc",
            "Tectonic.toml",
            "texmf.cnf",
            "Makefile",
            "run.bat",
            "x.cmd",
            "x.ps1",
            "x.pl",
            "x.exe",
            "x.sh",
            "x.py",
            "x.lua",
            "noext",
            ".tex",
        ] {
            assert!(may_change(bad).is_err(), "{bad}");
        }
        assert!(may_change("latexmkrc").unwrap_err().contains("build configuration"));
        for ok in ["main.tex", "sections/intro.TEX", "refs.bib", "notes.md", "data/plot.csv", "mystyle.sty", "response-to-reviewers.tex"] {
            assert!(may_change(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn added_shell_escape_is_flagged() {
        let base = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n";
        for (add, word) in [
            ("\\immediate\\write18{curl evil}", "\\write18"),
            ("\\write 18{rm -rf}", "\\write18"),
            ("\\ShellEscape{calc}", "ShellEscape"),
            ("\\input{|\"powershell -c x\"}", "pipe"),
            ("\\input|\"ls\"", "pipe"),
            ("\\immediate\\openout5=/home/u/.bashrc", "outside the project"),
            ("\\directlua{os.execute('x')}", "Lua"),
        ] {
            let new = base.replace("Hi", &format!("Hi\n{add}"));
            let r = shell_reasons(Some(base), Some(&new));
            assert!(r.iter().any(|x| x.contains(word)), "{add}: {r:?}");
        }
        // Already there, or only in a comment: not new.
        let with = base.replace("Hi", "\\immediate\\write18{make}");
        assert!(shell_reasons(Some(&with), Some(&with.replace("\\end{document}", "Bye\n\\end{document}"))).is_empty());
        assert!(shell_reasons(Some(base), Some(&base.replace("Hi", "Hi % \\write18{x}"))).is_empty());
        // Ordinary writing and \input of a file: fine.
        assert!(shell_reasons(Some(base), Some(&base.replace("Hi", "\\input{sections/a}\nA | B"))).is_empty());
        assert!(shell_reasons(Some(base), Some(&base.replace("Hi", "\\newwrite\\f\\immediate\\openout\\f=\\jobname.out"))).is_empty());
    }

    #[test]
    fn check_flags_every_kind_of_change() {
        let mut c = vec![
            ChangeEntry { file: "latexmkrc".into(), base_text: None, new_text: Some("system('x');".into()), ..Default::default() },
            ChangeEntry { file: "main.tex".into(), base_text: Some("a\n".into()), new_text: Some("a\n\\write18{x}\n".into()), ..Default::default() },
            ChangeEntry { file: "intro.tex".into(), base_text: Some("a\n".into()), new_text: Some("b\n".into()), ..Default::default() },
        ];
        check(&mut c);
        assert!(!c[0].attention.is_empty() && !c[1].attention.is_empty());
        assert!(c[2].attention.is_empty());
        let before = c[1].attention.clone();
        check(&mut c);
        assert_eq!(c[1].attention, before, "no duplicates");
    }
}
