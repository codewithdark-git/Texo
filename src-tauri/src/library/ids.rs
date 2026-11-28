//! Paper identifiers in one canonical spelling, so the same paper found by
//! two services (or typed by the user) maps to the same `paper_ids` row.

/// `10.1000/ABC`, `https://doi.org/10.1000/abc.` and `doi:10.1000/abc` →
/// `10.1000/abc`. DOIs compare case-insensitively, so they are lower-cased.
pub fn normalise_doi(input: &str) -> Option<String> {
    let s = input.trim().trim_matches(|c| c == '{' || c == '}' || c == '<' || c == '>');
    let lower = s.to_lowercase();
    let mut rest = lower.as_str();
    for p in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi.org/",
        "dx.doi.org/",
        "doi:",
    ] {
        if let Some(r) = rest.strip_prefix(p) {
            rest = r.trim_start();
            break;
        }
    }
    let d = rest.trim().trim_end_matches(['.', ',', ';', ':', ')', ']']);
    let (prefix, suffix) = d.split_once('/')?;
    let registrant = prefix.strip_prefix("10.")?;
    if registrant.is_empty() || !registrant.chars().all(|c| c.is_ascii_digit() || c == '.') || suffix.is_empty() {
        return None;
    }
    if d.chars().any(char::is_whitespace) {
        return None;
    }
    Some(d.to_string())
}

/// A canonical DOI from a preprint server (bioRxiv and medRxiv, Research
/// Square, SSRN, ChemRxiv, TechRxiv, Preprints.org, OSF preprints). When a
/// paper has two DOIs, the published one is the one to cite.
pub fn is_preprint_doi(doi: &str) -> bool {
    const PREFIXES: [&str; 8] =
        ["10.1101/", "10.21203/", "10.2139/", "10.26434/", "10.36227/", "10.20944/", "10.31234/", "10.31219/"];
    PREFIXES.iter().any(|p| doi.starts_with(p))
}

/// The arXiv id an arXiv DOI (`10.48550/arXiv.2401.01234`) stands for.
pub fn arxiv_from_doi(doi: &str) -> Option<String> {
    let d = normalise_doi(doi)?;
    d.strip_prefix("10.48550/arxiv.").and_then(normalise_arxiv)
}

