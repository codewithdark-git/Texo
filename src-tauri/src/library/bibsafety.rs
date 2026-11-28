//! "Add to bibliography" saves BibTeX from doi.org or arXiv into the
//! project's `.bib` without a review step, so the entry must not carry TeX
//! that could run programs when the project compiles.
//!
//! A denylist of dangerous spellings can be dodged (`\let\w=\write` and
//! then `\w18`, `^^` character codes, …), so this is an allowlist: every
//! control word in the entry must be one that formatting, accents or math
//! in an honest bibliography entry uses. Control symbols (`\'`, `\&`, `\\`)
//! are always fine. With `\catcode`, `\def` and `\let` refused, TeX reads
//! the entry with normal catcodes, which is what this scan assumes.

/// Control words an entry from an online source may use.
const SAFE: &[&str] = &[
    // accents and special letters
    "u", "v", "H", "c", "d", "b", "t", "r", "k", "i", "j", "o", "O", "l", "L", "aa", "AA", "ae", "AE", "oe", "OE", "ss",
    "SS", "dh", "DH", "th", "TH", "ng", "NG", "dj", "DJ",
    // text formatting
    "textit", "textbf", "emph", "textsc", "textrm", "textsf", "texttt", "textsl", "textup", "textnormal", "textmd",
    "textsuperscript", "textsubscript", "mbox", "hbox", "url", "doi", "nolinkurl", "href", "rm", "it", "bf", "em", "sc",
    "sf", "tt", "sl", "up", "small", "relax", "space", "nobreakspace", "quad", "qquad", "enspace", "thinspace",
    "ensuremath", "text",
    // text symbols
    "textendash", "textemdash", "textquotesingle", "textquotedbl", "textasciitilde", "textasciicircum",
    "textbackslash", "textbar", "textless", "textgreater", "textregistered", "texttrademark", "textcopyright",
    "textdegree", "textmu", "textperiodcentered", "textunderscore", "textellipsis", "textquoteleft",
    "textquoteright", "textquotedblleft", "textquotedblright", "guillemotleft", "guillemotright", "dots", "ldots",
    "cdots", "vdots", "S", "P", "dag", "ddag", "pounds", "euro", "copyright", "textdagger", "textbullet",
    // math alphabets
    "mathrm", "mathit", "mathbf", "mathcal", "mathsf", "mathtt", "mathbb", "mathfrak", "mathscr", "boldsymbol", "bm",
    "operatorname",
    // greek
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa",
    "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi",
    "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
    // math symbols
    "times", "cdot", "pm", "mp", "le", "leq", "ge", "geq", "ll", "gg", "ne", "neq", "approx", "sim", "simeq", "equiv",
    "propto", "infty", "partial", "nabla", "to", "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow",
    "Leftarrow", "Leftrightarrow", "mapsto", "in", "notin", "subset", "subseteq", "supset", "supseteq", "cup", "cap",
    "setminus", "emptyset", "forall", "exists", "neg", "wedge", "vee", "oplus", "otimes", "sum", "prod", "int",
    "oint", "sqrt", "frac", "dfrac", "tfrac", "binom", "log", "ln", "exp", "sin", "cos", "tan", "min", "max", "lim",
    "sup", "inf", "det", "ell", "hbar", "circ", "star", "ast", "bullet", "prime", "langle", "rangle", "left", "right",
    "big", "Big", "bigg", "Bigg", "vert", "lvert", "rvert", "mid", "dagger", "sharp", "flat", "natural", "hat",
    "tilde", "bar", "vec", "dot", "ddot", "overline", "underline", "widehat", "widetilde", "mathring", "colon",
];

/// The first control word in `bibtex` that isn't on the allowlist, as
/// written (with its backslash), or a `^^` / `@preamble` the scan refuses.
pub fn unsafe_construct(bibtex: &str) -> Option<String> {
    if bibtex.contains("^^") {
        return Some("^^".into());
    }
    if let Some(what) = structure_problem(bibtex) {
        return Some(what);
    }
    let chars: Vec<char> = bibtex.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\\' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while end < chars.len() && chars[end].is_ascii_alphabetic() {
            end += 1;
        }
        if end == start {
            // A control symbol such as \' or \\: its character is consumed with it.
            i = start + 1;
            continue;
        }
        let word: String = chars[start..end].iter().collect();
        if !SAFE.contains(&word.as_str()) {
            return Some(format!("\\{word}"));
        }
        i = end;
    }
    None
}

