//! Literature tools, keyless and polite:
//! - `search_papers`: arXiv (Atom API), Crossref and Semantic Scholar in
//!   parallel, plus OpenAlex when the user added a free key; merged and
//!   de-duplicated by DOI or arXiv id (and by identical long titles);
//! - `get_bibtex`: BibTeX from doi.org content negotiation
//!   (`Accept: application/x-bibtex`) or from arXiv, normalised with a
//!   stable `authorYEARfirstword` key and checked;
//! - `verify_citation`: checks that a `.bib` entry points at a real paper
//!   (by DOI, arXiv id, or a title search) and says what doesn't match.
//!
//! One source failing (offline, busy) doesn't fail a search: the others'
//! results come back with a note.


use std::collections::HashMap;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::bibtex::{self, BibRecord};
use super::html::decode_entities;
use super::net::{self, NetCtx};
use crate::ai::error::{AiError, AiResult, Kind};

pub const MAX_PAPERS: usize = 8;
const SEARCH_TTL: Duration = Duration::from_secs(60 * 60);
const BIBTEX_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const ABSTRACT_CHARS: usize = 400;

/// arXiv asks for one request every 3 seconds.
const ARXIV_INTERVAL: Duration = Duration::from_millis(3000);
const CROSSREF_INTERVAL: Duration = Duration::from_millis(200);
/// Keyless Semantic Scholar shares one pool with everybody: go slowly.
const S2_INTERVAL: Duration = Duration::from_millis(1100);
const OPENALEX_INTERVAL: Duration = Duration::from_millis(150);
const DOI_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    /// The first few hundred characters of the abstract.
    pub abstract_snippet: Option<String>,
    pub url: Option<String>,
    /// Where it was found: "arXiv", "Crossref", "Semantic Scholar", "OpenAlex".
    pub sources: Vec<String>,
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
        s
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
            }
        }
        for n in &self.notes {
            out.push_str(&format!("\nNote: {n}"));
        }
        out
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    Arxiv,
    Crossref,
    SemanticScholar,
    OpenAlex,
}

impl Source {
    fn label(self) -> &'static str {
        match self {
            Source::Arxiv => "arXiv",
            Source::Crossref => "Crossref",
            Source::SemanticScholar => "Semantic Scholar",
            Source::OpenAlex => "OpenAlex",
        }
    }
}

// --------------------------------------------------------- search_papers --

/// Searches arXiv, Crossref and Semantic Scholar (and OpenAlex with a key),
/// merges the results and keeps at most `limit` (≤ 8).
pub async fn search_papers(ctx: &NetCtx, query: &str, limit: usize) -> AiResult<PaperSearch> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.is_empty() {
        return Err(AiError::invalid("Give a few words to search for."));
    }
    if query.chars().count() > 300 {
        return Err(AiError::invalid("The search is too long; use a few key words or the title."));
    }
    let limit = limit.clamp(1, MAX_PAPERS);
    let cache_key = format!("papers|{}|{}|{}|{limit}|{query}", ctx.services.crossref, ctx.services.arxiv_api, ctx.openalex_key.is_some());
    if let Some(hit) = net::cache_get::<PaperSearch>(&cache_key) {
        return Ok(hit);
    }
    let per_source = limit.max(5);
    let openalex = async {
        if ctx.openalex_key.is_some() {
            Some(search_openalex(ctx, &query, per_source).await)
        } else {
            None
        }
    };
    let (a, c, s, o) = tokio::join!(
        search_arxiv(ctx, &query, per_source),
        search_crossref(ctx, &query, per_source),
        search_s2(ctx, &query, per_source),
        openalex,
    );
    ctx.cancel.check()?;
    let mut lists = Vec::new();
    let mut notes = Vec::new();
    let mut errors = Vec::new();
    for (source, res) in [(Source::SemanticScholar, Some(s)), (Source::Crossref, Some(c)), (Source::Arxiv, Some(a)), (Source::OpenAlex, o)] {
        match res {
            None => {}
            Some(Ok(list)) => lists.push((source, list)),
            Some(Err(e)) => {
                if e.kind == Kind::Cancelled {
                    return Err(e);
                }
                notes.push(match e.kind {
                    Kind::RateLimited => format!("{} was busy, so its results are missing.", source.label()),
                    Kind::BadKey if source == Source::OpenAlex => {
                        "OpenAlex didn't accept the key in Settings > AI > Web, so its results are missing.".to_string()
                    }
                    _ => format!("{} couldn't be reached, so its results are missing.", source.label()),
                });
                errors.push(e);
            }
        }
    }
    if lists.is_empty() {
        let mut err = errors.into_iter().next().unwrap_or_else(|| AiError::new(Kind::Network, "The paper search failed."));
        err.message = format!("No paper database could be reached. {}", offline_hint(&err));
        return Err(err);
    }
    let papers = merge(lists, limit);
    let result = PaperSearch { query, papers, notes };
    if result.notes.is_empty() {
        net::cache_put(&cache_key, &result, SEARCH_TTL);
    }
    Ok(result)
}

