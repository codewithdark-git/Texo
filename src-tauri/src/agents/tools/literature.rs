//! Literature tools, keyless and polite:
//! - `search_papers`: Semantic Scholar, Crossref and arXiv in parallel, plus
//!   OpenAlex when the user added a free key; fused by reciprocal rank,
//!   de-duplicated by identifiers and by fuzzy title (an arXiv preprint and
//!   its published version become one paper), filtered by year and open
//!   access, and sorted by relevance, citations or date;
//! - `get_bibtex`: BibTeX from doi.org content negotiation
//!   (`Accept: application/x-bibtex`) or from arXiv, normalised with a
//!   stable `authorYEARfirstword` key and checked;
//! - `verify_citation`: checks that a `.bib` entry points at a real paper
//!   (by DOI, arXiv id, or a title search) and says what doesn't match.
//!
//! One source failing (offline, busy) doesn't fail a search: the others'
//! results come back with a note. Each source's answer is cached on its own
//! (through [`SearchHooks`]), so a partial result still saves work.
//!
//! Keys never go in an address: OpenAlex gets a bearer header, Semantic
//! Scholar an `x-api-key` header, and cache keys never include either.


use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::bibtex::{self, BibRecord};
use super::html::decode_entities;
use super::net::{self, NetCtx};
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::ApiKey;

/// The most papers the model gets from one search.
pub const MAX_PAPERS: usize = 8;
/// The most papers the UI may ask for in one search.
pub const MAX_PAPERS_UI: usize = 25;
const SEARCH_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const BIBTEX_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const ABSTRACT_CHARS: usize = 400;
/// The full abstract is kept up to this many characters (for the library).
const ABSTRACT_FULL_CHARS: usize = 4000;

/// arXiv asks for one request every 3 seconds, over one connection.
const ARXIV_INTERVAL: Duration = Duration::from_millis(3000);
const CROSSREF_INTERVAL: Duration = Duration::from_millis(200);
/// Keyless Semantic Scholar shares one pool with everybody: go slowly.
const S2_INTERVAL: Duration = Duration::from_millis(1100);
/// With a key, Semantic Scholar allows one request a second.
const S2_KEY_INTERVAL: Duration = Duration::from_millis(1000);
const OPENALEX_INTERVAL: Duration = Duration::from_millis(150);
const DOI_INTERVAL: Duration = Duration::from_millis(200);
/// Waits shorter than this aren't worth telling the user about.
const SHOW_WAIT: Duration = Duration::from_millis(500);

/// Reciprocal rank fusion constant.
const RRF_K: f64 = 60.0;
/// Fuzzy title match needed (with a close year and the same first author)
/// to treat two results as one paper.
const SAME_TITLE_JW: f64 = 0.95;

// ---------------------------------------------------------------- types --

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Paper {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    /// The first few hundred characters of the abstract (what the model sees).
    pub abstract_snippet: Option<String>,
    pub url: Option<String>,
    /// Where it was found: "arXiv", "Crossref", "Semantic Scholar", "OpenAlex".
    pub sources: Vec<String>,
    /// Semantic Scholar's paper id.
    pub s2_id: Option<String>,
    /// OpenAlex's work id, like `W2741809807`.
    pub openalex_id: Option<String>,
    pub citation_count: Option<u64>,
    /// Semantic Scholar's "influential citations".
    pub influential_count: Option<u64>,
    /// Semantic Scholar's one-sentence summary.
    pub tldr: Option<String>,
    /// The abstract, up to 4,000 characters.
    pub abstract_full: Option<String>,
    /// A link to a free PDF.
    pub oa_pdf: Option<String>,
    /// "gold", "green", "hybrid", "bronze" or "closed", when known.
    pub oa_status: Option<String>,
    pub is_oa: Option<bool>,
    /// The source's own kind of work ("journal-article", "preprint", …).
    pub work_type: Option<String>,
    /// Fields of study (Semantic Scholar).
    pub fields: Vec<String>,
    /// Where each source ranked it, and the citations each one reported.
    pub per_source: Vec<SourceHit>,
}

/// One source's view of a paper: its 1-based rank and citation count.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHit {
    pub source: Source,
    pub rank: usize,
    pub citations: Option<u64>,
}

impl Paper {
    fn one_line(&self) -> String {
        let authors = match self.authors.len() {
            0 => "unknown authors".to_string(),
            1 | 2 => self.authors.join(" and "),
            _ => format!("{} et al.", self.authors[0]),
        };
        let mut s = format!("{} ({}, {})", self.title, authors, self.year.map(|y| y.to_string()).unwrap_or_else(|| "n.d.".into()));
        if let Some(v) = &self.venue {
            s.push_str(&format!(". {v}"));
        }
        if let Some(d) = &self.doi {
            s.push_str(&format!(". DOI: {d}"));
        }
        if let Some(a) = &self.arxiv_id {
            s.push_str(&format!(". arXiv: {a}"));
        }
        if let Some(c) = self.citation_count {
            s.push_str(&format!(". Cited by {c}"));
        }
        s
    }

    fn is_open(&self) -> bool {
        self.is_oa == Some(true) || self.oa_pdf.is_some() || self.arxiv_id.is_some()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSearch {
    pub query: String,
    pub papers: Vec<Paper>,
    /// Plain remarks: a source that was busy or unreachable.
    pub notes: Vec<String>,
}

impl PaperSearch {
    pub fn to_tool_text(&self) -> String {
        let mut out = if self.papers.is_empty() {
            format!("No papers found for \"{}\".\n", self.query)
        } else {
            format!("Papers for \"{}\":\n", self.query)
        };
        for (i, p) in self.papers.iter().enumerate() {
            out.push_str(&format!("\n{}. {}\n", i + 1, p.one_line()));
            if let Some(a) = &p.abstract_snippet {
                out.push_str(&format!("   {a}\n"));
            } else if let Some(t) = &p.tldr {
                out.push_str(&format!("   TL;DR: {t}\n"));
            }
        }
        for n in &self.notes {
            out.push_str(&format!("\nNote: {n}"));
        }
        out
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum Source {
    #[serde(rename = "arxiv")]
    Arxiv,
    #[serde(rename = "crossref")]
    Crossref,
    #[serde(rename = "s2")]
    SemanticScholar,
    #[serde(rename = "openalex")]
    OpenAlex,
}

impl Source {
    /// In the order their lists are fused (earlier ones fill fields first).
    // For the paper library's progress events (v1.3); tests use it now.
    #[allow(dead_code)]
    pub const ALL: [Source; 4] = [Source::SemanticScholar, Source::Crossref, Source::Arxiv, Source::OpenAlex];

    pub fn label(self) -> &'static str {
        match self {
            Source::Arxiv => "arXiv",
            Source::Crossref => "Crossref",
            Source::SemanticScholar => "Semantic Scholar",
            Source::OpenAlex => "OpenAlex",
        }
    }

    /// The short name used in settings, events and cache keys.
    pub fn key(self) -> &'static str {
        match self {
            Source::Arxiv => "arxiv",
            Source::Crossref => "crossref",
            Source::SemanticScholar => "s2",
            Source::OpenAlex => "openalex",
        }
    }

    /// How much a rank in this source's list counts in the fusion.
    fn weight(self) -> f64 {
        match self {
            Source::SemanticScholar | Source::OpenAlex => 1.0,
            Source::Arxiv => 0.7,
            Source::Crossref => 0.5,
        }
    }
}

/// Which paper sources to ask. All on by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceSet {
    pub s2: bool,
    pub crossref: bool,
    pub arxiv: bool,
    pub openalex: bool,
}

impl Default for SourceSet {
    fn default() -> Self {
        SourceSet { s2: true, crossref: true, arxiv: true, openalex: true }
    }
}

impl SourceSet {
    pub fn has(self, s: Source) -> bool {
        match s {
            Source::SemanticScholar => self.s2,
            Source::Crossref => self.crossref,
            Source::Arxiv => self.arxiv,
            Source::OpenAlex => self.openalex,
        }
    }

    /// The sources on in both sets.
    pub fn and(self, o: SourceSet) -> SourceSet {
        SourceSet { s2: self.s2 && o.s2, crossref: self.crossref && o.crossref, arxiv: self.arxiv && o.arxiv, openalex: self.openalex && o.openalex }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchSort {
    #[default]
    Relevance,
    /// Most cited first.
    Cited,
    /// Newest first.
    Newest,
}

impl SearchSort {
    /// Reads "relevance", "cited" or "newest" (as the tools and UI send it).
    // For the `sort` argument of the tools and library commands (v1.3).
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Option<SearchSort> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "relevance" => Some(SearchSort::Relevance),
            "cited" | "citations" | "most cited" => Some(SearchSort::Cited),
            "newest" | "recent" | "date" => Some(SearchSort::Newest),
            _ => None,
        }
    }

    fn key(self) -> &'static str {
        match self {
            SearchSort::Relevance => "rel",
            SearchSort::Cited => "cited",
            SearchSort::Newest => "new",
        }
    }
}

/// What to search for besides the words.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchOpts {
    /// At most this many papers (≤ 25; the model's tool keeps ≤ 8).
    pub limit: usize,
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    /// Only papers with a free full text.
    pub oa_only: bool,
    pub sort: SearchSort,
    /// Narrows the sources the user left on (never widens them).
    pub sources: SourceSet,
}

impl Default for SearchOpts {
    fn default() -> Self {
        SearchOpts { limit: 5, year_from: None, year_to: None, oa_only: false, sort: SearchSort::Relevance, sources: SourceSet::default() }
    }
}

/// How one source is doing during a search, for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "detail")]
pub enum SourceState {
    Pending,
    /// Waiting this many milliseconds for its polite slot.
    Waiting(u64),
    /// Answered with this many results.
    Ok(usize),
    /// Failed; the plain note says why.
    Degraded(String),
    /// Not asked; the plain reason says why.
    Skipped(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEvent {
    pub source: Source,
    pub state: SourceState,
}

/// Where the paper search keeps its per-source answers and reports its
/// progress. [`MemoryHooks`] is the default; the paper library plugs in a
/// persistent one. Keys never include an API key or e-mail address.
pub trait SearchHooks: Send + Sync {
    fn cached(&self, source: Source, key: &str) -> Option<String>;
    fn store(&self, source: Source, key: &str, body: &str, ttl: Duration);
    fn progress(&self, ev: SourceEvent);
    /// Extra ranking weight for a paper (for example: already in the
    /// library or the project). Zero by default.
    fn boost(&self, p: &Paper) -> f64;
}

/// The process-wide in-memory cache, no progress, no boost.
pub struct MemoryHooks;

impl SearchHooks for MemoryHooks {
    fn cached(&self, source: Source, key: &str) -> Option<String> {
        net::cache_get::<String>(&format!("src|{}|{key}", source.key()))
    }
    fn store(&self, source: Source, key: &str, body: &str, ttl: Duration) {
        net::cache_put(&format!("src|{}|{key}", source.key()), &body, ttl);
    }
    fn progress(&self, _ev: SourceEvent) {}
    fn boost(&self, _p: &Paper) -> f64 {
        0.0
    }
}

fn report(ctx: &NetCtx, source: Source, state: SourceState) {
    ctx.hooks.progress(SourceEvent { source, state });
}

// --------------------------------------------------------- search_papers --

/// Searches the paper sources, merges the results and keeps at most `limit`
/// (≤ 8). The model's tool calls this.
pub async fn search_papers(ctx: &NetCtx, query: &str, limit: usize) -> AiResult<PaperSearch> {
    let opts = SearchOpts { limit: limit.clamp(1, MAX_PAPERS), ..SearchOpts::default() };
    search_papers_opts(ctx, query, &opts).await
}

/// The words, filters and sort of one search, as each source is asked.
struct SourceQuery<'a> {
    text: &'a str,
    rows: usize,
    opts: &'a SearchOpts,
}

/// Searches with filters and a sort; keeps at most `opts.limit` (≤ 25).
pub async fn search_papers_opts(ctx: &NetCtx, query: &str, opts: &SearchOpts) -> AiResult<PaperSearch> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.is_empty() {
        return Err(AiError::invalid("Give a few words to search for."));
    }
    if query.chars().count() > 300 {
        return Err(AiError::invalid("The search is too long; use a few key words or the title."));
    }
    if let (Some(a), Some(b)) = (opts.year_from, opts.year_to) {
        if a > b {
            return Err(AiError::invalid("The start year is after the end year."));
        }
    }
    let limit = opts.limit.clamp(1, MAX_PAPERS_UI);
    let wanted = ctx.sources.and(opts.sources);
    let q = SourceQuery { text: &query, rows: limit.max(5), opts };
    let (s, c, a, o) = tokio::join!(
        fetch_source(ctx, Source::SemanticScholar, &q, wanted),
        fetch_source(ctx, Source::Crossref, &q, wanted),
        fetch_source(ctx, Source::Arxiv, &q, wanted),
        fetch_source(ctx, Source::OpenAlex, &q, wanted),
    );
    ctx.cancel.check()?;
    let mut lists = Vec::new();
    let mut notes = Vec::new();
    let mut errors = Vec::new();
    let mut asked = 0;
    for (source, res) in [(Source::SemanticScholar, s), (Source::Crossref, c), (Source::Arxiv, a), (Source::OpenAlex, o)] {
        match res {
            None => {}
            Some(Ok(list)) => {
                asked += 1;
                lists.push((source, list));
            }
            Some(Err(e)) => {
                asked += 1;
                if e.kind == Kind::Cancelled {
                    return Err(e);
                }
                notes.push(source_note(ctx, source, &e));
                errors.push(e);
            }
        }
    }
    if asked == 0 {
        return Err(AiError::invalid("All paper sources are turned off. Turn one on in Settings > AI > Web."));
    }
    if lists.is_empty() {
        let mut err = errors.into_iter().next().unwrap_or_else(|| AiError::new(Kind::Network, "The paper search failed."));
        err.message = format!("No paper database could be reached. {}", offline_hint(&err));
        return Err(err);
    }
    let papers = fuse(lists, &query, opts, ctx.hooks.as_ref(), limit);
    Ok(PaperSearch { query, papers, notes })
}

