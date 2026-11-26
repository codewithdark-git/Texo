//! A small, forgiving BibTeX reader and writer for the literature tools:
//! parse entries, give them a stable key (`authorYEARfirstword`, e.g.
//! `vaswani2017attention`), check them, and print them in one tidy style.


use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibField {
    /// Lower case.
    pub name: String,
    /// As written, with its delimiters (`{...}`, `"..."`, or bare).
    pub raw: String,
}

impl BibField {
    /// The value without its outer braces or quotes.
    pub fn text(&self) -> &str {
        let r = self.raw.trim();
        if (r.starts_with('{') && r.ends_with('}') && outer_group(r)) || (r.starts_with('"') && r.ends_with('"') && r.len() >= 2) {
            &r[1..r.len() - 1]
        } else {
            r
        }
    }
}

/// Whether the first `{` of `r` closes at its last character.
fn outer_group(r: &str) -> bool {
    let mut depth = 0i32;
    for (i, c) in r.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return i == r.len() - 1;
                }
            }
            _ => {}
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibRecord {
    /// Lower case (`article`, `inproceedings`, ...).
    pub entry_type: String,
    pub key: String,
    pub fields: Vec<BibField>,
    /// Line (1-based) where the entry starts in the text it came from.
    pub line: usize,
}

impl BibRecord {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.fields.iter().find(|f| f.name == name).map(BibField::text).filter(|t| !t.trim().is_empty())
    }

    pub fn set(&mut self, name: &str, raw: String) {
        match self.fields.iter_mut().find(|f| f.name == name) {
            Some(f) => f.raw = raw,
            None => self.fields.push(BibField { name: name.to_string(), raw }),
        }
    }

    /// The DOI, without any `https://doi.org/` prefix.
    pub fn doi(&self) -> Option<String> {
        self.get("doi").map(clean_doi).filter(|d| d.starts_with("10."))
    }

    /// The arXiv id, from `eprint` (with an arXiv archive prefix), `url`, or
    /// `journal = {arXiv preprint arXiv:...}`.
    pub fn arxiv_id(&self) -> Option<String> {
        let archive = self.get("archiveprefix").or(self.get("eprinttype")).unwrap_or_default().to_ascii_lowercase();
        if let Some(e) = self.get("eprint") {
            if archive.is_empty() || archive == "arxiv" {
                if let Some(id) = parse_arxiv_id(e) {
                    return Some(id);
                }
            }
        }
        for f in ["url", "journal", "note", "howpublished"] {
            if let Some(v) = self.get(f) {
                let lower = v.to_ascii_lowercase();
                if let Some(pos) = lower.find("arxiv.org/abs/").map(|p| p + 14).or_else(|| lower.find("arxiv:").map(|p| p + 6)) {
                    if let Some(id) = parse_arxiv_id(v[pos..].split(|c: char| c.is_whitespace() || c == '}').next().unwrap_or_default()) {
                        return Some(id);
                    }
                }
            }
        }
        if let Some(d) = self.doi() {
            return arxiv_from_doi(&d);
        }
        None
    }

    /// Four-digit year, from `year` or `date`.
    pub fn year(&self) -> Option<i32> {
        let y = self.get("year").or(self.get("date"))?;
        let digits: String = y.chars().skip_while(|c| !c.is_ascii_digit()).take(4).collect();
        (digits.len() == 4).then(|| digits.parse().ok()).flatten()
    }

    /// Family names of the authors (or editors), in order.
    pub fn surnames(&self) -> Vec<String> {
        let names = self.get("author").or(self.get("editor")).unwrap_or_default();
        split_names(names).iter().map(|n| surname(n)).filter(|s| !s.is_empty()).collect()
    }
}