fn offline_hint(err: &AiError) -> &'static str {
    match err.kind {
        Kind::Offline | Kind::Network | Kind::Tls => "Check your internet connection.",
        Kind::RateLimited => "The services are busy; try again in a minute.",
        Kind::Timeout => "They took too long to answer; try again.",
        _ => "Try again later.",
    }
}

/// Merges ranked lists: papers found by several sources first, then by
/// their rank in each list.
fn merge(lists: Vec<(Source, Vec<Paper>)>, limit: usize) -> Vec<Paper> {
    let mut merged: Vec<(Paper, f64)> = Vec::new();
    for (_, list) in lists {
        for (rank, p) in list.into_iter().enumerate() {
            let score = 1.0 / (rank as f64 + 1.0);
            match merged.iter_mut().find(|(m, _)| same_paper(m, &p)) {
                Some((m, s)) => {
                    absorb(m, p);
                    *s += score + 0.5;
                }
                None => merged.push((p, score)),
            }
        }
    }
    merged.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    merged.into_iter().map(|(p, _)| p).take(limit).collect()
}

fn same_paper(a: &Paper, b: &Paper) -> bool {
    if let (Some(x), Some(y)) = (&a.doi, &b.doi) {
        if x.eq_ignore_ascii_case(y) {
            return true;
        }
    }
    if let (Some(x), Some(y)) = (&a.arxiv_id, &b.arxiv_id) {
        if x.eq_ignore_ascii_case(y) {
            return true;
        }
    }
    let (ta, tb) = (norm_title(&a.title), norm_title(&b.title));
    ta.len() >= 20 && ta == tb
}

fn absorb(into: &mut Paper, from: Paper) {
    // A publisher DOI is better than arXiv's own.
    let arxiv_doi = |d: &Option<String>| d.as_deref().is_some_and(|d| bibtex::arxiv_from_doi(d).is_some());
    if into.doi.is_none() || (arxiv_doi(&into.doi) && from.doi.is_some() && !arxiv_doi(&from.doi)) {
        into.doi = from.doi.or(into.doi.take());
    }
    if into.arxiv_id.is_none() {
        into.arxiv_id = from.arxiv_id;
    }
    if into.year.is_none() {
        into.year = from.year;
    }
    if into.venue.is_none() {
        into.venue = from.venue;
    }
    if into.abstract_snippet.is_none() {
        into.abstract_snippet = from.abstract_snippet;
    }
    if into.url.is_none() {
        into.url = from.url;
    }
    if into.authors.is_empty() {
        into.authors = from.authors;
    }
    for s in from.sources {
        if !into.sources.contains(&s) {
            into.sources.push(s);
        }
    }
}

fn norm_title(t: &str) -> String {
    t.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn snippet(text: &str) -> Option<String> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return None;
    }
    let (s, cut) = net::cap_chars(&t, ABSTRACT_CHARS);
    Some(if cut { format!("{s}…") } else { s })
}

/// Normalised DOI (lower case, no resolver prefix) and the arXiv id it
/// stands for, if it's one of arXiv's.
fn doi_ids(doi: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(d) = doi.map(bibtex::clean_doi).filter(|d| d.starts_with("10.")) else { return (None, None) };
    let d = d.to_ascii_lowercase();
    let arxiv = bibtex::arxiv_from_doi(&d);
    (Some(d), arxiv)
}