/// BibTeX joins values before TeX reads them (`"\" # "write18"` becomes
/// `\write18`), so the scan below only sees what TeX will see when the
/// entry has no `@string`, `@preamble` or `#`, uses `{…}` delimiters, and
/// no field value ends in an unpaired backslash. Anything else is refused.
fn structure_problem(bibtex: &str) -> Option<String> {
    let lower = bibtex.to_ascii_lowercase();
    for (i, _) in lower.match_indices('@') {
        let rest = lower[i + 1..].trim_start();
        let word: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        if word == "string" || word == "preamble" {
            return Some(format!("@{word}"));
        }
        if !word.is_empty() && rest[word.len()..].trim_start().starts_with('(') {
            return Some("an entry in ( ) instead of { }".into());
        }
    }
    let chars: Vec<char> = bibtex.chars().collect();
    let ends_badly = |v: &[char]| v.iter().rev().take_while(|c| **c == '\\').count() % 2 == 1;
    // Exactly one `@type{…}` entry with only whitespace around it, so the
    // depth counted here is the depth BibTeX sees (text outside an entry is
    // ignored by BibTeX and could otherwise shift the count).
    let outside = || Some("text outside the entry".to_string());
    let header_end = chars.iter().position(|&c| c == '{');
    let header: String = chars[..header_end.unwrap_or(chars.len())].iter().collect();
    let header = header.trim();
    if header_end.is_none()
        || !header.starts_with('@')
        || header.len() < 2
        || !header[1..].trim_start().chars().all(|c| c.is_ascii_alphabetic())
    {
        return outside();
    }
    let (mut depth, mut quoted, mut start, mut closed) = (0usize, false, 0usize, false);
    for (i, &c) in chars.iter().enumerate() {
        if closed {
            if !c.is_whitespace() {
                return outside();
            }
            continue;
        }
        match c {
            '{' => {
                depth += 1;
                if depth == 2 && !quoted {
                    start = i + 1;
                }
            }
            '}' => {
                if depth == 2 && !quoted && ends_badly(&chars[start..i]) {
                    return Some("a backslash at the end of a field".into());
                }
                if depth == 0 {
                    return outside();
                }
                depth -= 1;
                closed = depth == 0 && !quoted;
            }
            '"' if depth == 1 => {
                if quoted && ends_badly(&chars[start..i]) {
                    return Some("a backslash at the end of a field".into());
                }
                quoted = !quoted;
                start = i + 1;
            }
            '#' if depth == 1 && !quoted => return Some("# (joining values)".into()),
            _ => {}
        }
    }
    if !closed {
        return Some("an entry that isn't closed".into());
    }
    None
}