/// `https://doi.org/10.1/x` or `doi:10.1/x` → `10.1/x`.
pub fn clean_doi(d: &str) -> String {
    let d = d.trim().trim_matches(|c| c == '{' || c == '}');
    let lower = d.to_ascii_lowercase();
    for p in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi.org/", "doi:"] {
        if lower.starts_with(p) {
            return d[p.len()..].trim().to_string();
        }
    }
    d.to_string()
}

/// arXiv's own DOIs (`10.48550/arXiv.1706.03762`).
pub fn arxiv_from_doi(doi: &str) -> Option<String> {
    let lower = doi.to_ascii_lowercase();
    lower.strip_prefix("10.48550/arxiv.").and_then(parse_arxiv_id)
}

/// A bare arXiv id, without version: `1706.03762`, `2101.00001`,
/// `hep-th/9901001`, `math.GT/0309136`.
pub fn parse_arxiv_id(s: &str) -> Option<String> {
    let s = s.trim().trim_matches(|c| c == '{' || c == '}');
    let lower = s.to_ascii_lowercase();
    let s = if lower.starts_with("arxiv:") { &s[6..] } else { s };
    let s = s.trim().trim_end_matches(['.', ',', ')']);
    let base = match s.rfind('v') {
        Some(i) if i > 0 && s[i + 1..].chars().all(|c| c.is_ascii_digit()) && !s[i + 1..].is_empty() && s[..i].ends_with(|c: char| c.is_ascii_digit()) => &s[..i],
        _ => s,
    };
    let new_style = {
        let mut parts = base.split('.');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(b), None) => a.len() == 4 && a.chars().all(|c| c.is_ascii_digit()) && (4..=5).contains(&b.len()) && b.chars().all(|c| c.is_ascii_digit()),
            _ => false,
        }
    };
    let old_style = match base.split_once('/') {
        Some((arch, num)) => {
            arch.starts_with(|c: char| c.is_ascii_alphabetic())
                && arch.chars().all(|c| c.is_ascii_alphabetic() || c == '-' || c == '.')
                && num.len() == 7
                && num.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    };
    (new_style || old_style).then(|| base.to_string())
}

/// Reads every entry of a `.bib` text. `@comment`, `@string` and
/// `@preamble` are skipped; broken entries are skipped too.
pub fn parse_entries(text: &str) -> Vec<BibRecord> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(at) = text[i..].find('@').map(|p| p + i) {
        i = at + 1;
        let ty_end = text[i..].find(|c: char| !c.is_ascii_alphanumeric()).map(|p| p + i).unwrap_or(text.len());
        let entry_type = text[i..ty_end].to_ascii_lowercase();
        let mut j = ty_end;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if entry_type.is_empty() || j >= bytes.len() || !(bytes[j] == b'{' || bytes[j] == b'(') {
            continue;
        }
        let close = if bytes[j] == b'{' { b'}' } else { b')' };
        if matches!(entry_type.as_str(), "comment" | "string" | "preamble") {
            continue;
        }
        let body_start = j + 1;
        let Some(body_end) = matching(bytes, j, bytes[j], close) else { continue };
        let line = text[..at].matches('\n').count() + 1;
        if let Some(rec) = parse_body(&entry_type, &text[body_start..body_end], line) {
            out.push(rec);
        }
        i = body_end + 1;
    }
    out
}

/// Index of the delimiter closing the one at `open_at`, minding braces and
/// quoted values.
fn matching(b: &[u8], open_at: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = open_at;
    while i < b.len() {
        let c = b[i];
        if c == b'\\' {
            i += 2;
            continue;
        }
        if open == b'{' {
            if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
        } else if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
        } else if c == close && depth == 0 {
            return Some(i);
        } else if c == open && i == open_at {
            // the opening paren
        }
        i += 1;
    }
    None
}