/// The plain note for a source that failed (the key itself is never named).
/// A refusal blames the key only when one is set.
fn source_note(ctx: &NetCtx, source: Source, e: &AiError) -> String {
    let has_key = match source {
        Source::SemanticScholar => ctx.s2_key.is_some(),
        Source::OpenAlex => ctx.openalex_key.is_some(),
        Source::Crossref | Source::Arxiv => false,
    };
    match e.kind {
        Kind::RateLimited => format!("{} was busy, so its results are missing.", source.label()),
        Kind::BadKey if has_key => format!("{} didn't accept the key in Settings > AI > Web, so its results are missing.", source.label()),
        Kind::BadKey => format!("{} refused the request, so its results are missing.", source.label()),
        _ => format!("{} couldn't be reached, so its results are missing.", source.label()),
    }
}

/// Asks one source (or its cache). `None`: it wasn't asked.
async fn fetch_source(ctx: &NetCtx, source: Source, q: &SourceQuery<'_>, wanted: SourceSet) -> Option<AiResult<Vec<Paper>>> {
    if !wanted.has(source) {
        report(ctx, source, SourceState::Skipped("Turned off in Settings".into()));
        return None;
    }
    if source == Source::OpenAlex && ctx.openalex_key.is_none() {
        report(ctx, source, SourceState::Skipped("Key not set".into()));
        return None;
    }
    report(ctx, source, SourceState::Pending);
    let key = cache_key(ctx, source, q);
    if let Some(list) = ctx.hooks.cached(source, &key).and_then(|b| serde_json::from_str::<Vec<Paper>>(&b).ok()) {
        report(ctx, source, SourceState::Ok(list.len()));
        return Some(Ok(list));
    }
    // `complete`: false when the answer may be missing papers (arXiv's
    // looser retry failed), so it isn't cached.
    let (res, complete) = match source {
        Source::SemanticScholar => (search_s2(ctx, q).await, true),
        Source::Crossref => (search_crossref(ctx, q).await, true),
        Source::Arxiv => match search_arxiv(ctx, q).await {
            Ok((list, complete)) => (Ok(list), complete),
            Err(e) => (Err(e), false),
        },
        Source::OpenAlex => (search_openalex(ctx, q).await, true),
    };
    match res {
        Ok(mut list) => {
            for (i, p) in list.iter_mut().enumerate() {
                p.per_source = vec![SourceHit { source, rank: i + 1, citations: p.citation_count }];
            }
            if complete {
                if let Ok(body) = serde_json::to_string(&list) {
                    ctx.hooks.store(source, &key, &body, SEARCH_TTL);
                }
            }
            report(ctx, source, SourceState::Ok(list.len()));
            Some(Ok(list))
        }
        Err(e) => {
            if e.kind != Kind::Cancelled {
                report(ctx, source, SourceState::Degraded(source_note(ctx, source, &e)));
            }
            Some(Err(e))
        }
    }
}

/// `address|rows|years|oa|sort|words`: never a key or an e-mail address.
fn cache_key(ctx: &NetCtx, source: Source, q: &SourceQuery<'_>) -> String {
    let base = match source {
        Source::SemanticScholar => &ctx.services.semantic_scholar,
        Source::Crossref => &ctx.services.crossref,
        Source::Arxiv => &ctx.services.arxiv_api,
        Source::OpenAlex => &ctx.services.openalex,
    };
    let year = |y: Option<i32>| y.map(|y| y.to_string()).unwrap_or_default();
    format!(
        "{base}|{}|{}-{}|{}|{}|{}",
        q.rows,
        year(q.opts.year_from),
        year(q.opts.year_to),
        u8::from(q.opts.oa_only),
        q.opts.sort.key(),
        q.text.to_lowercase()
    )
}

fn offline_hint(err: &AiError) -> &'static str {
    match err.kind {
        Kind::Offline | Kind::Network | Kind::Tls => "Check your internet connection.",
        Kind::RateLimited => "The services are busy; try again in a minute.",
        Kind::Timeout => "They took too long to answer; try again.",
        _ => "Try again later.",
    }
}

// ------------------------------------------------------ ranking, dedup --

/// Fuses ranked lists by reciprocal rank (`Σ w/(60+rank)`), merging the
/// same paper across lists, then filters, scores and sorts.
///
/// The fused score is scaled so the best paper has 1.0; the small extras
/// (citations, open access, title words, the hooks' boost) then act as
/// tie-breakers instead of drowning the agreement between sources.
fn fuse(lists: Vec<(Source, Vec<Paper>)>, query: &str, opts: &SearchOpts, hooks: &dyn SearchHooks, limit: usize) -> Vec<Paper> {
    let mut merged: Vec<(Paper, f64)> = Vec::new();
    for (source, list) in lists {
        for (i, p) in list.into_iter().enumerate() {
            let score = source.weight() / (RRF_K + (i + 1) as f64);
            match merged.iter_mut().find(|(m, _)| same_paper(m, &p)) {
                Some((m, s)) => {
                    absorb(m, p);
                    *s += score;
                }
                None => merged.push((p, score)),
            }
        }
    }
    merged.retain(|(p, _)| passes(p, opts));
    let top = merged.iter().map(|(_, s)| *s).fold(0.0, f64::max);
    let cmax = merged.iter().filter_map(|(p, _)| p.citation_count).max().unwrap_or(0);
    let words = query_words(query);
    let mut scored: Vec<(usize, Paper, f64)> = merged
        .into_iter()
        .enumerate()
        .map(|(i, (p, s))| {
            let mut score = if top > 0.0 { s / top } else { 0.0 };
            if let (Some(c), true) = (p.citation_count, cmax > 0) {
                score += 0.1 * (1.0 + c as f64).ln() / (1.0 + cmax as f64).ln();
            }
            if p.is_open() {
                score += 0.05;
            }
            score += 0.1 * title_overlap(&words, &p.title);
            score += hooks.boost(&p);
            (i, p, score)
        })
        .collect();
    let by_score = |a: &(usize, Paper, f64), b: &(usize, Paper, f64)| {
        b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0))
    };
    match opts.sort {
        SearchSort::Relevance => scored.sort_by(by_score),
        SearchSort::Cited => scored.sort_by(|a, b| b.1.citation_count.cmp(&a.1.citation_count).then_with(|| by_score(a, b))),
        SearchSort::Newest => scored.sort_by(|a, b| b.1.year.cmp(&a.1.year).then_with(|| by_score(a, b))),
    }
    scored.into_iter().map(|(_, p, _)| p).take(limit).collect()
}

/// The year and open-access filters (a paper without a year fails a year
/// filter: it can't be shown to pass).
fn passes(p: &Paper, opts: &SearchOpts) -> bool {
    if opts.year_from.is_some() || opts.year_to.is_some() {
        let Some(y) = p.year else { return false };
        if opts.year_from.is_some_and(|f| y < f) || opts.year_to.is_some_and(|t| y > t) {
            return false;
        }
    }
    !opts.oa_only || p.is_open()
}