/// The refusal shown to the user, or `None` when the entry is fine.
pub fn refusal(bibtex: &str) -> Option<String> {
    unsafe_construct(bibtex).map(|what| {
        format!(
            "This paper's BibTeX from the online source uses {what}, which isn't plain formatting and could run code when the project compiles, so Texo didn't add it."
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str) -> String {
        format!("@article{{smith2020,\n  title={{{title}}},\n  author={{Smith, Jo and M{{\\\"u}}ller, A}}\n}}")
    }

    #[test]
    fn ordinary_entries_accents_and_math_pass() {
        for t in [
            r"On the {\'e}tude of $x^2$ and \textit{Na}\textsubscript{2}",
            r"A \emph{write} up of 18 inputs | outputs \& more",
            r"$\alpha$-helices in $\mathbb{R}^n$, $\sqrt{2}\times 10^{-3}$",
            r"Line\\break and {\o}re {\ss} \url{https://x.org/a_b}",
        ] {
            assert_eq!(unsafe_construct(&entry(t)), None, "{t}");
        }
    }

    #[test]
    fn commands_that_run_programs_are_refused() {
        assert_eq!(unsafe_construct(&entry(r"\immediate\write18{rm -rf ~}")).as_deref(), Some(r"\immediate"));
        assert_eq!(unsafe_construct(&entry(r"\write18{x}")).as_deref(), Some(r"\write"));
        assert_eq!(unsafe_construct(&entry(r"\directlua{os.execute('x')}")).as_deref(), Some(r"\directlua"));
        assert_eq!(unsafe_construct(&entry(r"\input{|curl x}")).as_deref(), Some(r"\input"));
        assert_eq!(unsafe_construct(&entry(r"\openout3=latexmkrc")).as_deref(), Some(r"\openout"));
    }

    #[test]
    fn aliases_and_hidden_commands_are_refused() {
        assert_eq!(unsafe_construct(&entry(r"\let\w=\write \w18{x}")).as_deref(), Some(r"\let"));
        assert_eq!(unsafe_construct(&entry(r"\def\x{\write}")).as_deref(), Some(r"\def"));
        assert_eq!(unsafe_construct(&entry(r"\csname directlua\endcsname{x}")).as_deref(), Some(r"\csname"));
        assert_eq!(unsafe_construct(&entry(r"\expandafter\x")).as_deref(), Some(r"\expandafter"));
        assert_eq!(unsafe_construct(&entry(r"\catcode`\|=0")).as_deref(), Some(r"\catcode"));
        assert_eq!(unsafe_construct(&entry("^^5cdirectlua{x}")).as_deref(), Some("^^"));
        assert_eq!(unsafe_construct(&entry("^^Z")).as_deref(), Some("^^"));
        assert_eq!(unsafe_construct("@PREAMBLE{\"x\"}").as_deref(), Some("@preamble"));
        assert_eq!(unsafe_construct("@ preamble{\"x\"}").as_deref(), Some("@preamble"));
    }

    #[test]
    fn values_bibtex_joins_are_refused() {
        let joined = r#"@article{k, title = "\" # "write18{x}"}"#;
        assert_eq!(unsafe_construct(joined).as_deref(), Some("a backslash at the end of a field"));
        let hash = r#"@article{k, title = "a" # "b"}"#;
        assert_eq!(unsafe_construct(hash).as_deref(), Some("# (joining values)"));
        let macro_ = "@string{w = \"write\"}\n@article{k, title = {x}}";
        assert_eq!(unsafe_construct(macro_).as_deref(), Some("@string"));
        assert_eq!(unsafe_construct(r"@article{k, title = {a\}}").as_deref(), Some("a backslash at the end of a field"));
        assert_eq!(unsafe_construct("@article(k, title = {a})").as_deref(), Some("an entry in ( ) instead of { }"));
        // Text outside the one entry would shift the brace count, so it is refused.
        let shifted = r#"{{ @article{k, title = "\" # "write18{x}"}"#;
        assert_eq!(unsafe_construct(shifted).as_deref(), Some("text outside the entry"));
        assert_eq!(unsafe_construct("@misc{a, title = {x}}\n@misc{b, title = {y}}").as_deref(), Some("text outside the entry"));
        assert_eq!(unsafe_construct("@misc{a, title = {x}").as_deref(), Some("an entry that isn't closed"));
        assert_eq!(unsafe_construct("@misc{a, title = {x}}}").as_deref(), Some("text outside the entry"));
        assert_eq!(unsafe_construct("  @ARTICLE{a, title = {x}}\n"), None);
        // A # or quote inside a braced value, and a doubled backslash, are fine.
        assert_eq!(unsafe_construct(r#"@misc{k, url = {https://x.org/a#b}, note = {say "hi" \\}}"#), None);
        assert_eq!(unsafe_construct(r#"@misc{k, title = "M{\"u}ller"}"#), None);
        // A control symbol doesn't hide the word after it.
        assert_eq!(unsafe_construct(&entry(r"\'\write18")).as_deref(), Some(r"\write"));
    }

    #[test]
    fn entries_the_app_formats_pass_and_hostile_values_still_fail() {
        use crate::agents::tools::bibtex;
        let fetched = "@article{Smith_2020, title={On {\\'e}tude: $\\alpha$ \\& more}, author={M{\\\"u}ller, A. and Smith, J.}, journal={J. X}, year={2020}, doi={10.1/x#y}, url={https://x.org/a?b=1#c}}";
        let rec = bibtex::parse_entries(fetched).into_iter().next().unwrap();
        let out = bibtex::format(&rec);
        assert_eq!(unsafe_construct(&out), None, "{out}");
        let hostile = "@article{k, title = {x}, note = {\\immediate\\write18{calc}}}";
        let out = bibtex::format(&bibtex::parse_entries(hostile).into_iter().next().unwrap());
        assert_eq!(unsafe_construct(&out).as_deref(), Some("\\immediate"), "{out}");
    }

    #[test]
    fn the_refusal_is_plain() {
        assert_eq!(
            refusal(&entry(r"\directlua{x}")).unwrap(),
            r"This paper's BibTeX from the online source uses \directlua, which isn't plain formatting and could run code when the project compiles, so Texo didn't add it."
        );
        assert_eq!(refusal(&entry("Plain title")), None);
    }
}