fn parse_body(entry_type: &str, body: &str, line: usize) -> Option<BibRecord> {
    let (key, rest) = match body.find(',') {
        Some(p) => (body[..p].trim(), &body[p + 1..]),
        None => (body.trim(), ""),
    };
    if key.is_empty() || key.contains(char::is_whitespace) || key.contains('=') {
        return None;
    }
    let mut fields = Vec::new();
    let b = rest.as_bytes();
    let mut i = 0;
    loop {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b',') {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let ns = i;
        while i < b.len() && b[i] != b'=' && b[i] != b',' {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            break;
        }
        let name = rest[ns..i].trim().to_ascii_lowercase();
        i += 1;
        // Value: pieces joined by '#', each {..}, ".." or bare.
        let vs = i;
        let mut depth = 0i32;
        let mut in_quote = false;
        while i < b.len() {
            let c = b[i];
            match c {
                b'\\' => {
                    i += 2;
                    continue;
                }
                b'{' => depth += 1,
                b'}' => depth -= 1,
                b'"' if depth == 0 => in_quote = !in_quote,
                b',' if depth == 0 && !in_quote => break,
                _ => {}
            }
            i += 1;
        }
        let raw = rest[vs..i.min(rest.len())].trim().to_string();
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_:.+".contains(c)) {
            fields.push(BibField { name, raw });
        }
    }
    Some(BibRecord { entry_type: entry_type.to_string(), key: key.to_string(), fields, line })
}

/// The entry with this key (keys compare case-insensitively, like BibTeX).
pub fn find_entry(text: &str, key: &str) -> Option<BibRecord> {
    parse_entries(text).into_iter().find(|r| r.key.eq_ignore_ascii_case(key.trim()))
}

/// Splits an author list on top-level " and ".
pub fn split_names(names: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut cur = String::new();
    let chars: Vec<char> = names.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
        }
        if depth == 0 && c.is_whitespace() && i + 4 < chars.len() {
            let word: String = chars[i + 1..i + 4].iter().collect::<String>().to_ascii_lowercase();
            if word == "and" && chars[i + 4].is_whitespace() {
                out.push(cur.trim().to_string());
                cur.clear();
                i += 4;
                continue;
            }
        }
        cur.push(c);
        i += 1;
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out.retain(|n| !n.is_empty());
    out
}

/// The family name of "Last, First" or "First von Last".
fn surname(name: &str) -> String {
    let name = name.trim();
    if let Some(i) = top_level_comma(name) {
        return plain(&name[..i]);
    }
    // A braced whole name ({World Health Organization}) is kept whole.
    if name.starts_with('{') && name.ends_with('}') && outer_group(name) {
        return plain(name);
    }
    name.split_whitespace().last().map(plain).unwrap_or_default()
}