/// The query's words worth matching (folded, three letters or more).
fn query_words(q: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in q.split(|c: char| !c.is_alphanumeric()).map(fold).filter(|w| w.chars().count() > 2) {
        if !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// The share of the query's words found in the title, 0..1.
fn title_overlap(words: &[String], title: &str) -> f64 {
    if words.is_empty() {
        return 0.0;
    }
    let tw: Vec<String> = title.split(|c: char| !c.is_alphanumeric()).map(fold).collect();
    words.iter().filter(|w| tw.contains(w)).count() as f64 / words.len() as f64
}

fn same_paper(a: &Paper, b: &Paper) -> bool {
    let same = |x: &Option<String>, y: &Option<String>| matches!((x, y), (Some(x), Some(y)) if x.eq_ignore_ascii_case(y));
    let differ = |x: &Option<String>, y: &Option<String>| matches!((x, y), (Some(x), Some(y)) if !x.eq_ignore_ascii_case(y));
    if same(&a.doi, &b.doi) || same(&a.arxiv_id, &b.arxiv_id) || same(&a.s2_id, &b.s2_id) || same(&a.openalex_id, &b.openalex_id) {
        return true;
    }
    // Two different publisher DOIs (or arXiv ids, or ids in one database)
    // are two papers, however alike their titles.
    let publisher = |p: &Paper| p.doi.clone().filter(|d| bibtex::arxiv_from_doi(d).is_none());
    if differ(&publisher(a), &publisher(b)) || differ(&a.arxiv_id, &b.arxiv_id) || differ(&a.s2_id, &b.s2_id) || differ(&a.openalex_id, &b.openalex_id) {
        return false;
    }
    let (ta, tb) = (norm_title(&a.title), norm_title(&b.title));
    if ta.len() >= 20 && ta == tb {
        return true;
    }
    // A preprint and its published version: nearly the same title, a year
    // apart at most, the same first author.
    let (fa, fb) = (fold(&a.title), fold(&b.title));
    if fa.chars().count() < 12 || fb.chars().count() < 12 || jaro_winkler(&fa, &fb) < SAME_TITLE_JW {
        return false;
    }
    // Part I and Part II (or volume 1 and 2) are two papers.
    if numerals(&a.title) != numerals(&b.title) {
        return false;
    }
    // Both years and both first authors must be known: a near-title alone
    // merges different papers ("A survey on ..." and "A survey of ...").
    match (a.year, b.year) {
        (Some(x), Some(y)) if (x - y).abs() <= 1 => {}
        _ => return false,
    }
    match (a.authors.first().map(|n| surname(n)), b.authors.first().map(|n| surname(n))) {
        (Some(x), Some(y)) => !x.is_empty() && x == y,
        _ => false,
    }
}

/// The numbers in a title, Arabic or Roman, in order: "Convergence, part
/// II" → ["ii"]. Roman numerals count up to "xx".
fn numerals(title: &str) -> Vec<String> {
    const ROMAN: [&str; 20] = [
        "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
    ];
    title
        .split(|c: char| !c.is_alphanumeric())
        .map(fold)
        .filter(|w| !w.is_empty() && (w.chars().all(|c| c.is_ascii_digit()) || ROMAN.contains(&w.as_str())))
        .collect()
}

fn absorb(into: &mut Paper, from: Paper) {
    // A publisher DOI is better than arXiv's own.
    let arxiv_doi = |d: &Option<String>| d.as_deref().is_some_and(|d| bibtex::arxiv_from_doi(d).is_some());
    if into.doi.is_none() || (arxiv_doi(&into.doi) && from.doi.is_some() && !arxiv_doi(&from.doi)) {
        into.doi = from.doi.or(into.doi.take());
    }
    fn fill<T>(into: &mut Option<T>, from: Option<T>) {
        if into.is_none() {
            *into = from;
        }
    }
    fill(&mut into.arxiv_id, from.arxiv_id);
    fill(&mut into.year, from.year);
    fill(&mut into.venue, from.venue);
    fill(&mut into.abstract_snippet, from.abstract_snippet);
    fill(&mut into.url, from.url);
    fill(&mut into.s2_id, from.s2_id);
    fill(&mut into.openalex_id, from.openalex_id);
    fill(&mut into.influential_count, from.influential_count);
    fill(&mut into.tldr, from.tldr);
    fill(&mut into.oa_pdf, from.oa_pdf);
    fill(&mut into.oa_status, from.oa_status);
    fill(&mut into.work_type, from.work_type);
    if into.authors.is_empty() {
        into.authors = from.authors;
    }
    if into.fields.is_empty() {
        into.fields = from.fields;
    }
    if from.is_oa == Some(true) || into.is_oa.is_none() {
        into.is_oa = from.is_oa.or(into.is_oa);
    }
    into.citation_count = into.citation_count.max(from.citation_count);
    // The longest abstract wins.
    if from.abstract_full.as_ref().map_or(0, String::len) > into.abstract_full.as_ref().map_or(0, String::len) {
        into.abstract_full = from.abstract_full;
    }
    for s in from.sources {
        if !into.sources.contains(&s) {
            into.sources.push(s);
        }
    }
    for h in from.per_source {
        if !into.per_source.iter().any(|x| x.source == h.source) {
            into.per_source.push(h);
        }
    }
}

fn norm_title(t: &str) -> String {
    t.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Lower case letters and digits, Latin accents removed: "Schrödinger's
/// Équation" → "schrodingersequation".
fn fold(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    for c in t.chars().flat_map(char::to_lowercase) {
        match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => out.push('a'),
            'ç' | 'ć' | 'č' => out.push('c'),
            'ď' | 'đ' => out.push('d'),
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => out.push('e'),
            'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ı' => out.push('i'),
            'ł' | 'ľ' => out.push('l'),
            'ñ' | 'ń' | 'ň' => out.push('n'),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => out.push('o'),
            'ř' => out.push('r'),
            'ś' | 'š' | 'ş' => out.push('s'),
            'ť' | 'ţ' => out.push('t'),
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => out.push('u'),
            'ý' | 'ÿ' => out.push('y'),
            'ź' | 'ż' | 'ž' => out.push('z'),
            'ß' => out.push_str("ss"),
            'æ' => out.push_str("ae"),
            'œ' => out.push_str("oe"),
            c if c.is_alphanumeric() => out.push(c),
            _ => {}
        }
    }
    out
}

/// The folded family name: "Yann LeCun" and "LeCun, Yann" → "lecun".
fn surname(name: &str) -> String {
    let family = match name.split_once(',') {
        Some((f, _)) => f,
        None => name.split_whitespace().last().unwrap_or(name),
    };
    fold(family)
}

/// Jaro-Winkler similarity of two strings, 0..1.
pub(crate) fn jaro_winkler(a: &str, b: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() && b.is_empty() {
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
    let mut k = 0;
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
    let prefix = a.iter().zip(&b).take(4).take_while(|(x, y)| x == y).count();
    jaro + prefix as f64 * 0.1 * (1.0 - jaro)
}

// -------------------------------------------------------------- sources --

/// The short snippet the model sees and the longer abstract kept for the
/// library.
fn abstracts(text: &str) -> (Option<String>, Option<String>) {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return (None, None);
    }
    let cap = |max| {
        let (s, cut) = net::cap_chars(&t, max);
        if cut { format!("{s}…") } else { s }
    };
    (Some(cap(ABSTRACT_CHARS)), Some(cap(ABSTRACT_FULL_CHARS)))
}

/// Normalised DOI (lower case, no resolver prefix) and the arXiv id it
/// stands for, if it's one of arXiv's.
fn doi_ids(doi: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(d) = doi.map(bibtex::clean_doi).filter(|d| d.starts_with("10.")) else { return (None, None) };
    let d = d.to_ascii_lowercase();
    let arxiv = bibtex::arxiv_from_doi(&d);
    (Some(d), arxiv)
}

/// A header carrying a key, marked sensitive so it is never printed.
fn secret_header(value: String) -> AiResult<HeaderValue> {
    let mut v = HeaderValue::from_str(&value).map_err(|_| AiError::new(Kind::BadKey, "The saved key can't be used. Replace it in Settings > AI > Web."))?;
    v.set_sensitive(true);
    Ok(v)
}

/// Waits for `host`'s slot, telling the UI when the wait is long.
async fn pace_source(ctx: &NetCtx, source: Option<Source>, host: &str, interval: Duration) -> AiResult<()> {
    let wait = net::reserve(ctx, host, interval);
    if let Some(s) = source.filter(|_| wait >= SHOW_WAIT) {
        report(ctx, s, SourceState::Waiting(wait.as_millis() as u64));
    }
    net::sleep(ctx, wait).await
}

async fn get_json(ctx: &NetCtx, url: reqwest::Url, source: Source, interval: Duration, auth: Option<(&'static str, HeaderValue)>) -> AiResult<Value> {
    let client = ctx.client()?;
    let host = net::host_key(url.as_str());
    let mut tries = 0;
    loop {
        pace_source(ctx, Some(source), &host, interval).await?;
        let mut req = client.get(url.clone()).header(ACCEPT, "application/json");
        if let Some((name, value)) = &auth {
            req = req.header(*name, value.clone());
        }
        let reply = net::send(ctx, req, source.label()).await?;
        if reply.status == StatusCode::TOO_MANY_REQUESTS && tries == 0 {
            // One polite retry, after what the service asks (at most 5 s).
            tries += 1;
            let wait = crate::ai::http::retry_after(&reply.headers).unwrap_or(2).min(5);
            if wait > 0 {
                report(ctx, source, SourceState::Waiting(wait * 1000));
            }
            net::sleep(ctx, Duration::from_secs(wait)).await?;
            continue;
        }
        if !reply.status.is_success() {
            return Err(net::service_error(reply.status, &reply.headers, source.label()));
        }
        return serde_json::from_str(&reply.body)
            .map_err(|_| AiError::new(Kind::BadResponse, format!("{} sent an answer Texo couldn't read.", source.label())));
    }
}

async fn search_crossref(ctx: &NetCtx, q: &SourceQuery<'_>) -> AiResult<Vec<Paper>> {
    let rows = q.rows.to_string();
    let mut pairs = vec![
        ("query.bibliographic", q.text.to_string()),
        ("rows", rows),
        ("select", "DOI,title,author,issued,container-title,abstract,type,URL,is-referenced-by-count,score".to_string()),
    ];
    let mut filters = Vec::new();
    if let Some(y) = q.opts.year_from {
        filters.push(format!("from-pub-date:{y}-01-01"));
    }
    if let Some(y) = q.opts.year_to {
        filters.push(format!("until-pub-date:{y}-12-31"));
    }
    if !filters.is_empty() {
        pairs.push(("filter", filters.join(",")));
    }
    match q.opts.sort {
        SearchSort::Relevance => {}
        SearchSort::Cited => pairs.extend([("sort", "is-referenced-by-count".to_string()), ("order", "desc".to_string())]),
        SearchSort::Newest => pairs.extend([("sort", "published".to_string()), ("order", "desc".to_string())]),
    }
    if let Some(m) = &ctx.contact_email {
        pairs.push(("mailto", m.clone()));
    }
    let pairs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let url = net::with_query(&format!("{}/works", ctx.services.crossref), &pairs)?;
    let v = get_json(ctx, url, Source::Crossref, CROSSREF_INTERVAL, None).await?;
    let items = v.pointer("/message/items").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(items.iter().filter_map(crossref_paper).collect())
}

fn crossref_paper(item: &Value) -> Option<Paper> {
    let title = first_str(item.get("title"))?;
    let (doi, arxiv_id) = doi_ids(item.get("DOI").and_then(Value::as_str));
    let authors = item
        .get("author")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let given = p.get("given").and_then(Value::as_str).unwrap_or_default();
                    match p.get("family").and_then(Value::as_str) {
                        Some(f) => Some(format!("{given} {f}").trim().to_string()),
                        None => p.get("name").and_then(Value::as_str).map(str::to_string),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let year = item
        .pointer("/issued/date-parts/0/0")
        .and_then(Value::as_i64)
        .map(|y| y as i32);
    let (abstract_snippet, abstract_full) =
        item.get("abstract").and_then(Value::as_str).map(|a| abstracts(&strip_markup(a))).unwrap_or_default();
    Some(Paper {
        title: clean_text(&title),
        authors,
        year,
        venue: first_str(item.get("container-title")).map(|v| clean_text(&v)),
        url: doi.as_ref().map(|d| format!("https://doi.org/{d}")),
        doi,
        arxiv_id,
        abstract_snippet,
        abstract_full,
        citation_count: item.get("is-referenced-by-count").and_then(Value::as_u64),
        work_type: item.get("type").and_then(Value::as_str).map(str::to_string),
        sources: vec![Source::Crossref.label().into()],
        ..Paper::default()
    })
}

const S2_FIELDS: &str = "paperId,externalIds,title,abstract,tldr,year,venue,authors,citationCount,influentialCitationCount,openAccessPdf,publicationTypes,fieldsOfStudy,url";

async fn search_s2(ctx: &NetCtx, q: &SourceQuery<'_>) -> AiResult<Vec<Paper>> {
    let limit = q.rows.to_string();
    let mut pairs = vec![("query", q.text.to_string()), ("limit", limit), ("fields", S2_FIELDS.to_string())];
    if q.opts.year_from.is_some() || q.opts.year_to.is_some() {
        let y = |y: Option<i32>| y.map(|y| y.to_string()).unwrap_or_default();
        pairs.push(("year", format!("{}-{}", y(q.opts.year_from), y(q.opts.year_to))));
    }
    if q.opts.oa_only {
        pairs.push(("openAccessPdf", String::new()));
    }
    let pairs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let url = net::with_query(&format!("{}/paper/search", ctx.services.semantic_scholar), &pairs)?;
    let (auth, interval) = match &ctx.s2_key {
        Some(k) => (Some(("x-api-key", secret_header(k.expose().to_string())?)), S2_KEY_INTERVAL),
        None => (None, S2_INTERVAL),
    };
    let v = get_json(ctx, url, Source::SemanticScholar, interval, auth).await?;
    let data = v.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(data.iter().filter_map(s2_paper).collect())
}

fn s2_paper(p: &Value) -> Option<Paper> {
    let title = p.get("title").and_then(Value::as_str).filter(|t| !t.trim().is_empty())?;
    let ids = p.get("externalIds");
    let (doi, arxiv_from) = doi_ids(ids.and_then(|i| i.get("DOI")).and_then(Value::as_str));
    let arxiv_id = ids
        .and_then(|i| i.get("ArXiv"))
        .and_then(Value::as_str)
        .and_then(bibtex::parse_arxiv_id)
        .or(arxiv_from);
    let (abstract_snippet, abstract_full) = p.get("abstract").and_then(Value::as_str).map(abstracts).unwrap_or_default();
    let oa_pdf = p.pointer("/openAccessPdf/url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
    let strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    };
    Some(Paper {
        title: clean_text(title),
        authors: p
            .get("authors")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default(),
        year: p.get("year").and_then(Value::as_i64).map(|y| y as i32),
        venue: p.get("venue").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string),
        doi,
        arxiv_id,
        abstract_snippet,
        abstract_full,
        url: p.get("url").and_then(Value::as_str).map(str::to_string),
        s2_id: p.get("paperId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        citation_count: p.get("citationCount").and_then(Value::as_u64),
        influential_count: p.get("influentialCitationCount").and_then(Value::as_u64),
        tldr: p.pointer("/tldr/text").and_then(Value::as_str).map(collapse).filter(|t| !t.is_empty()),
        oa_status: p
            .pointer("/openAccessPdf/status")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_ascii_lowercase),
        is_oa: oa_pdf.as_ref().map(|_| true),
        oa_pdf,
        work_type: strings(p.get("publicationTypes")).into_iter().next(),
        fields: strings(p.get("fieldsOfStudy")),
        sources: vec![Source::SemanticScholar.label().into()],
        ..Paper::default()
    })
}

async fn search_openalex(ctx: &NetCtx, q: &SourceQuery<'_>) -> AiResult<Vec<Paper>> {
    let Some(key) = &ctx.openalex_key else { return Ok(Vec::new()) };
    let limit = q.rows.to_string();
    let mut pairs = vec![
        ("search", q.text.to_string()),
        ("per-page", limit),
        (
            "select",
            "id,doi,title,publication_year,authorships,primary_location,ids,abstract_inverted_index,cited_by_count,type,open_access,best_oa_location"
                .to_string(),
        ),
    ];
    let mut filters = Vec::new();
    if let Some(y) = q.opts.year_from {
        filters.push(format!("from_publication_date:{y}-01-01"));
    }
    if let Some(y) = q.opts.year_to {
        filters.push(format!("to_publication_date:{y}-12-31"));
    }
    if q.opts.oa_only {
        filters.push("is_oa:true".to_string());
    }
    if !filters.is_empty() {
        pairs.push(("filter", filters.join(",")));
    }
    match q.opts.sort {
        SearchSort::Relevance => {}
        SearchSort::Cited => pairs.push(("sort", "cited_by_count:desc".to_string())),
        SearchSort::Newest => pairs.push(("sort", "publication_date:desc".to_string())),
    }
    let pairs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let url = net::with_query(&format!("{}/works", ctx.services.openalex), &pairs)?;
    let auth = bearer(key)?;
    let v = get_json(ctx, url, Source::OpenAlex, OPENALEX_INTERVAL, Some((AUTHORIZATION.as_str(), auth))).await?;
    let results = v.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(results.iter().filter_map(openalex_paper).collect())
}

fn bearer(key: &ApiKey) -> AiResult<HeaderValue> {
    secret_header(format!("Bearer {}", key.expose()))
}

fn openalex_paper(w: &Value) -> Option<Paper> {
    let title = w.get("title").and_then(Value::as_str).filter(|t| !t.trim().is_empty())?;
    let (doi, arxiv_id) = doi_ids(w.get("doi").and_then(Value::as_str));
    let authors = w
        .get("authorships")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.pointer("/author/display_name").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    let (abstract_snippet, abstract_full) =
        w.get("abstract_inverted_index").and_then(inverted_abstract).map(|a| abstracts(&a)).unwrap_or_default();
    let openalex_id = w
        .get("id")
        .and_then(Value::as_str)
        .map(|id| id.rsplit('/').next().unwrap_or(id).to_string())
        .filter(|id| !id.is_empty());
    Some(Paper {
        title: clean_text(title),
        authors,
        year: w.get("publication_year").and_then(Value::as_i64).map(|y| y as i32),
        venue: w.pointer("/primary_location/source/display_name").and_then(Value::as_str).map(str::to_string),
        url: doi.as_ref().map(|d| format!("https://doi.org/{d}")),
        doi,
        arxiv_id,
        abstract_snippet,
        abstract_full,
        openalex_id,
        citation_count: w.get("cited_by_count").and_then(Value::as_u64),
        is_oa: w.pointer("/open_access/is_oa").and_then(Value::as_bool),
        oa_status: w.pointer("/open_access/oa_status").and_then(Value::as_str).map(str::to_string),
        oa_pdf: w.pointer("/best_oa_location/pdf_url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string),
        work_type: w.get("type").and_then(Value::as_str).map(str::to_string),
        sources: vec![Source::OpenAlex.label().into()],
        ..Paper::default()
    })
}

/// OpenAlex abstracts come as `{word: [positions]}`.
fn inverted_abstract(v: &Value) -> Option<String> {
    let map = v.as_object()?;
    let mut words: Vec<(u64, &str)> = Vec::new();
    for (word, pos) in map {
        for p in pos.as_array()? {
            words.push((p.as_u64()?, word));
        }
        if words.len() > 5000 {
            break;
        }
    }
    words.sort_by_key(|(p, _)| *p);
    Some(words.into_iter().map(|(_, w)| w).collect::<Vec<_>>().join(" "))
}

/// The words of an arXiv query (at most 12, one-letter words dropped).
fn arxiv_words(query: &str) -> Vec<&str> {
    query.split(|c: char| !c.is_alphanumeric() && c != '-').filter(|w| w.chars().count() > 1).take(12).collect()
}

/// The looser query tried once when every word ANDed finds nothing: the
/// title as a phrase for a short query, else its four longest words ORed.
fn arxiv_fallback(words: &[&str]) -> Option<String> {
    if words.len() < 2 {
        return None;
    }
    if words.len() <= 5 {
        return Some(format!("ti:\"{}\"", words.join(" ")));
    }
    let mut longest: Vec<&str> = words.to_vec();
    longest.sort_by_key(|w| std::cmp::Reverse(w.chars().count()));
    Some(longest.iter().take(4).map(|w| format!("all:{w}")).collect::<Vec<_>>().join(" OR "))
}

/// The papers, and whether the answer is complete (false: the strict query
/// found nothing and the looser retry failed, so don't cache it).
async fn search_arxiv(ctx: &NetCtx, q: &SourceQuery<'_>) -> AiResult<(Vec<Paper>, bool)> {
    let words = arxiv_words(q.text);
    if words.is_empty() {
        return Ok((Vec::new(), true));
    }
    let dates = (q.opts.year_from.is_some() || q.opts.year_to.is_some()).then(|| {
        format!(
            " AND submittedDate:[{}01010000 TO {}12312359]",
            q.opts.year_from.unwrap_or(1991),
            q.opts.year_to.unwrap_or(9999)
        )
    });
    let limit = q.rows.to_string();
    let url = |query: String| {
        let full = match &dates {
            Some(d) if query.contains(" OR ") => format!("({query}){d}"),
            Some(d) => format!("{query}{d}"),
            None => query,
        };
        let mut pairs: Vec<(&str, &str)> = vec![("search_query", &full), ("start", "0"), ("max_results", &limit)];
        if q.opts.sort == SearchSort::Newest {
            pairs.extend([("sortBy", "submittedDate"), ("sortOrder", "descending")]);
        }
        net::with_query(&ctx.services.arxiv_api, &pairs)
    };
    let strict = words.iter().map(|w| format!("all:{w}")).collect::<Vec<_>>().join(" AND ");
    let found = arxiv_query(ctx, url(strict)?, true).await?;
    if !found.is_empty() {
        return Ok((found, true));
    }
    let Some(loose) = arxiv_fallback(&words) else { return Ok((found, true)) };
    // Best effort: the strict query did answer, so a failed retry is just
    // "nothing found", but not one to remember.
    match arxiv_query(ctx, url(loose)?, true).await {
        Ok(list) => Ok((list, true)),
        Err(e) if e.kind == Kind::Cancelled => Err(e),
        Err(_) => Ok((found, false)),
    }
}

/// arXiv wants one connection at a time: every request holds this.
fn arxiv_gate() -> &'static tokio::sync::Semaphore {
    static G: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    G.get_or_init(|| tokio::sync::Semaphore::new(1))
}

/// One arXiv API request. `searching`: report waits as search progress.
async fn arxiv_query(ctx: &NetCtx, url: reqwest::Url, searching: bool) -> AiResult<Vec<Paper>> {
    let client = ctx.client()?;
    let _permit = ctx
        .cancel
        .run(async { arxiv_gate().acquire().await.map_err(|_| AiError::new(Kind::Other, "arXiv couldn't be reached.")) })
        .await?;
    pace_source(ctx, searching.then_some(Source::Arxiv), &net::host_key(url.as_str()), ARXIV_INTERVAL).await?;
    let reply = net::send(ctx, client.get(url).header(ACCEPT, "application/atom+xml"), "arXiv").await?;
    if !reply.status.is_success() {
        return Err(net::service_error(reply.status, &reply.headers, "arXiv"));
    }
    Ok(parse_arxiv_feed(&reply.body))
}

/// Reads the entries of an arXiv Atom feed (just the tags Texo needs).
pub(crate) fn parse_arxiv_feed(xml: &str) -> Vec<Paper> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<entry>").or_else(|| rest.find("<entry ")) {
        let after = &rest[start..];
        let end = after.find("</entry>").map(|e| e + 8).unwrap_or(after.len());
        let entry = &after[..end];
        rest = &after[end..];
        let Some(id_url) = tag(entry, "id") else { continue };
        let Some(arxiv_id) = id_url.rsplit_once("/abs/").and_then(|(_, id)| bibtex::parse_arxiv_id(id)) else { continue };
        let Some(title) = tag(entry, "title").map(|t| collapse(&t)).filter(|t| !t.is_empty()) else { continue };
        let mut authors = Vec::new();
        let mut a_rest = entry;
        while let Some(p) = a_rest.find("<author>") {
            let block = &a_rest[p..];
            let e = block.find("</author>").map(|e| e + 9).unwrap_or(block.len());
            if let Some(name) = tag(&block[..e], "name") {
                authors.push(collapse(&name));
            }
            a_rest = &block[e..];
        }
        let year = tag(entry, "published").and_then(|d| d.get(..4).and_then(|y| y.parse().ok()));
        let (doi, _) = doi_ids(tag(entry, "arxiv:doi").as_deref());
        let (abstract_snippet, abstract_full) = tag(entry, "summary").map(|s| abstracts(&s)).unwrap_or_default();
        out.push(Paper {
            title,
            authors,
            year,
            venue: tag(entry, "arxiv:journal_ref").map(|j| collapse(&j)).or_else(|| Some("arXiv".to_string())),
            doi,
            url: Some(format!("https://arxiv.org/abs/{arxiv_id}")),
            oa_pdf: Some(format!("https://arxiv.org/pdf/{arxiv_id}")),
            oa_status: Some("green".to_string()),
            is_oa: Some(true),
            work_type: Some("preprint".to_string()),
            arxiv_id: Some(arxiv_id),
            abstract_snippet,
            abstract_full,
            sources: vec![Source::Arxiv.label().into()],
            ..Paper::default()
        });
    }
    out
}

/// Text of the first `<name ...>text</name>` in `xml`, entities decoded.
fn tag(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}");
    let mut from = 0;
    while let Some(p) = xml[from..].find(&open).map(|p| p + from) {
        let after = &xml[p + open.len()..];
        // `<id>` must not match `<idx>`.
        if !after.starts_with('>') && !after.starts_with(char::is_whitespace) && !after.starts_with('/') {
            from = p + open.len();
            continue;
        }
        let gt = after.find('>')?;
        if after[..gt].ends_with('/') {
            return None;
        }
        let body = &after[gt + 1..];
        let close = format!("</{name}>");
        let end = body.find(&close)?;
        let text = &body[..end];
        let text = text.strip_prefix("<![CDATA[").and_then(|t| t.strip_suffix("]]>")).unwrap_or(text);
        return Some(decode_entities(text).trim().to_string());
    }
    None
}