/// A bare arXiv id without its version: `2401.01234v3`, `arXiv:2401.01234`,
/// `https://arxiv.org/abs/2401.01234v2`, `10.48550/arXiv.2401.01234` →
/// `2401.01234`. Old-style ids keep their archive: `hep-th/9901001`.
pub fn normalise_arxiv(input: &str) -> Option<String> {
    let s = input.trim().trim_matches(|c| c == '{' || c == '}');
    let lower = s.to_lowercase();
    let mut rest = lower.as_str();
    if rest.contains("10.48550/arxiv.") {
        let at = rest.find("10.48550/arxiv.")? + "10.48550/arxiv.".len();
        rest = &rest[at..];
    }
    for p in [
        "https://arxiv.org/abs/",
        "http://arxiv.org/abs/",
        "https://arxiv.org/pdf/",
        "http://arxiv.org/pdf/",
        "arxiv.org/abs/",
        "arxiv.org/pdf/",
        "arxiv:",
    ] {
        if let Some(r) = rest.strip_prefix(p) {
            rest = r.trim_start();
            break;
        }
    }
    let rest = rest.trim().trim_end_matches(['.', ',', ';', ')', ']', '/']);
    let rest = rest.strip_suffix(".pdf").unwrap_or(rest);
    let base = match rest.rfind('v') {
        Some(i)
            if i > 0
                && !rest[i + 1..].is_empty()
                && rest[i + 1..].chars().all(|c| c.is_ascii_digit())
                && rest[..i].ends_with(|c: char| c.is_ascii_digit()) =>
        {
            &rest[..i]
        }
        _ => rest,
    };
    let new_style = match base.split_once('.') {
        Some((a, b)) => {
            a.len() == 4 && a.chars().all(|c| c.is_ascii_digit()) && (4..=5).contains(&b.len()) && b.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
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

/// `https://openalex.org/W2741809807` or `w2741809807` → `W2741809807`.
pub fn normalise_openalex(input: &str) -> Option<String> {
    let s = input.trim();
    let s = s.rsplit('/').next().unwrap_or(s);
    let mut chars = s.chars();
    let first = chars.next()?.to_ascii_uppercase();
    let digits: String = chars.collect();
    (matches!(first, 'W' | 'A' | 'S' | 'I') && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("{first}{digits}"))
}

/// Any other id: trimmed, with nothing inside that could not be an id.
fn plain_id(input: &str) -> Option<String> {
    let s = input.trim();
    (!s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_whitespace)).then(|| s.to_string())
}

/// One identifier of a paper, as stored in `paper_ids(scheme, value)`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PaperKey {
    Doi(String),
    Arxiv(String),
    /// Semantic Scholar paper id (40 hex characters).
    S2(String),
    /// Semantic Scholar corpus id.
    Corpus(String),
    OpenAlex(String),
    Pmid(String),
    Dblp(String),
}

impl PaperKey {
    pub fn scheme(&self) -> &'static str {
        match self {
            PaperKey::Doi(_) => "doi",
            PaperKey::Arxiv(_) => "arxiv",
            PaperKey::S2(_) => "s2",
            PaperKey::Corpus(_) => "corpus",
            PaperKey::OpenAlex(_) => "openalex",
            PaperKey::Pmid(_) => "pmid",
            PaperKey::Dblp(_) => "dblp",
        }
    }

    pub fn value(&self) -> &str {
        match self {
            PaperKey::Doi(v)
            | PaperKey::Arxiv(v)
            | PaperKey::S2(v)
            | PaperKey::Corpus(v)
            | PaperKey::OpenAlex(v)
            | PaperKey::Pmid(v)
            | PaperKey::Dblp(v) => v,
        }
    }

    /// The canonical key for a value of a known scheme. An arXiv DOI becomes
    /// an arXiv key, so it matches the same preprint found by arXiv itself.
    pub fn new(scheme: &str, value: &str) -> Option<PaperKey> {
        match scheme {
            "doi" => match arxiv_from_doi(value) {
                Some(a) => Some(PaperKey::Arxiv(a)),
                None => normalise_doi(value).map(PaperKey::Doi),
            },
            "arxiv" => normalise_arxiv(value).map(PaperKey::Arxiv),
            "s2" => plain_id(value).map(|v| PaperKey::S2(v.to_lowercase())),
            "corpus" => plain_id(value).filter(|v| v.chars().all(|c| c.is_ascii_digit())).map(PaperKey::Corpus),
            "openalex" => normalise_openalex(value).map(PaperKey::OpenAlex),
            "pmid" => plain_id(value).filter(|v| v.chars().all(|c| c.is_ascii_digit())).map(PaperKey::Pmid),
            "dblp" => plain_id(value).map(PaperKey::Dblp),
            _ => None,
        }
    }

    /// Reads whatever the user or a tool passed as an id: a DOI (bare, `doi:`
    /// or a doi.org link), an arXiv id or link, or an OpenAlex work id.
    pub fn parse(input: &str) -> Option<PaperKey> {
        let lower = input.trim().to_lowercase();
        if lower.contains("arxiv") {
            if let Some(a) = normalise_arxiv(input) {
                return Some(PaperKey::Arxiv(a));
            }
        }
        if let Some(d) = normalise_doi(input) {
            return PaperKey::new("doi", &d);
        }
        if let Some(a) = normalise_arxiv(input) {
            return Some(PaperKey::Arxiv(a));
        }
        if lower.contains("openalex.org/") {
            return normalise_openalex(input).map(PaperKey::OpenAlex);
        }
        None
    }
}