fn top_level_comma(s: &str) -> Option<usize> {
    let mut depth = 0;
    for (i, c) in s.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

/// LaTeX text to plain words: drops braces and accent commands, folds
/// accented letters to ASCII where a key needs it.
pub fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' | '}' | '$' | '~' => {
                if c == '~' {
                    out.push(' ');
                }
            }
            '\\' => {
                // \"o, \'e, \ss, \o, \aa, \l, \emph{...}
                let mut cmd = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphabetic() {
                        cmd.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if cmd.is_empty() {
                    // Accent symbol (\" \' \` \^ \~ \=) or escaped char.
                    if let Some(n) = chars.next() {
                        if !"\"'`^~=.".contains(n) {
                            out.push(n);
                        }
                    }
                } else {
                    match cmd.as_str() {
                        "ss" => out.push_str("ss"),
                        "o" | "O" => out.push('o'),
                        "aa" | "AA" => out.push('a'),
                        "ae" | "AE" => out.push_str("ae"),
                        "oe" | "OE" => out.push_str("oe"),
                        "l" | "L" => out.push('l'),
                        "i" => out.push('i'),
                        "j" => out.push('j'),
                        // \c{c}, \v{s}, \u{a}, \H{o}, \k{a}, \r{a}, \d{x}, \b{x}
                        "c" | "v" | "u" | "H" | "k" | "r" | "d" | "b" | "t" => {}
                        _ => out.push(' '),
                    }
                }
            }
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn fold_ascii(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        let mapped = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' => "a",
            'ç' | 'ć' | 'č' | 'Ç' | 'Ć' | 'Č' => "c",
            'ď' | 'đ' | 'Ď' | 'Đ' => "d",
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' | 'È' | 'É' | 'Ê' | 'Ë' => "e",
            'ì' | 'í' | 'î' | 'ï' | 'ı' | 'Ì' | 'Í' | 'Î' | 'Ï' => "i",
            'ł' | 'Ł' | 'ľ' | 'ĺ' => "l",
            'ñ' | 'ń' | 'ň' | 'Ñ' | 'Ń' => "n",
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ő' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ő' => "o",
            'ř' | 'Ř' => "r",
            'ś' | 'š' | 'ş' | 'Ś' | 'Š' | 'Ş' => "s",
            'ß' => "ss",
            'ť' | 'ţ' | 'Ť' => "t",
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'Ù' | 'Ú' | 'Û' | 'Ü' => "u",
            'ý' | 'ÿ' | 'Ý' => "y",
            'ź' | 'ż' | 'ž' | 'Ź' | 'Ż' | 'Ž' => "z",
            'æ' | 'Æ' => "ae",
            'œ' | 'Œ' => "oe",
            'þ' | 'Þ' => "th",
            c if c.is_ascii_alphanumeric() => {
                out.push(c.to_ascii_lowercase());
                continue;
            }
            _ => "",
        };
        out.push_str(mapped);
    }
    out
}

const STOPWORDS: &[&str] = &[
    "a", "an", "the", "on", "of", "in", "for", "to", "and", "with", "from", "by", "at", "is", "are", "as", "via", "into",
    "über", "der", "die", "das", "le", "la", "les", "un", "une", "el", "los",
];

/// `authorYEARfirstword`, all lower-case ASCII: `vaswani2017attention`.
/// Parts that are missing are left out (`anon` when there is no author).
pub fn make_key(rec: &BibRecord) -> String {
    let author = rec.surnames().first().map(|s| fold_ascii(s)).filter(|s| !s.is_empty()).unwrap_or_else(|| "anon".into());
    let year = rec.year().map(|y| y.to_string()).unwrap_or_default();
    let word = rec
        .get("title")
        .map(plain)
        .unwrap_or_default()
        .split(|c: char| c.is_whitespace() || c == '-' || c == ':' || c == '/')
        .map(fold_ascii)
        .find(|w| !w.is_empty() && !STOPWORDS.contains(&w.as_str()))
        .unwrap_or_default();
    let mut key: String = format!("{author}{year}{word}");
    key.truncate(60);
    key
}

/// Problems that make an entry unusable or likely wrong, in plain words.
pub fn validate(rec: &BibRecord) -> Vec<String> {
    let mut out = Vec::new();
    if rec.get("title").is_none() {
        out.push("It has no title.".to_string());
    }
    if rec.get("author").is_none() && rec.get("editor").is_none() {
        out.push("It has no author.".to_string());
    }
    if rec.year().is_none() {
        out.push("It has no year.".to_string());
    }
    let venue = ["journal", "booktitle", "publisher", "school", "institution", "howpublished", "eprint", "url", "note"];
    if matches!(rec.entry_type.as_str(), "article" | "inproceedings" | "incollection" | "conference")
        && !venue.iter().any(|f| rec.get(f).is_some())
    {
        out.push("It doesn't say where it was published.".to_string());
    }
    for f in &rec.fields {
        if !balanced(&f.raw) {
            out.push(format!("The {} field has unbalanced braces.", f.name));
        }
    }
    out
}