fn first_str(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => a.iter().find_map(|x| x.as_str().map(str::to_string)),
        _ => None,
    }
    .filter(|s| !s.trim().is_empty())
}

/// Crossref abstracts are JATS XML: keep the words.
fn strip_markup(s: &str) -> String {
    super::html::html_to_text(s).text
}

/// Feed text is already plain once its entities are decoded.
fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_text(s: &str) -> String {
    let t = if s.contains('<') { strip_markup(s) } else { decode_entities(s) };
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ----------------------------------------------------------- get_bibtex --

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BibEntry {
    /// The normalised key, `authorYEARfirstword`.
    pub key: String,
    pub entry_type: String,
    /// The entry, ready to paste into a `.bib` file.
    pub bibtex: String,
    pub title: Option<String>,
    pub year: Option<i32>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    /// Problems found in the entry ("It has no year.").
    pub warnings: Vec<String>,
    /// "doi.org" or "arXiv".
    pub source: String,
}

impl BibEntry {
    pub fn to_tool_text(&self) -> String {
        let mut out = self.bibtex.clone();
        for w in &self.warnings {
            out.push_str(&format!("\n% Warning: {w}"));
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaperId {
    Doi(String),
    Arxiv(String),
}

/// Reads a DOI (`10.1038/nature14539`, `doi:...`, `https://doi.org/...`)
/// or an arXiv id (`1706.03762`, `arXiv:1706.03762v2`, an arxiv.org URL).
pub fn parse_paper_id(input: &str) -> AiResult<PaperId> {
    let s = input.trim();
    let lower = s.to_ascii_lowercase();
    for p in ["https://arxiv.org/abs/", "http://arxiv.org/abs/", "https://arxiv.org/pdf/", "http://arxiv.org/pdf/", "arxiv.org/abs/"] {
        if lower.starts_with(p) {
            let id = s[p.len()..].trim_end_matches(".pdf");
            return bibtex::parse_arxiv_id(id).map(PaperId::Arxiv).ok_or_else(bad_id);
        }
    }
    let doi = bibtex::clean_doi(s);
    if doi.starts_with("10.") && doi.contains('/') {
        if doi.len() > 300 || doi.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(bad_id());
        }
        if let Some(a) = bibtex::arxiv_from_doi(&doi) {
            return Ok(PaperId::Arxiv(a));
        }
        return Ok(PaperId::Doi(doi));
    }
    bibtex::parse_arxiv_id(s).map(PaperId::Arxiv).ok_or_else(bad_id)
}

fn bad_id() -> AiError {
    AiError::invalid("Give a DOI (like 10.1038/nature14539) or an arXiv id (like 2101.00001).")
}

/// BibTeX for a DOI or an arXiv id, normalised and checked.
pub async fn get_bibtex(ctx: &NetCtx, id: &str) -> AiResult<BibEntry> {
    let id = parse_paper_id(id)?;
    let cache_key = format!("bib|{}|{}|{id:?}", ctx.services.doi, ctx.services.arxiv_bibtex);
    if let Some(hit) = net::cache_get::<BibEntry>(&cache_key) {
        return Ok(hit);
    }
    let client = ctx.client()?;
    let (url, label, source) = match &id {
        PaperId::Doi(doi) => (format!("{}/{}", ctx.services.doi, encode_doi(doi)), "doi.org", "doi.org"),
        PaperId::Arxiv(a) => (format!("{}/{}", ctx.services.arxiv_bibtex, a), "arXiv", "arXiv"),
    };
    let interval = if matches!(id, PaperId::Arxiv(_)) { ARXIV_INTERVAL } else { DOI_INTERVAL };
    net::pace(ctx, &net::host_key(&url), interval).await?;
    let req = client.get(&url).header(ACCEPT, "application/x-bibtex; charset=utf-8, text/plain;q=0.5");
    let reply = net::send(ctx, req, label).await?;
    if reply.status == StatusCode::NOT_FOUND {
        return Err(AiError::new(
            Kind::NotFound,
            match id {
                PaperId::Doi(_) => "No paper with that DOI was found. Check it for typos.",
                PaperId::Arxiv(_) => "No arXiv paper with that id was found.",
            },
        ));
    }
    if !reply.status.is_success() {
        return Err(net::service_error(reply.status, &reply.headers, label));
    }
    let body = reply.body.trim();
    let Some(rec) = body.starts_with('@').then(|| bibtex::parse_entries(body)).and_then(|v| v.into_iter().next()) else {
        return Err(AiError::new(Kind::BadResponse, format!("{label} didn't send BibTeX for that paper.")));
    };
    let mut rec = bibtex::normalise(&rec);
    // Keep the identifiers in the entry.
    if let PaperId::Doi(d) = &id {
        if rec.get("doi").is_none() {
            rec.set("doi", format!("{{{d}}}"));
        }
    }
    let warnings = bibtex::validate(&rec);
    if rec.get("title").is_none() {
        return Err(AiError::new(Kind::BadResponse, format!("{label} sent an entry without a title.")));
    }
    let entry = BibEntry {
        key: rec.key.clone(),
        entry_type: rec.entry_type.clone(),
        bibtex: bibtex::format(&rec),
        title: rec.get("title").map(bibtex::plain),
        year: rec.year(),
        doi: rec.doi(),
        arxiv_id: rec.arxiv_id().or(match &id {
            PaperId::Arxiv(a) => Some(a.clone()),
            _ => None,
        }),
        warnings,
        source: source.to_string(),
    };
    net::cache_put(&cache_key, &entry, BIBTEX_TTL);
    Ok(entry)
}

/// DOIs go in the path as they are, except characters a URL can't carry.
fn encode_doi(doi: &str) -> String {
    let mut out = String::new();
    for b in doi.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:;()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ------------------------------------------------------ verify_citation --

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitationStatus {
    /// It points at a real paper and the details agree.
    Verified,
    /// A paper was found, but some details differ (see `differences`).
    Mismatch,
    /// No such paper could be found.
    NotFound,
    /// The entry has too little to check (no title, DOI or arXiv id).
    Unchecked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationCheck {
    pub key: String,
    pub status: CitationStatus,
    /// One plain sentence.
    pub message: String,
    pub differences: Vec<String>,
    /// The paper it was compared with.
    pub found: Option<Paper>,
}

impl CitationCheck {
    pub fn to_tool_text(&self) -> String {
        let mut out = format!("{}: {:?}. {}", self.key, self.status, self.message);
        for d in &self.differences {
            out.push_str(&format!("\n- {d}"));
        }
        if let Some(p) = &self.found {
            out.push_str(&format!("\nFound: {}", p.one_line()));
        }
        out
    }
}

/// Checks the entry `key` of a `.bib` text.
pub async fn verify_citation_in(ctx: &NetCtx, bib_text: &str, key: &str) -> AiResult<CitationCheck> {
    let Some(rec) = bibtex::find_entry(bib_text, key) else {
        return Err(AiError::invalid(format!("There's no entry \"{}\" in the .bib files.", key.trim())));
    };
    verify_citation(ctx, &rec).await
}

/// Checks that an entry resolves: by DOI, else arXiv id, else a title
/// search; then compares title, year and first author.
pub async fn verify_citation(ctx: &NetCtx, rec: &BibRecord) -> AiResult<CitationCheck> {
    let key = rec.key.clone();
    let title = rec.get("title").map(bibtex::plain);
    let check = |status, message: &str, differences, found| CitationCheck { key: key.clone(), status, message: message.to_string(), differences, found };

    let found: Option<Paper> = if let Some(doi) = rec.doi() {
        match doi_metadata(ctx, &doi).await {
            Ok(p) => Some(p),
            Err(e) if e.kind == Kind::NotFound => {
                return Ok(check(CitationStatus::NotFound, "Its DOI doesn't resolve to any paper; it may have a typo.", vec![format!("DOI {doi} was not found.")], None));
            }
            Err(e) => return Err(e),
        }
    } else if let Some(a) = rec.arxiv_id() {
        let url = net::with_query(&ctx.services.arxiv_api, &[("id_list", &a)])?;
        let list = arxiv_query(ctx, url, false).await?;
        match list.into_iter().next() {
            Some(p) => Some(p),
            None => {
                return Ok(check(CitationStatus::NotFound, "Its arXiv id doesn't match any paper.", vec![format!("arXiv {a} was not found.")], None));
            }
        }
    } else if let Some(t) = &title {
        let search = search_papers(ctx, t, 5).await?;
        let best = search
            .papers
            .into_iter()
            .map(|p| (title_similarity(t, &p.title), p))
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        match best {
            Some((sim, p)) if sim >= 0.8 => Some(p),
            _ => {
                return Ok(check(
                    CitationStatus::NotFound,
                    "No paper with this title was found in arXiv, Crossref or Semantic Scholar.",
                    Vec::new(),
                    None,
                ));
            }
        }
    } else {
        return Ok(check(CitationStatus::Unchecked, "The entry has no title, DOI or arXiv id to check.", Vec::new(), None));
    };
    let Some(found) = found else {
        return Ok(check(CitationStatus::NotFound, "No matching paper was found.", Vec::new(), None));
    };

    let mut diffs = Vec::new();
    if let Some(t) = &title {
        let sim = title_similarity(t, &found.title);
        if sim < 0.8 {
            diffs.push(format!("The title differs: the entry says \"{t}\", the paper is \"{}\".", found.title));
        }
    }
    if let (Some(y), Some(fy)) = (rec.year(), found.year) {
        if (y - fy).abs() > 1 {
            diffs.push(format!("The year differs: the entry says {y}, the paper says {fy}."));
        }
    }
    let surnames = rec.surnames();
    if let (Some(first), Some(fa)) = (surnames.first(), found.authors.first()) {
        let a = norm_title(first);
        let fa_norm = norm_title(fa);
        if !a.is_empty() && !fa_norm.contains(&a) && !found.authors.iter().take(3).any(|x| norm_title(x).contains(&a)) {
            diffs.push(format!("The first author differs: the entry says {first}, the paper lists {fa}."));
        }
    }
    if rec.doi().is_none() {
        if let Some(d) = &found.doi {
            if diffs.is_empty() && bibtex::arxiv_from_doi(d).is_none() {
                diffs.push(format!("The entry has no DOI; the paper's DOI is {d}."));
                return Ok(check(CitationStatus::Verified, "It matches a real paper (you could add its DOI).", diffs, Some(found)));
            }
        }
    }
    if diffs.is_empty() {
        Ok(check(CitationStatus::Verified, "It matches a real paper.", diffs, Some(found)))
    } else {
        Ok(check(CitationStatus::Mismatch, "A paper was found, but some details don't match.", diffs, Some(found)))
    }
}

/// Metadata of a DOI as CSL JSON (doi.org content negotiation works for
/// Crossref, DataCite and the other agencies).
async fn doi_metadata(ctx: &NetCtx, doi: &str) -> AiResult<Paper> {
    let client = ctx.client()?;
    let url = format!("{}/{}", ctx.services.doi, encode_doi(doi));
    net::pace(ctx, &net::host_key(&url), DOI_INTERVAL).await?;
    let reply = net::send(ctx, client.get(&url).header(ACCEPT, "application/vnd.citationstyles.csl+json"), "doi.org").await?;
    if reply.status == StatusCode::NOT_FOUND {
        return Err(AiError::new(Kind::NotFound, "No paper with that DOI was found."));
    }
    if !reply.status.is_success() {
        return Err(net::service_error(reply.status, &reply.headers, "doi.org"));
    }
    let v: Value = serde_json::from_str(&reply.body)
        .map_err(|_| AiError::new(Kind::BadResponse, "doi.org sent an answer Texo couldn't read."))?;
    let title = first_str(v.get("title")).map(|t| clean_text(&t)).unwrap_or_default();
    let authors = v
        .get("author")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let given = p.get("given").and_then(Value::as_str).unwrap_or_default();
                    p.get("family")
                        .and_then(Value::as_str)
                        .map(|f| format!("{given} {f}").trim().to_string())
                        .or_else(|| p.get("literal").and_then(Value::as_str).map(str::to_string))
                })
                .collect()
        })
        .unwrap_or_default();
    let year = ["issued", "published-print", "published-online", "created"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|d| d.pointer("/date-parts/0/0")).and_then(|y| y.as_i64().or_else(|| y.as_str().and_then(|s| s.parse().ok()))))
        .map(|y| y as i32);
    let (doi_norm, arxiv_id) = doi_ids(Some(doi));
    Ok(Paper {
        title,
        authors,
        year,
        venue: first_str(v.get("container-title")).or_else(|| first_str(v.get("publisher"))),
        url: Some(format!("https://doi.org/{doi}")),
        doi: doi_norm,
        arxiv_id,
        sources: vec!["doi.org".into()],
        ..Paper::default()
    })
}

