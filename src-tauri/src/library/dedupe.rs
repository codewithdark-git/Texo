//! Telling whether two records are the same paper when they share no
//! identifier: folded titles compared with Jaro-Winkler, plus year and first
//! author.

/// At or above this, with the year within one and the same first author,
/// two titles are the same paper and are merged.
pub const STRONG: f64 = 0.95;
/// From here up to [`STRONG`], the newer row is linked as a possible
/// duplicate (`dup_of`) and never merged on its own.
pub const PROBABLE: f64 = 0.90;
/// Folded titles shorter than this ("Introduction", "Reply") never match.
const MIN_TITLE: usize = 12;
/// Characters of the folded title that candidates must share (blocking).
/// Titles shorter than this never match anyway (see [`match_kind`]), and
/// a longer key keeps a block small even when many titles open alike
/// ("Large language models ...").
pub const BLOCK_PREFIX: usize = 12;
/// Most candidates compared per lookup, closest in length and year first.
pub const BLOCK_LIMIT: i64 = 200;

/// A Latin letter with a diacritic as plain ASCII letters (`é` → `e`,
/// `ß` → `ss`). Other characters come back unchanged.
fn fold_char(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'æ' => "ae",
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => "c",
        'ď' | 'đ' | 'ð' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => "e",
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => "g",
        'ĥ' | 'ħ' => "h",
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => "i",
        'ĵ' => "j",
        'ķ' => "k",
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => "l",
        'ñ' | 'ń' | 'ņ' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => "o",
        'œ' => "oe",
        'ŕ' | 'ŗ' | 'ř' => "r",
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => "s",
        'ß' => "ss",
        'ţ' | 'ť' | 'ŧ' | 'ț' => "t",
        'þ' => "th",
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => "u",
        'ŵ' => "w",
        'ý' | 'ÿ' | 'ŷ' => "y",
        'ź' | 'ż' | 'ž' => "z",
        _ => return None,
    })
}

/// Lower case, diacritics folded, only letters and digits kept. This is the
/// `title_norm` column, and what titles are compared on.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match fold_char(c) {
            Some(s) => out.push_str(s),
            None if c.is_alphanumeric() => out.push(c),
            None => {}
        }
    }
    out
}

/// The folded family name of one author: the part before a comma
/// ("Smith, J."), else the last word ("Jane Smith").
pub fn surname_norm(name: &str) -> Option<String> {
    let name = name.trim();
    let family = match name.split_once(',') {
        Some((family, _)) => family.to_string(),
        None => name.split_whitespace().last().unwrap_or_default().to_string(),
    };
    let f = fold(&family);
    (!f.is_empty()).then_some(f)
}

/// Jaro-Winkler similarity in 0..=1 (prefix scale 0.1, up to 4 characters).
pub fn jaro_winkler(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let window = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut a_hit = vec![false; a.len()];
    let mut b_hit = vec![false; b.len()];
    let mut matches = 0usize;
    for (i, ca) in a.iter().enumerate() {
        let lo = i.saturating_sub(window);
        let hi = (i + window + 1).min(b.len());
        for j in lo..hi {
            if !b_hit[j] && b[j] == *ca {
                a_hit[i] = true;
                b_hit[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let mut transpositions = 0usize;
    let mut k = 0usize;
    for (i, ca) in a.iter().enumerate() {
        if !a_hit[i] {
            continue;
        }
        while !b_hit[k] {
            k += 1;
        }
        if *ca != b[k] {
            transpositions += 1;
        }
        k += 1;
    }
    let m = matches as f64;
    let jaro = (m / a.len() as f64 + m / b.len() as f64 + (m - transpositions as f64 / 2.0) / m) / 3.0;
    let prefix = a.iter().zip(&b).take(4).take_while(|(x, y)| x == y).count() as f64;
    jaro + prefix * 0.1 * (1.0 - jaro)
}

/// What [`match_kind`] compares: the folded title, year and folded first
/// author surname.
#[derive(Debug, Clone, Copy)]
pub struct Probe<'a> {
    pub title_norm: &'a str,
    pub year: Option<i32>,
    pub first_author: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchKind {
    /// The same paper: merge.
    Strong,
    /// Maybe the same paper: link through `dup_of`, don't merge.
    Probable,
    None,
}

fn years_close(a: Option<i32>, b: Option<i32>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= 1,
        // A missing year neither confirms nor rules out a match.
        _ => true,
    }
}

/// Whether two records describe the same paper, on titles, years and first
/// authors alone (identifiers are matched before this is asked).
pub fn match_kind(a: &Probe<'_>, b: &Probe<'_>) -> MatchKind {
    // Very short titles ("Introduction", "Reply") say too little.
    if a.title_norm.chars().count() < MIN_TITLE || b.title_norm.chars().count() < MIN_TITLE || !years_close(a.year, b.year) {
        return MatchKind::None;
    }
    let sim = jaro_winkler(a.title_norm, b.title_norm);
    let same_author = match (a.first_author, b.first_author) {
        (Some(x), Some(y)) => x == y,
        // With no author on either side only the exact same title is
        // enough to merge (a `.bib` entry synced again); a near title alone
        // ("... 2020 Workshop" and "... 2021 Workshop") is at most Probable.
        (None, None) => a.title_norm == b.title_norm,
        _ => false,
    };
    if sim >= STRONG && same_author {
        MatchKind::Strong
    } else if sim >= PROBABLE {
        MatchKind::Probable
    } else {
        MatchKind::None
    }
}

/// The numbers in a title, Arabic or Roman (up to "xx"), in order:
/// "Convergence, part II" gives ["ii"]. Titles whose numbers differ (Part I
/// and Part II, volume 1 and 2, the 2020 and 2021 proceedings) are two
/// papers however alike they read. Works on the raw title: `title_norm` has
/// no word breaks left.
pub fn numerals(title: &str) -> Vec<String> {
    const ROMAN: [&str; 20] = [
        "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
    ];
    title
        .split(|c: char| !c.is_alphanumeric())
        .map(fold)
        .filter(|w| !w.is_empty() && (w.chars().all(|c| c.is_ascii_digit()) || ROMAN.contains(&w.as_str())))
        .collect()
}

/// The `title_norm` prefix candidates are looked up by.
pub fn block_prefix(title_norm: &str) -> String {
    title_norm.chars().take(BLOCK_PREFIX).collect()
}