fn balanced(s: &str) -> bool {
    let mut depth = 0i32;
    let mut esc = false;
    for c in s.chars() {
        if esc {
            esc = false;
            continue;
        }
        match c {
            '\\' => esc = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

const FIELD_ORDER: &[&str] = &[
    "title", "author", "editor", "journal", "booktitle", "school", "institution", "publisher", "year", "month", "volume",
    "number", "pages", "doi", "eprint", "archiveprefix", "primaryclass", "url",
];

/// Tidies an entry fetched from a service: stable key, collapsed spaces,
/// `--` page ranges, no duplicated or empty fields, a canonical field order.
pub fn normalise(rec: &BibRecord) -> BibRecord {
    let mut fields: Vec<BibField> = Vec::new();
    for f in &rec.fields {
        if fields.iter().any(|g| g.name == f.name) {
            continue;
        }
        let mut raw = f.raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if f.name == "pages" {
            raw = raw.replace(['–', '—'], "--");
            if !raw.contains("--") {
                raw = raw.replacen('-', "--", 1);
            }
        }
        if f.name == "doi" {
            let d = clean_doi(BibField { name: f.name.clone(), raw: raw.clone() }.text());
            raw = format!("{{{d}}}");
        }
        let field = BibField { name: f.name.clone(), raw };
        if field.text().trim().is_empty() {
            continue;
        }
        fields.push(field);
    }
    fields.sort_by_key(|f| FIELD_ORDER.iter().position(|n| *n == f.name).unwrap_or(FIELD_ORDER.len()));
    let mut out = BibRecord { entry_type: rec.entry_type.clone(), key: String::new(), fields, line: rec.line };
    out.key = make_key(&out);
    out
}

/// Prints an entry: two-space indent, `name = {value}`.
pub fn format(rec: &BibRecord) -> String {
    let mut out = format!("@{}{{{},\n", rec.entry_type, rec.key);
    for (i, f) in rec.fields.iter().enumerate() {
        let r = f.raw.trim();
        let single = (r.starts_with('{') && outer_group(r)) || (r.starts_with('"') && r.ends_with('"') && !r[1..r.len() - 1].contains('"'));
        let value = if single {
            format!("{{{}}}", f.text())
        } else {
            r.to_string()
        };
        out.push_str(&format!("  {} = {}", f.name, value));
        out.push_str(if i + 1 < rec.fields.len() { ",\n" } else { "\n" });
    }
    out.push('}');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARXIV: &str = "@misc{vaswani2023attentionneed,\n      title={Attention Is All You Need}, \n      author={Ashish Vaswani and Noam Shazeer and Niki Parmar},\n      year={2023},\n      eprint={1706.03762},\n      archivePrefix={arXiv},\n      primaryClass={cs.CL},\n      url={https://arxiv.org/abs/1706.03762}, \n}";
    const CROSSREF: &str = "@article{LeCun_2015, title={Deep learning}, volume={521}, ISSN={1476-4687}, url={http://dx.doi.org/10.1038/nature14539}, DOI={10.1038/nature14539}, number={7553}, journal={Nature}, publisher={Springer Science and Business Media LLC}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}, month=May, pages={436–444} }";

    #[test]
    fn parses_service_output() {
        let r = &parse_entries(ARXIV)[0];
        assert_eq!(r.entry_type, "misc");
        assert_eq!(r.get("title"), Some("Attention Is All You Need"));
        assert_eq!(r.arxiv_id().as_deref(), Some("1706.03762"));
        assert_eq!(r.surnames(), vec!["Vaswani", "Shazeer", "Parmar"]);
        let r = &parse_entries(CROSSREF)[0];
        assert_eq!(r.doi().as_deref(), Some("10.1038/nature14539"));
        assert_eq!(r.year(), Some(2015));
        assert_eq!(r.get("month"), Some("May"));
        assert_eq!(r.surnames()[0], "LeCun");
    }

    #[test]
    fn keys_are_author_year_word() {
        let r = normalise(&parse_entries(ARXIV)[0]);
        assert_eq!(r.key, "vaswani2023attention");
        let r = normalise(&parse_entries(CROSSREF)[0]);
        assert_eq!(r.key, "lecun2015deep");
        let text = r#"@inproceedings{x, author = {M{\"u}ller, J{\"o}rg and Doe, J.}, title = "The {\'E}tude of {B}ayesian things", year = 2019}"#;
        assert_eq!(make_key(&parse_entries(text)[0]), "muller2019etude");
        let text = "@book{y, author = {Søren Ørsted and Ann Lee}, title = {À la carte: models}, date = {2021-03-01}}";
        assert_eq!(make_key(&parse_entries(text)[0]), "orsted2021carte");
        let text = "@misc{z, author = {{World Health Organization}}, title = {On the report}}";
        assert_eq!(make_key(&parse_entries(text)[0]), "worldhealthorganizationreport");
        assert_eq!(make_key(&parse_entries("@misc{w, title={}}")[0]), "anon");
    }

    #[test]
    fn normalise_and_format() {
        let r = normalise(&parse_entries(CROSSREF)[0]);
        let text = format(&r);
        assert!(text.starts_with("@article{lecun2015deep,\n  title = {Deep learning},\n  author = {LeCun, Yann and"), "{text}");
        assert!(text.contains("pages = {436--444}"), "{text}");
        assert!(text.contains("month = May"), "{text}");
        assert!(text.contains("doi = {10.1038/nature14539}"));
        assert!(text.ends_with("\n}"));
        // What we print parses back the same.
        let again = &parse_entries(&text)[0];
        assert_eq!(again.fields, r.fields);
        assert!(validate(&r).is_empty());
    }

    #[test]
    fn validation_finds_problems() {
        let r = &parse_entries("@article{k, title = {T}, journal = {J}}")[0];
        let p = validate(r);
        assert!(p.iter().any(|x| x.contains("no author")));
        assert!(p.iter().any(|x| x.contains("no year")));
        let r = &parse_entries("@article{k, author = {A}, title = {T}, year = 2020}")[0];
        assert!(validate(r).iter().any(|x| x.contains("published")));
    }

    #[test]
    fn tolerant_parsing() {
        let text = "% comment\n@string{foo = \"bar\"}\n@comment{ignored}\n@Article(key1, title = {A, with comma}, author = \"B and C\")\n\
            @misc{broken title = x}\n@book{key2,\n title = {Nested {Braces} here},\n year = {2001}\n}\n";
        let all = parse_entries(text);
        let keys: Vec<&str> = all.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["key1", "key2"]);
        assert_eq!(all[0].get("title"), Some("A, with comma"));
        assert_eq!(all[0].surnames(), vec!["B", "C"]);
        assert_eq!(all[1].get("title"), Some("Nested {Braces} here"));
        assert_eq!(all[1].line, 6);
        assert_eq!(find_entry(text, "KEY2").unwrap().key, "key2");
        assert!(find_entry(text, "nope").is_none());
    }

    #[test]
    fn identifiers() {
        assert_eq!(parse_arxiv_id("arXiv:1706.03762v7").as_deref(), Some("1706.03762"));
        assert_eq!(parse_arxiv_id("2101.00001").as_deref(), Some("2101.00001"));
        assert_eq!(parse_arxiv_id("hep-th/9901001v2").as_deref(), Some("hep-th/9901001"));
        assert_eq!(parse_arxiv_id("math.GT/0309136").as_deref(), Some("math.GT/0309136"));
        assert_eq!(parse_arxiv_id("10.1038/nature14539"), None);
        assert_eq!(parse_arxiv_id("../../etc"), None);
        assert_eq!(clean_doi("https://doi.org/10.1000/XYZ"), "10.1000/XYZ");
        assert_eq!(arxiv_from_doi("10.48550/arXiv.1706.03762").as_deref(), Some("1706.03762"));
        let r = &parse_entries("@article{k, journal = {arXiv preprint arXiv:2005.14165}, title={GPT}}")[0];
        assert_eq!(r.arxiv_id().as_deref(), Some("2005.14165"));
    }
}