/// Word-overlap similarity of two titles, 0..1 (Dice on word sets).
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let words = |s: &str| -> HashMap<String, usize> {
        let mut m = HashMap::new();
        for w in s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
            *m.entry(w.to_lowercase()).or_insert(0) += 1;
        }
        m
    };
    let (wa, wb) = (words(a), words(b));
    let total: usize = wa.values().sum::<usize>() + wb.values().sum::<usize>();
    if total == 0 {
        return 0.0;
    }
    let common: usize = wa.iter().map(|(w, n)| (*n).min(*wb.get(w).unwrap_or(&0))).sum();
    2.0 * common as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http::{ApiKey, Cancel};
    use crate::ai::mock::{runtime, Canned, MockServer};

    const ATOM: &str = r#"<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/x</id>
  <title>arXiv Query: search_query=all:attention</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All
      You Need</title>
    <updated>2023-08-02T00:41:18Z</updated>
    <summary>The dominant sequence transduction models are based on complex recurrent &amp; convolutional networks.</summary>
    <published>2017-06-12T17:57:34Z</published>
    <arxiv:comment>15 pages</arxiv:comment>
    <author>
      <name>Ashish Vaswani</name>
    </author>
    <author>
      <name>Noam Shazeer</name>
    </author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <title>Another &lt;Paper&gt;</title>
    <published>2021-01-01T00:00:00Z</published>
    <arxiv:doi>10.1000/another</arxiv:doi>
    <arxiv:journal_ref>J. Testing 1 (2021)</arxiv:journal_ref>
    <author><name>Jane Roe</name></author>
  </entry>