async fn get_json(ctx: &NetCtx, url: reqwest::Url, source: Source, interval: Duration) -> AiResult<Value> {
    let client = ctx.client()?;
    let host = net::host_key(url.as_str());
    let mut tries = 0;
    loop {
        net::pace(ctx, &host, interval).await?;
        let req = client.get(url.clone()).header(ACCEPT, "application/json");
        let reply = net::send(ctx, req, source.label()).await?;
        if reply.status == StatusCode::TOO_MANY_REQUESTS && tries == 0 {
            // One polite retry, after what the service asks (at most 5 s).
            tries += 1;
            let wait = crate::ai::http::retry_after(&reply.headers).unwrap_or(2).min(5);
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

async fn search_crossref(ctx: &NetCtx, query: &str, rows: usize) -> AiResult<Vec<Paper>> {
    let rows = rows.to_string();
    let mut pairs = vec![
        ("query.bibliographic", query),
        ("rows", rows.as_str()),
        ("select", "DOI,title,author,issued,container-title,abstract,type,URL"),
    ];
    if let Some(m) = &ctx.contact_email {
        pairs.push(("mailto", m.as_str()));
    }
    let url = net::with_query(&format!("{}/works", ctx.services.crossref), &pairs)?;
    let v = get_json(ctx, url, Source::Crossref, CROSSREF_INTERVAL).await?;
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
    let abstract_snippet = item.get("abstract").and_then(Value::as_str).and_then(|a| snippet(&strip_markup(a)));
    Some(Paper {
        title: clean_text(&title),
        authors,
        year,
        venue: first_str(item.get("container-title")).map(|v| clean_text(&v)),
        url: doi.as_ref().map(|d| format!("https://doi.org/{d}")),
        doi,
        arxiv_id,
        abstract_snippet,
        sources: vec![Source::Crossref.label().into()],
    })
}

async fn search_s2(ctx: &NetCtx, query: &str, limit: usize) -> AiResult<Vec<Paper>> {
    let limit = limit.to_string();
    let url = net::with_query(
        &format!("{}/paper/search", ctx.services.semantic_scholar),
        &[("query", query), ("limit", &limit), ("fields", "title,authors,year,venue,externalIds,abstract,url")],
    )?;
    let v = get_json(ctx, url, Source::SemanticScholar, S2_INTERVAL).await?;
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
        abstract_snippet: p.get("abstract").and_then(Value::as_str).and_then(snippet),
        url: p.get("url").and_then(Value::as_str).map(str::to_string),
        sources: vec![Source::SemanticScholar.label().into()],
    })
}

async fn search_openalex(ctx: &NetCtx, query: &str, limit: usize) -> AiResult<Vec<Paper>> {
    let Some(key) = &ctx.openalex_key else { return Ok(Vec::new()) };
    let limit = limit.to_string();
    let url = net::with_query(
        &format!("{}/works", ctx.services.openalex),
        &[
            ("search", query),
            ("per-page", &limit),
            ("select", "id,doi,title,publication_year,authorships,primary_location,ids,abstract_inverted_index"),
            ("api_key", key.expose()),
        ],
    )?;
    let v = get_json(ctx, url, Source::OpenAlex, OPENALEX_INTERVAL).await?;
    let results = v.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(results.iter().filter_map(openalex_paper).collect())
}

fn openalex_paper(w: &Value) -> Option<Paper> {
    let title = w.get("title").and_then(Value::as_str).filter(|t| !t.trim().is_empty())?;
    let (doi, arxiv_id) = doi_ids(w.get("doi").and_then(Value::as_str));
    let authors = w
        .get("authorships")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.pointer("/author/display_name").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    Some(Paper {
        title: clean_text(title),
        authors,
        year: w.get("publication_year").and_then(Value::as_i64).map(|y| y as i32),
        venue: w.pointer("/primary_location/source/display_name").and_then(Value::as_str).map(str::to_string),
        url: doi.as_ref().map(|d| format!("https://doi.org/{d}")),
        doi,
        arxiv_id,
        abstract_snippet: w.get("abstract_inverted_index").and_then(inverted_abstract).and_then(|a| snippet(&a)),
        sources: vec![Source::OpenAlex.label().into()],
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

async fn search_arxiv(ctx: &NetCtx, query: &str, limit: usize) -> AiResult<Vec<Paper>> {
    let terms: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .filter(|w| w.chars().count() > 1)
        .take(12)
        .map(|w| format!("all:{w}"))
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let q = terms.join(" AND ");
    let limit = limit.to_string();
    let url = net::with_query(&ctx.services.arxiv_api, &[("search_query", &q), ("start", "0"), ("max_results", &limit)])?;
    arxiv_query(ctx, url).await
}

async fn arxiv_query(ctx: &NetCtx, url: reqwest::Url) -> AiResult<Vec<Paper>> {
    let client = ctx.client()?;
    net::pace(ctx, &net::host_key(url.as_str()), ARXIV_INTERVAL).await?;
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
        out.push(Paper {
            title,
            authors,
            year,
            venue: tag(entry, "arxiv:journal_ref").map(|j| collapse(&j)).or_else(|| Some("arXiv".to_string())),
            doi,
            url: Some(format!("https://arxiv.org/abs/{arxiv_id}")),
            arxiv_id: Some(arxiv_id),
            abstract_snippet: tag(entry, "summary").and_then(|s| snippet(&s)),
            sources: vec![Source::Arxiv.label().into()],
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
        let list = arxiv_query(ctx, url).await?;
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
        abstract_snippet: None,
        sources: vec!["doi.org".into()],
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
            assert!(rec.path.contains("search=open+work") && rec.path.contains("api_key=oa-key-1234567"));
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
}