</feed>"#;

    fn atom(body: &str) -> Canned {
        let mut c = Canned::json(200, Value::Null);
        c.body = body.to_string();
        c.content_type = "application/atom+xml";
        c
    }

    fn text(status: u16, body: &str, ct: &'static str) -> Canned {
        let mut c = Canned::json(status, Value::Null);
        c.body = body.to_string();
        c.content_type = ct;
        c
    }

    struct Mocks {
        arxiv: MockServer,
        crossref: MockServer,
        s2: MockServer,
    }

    fn ctx_for(m: &Mocks) -> NetCtx {
        let mut c = NetCtx::new(Cancel::default());
        c.services.pacing = false;
        c.services.arxiv_api = format!("{}/api/query", m.arxiv.base_url);
        c.services.crossref = m.crossref.base_url.clone();
        c.services.semantic_scholar = format!("{}/graph/v1", m.s2.base_url);
        c
    }

    fn crossref_reply() -> Canned {
        Canned::json(
            200,
            serde_json::json!({"status": "ok", "message": {"items": [
                {"DOI": "10.48550/ARXIV.1706.03762", "title": ["Attention Is All You Need"], "author": [{"given": "Ashish", "family": "Vaswani"}], "issued": {"date-parts": [[2017]]}, "type": "posted-content"},
                {"DOI": "10.1038/nature14539", "title": ["Deep learning"], "author": [{"given": "Yann", "family": "LeCun"}, {"name": "Consortium"}], "issued": {"date-parts": [[2015, 5]]}, "container-title": ["Nature"], "abstract": "<jats:p>Deep learning allows <jats:italic>models</jats:italic>.</jats:p>"}
            ]}}),
        )
    }

    fn s2_reply() -> Canned {
        Canned::json(
            200,
            serde_json::json!({"total": 2, "offset": 0, "data": [
                {"paperId": "a", "title": "Deep Learning", "year": 2015, "venue": "Nature", "externalIds": {"DOI": "10.1038/NATURE14539", "MAG": "1"}, "authors": [{"authorId": "1", "name": "Yann LeCun"}], "abstract": null},
                {"paperId": "b", "title": "Something else entirely", "year": 2020, "venue": "", "externalIds": {"ArXiv": "2005.14165"}, "authors": []}
            ]}),
        )
    }

    #[test]
    fn parses_the_arxiv_feed() {
        let papers = parse_arxiv_feed(ATOM);
        assert_eq!(papers.len(), 2);
        let p = &papers[0];
        assert_eq!(p.title, "Attention Is All You Need");
        assert_eq!(p.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(p.year, Some(2017));
        assert_eq!(p.authors, vec!["Ashish Vaswani", "Noam Shazeer"]);
        assert!(p.abstract_snippet.as_deref().unwrap().contains("recurrent & convolutional"));
        assert_eq!(papers[1].title, "Another <Paper>");
        assert_eq!(papers[1].doi.as_deref(), Some("10.1000/another"));
        assert_eq!(papers[1].venue.as_deref(), Some("J. Testing 1 (2021)"));
    }

    #[test]
    fn search_merges_and_dedupes() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![atom(ATOM)]),
                crossref: MockServer::start(vec![crossref_reply()]),
                s2: MockServer::start(vec![s2_reply()]),
            };
            let c = ctx_for(&m);
            let r = search_papers(&c, "  attention   deep learning ", 8).await.unwrap();
            assert!(r.notes.is_empty(), "{:?}", r.notes);
            // Attention (arXiv + Crossref via arXiv DOI), Deep learning
            // (Crossref + S2 via DOI), Something else, Another <Paper>.
            assert_eq!(r.papers.len(), 4, "{:#?}", r.papers);
            let deep = r.papers.iter().find(|p| p.doi.as_deref() == Some("10.1038/nature14539")).unwrap();
            assert_eq!(deep.sources.len(), 2);
            assert_eq!(deep.venue.as_deref(), Some("Nature"));
            assert!(deep.abstract_snippet.as_deref().unwrap().contains("Deep learning allows models."));
            // Fields come from the best-ranked source first.
            assert_eq!(deep.authors, vec!["Yann LeCun"]);
            assert_eq!(deep.title, "Deep Learning");
            let att = r.papers.iter().find(|p| p.arxiv_id.as_deref() == Some("1706.03762")).unwrap();
            assert_eq!(att.sources.len(), 2);
            // Found twice ranks above found once.
            assert!(r.papers[0].sources.len() == 2 && r.papers[1].sources.len() == 2);

            let arxiv_q = &m.arxiv.recorded()[0].path;
            assert!(arxiv_q.contains("search_query=all%3Aattention+AND+all%3Adeep+AND+all%3Alearning"), "{arxiv_q}");
            let cr = &m.crossref.recorded()[0];
            assert!(cr.path.starts_with("/works?query.bibliographic=attention+deep+learning"), "{}", cr.path);
            assert!(!cr.path.contains("mailto"));
            assert!(m.s2.recorded()[0].path.starts_with("/graph/v1/paper/search?query=attention+deep+learning&limit=8"));
            assert!(r.to_tool_text().contains("DOI: 10.1038/nature14539"));
        });
    }

    #[test]
    fn one_busy_source_is_a_note_not_a_failure() {
        let rt = runtime();
        rt.block_on(async {
            let busy = || Canned::json(429, serde_json::json!({"message": "Too Many Requests.", "code": "429"})).header("retry-after", "0");
            let m = Mocks {
                arxiv: MockServer::start(vec![atom("<feed></feed>")]),
                crossref: MockServer::start(vec![crossref_reply()]),
                // Retried once politely, then given up on.
                s2: MockServer::start(vec![busy(), busy()]),
            };
            let mut c = ctx_for(&m);
            c.contact_email = Some("someone@example.org".into());
            let r = search_papers(&c, "deep learning busy", 3).await.unwrap();
            assert_eq!(r.papers.len(), 2);
            assert_eq!(r.notes, vec!["Semantic Scholar was busy, so its results are missing."]);
            assert_eq!(m.s2.recorded().len(), 2);
            assert!(m.crossref.recorded()[0].path.contains("mailto=someone%40example.org"));
        });
    }

    #[test]
    fn all_sources_down_is_an_error() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![Canned::json(503, Value::Null)]),
                crossref: MockServer::start(vec![Canned::json(500, Value::Null)]),
                s2: MockServer::start(vec![Canned::json(500, Value::Null)]),
            };
            let err = search_papers(&ctx_for(&m), "nothing works here", 3).await.unwrap_err();
            assert!(err.message.starts_with("No paper database could be reached."), "{err:?}");
            assert_eq!(search_papers(&ctx_for(&m), "   ", 3).await.unwrap_err().kind, Kind::InvalidInput);
        });
    }

    #[test]
    fn openalex_only_with_a_key() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![atom("<feed></feed>")]),
                crossref: MockServer::start(vec![Canned::json(200, serde_json::json!({"message": {"items": []}}))]),
                s2: MockServer::start(vec![Canned::json(200, serde_json::json!({"total": 0, "offset": 0, "data": []}))]),
            };
            let oa = MockServer::start(vec![Canned::json(
                200,
                serde_json::json!({"meta": {}, "results": [{
                    "id": "https://openalex.org/W1", "doi": "https://doi.org/10.5555/OA.1", "title": "Open work",
                    "publication_year": 2022, "authorships": [{"author": {"display_name": "Ada Lovelace"}}],
                    "primary_location": {"source": {"display_name": "Journal of Openness"}},
                    "abstract_inverted_index": {"world": [1], "Hello": [0], "again": [2]}
                }]}),
            )]);
            let mut c = ctx_for(&m);
            c.services.openalex = oa.base_url.clone();
            c.openalex_key = Some(ApiKey::new("oa-key-1234567".into()));
            let r = search_papers(&c, "open work", 3).await.unwrap();
            assert_eq!(r.papers.len(), 1);
            let p = &r.papers[0];
            assert_eq!(p.doi.as_deref(), Some("10.5555/oa.1"));
            assert_eq!(p.abstract_snippet.as_deref(), Some("Hello world again"));
            assert_eq!(p.venue.as_deref(), Some("Journal of Openness"));
            let rec = &oa.recorded()[0];
            // The key travels in a header, never in the address.
            assert!(rec.path.contains("search=open+work"), "{}", rec.path);
            assert!(!rec.path.contains("api_key") && !rec.path.contains("oa-key-1234567"), "{}", rec.path);
            assert_eq!(rec.header("authorization"), Some("Bearer oa-key-1234567"));
            assert!(rec.path.contains("cited_by_count") && rec.path.contains("best_oa_location"), "{}", rec.path);
        });
    }

    #[test]
    fn bibtex_from_doi_and_arxiv() {
        let rt = runtime();
        rt.block_on(async {
            let doi = MockServer::start(vec![
                text(200, "@article{LeCun_2015, title={Deep learning}, DOI={10.1038/nature14539}, journal={Nature}, author={LeCun, Yann and Bengio, Yoshua}, year={2015}, month=May, pages={436–444} }", "application/x-bibtex"),
                text(404, "not found", "text/html"),
                text(200, "<html>a landing page</html>", "text/html"),
            ]);
            let arxiv = MockServer::start(vec![text(
                200,
                "\n@misc{vaswani2023attentionneed,\n      title={Attention Is All You Need}, \n      author={Ashish Vaswani and Noam Shazeer},\n      year={2023},\n      eprint={1706.03762},\n      archivePrefix={arXiv},\n      primaryClass={cs.CL},\n      url={https://arxiv.org/abs/1706.03762}, \n}",
                "text/plain; charset=utf-8",
            )]);
            let mut c = NetCtx::new(Cancel::default());
            c.services.pacing = false;
            c.services.doi = doi.base_url.clone();
            c.services.arxiv_bibtex = format!("{}/bibtex", arxiv.base_url);

            let e = get_bibtex(&c, "https://doi.org/10.1038/nature14539").await.unwrap();
            assert_eq!(e.key, "lecun2015deep");
            assert!(e.bibtex.starts_with("@article{lecun2015deep,"));
            assert!(e.bibtex.contains("pages = {436--444}"));
            assert!(e.warnings.is_empty(), "{:?}", e.warnings);
            let rec = &doi.recorded()[0];
            assert_eq!(rec.path, "/10.1038/nature14539");
            assert!(rec.header("accept").unwrap().starts_with("application/x-bibtex"));

            let err = get_bibtex(&c, "10.9999/missing").await.unwrap_err();
            assert_eq!(err.kind, Kind::NotFound);
            let err = get_bibtex(&c, "10.9999/landing").await.unwrap_err();
            assert_eq!(err.kind, Kind::BadResponse);

            let e = get_bibtex(&c, "arXiv:1706.03762v7").await.unwrap();
            assert_eq!(e.key, "vaswani2023attention");
            assert_eq!(e.arxiv_id.as_deref(), Some("1706.03762"));
            assert_eq!(arxiv.recorded()[0].path, "/bibtex/1706.03762");
            // arXiv DOIs go to arXiv too; cached now, so no new request.
            let again = get_bibtex(&c, "10.48550/arXiv.1706.03762").await.unwrap();
            assert_eq!(again, e);
            assert_eq!(arxiv.recorded().len(), 1);

            assert_eq!(get_bibtex(&c, "not an id").await.unwrap_err().kind, Kind::InvalidInput);
            assert_eq!(get_bibtex(&c, "../../etc/passwd").await.unwrap_err().kind, Kind::InvalidInput);
        });
    }

    #[test]
    fn paper_ids() {
        assert_eq!(parse_paper_id("doi:10.1000/ABC").unwrap(), PaperId::Doi("10.1000/ABC".into()));
        assert_eq!(parse_paper_id("https://arxiv.org/pdf/2101.00001v2.pdf").unwrap(), PaperId::Arxiv("2101.00001".into()));
        assert_eq!(parse_paper_id("hep-th/9901001").unwrap(), PaperId::Arxiv("hep-th/9901001".into()));
        assert!(parse_paper_id("10.1000/has space").is_err());
        assert_eq!(encode_doi("10.1002/(SICI)1097-4571<3>"), "10.1002/(SICI)1097-4571%3C3%3E");
    }

    #[test]
    fn verifies_citations() {
        let rt = runtime();
        rt.block_on(async {
            let csl = serde_json::json!({"title": "Deep learning", "author": [{"given": "Yann", "family": "LeCun"}], "issued": {"date-parts": [[2015, 5, 27]]}, "container-title": "Nature", "DOI": "10.1038/nature14539"});
            let doi = MockServer::start(vec![
                Canned::json(200, csl.clone()),
                Canned::json(200, csl),
                text(404, "", "text/html"),
            ]);
            let arxiv = MockServer::start(vec![atom(ATOM)]);
            let mut c = NetCtx::new(Cancel::default());
            c.services.pacing = false;
            c.services.doi = doi.base_url.clone();
            c.services.arxiv_api = format!("{}/api/query", arxiv.base_url);
            let bib = "@article{good, author={LeCun, Yann}, title={Deep Learning}, journal={Nature}, year={2015}, doi={10.1038/nature14539}}\n\
                @article{wrong, author={Smith, John}, title={Shallow thoughts}, year={1999}, doi={10.1038/nature14539}}\n\
                @article{typo, author={A}, title={B}, year={2000}, doi={10.1038/nature1453X}}\n\
                @misc{arx, author={Vaswani, Ashish}, title={Attention is all you need}, year={2017}, eprint={1706.03762}, archivePrefix={arXiv}}\n\
                @misc{empty, note={nothing}}";

            let r = verify_citation_in(&c, bib, "good").await.unwrap();
            assert_eq!(r.status, CitationStatus::Verified, "{r:?}");
            assert_eq!(doi.recorded()[0].header("accept"), Some("application/vnd.citationstyles.csl+json"));

            let r = verify_citation_in(&c, bib, "wrong").await.unwrap();
            assert_eq!(r.status, CitationStatus::Mismatch);
            assert_eq!(r.differences.len(), 3, "{:?}", r.differences);

            let r = verify_citation_in(&c, bib, "typo").await.unwrap();
            assert_eq!(r.status, CitationStatus::NotFound);

            let r = verify_citation_in(&c, bib, "arx").await.unwrap();
            assert_eq!(r.status, CitationStatus::Verified, "{r:?}");
            assert!(arxiv.recorded()[0].path.contains("id_list=1706.03762"));

            let r = verify_citation_in(&c, bib, "empty").await.unwrap();
            assert_eq!(r.status, CitationStatus::Unchecked);
            assert_eq!(verify_citation_in(&c, bib, "absent").await.unwrap_err().kind, Kind::InvalidInput);
            assert!(r.to_tool_text().starts_with("empty: Unchecked."));
        });
    }

    #[test]
    fn verifies_by_title_search() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![atom(ATOM), atom("<feed></feed>")]),
                crossref: MockServer::start(vec![crossref_reply(), Canned::json(200, serde_json::json!({"message": {"items": []}}))]),
                s2: MockServer::start(vec![s2_reply(), Canned::json(200, serde_json::json!({"data": []}))]),
            };
            let c = ctx_for(&m);
            let bib = "@article{t, author={Yann LeCun}, title={{Deep} learning}, year={2015}}\n@article{u, author={X}, title={A title nobody ever wrote}, year={2015}}";
            let r = verify_citation_in(&c, bib, "t").await.unwrap();
            assert_eq!(r.status, CitationStatus::Verified, "{r:?}");
            assert!(r.message.contains("DOI"), "{r:?}");
            let r = verify_citation_in(&c, bib, "u").await.unwrap();
            assert_eq!(r.status, CitationStatus::NotFound);
        });
    }

    #[test]
    fn similarity() {
        assert!(title_similarity("Attention Is All You Need", "attention is all you need") > 0.99);
        assert!(title_similarity("Deep learning", "Shallow thoughts") < 0.1);
        assert!(title_similarity("BERT: Pre-training of deep bidirectional transformers", "BERT pre-training of deep bidirectional transformers for language understanding") > 0.7);
    }

    // ------------------------------------------------ v1.3 search quality --

    use std::sync::{Arc, Mutex};

    /// Records the progress events; caches like [`MemoryHooks`].
    #[derive(Default)]
    struct Recorder(Mutex<Vec<SourceEvent>>);

    impl Recorder {
        fn states(&self, s: Source) -> Vec<SourceState> {
            self.0.lock().unwrap().iter().filter(|e| e.source == s).map(|e| e.state.clone()).collect()
        }
    }

    impl SearchHooks for Recorder {
        fn cached(&self, source: Source, key: &str) -> Option<String> {
            MemoryHooks.cached(source, key)
        }
        fn store(&self, source: Source, key: &str, body: &str, ttl: Duration) {
            MemoryHooks.store(source, key, body, ttl)
        }
        fn progress(&self, ev: SourceEvent) {
            self.0.lock().unwrap().push(ev);
        }
        fn boost(&self, _p: &Paper) -> f64 {
            0.0
        }
    }

    fn only(sources: &[Source]) -> SourceSet {
        SourceSet {
            s2: sources.contains(&Source::SemanticScholar),
            crossref: sources.contains(&Source::Crossref),
            arxiv: sources.contains(&Source::Arxiv),
            openalex: sources.contains(&Source::OpenAlex),
        }
    }

    fn paper(title: &str, author: &str, year: i32) -> Paper {
        Paper { title: title.into(), authors: vec![author.into()], year: Some(year), ..Paper::default() }
    }

    #[test]
    fn fusion_order_is_deterministic() {
        let lists = || {
            vec![
                (Source::SemanticScholar, vec![paper("Graph neural networks for chemistry", "Ann Lee", 2020), {
                    let mut p = paper("Message passing on molecules", "Bo Chan", 2017);
                    p.doi = Some("10.1/mp".into());
                    p.citation_count = Some(900);
                    p
                }]),
                (Source::Crossref, vec![{
                    let mut p = paper("Message Passing on Molecules", "Bo Chan", 2017);
                    p.doi = Some("10.1/MP".into());
                    p
                }, paper("A survey of chemistry software", "Cy Dee", 2010)]),
                (Source::Arxiv, vec![{
                    let mut p = paper("Equivariant graph networks", "Di Eve", 2021);
                    p.arxiv_id = Some("2101.00002".into());
                    p
                }]),
            ]
        };
        let titles = |v: Vec<Paper>| v.into_iter().map(|p| p.title).collect::<Vec<_>>();
        let opts = SearchOpts::default();
        let first = titles(fuse(lists(), "graph networks chemistry", &opts, &MemoryHooks, 10));
        assert_eq!(
            first,
            vec![
                // Found twice (S2 rank 2 + Crossref rank 1) and cited.
                "Message passing on molecules",
                "Graph neural networks for chemistry",
                "Equivariant graph networks",
                "A survey of chemistry software",
            ]
        );
        for _ in 0..5 {
            assert_eq!(titles(fuse(lists(), "graph networks chemistry", &opts, &MemoryHooks, 10)), first);
        }
        // Sorts and filters.
        let newest = SearchOpts { sort: SearchSort::Newest, ..SearchOpts::default() };
        assert_eq!(titles(fuse(lists(), "x", &newest, &MemoryHooks, 2)), vec!["Equivariant graph networks", "Graph neural networks for chemistry"]);
        let cited = SearchOpts { sort: SearchSort::Cited, ..SearchOpts::default() };
        assert_eq!(titles(fuse(lists(), "x", &cited, &MemoryHooks, 1)), vec!["Message passing on molecules"]);
        let recent_oa = SearchOpts { year_from: Some(2018), oa_only: true, ..SearchOpts::default() };
        assert_eq!(titles(fuse(lists(), "x", &recent_oa, &MemoryHooks, 10)), vec!["Equivariant graph networks"]);
        let old = SearchOpts { year_to: Some(2015), ..SearchOpts::default() };
        assert_eq!(titles(fuse(lists(), "x", &old, &MemoryHooks, 10)), vec!["A survey of chemistry software"]);
    }

    #[test]
    fn a_preprint_and_its_published_version_merge() {
        let pre_title = "Neural machine translation by jointly learning to align and translate";
        let pub_title = "Neural machine translation by jointly learning alignment and translation";
        let jw = jaro_winkler(&fold(pre_title), &fold(pub_title));
        assert!((0.955..0.97).contains(&jw), "{jw}");
        let mut pre = paper(pre_title, "Dzmitry Bahdanau", 2014);
        pre.arxiv_id = Some("1409.0473".into());
        pre.doi = Some("10.48550/arxiv.1409.0473".into());
        pre.sources = vec!["arXiv".into()];
        let mut publ = paper(pub_title, "Bahdanau, Dzmitry", 2015);
        publ.doi = Some("10.5555/iclr.2015".into());
        publ.citation_count = Some(30000);
        publ.sources = vec!["Crossref".into()];
        let merged = fuse(vec![(Source::Crossref, vec![publ.clone()]), (Source::Arxiv, vec![pre.clone()])], "nmt", &SearchOpts::default(), &MemoryHooks, 8);
        assert_eq!(merged.len(), 1, "{merged:#?}");
        let m = &merged[0];
        assert_eq!(m.doi.as_deref(), Some("10.5555/iclr.2015"), "the publisher DOI wins");
        assert_eq!(m.arxiv_id.as_deref(), Some("1409.0473"));
        assert_eq!(m.sources, vec!["Crossref", "arXiv"]);
        assert_eq!(m.citation_count, Some(30000));

        // Two years apart, another first author, or two publisher DOIs: two papers.
        let mut far = pre.clone();
        far.year = Some(2017);
        assert!(!same_paper(&publ, &far));
        let mut other = pre.clone();
        other.authors = vec!["Someone Else".into()];
        assert!(!same_paper(&publ, &other));
        let mut twin = publ.clone();
        twin.doi = Some("10.5555/other".into());
        assert!(!same_paper(&publ, &twin));
        // Accents and case don't matter.
        assert_eq!(fold("Schrödinger's Équation"), "schrodingersequation");
        assert!(jaro_winkler("martha", "marhta") > 0.96 && jaro_winkler("abc", "xyz") == 0.0);
    }

    #[test]
    fn arxiv_retries_a_looser_query_when_and_finds_nothing() {
        let rt = runtime();
        rt.block_on(async {
            let arxiv = MockServer::start(vec![atom("<feed></feed>"), atom(ATOM)]);
            let mut c = NetCtx::new(Cancel::default());
            c.services.pacing = false;
            c.services.arxiv_api = format!("{}/api/query", arxiv.base_url);
            c.sources = only(&[Source::Arxiv]);
            let r = search_papers(&c, "attention is all you need", 5).await.unwrap();
            assert_eq!(r.papers.len(), 2);
            let rec = arxiv.recorded();
            assert_eq!(rec.len(), 2);
            assert!(rec[0].path.contains("all%3Aattention+AND+all%3Ais"), "{}", rec[0].path);
            assert!(rec[1].path.contains("search_query=ti%3A%22attention+is+all+you+need%22"), "{}", rec[1].path);
            assert_eq!(arxiv_fallback(&arxiv_words("one two three four five six seven")).unwrap(), "all:three OR all:seven OR all:four OR all:five");
            assert_eq!(arxiv_fallback(&["single"]), None);
        });
    }

    #[test]
    fn a_failed_arxiv_retry_is_not_cached() {
        let rt = runtime();
        rt.block_on(async {
            // Strict query: nothing. Retry: 503. Next search: both asked again.
            let arxiv = MockServer::start(vec![atom("<feed></feed>"), Canned::json(503, Value::Null), atom("<feed></feed>"), atom(ATOM)]);
            let mut c = NetCtx::new(Cancel::default());
            c.services.pacing = false;
            c.services.arxiv_api = format!("{}/api/query", arxiv.base_url);
            c.sources = only(&[Source::Arxiv]);
            let rec = Arc::new(Recorder::default());
            c.hooks = rec.clone();
            let r = search_papers(&c, "uncached retry words here", 5).await.unwrap();
            assert!(r.papers.is_empty());
            assert_eq!(arxiv.recorded().len(), 2);
            let r = search_papers(&c, "uncached retry words here", 5).await.unwrap();
            assert_eq!(r.papers.len(), 2, "arXiv was asked again");
            assert_eq!(arxiv.recorded().len(), 4);
            // That complete answer is cached.
            let r = search_papers(&c, "uncached retry words here", 5).await.unwrap();
            assert_eq!(r.papers.len(), 2);
            assert_eq!(arxiv.recorded().len(), 4);
        });
    }

    #[test]
    fn near_titles_need_both_authors_and_years_and_the_same_part() {
        // JW 0.956 after folding, but two papers.
        let a = Paper { title: "A survey on large language models".into(), year: Some(2023), ..Paper::default() };
        let b = Paper { title: "A survey of large language models".into(), year: Some(2023), ..Paper::default() };
        assert!(jaro_winkler(&fold(&a.title), &fold(&b.title)) >= SAME_TITLE_JW);
        assert!(!same_paper(&a, &b));
        let with_author = |p: &Paper| Paper { authors: vec!["Wayne Zhao".into()], ..p.clone() };
        assert!(!same_paper(&with_author(&a), &b), "one side has no authors");
        assert!(!same_paper(&with_author(&a), &Paper { year: None, ..with_author(&b) }), "one side has no year");

        let mut one = paper("Convergence of stochastic gradient descent, part I", "Ann Lee", 2019);
        one.doi = Some("10.1/sgd1".into());
        let mut two = paper("Convergence of stochastic gradient descent, part II", "Ann Lee", 2020);
        two.arxiv_id = Some("2001.00001".into());
        assert!(jaro_winkler(&fold(&one.title), &fold(&two.title)) >= SAME_TITLE_JW);
        assert!(!same_paper(&one, &two));
        let vol = |n: &str| paper(&format!("Handbook of numerical analysis, volume {n}"), "Ann Lee", 2019);
        assert!(!same_paper(&vol("1"), &vol("2")));
        assert_eq!(numerals("Part IV: 3 cases"), vec!["iv", "3"]);
    }

    #[test]
    fn a_refusal_names_the_key_only_when_one_is_set() {
        let refused = net::service_error(reqwest::StatusCode::FORBIDDEN, &reqwest::header::HeaderMap::new(), "Semantic Scholar");
        let mut c = NetCtx::new(Cancel::default());
        assert_eq!(source_note(&c, Source::SemanticScholar, &refused), "Semantic Scholar refused the request, so its results are missing.");
        c.s2_key = Some(ApiKey::new("s2-secret-0123456789".into()));
        let note = source_note(&c, Source::SemanticScholar, &refused);
        assert!(note.contains("didn't accept the key") && !note.contains("s2-secret"), "{note}");
        assert!(source_note(&c, Source::OpenAlex, &refused).contains("refused the request"));
    }

    #[test]
    fn semantic_scholar_metadata_is_read() {
        let rt = runtime();
        rt.block_on(async {
            let s2 = MockServer::start(vec![Canned::json(
                200,
                serde_json::json!({"total": 1, "offset": 0, "data": [{
                    "paperId": "649def34f8be52c8b66281af98ae884c09aef38b", "title": "Attention is All you Need", "year": 2017,
                    "venue": "Neural Information Processing Systems", "externalIds": {"ArXiv": "1706.03762", "CorpusId": 13756489},
                    "authors": [{"name": "Ashish Vaswani"}], "abstract": "The dominant sequence transduction models.",
                    "citationCount": 120000, "influentialCitationCount": 15000,
                    "tldr": {"model": "tldr@v2.0.0", "text": "A new simple network architecture, the Transformer."},
                    "openAccessPdf": {"url": "https://arxiv.org/pdf/1706.03762", "status": "GREEN"},
                    "publicationTypes": ["JournalArticle", "Conference"], "fieldsOfStudy": ["Computer Science"]
                }]}),
            )]);
            let mut c = NetCtx::new(Cancel::default());
            c.services.pacing = false;
            c.services.semantic_scholar = format!("{}/graph/v1", s2.base_url);
            c.sources = only(&[Source::SemanticScholar]);
            let r = search_papers(&c, "transformer attention", 5).await.unwrap();
            let p = &r.papers[0];
            assert_eq!(p.s2_id.as_deref(), Some("649def34f8be52c8b66281af98ae884c09aef38b"));
            assert_eq!(p.citation_count, Some(120000));
            assert_eq!(p.influential_count, Some(15000));
            assert_eq!(p.tldr.as_deref(), Some("A new simple network architecture, the Transformer."));
            assert_eq!(p.oa_pdf.as_deref(), Some("https://arxiv.org/pdf/1706.03762"));
            assert_eq!(p.oa_status.as_deref(), Some("green"));
            assert_eq!(p.is_oa, Some(true));
            assert_eq!(p.work_type.as_deref(), Some("JournalArticle"));
            assert_eq!(p.fields, vec!["Computer Science"]);
            assert_eq!(p.abstract_full.as_deref(), Some("The dominant sequence transduction models."));
            assert_eq!(p.per_source, vec![SourceHit { source: Source::SemanticScholar, rank: 1, citations: Some(120000) }]);
            assert!(r.to_tool_text().contains("Cited by 120000"));
            let path = &s2.recorded()[0].path;
            assert!(path.contains("citationCount") && path.contains("tldr") && path.contains("openAccessPdf"), "{path}");
        });
    }

    #[test]
    fn the_s2_key_header_goes_only_with_a_key() {
        let rt = runtime();
        rt.block_on(async {
            let empty = || Canned::json(200, serde_json::json!({"total": 0, "offset": 0, "data": []}));
            let s2 = MockServer::start(vec![empty(), empty()]);
            let mut c = NetCtx::new(Cancel::default());
            c.services.pacing = false;
            c.services.semantic_scholar = format!("{}/graph/v1", s2.base_url);
            c.sources = only(&[Source::SemanticScholar]);
            search_papers(&c, "keyless s2 search", 3).await.unwrap();
            c.s2_key = Some(ApiKey::new("s2-secret-0123456789".into()));
            search_papers(&c, "keyed s2 search", 3).await.unwrap();
            let rec = s2.recorded();
            assert_eq!(rec[0].header("x-api-key"), None);
            assert_eq!(rec[1].header("x-api-key"), Some("s2-secret-0123456789"));
            assert!(rec.iter().all(|r| !r.path.contains("s2-secret")));
        });
    }

    #[test]
    fn a_source_turned_off_gets_no_requests() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![atom(ATOM)]),
                crossref: MockServer::start(vec![crossref_reply()]),
                s2: MockServer::start(vec![s2_reply()]),
            };
            let mut c = ctx_for(&m);
            c.sources.crossref = false;
            let rec = Arc::new(Recorder::default());
            c.hooks = rec.clone();
            // The search's own sources narrow further, never widen.
            let opts = SearchOpts { sources: SourceSet { arxiv: false, crossref: true, ..SourceSet::default() }, ..SearchOpts::default() };
            let r = search_papers_opts(&c, "attention deep learning off", &opts).await.unwrap();
            assert!(r.papers.iter().all(|p| p.sources == vec!["Semantic Scholar"]), "{:#?}", r.papers);
            assert_eq!(m.crossref.recorded().len(), 0);
            assert_eq!(m.arxiv.recorded().len(), 0);
            assert_eq!(m.s2.recorded().len(), 1);
            assert!(matches!(rec.states(Source::Crossref).as_slice(), [SourceState::Skipped(_)]));
            assert!(matches!(rec.states(Source::OpenAlex).as_slice(), [SourceState::Skipped(r)] if r == "Key not set"));

            c.sources = only(&[]);
            let err = search_papers(&c, "nothing on", 3).await.unwrap_err();
            assert_eq!(err.kind, Kind::InvalidInput);
            assert!(err.message.contains("Settings > AI > Web"));
        });
    }

    #[test]
    fn progress_goes_pending_then_ok_or_degraded_and_successes_are_cached() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![atom(ATOM)]),
                crossref: MockServer::start(vec![crossref_reply()]),
                // Fails the first search, answers the second.
                s2: MockServer::start(vec![Canned::json(500, Value::Null), s2_reply()]),
            };
            let mut c = ctx_for(&m);
            let rec = Arc::new(Recorder::default());
            c.hooks = rec.clone();
            let r = search_papers(&c, "attention deep learning partial", 8).await.unwrap();
            assert_eq!(r.notes, vec!["Semantic Scholar couldn't be reached, so its results are missing."]);
            assert_eq!(rec.states(Source::Crossref), vec![SourceState::Pending, SourceState::Ok(2)]);
            assert_eq!(rec.states(Source::Arxiv), vec![SourceState::Pending, SourceState::Ok(2)]);
            assert!(matches!(rec.states(Source::SemanticScholar).as_slice(), [SourceState::Pending, SourceState::Degraded(n)] if n.contains("Semantic Scholar")));

            // Again: Crossref and arXiv come from the cache, only S2 is asked.
            let r = search_papers(&c, "attention deep learning partial", 8).await.unwrap();
            assert!(r.notes.is_empty(), "{:?}", r.notes);
            assert_eq!(m.crossref.recorded().len(), 1);
            assert_eq!(m.arxiv.recorded().len(), 1);
            assert_eq!(m.s2.recorded().len(), 2);
            assert_eq!(r.papers.len(), 4);
            let json = serde_json::to_string(&SourceEvent { source: Source::Arxiv, state: SourceState::Waiting(3000) }).unwrap();
            assert_eq!(json, r#"{"source":"arxiv","state":{"state":"waiting","detail":3000}}"#);
        });
    }

    #[test]
    fn filters_and_sort_reach_the_sources() {
        let rt = runtime();
        rt.block_on(async {
            let m = Mocks {
                arxiv: MockServer::start(vec![atom(ATOM)]),
                crossref: MockServer::start(vec![crossref_reply()]),
                s2: MockServer::start(vec![s2_reply()]),
            };
            let c = ctx_for(&m);
            let opts = SearchOpts { limit: 20, year_from: Some(2015), year_to: Some(2018), sort: SearchSort::Newest, ..SearchOpts::default() };
            let r = search_papers_opts(&c, "attention deep learning filtered", &opts).await.unwrap();
            assert!(r.papers.iter().all(|p| p.year.is_some_and(|y| (2015..=2018).contains(&y))), "{:#?}", r.papers);
            assert_eq!(r.papers[0].year, Some(2017));
            assert!(m.s2.recorded()[0].path.contains("year=2015-2018"));
            let cr = &m.crossref.recorded()[0].path;
            assert!(cr.contains("filter=from-pub-date%3A2015-01-01%2Cuntil-pub-date%3A2018-12-31") && cr.contains("sort=published"), "{cr}");
            let ax = &m.arxiv.recorded()[0].path;
            assert!(ax.contains("submittedDate%3A%5B201501010000+TO+201812312359%5D") && ax.contains("sortBy=submittedDate"), "{ax}");
            let bad = SearchOpts { year_from: Some(2020), year_to: Some(2010), ..SearchOpts::default() };
            assert_eq!(search_papers_opts(&c, "x y", &bad).await.unwrap_err().kind, Kind::InvalidInput);
            assert_eq!(SearchSort::parse("Most cited"), Some(SearchSort::Cited));
            assert_eq!(SearchSort::parse("bogus"), None);
        });
    }

    #[test]
    fn cache_keys_never_carry_keys_or_email() {
        let mut c = NetCtx::new(Cancel::default());
        c.openalex_key = Some(ApiKey::new("oa-secret-123456".into()));
        c.s2_key = Some(ApiKey::new("s2-secret-123456".into()));
        c.contact_email = Some("me@uni.example".into());
        let opts = SearchOpts::default();
        let q = SourceQuery { text: "Deep Learning", rows: 5, opts: &opts };
        for s in Source::ALL {
            let k = cache_key(&c, s, &q);
            assert!(!k.contains("secret") && !k.contains('@'), "{k}");
            assert!(k.ends_with("|deep learning"), "{k}");
        }
    }
}
