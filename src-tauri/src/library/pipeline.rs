//! The paper library behind the literature tools (v1.3): a [`SearchHooks`]
//! that keeps each source's answers in the library's persistent cache and
//! ranks papers the user already has a little higher, the step that saves
//! what a search found, and the helpers the tools and the online commands
//! share (paper details from Semantic Scholar, checking a whole `.bib`,
//! a BibTeX entry with a key no `.bib` file uses yet).
//!
//! Without a library (it couldn't be opened) everything still works: the
//! hooks fall back to the in-memory cache and nothing is saved.
//!
//! The database is only touched on blocking threads or, inside a hook,
//! for one short statement on a connection that is free right now (a busy
//! one is a cache miss); no connection is held across an `.await`.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderValue, ACCEPT};
use reqwest::StatusCode;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::store::{self, LibraryFilters, LibraryPaper, OaInfo, PaperIds, PaperInput, Provenance, SearchPage, Sort, SourceInfo};
use super::{bibsync, cache, now_ms, LibError, LibResult, Library};
use crate::agents::tools::bibtex::{self, BibRecord};
use crate::agents::tools::literature::{
    self, BibEntry, CitationCheck, CitationStatus, MemoryHooks, Paper, PaperId, PaperSearch, SearchHooks, SearchOpts, Source,
    SourceEvent, SourceState,
};
use crate::agents::tools::net::{self, NetCtx};
use crate::agents::types::{cap, text_hash, SourceChip, SourceState as ChipState, MAX_DATA_ABSTRACT, MAX_DATA_PAPERS};
use crate::ai::error::{AiError, AiResult, Kind};

/// Gets every source event of a search (the online command emits them).
pub type Listener = Arc<dyn Fn(&SourceEvent) + Send + Sync>;

/// The most `.bib` entries one `verify_bibliography` call checks.
pub const MAX_VERIFY_KEYS: usize = 40;
/// How many references and citing papers `paper_details` lists.
const MAX_RELATED: usize = 10;
/// A citation check that found nothing is asked again after a day.
const NOT_FOUND_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Keyless Semantic Scholar shares one pool with everybody: go slowly.
const S2_INTERVAL: Duration = Duration::from_millis(1100);
const S2_KEY_INTERVAL: Duration = Duration::from_millis(1000);
const S2_FIELDS: &str = "paperId,externalIds,title,abstract,tldr,year,venue,authors,citationCount,influentialCitationCount,openAccessPdf,publicationTypes,fieldsOfStudy,url";
const S2_REF_FIELDS: &str = "paperId,externalIds,title,year,venue,authors,citationCount";
const ABSTRACT_CHARS: usize = 4000;

// ----------------------------------------------------------------- hooks --

/// The paper search's cache and progress, backed by the library when it is
/// open (else the in-memory cache), with an optional listener for events.
pub struct PipelineHooks {
    lib: Option<Arc<Library>>,
    /// The project folder, for the "in this project" boost.
    project: Option<String>,
    listener: Option<Listener>,
}

impl PipelineHooks {
    pub fn new(lib: Option<Arc<Library>>, project: Option<String>, listener: Option<Listener>) -> Self {
        PipelineHooks { lib, project, listener }
    }
}

/// The cache row key for one literature cache key (which never holds a key
/// or an e-mail address).
fn db_key(source: Source, key: &str) -> String {
    cache::cache_key(source.key(), "", key)
}

impl SearchHooks for PipelineHooks {
    // These run on the async runtime, inside the search: they never wait
    // for a connection. A busy one (a backup, a sync, a long local search)
    // counts as a miss, and a store it can't make goes to the in-memory
    // cache instead.
    fn cached(&self, source: Source, key: &str) -> Option<String> {
        let Some(lib) = &self.lib else { return MemoryHooks.cached(source, key) };
        let k = db_key(source, key);
        let now = now_ms();
        match lib.try_read(|c| cached_body(c, source.key(), &k, now)) {
            Some(Ok(Some(body))) => {
                // The LRU stamp is worth a try, not a wait.
                let _ = lib.try_write(|c| touch(c, &k, now));
                Some(body)
            }
            // A miss (or an error) may still be in memory: a store made while
            // the writer was busy went there, and the reader may be free now.
            Some(_) | None => MemoryHooks.cached(source, key),
        }
    }

    fn store(&self, source: Source, key: &str, body: &str, ttl: Duration) {
        let Some(lib) = &self.lib else { return MemoryHooks.store(source, key, body, ttl) };
        match lib.try_write(|c| cache::put(c, source.key(), &db_key(source, key), body, ttl, now_ms())) {
            Some(Ok(())) => {}
            _ => MemoryHooks.store(source, key, body, ttl),
        }
    }

    fn progress(&self, ev: SourceEvent) {
        if let Some(f) = &self.listener {
            f(&ev);
        }
    }

    fn boost(&self, p: &Paper) -> f64 {
        match &self.lib {
            Some(lib) => lib.try_read(|c| boost_of(c, p, self.project.as_deref())).and_then(Result::ok).unwrap_or(0.0),
            None => 0.0,
        }
    }
}

/// A cached body that hasn't expired, read without writing (the reader is
/// read-only).
fn cached_body(conn: &Connection, source: &str, key: &str, now: i64) -> LibResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT body FROM search_cache WHERE key = ?1 AND source = ?2 AND expires_at > ?3",
            params![key, source, now],
            |r| r.get(0),
        )
        .optional()?)
}

/// Counts a cache hit as a use, for the LRU.
fn touch(conn: &mut Connection, key: &str, now: i64) -> LibResult<()> {
    conn.execute("UPDATE search_cache SET hit_at = ?2 WHERE key = ?1", params![key, now])?;
    Ok(())
}

/// A little extra rank for a paper the user has: cited in this project
/// (0.08), or saved (0.04). One statement over all of its identifiers.
fn boost_of(conn: &Connection, p: &Paper, project: Option<&str>) -> LibResult<f64> {
    let keys = paper_input(p).keys();
    if keys.is_empty() {
        return Ok(0.0);
    }
    let ors = vec!["(i.scheme = ? AND i.value = ?)"; keys.len()].join(" OR ");
    let sql = format!(
        "SELECT max(CASE WHEN ?1 IS NOT NULL AND EXISTS (SELECT 1 FROM project_refs r JOIN projects j ON j.id = r.project_id \
         WHERE j.path = ?1 AND r.paper_id = p.id) THEN 2 WHEN p.saved_at IS NOT NULL THEN 1 ELSE 0 END) \
         FROM paper_ids i JOIN papers p ON p.id = i.paper_id WHERE {ors}"
    );
    let mut args: Vec<rusqlite::types::Value> = vec![project.map(str::to_string).into()];
    for k in &keys {
        args.push(k.scheme().to_string().into());
        args.push(k.value().to_string().into());
    }
    let best: Option<i64> = conn.prepare_cached(&sql)?.query_row(rusqlite::params_from_iter(args), |r| r.get(0))?;
    Ok(match best {
        Some(2) => 0.08,
        Some(1) => 0.04,
        _ => 0.0,
    })
}

/// Plugs the library into a context built from settings: the tools save
/// what they find and the cache survives a restart.
pub fn attach(ctx: &mut NetCtx, lib: Option<Arc<Library>>) {
    ctx.hooks = Arc::new(PipelineHooks::new(lib.clone(), None, None));
    ctx.library = lib;
}

/// A copy of `ctx` for one request: the same library, ranking for
/// `project`, and source events to `listener`.
pub fn scoped(ctx: &NetCtx, project: Option<String>, listener: Option<Listener>) -> NetCtx {
    let mut c = ctx.clone();
    c.hooks = Arc::new(PipelineHooks::new(ctx.library.clone(), project, listener));
    c
}

/// A source event as a chip on the run card. Sources turned off in
/// Settings get none.
pub fn chip(ev: &SourceEvent) -> Option<SourceChip> {
    let (state, detail) = match &ev.state {
        SourceState::Pending => (ChipState::Pending, None),
        SourceState::Waiting(ms) => (ChipState::Waiting, Some(format!("{}s", ms.div_ceil(1000)))),
        SourceState::Ok(n) => (ChipState::Ok, Some(n.to_string())),
        SourceState::Degraded(note) => (ChipState::Degraded, Some(note.clone())),
        SourceState::Skipped(reason) if reason.starts_with("Turned off") => return None,
        SourceState::Skipped(reason) => (ChipState::Degraded, Some(reason.clone())),
    };
    Some(SourceChip { source: ev.source.label().to_string(), state, detail })
}

// ---------------------------------------------------------------- papers --

/// The service's own id for the paper in `source`'s list.
fn source_id(p: &Paper, source: Source) -> Option<String> {
    match source {
        Source::SemanticScholar => p.s2_id.clone(),
        Source::OpenAlex => p.openalex_id.clone(),
        Source::Arxiv => p.arxiv_id.clone(),
        Source::Crossref => p.doi.clone(),
    }
}

/// A search result as library input.
pub fn paper_input(p: &Paper) -> PaperInput {
    let mut sources: Vec<store::SourceHit> = p
        .per_source
        .iter()
        .map(|h| store::SourceHit {
            source: h.source.key().to_string(),
            source_id: source_id(p, h.source).unwrap_or_default(),
            citations: h.citations.map(|c| c as i64),
        })
        .collect();
    if sources.is_empty() {
        for s in &p.sources {
            let slug = store::source_slug(s);
            if ["s2", "crossref", "arxiv", "openalex"].contains(&slug.as_str()) {
                sources.push(store::SourceHit { source: slug, source_id: String::new(), citations: None });
            }
        }
    }
    PaperInput {
        title: p.title.clone(),
        authors: p.authors.clone(),
        year: p.year,
        venue: p.venue.clone(),
        abstract_text: p.abstract_full.clone().or_else(|| p.abstract_snippet.clone()),
        tldr: p.tldr.clone(),
        work_type: p.work_type.clone(),
        doi: p.doi.clone(),
        arxiv: p.arxiv_id.clone(),
        s2: p.s2_id.clone(),
        openalex: p.openalex_id.clone(),
        citations: p.citation_count.map(|c| c as i64),
        influential: p.influential_count.map(|c| c as i64),
        is_oa: p.is_oa,
        oa_status: p.oa_status.clone(),
        oa_pdf_url: p.oa_pdf.clone(),
        landing_url: p.url.clone(),
        sources,
        ..Default::default()
    }
}

/// A paper that isn't in the library (it couldn't be saved), in the shape
/// the UI shows. Its uid starts with `online:`.
pub fn unsaved_paper(p: &Paper) -> LibraryPaper {
    let ident = p
        .doi
        .clone()
        .or_else(|| p.arxiv_id.clone())
        .or_else(|| p.s2_id.clone())
        .or_else(|| p.openalex_id.clone())
        .unwrap_or_else(|| format!("{}|{}", p.title.to_lowercase(), p.year.unwrap_or_default()));
    let now = now_ms();
    let oa = (p.is_oa == Some(true) || p.oa_status.is_some() || p.oa_pdf.is_some())
        .then(|| OaInfo { status: p.oa_status.clone(), pdf_url: p.oa_pdf.clone() });
    LibraryPaper {
        uid: format!("online:{}", text_hash(Some(&ident))),
        title: p.title.clone(),
        authors: p.authors.clone(),
        year: p.year,
        venue: p.venue.clone(),
        abstract_text: p.abstract_full.clone().or_else(|| p.abstract_snippet.clone()),
        tldr: p.tldr.clone(),
        citations: p.citation_count.map(|c| c as i64),
        influential: p.influential_count.map(|c| c as i64),
        oa,
        ids: PaperIds {
            doi: p.doi.clone(),
            arxiv: p.arxiv_id.clone(),
            s2: p.s2_id.clone(),
            openalex: p.openalex_id.clone(),
            ..Default::default()
        },
        sources: p
            .per_source
            .iter()
            .map(|h| SourceInfo { source: h.source.key().to_string(), fetched_at: now, citations: h.citations.map(|c| c as i64) })
            .collect(),
        saved: false,
        in_project: None,
        dup_of: None,
        snippet: None,
        tags: Vec::new(),
        note: None,
        url: p.url.clone(),
        work_type: p.work_type.clone(),
        volume: None,
        issue: None,
        pages: None,
        publisher: None,
        found_by: Vec::new(),
        last_seen_at: now,
    }
}

/// Saves `papers` in one transaction and reads each back as the UI shows
/// it (with its project link for `project`). Returns the papers in order
/// (unsaved ones as [`unsaved_paper`]) and how many were new.
pub fn store_papers(lib: &Library, papers: &[Paper], prov: &Provenance) -> LibResult<(Vec<LibraryPaper>, usize)> {
    let now = now_ms();
    let ups = lib.write(|c| {
        let tx = c.transaction()?;
        let mut out = Vec::new();
        for p in papers {
            out.push(store::upsert_one(&tx, &paper_input(p), prov, now)?);
        }
        tx.commit()?;
        Ok(out)
    })?;
    let new = ups.iter().flatten().filter(|u| u.created).count();
    let items = lib.read(|c| {
        let mut out = Vec::new();
        for (p, up) in papers.iter().zip(&ups) {
            let stored = match up {
                Some(u) => store::get(c, &u.uid, prov.project.as_deref())?,
                None => None,
            };
            out.push(stored.unwrap_or_else(|| unsaved_paper(p)));
        }
        Ok(out)
    })?;
    Ok((items, new))
}

/// What a search found, saved where possible.
#[derive(Debug, Clone)]
pub struct Found {
    pub search: PaperSearch,
    /// The papers in the same order, as the UI shows them.
    pub items: Vec<LibraryPaper>,
    /// Papers the library didn't have before.
    pub new: usize,
    /// Why nothing was saved (the library is unavailable or failed).
    pub warning: Option<String>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> LibResult<T> + Send + 'static) -> LibResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|_| LibError::msg("Something went wrong inside Texo. Try again."))?
}

/// Runs the paper search and saves what it found (`run_finds` when `prov`
/// names a run). The search never fails because saving did.
pub async fn search_and_store(ctx: &NetCtx, query: &str, opts: &SearchOpts, prov: Provenance) -> AiResult<Found> {
    let search = literature::search_papers_opts(ctx, query, opts).await?;
    let papers = search.papers.clone();
    let Some(lib) = ctx.library.clone() else {
        let items = papers.iter().map(unsaved_paper).collect();
        return Ok(Found { search, items, new: 0, warning: None });
    };
    let fallback: Vec<LibraryPaper> = papers.iter().map(unsaved_paper).collect();
    Ok(match blocking(move || store_papers(&lib, &papers, &prov)).await {
        Ok((items, new)) => Found { search, items, new, warning: None },
        Err(e) => Found { search, items: fallback, new: 0, warning: Some(format!("The papers couldn't be saved in your library. {}", e.plain())) },
    })
}

/// `{papers: [...]}` for a tool step: at most 10, abstracts trimmed, no
/// search snippets. Step data is saved in the run journal inside the project
/// folder, so the user's own library data stays out: the note, the tags and
/// which other runs found the paper are blanked (kept as empty values so the
/// card still reads the paper; it fetches them live by uid).
pub fn step_data(items: &[LibraryPaper]) -> Value {
    let papers: Vec<Value> = items
        .iter()
        .take(MAX_DATA_PAPERS)
        .filter_map(|p| {
            let mut v = serde_json::to_value(p).ok()?;
            if let Some(o) = v.as_object_mut() {
                o.remove("snippet");
                o.insert("note".into(), Value::Null);
                o.insert("tags".into(), json!([]));
                o.insert("foundBy".into(), json!([]));
                if let Some(Value::String(a)) = o.get_mut("abstract") {
                    if a.chars().count() > MAX_DATA_ABSTRACT {
                        *a = format!("{}…", a.chars().take(MAX_DATA_ABSTRACT).collect::<String>());
                    }
                }
            }
            Some(v)
        })
        .collect();
    json!({ "papers": papers })
}

/// The search text for the model, plus which results this project
/// already cites.
pub fn found_text(found: &Found) -> String {
    let mut text = found.search.to_tool_text();
    let cited: Vec<String> = found
        .items
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let key = p.in_project.as_ref()?.cite_key.as_ref()?;
            Some(format!("{} is already in this project's bibliography as \\cite{{{key}}}.", i + 1))
        })
        .collect();
    if !cited.is_empty() {
        text.push_str("\n\nAlready cited: ");
        text.push_str(&cited.join(" "));
    }
    if let Some(w) = &found.warning {
        text.push_str(&format!("\nNote: {w}"));
    }
    text
}

// --------------------------------------------------------- library_search --

/// Full-text search of the library, with this project's links.
pub fn local_search(lib: &Library, query: &str, project: Option<&str>, limit: i64) -> LibResult<SearchPage> {
    let filters = LibraryFilters { project: project.map(str::to_string), ..Default::default() };
    lib.read(|c| store::search_local(c, query, &filters, Sort::Relevance, limit, 0, now_ms()))
}

fn strip_marks(s: &str) -> String {
    s.chars().filter(|c| *c != super::fts::MARK_START && *c != super::fts::MARK_END).collect()
}

fn author_short(authors: &[String]) -> String {
    match authors.len() {
        0 => "unknown authors".into(),
        1 | 2 => authors.join(" and "),
        _ => format!("{} et al.", authors[0]),
    }
}

/// One line per library paper, for the model.
pub fn library_paper_line(p: &LibraryPaper) -> String {
    let mut s = format!("{} ({}, {})", p.title, author_short(&p.authors), p.year.map(|y| y.to_string()).unwrap_or_else(|| "n.d.".into()));
    if let Some(v) = &p.venue {
        s.push_str(&format!(". {v}"));
    }
    if let Some(d) = &p.ids.doi {
        s.push_str(&format!(". DOI: {d}"));
    }
    if let Some(a) = &p.ids.arxiv {
        s.push_str(&format!(". arXiv: {a}"));
    }
    if let Some(c) = p.citations {
        s.push_str(&format!(". Cited by {c}"));
    }
    if let Some(key) = p.in_project.as_ref().and_then(|r| r.cite_key.as_ref()) {
        s.push_str(&format!(". In this project as \\cite{{{key}}}"));
    }
    if p.saved {
        s.push_str(". Saved by the user");
    }
    s
}

/// The model's text for a library search.
pub fn local_text(query: &str, page: &SearchPage) -> String {
    if page.items.is_empty() {
        return format!("Nothing in your paper library matches \"{query}\". Use search_papers to look online.");
    }
    let mut out = format!("Papers in your library for \"{query}\" ({} of {}):\n", page.items.len(), page.total);
    for (i, p) in page.items.iter().enumerate() {
        out.push_str(&format!("\n{}. {}\n", i + 1, library_paper_line(p)));
        let blurb = p.tldr.clone().or_else(|| p.snippet.as_deref().map(strip_marks)).or_else(|| p.abstract_text.clone());
        if let Some(b) = blurb {
            let (b, cut) = net::cap_chars(&b, 300);
            out.push_str(&format!("   {b}{}\n", if cut { "…" } else { "" }));
        }
    }
    out
}

// ---------------------------------------------------------- paper_details --

/// A paper with its references and the papers citing it (Semantic Scholar).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Details {
    pub paper: Paper,
    pub references: Vec<Paper>,
    pub citations: Vec<Paper>,
    /// Plain remarks: a list that couldn't be fetched.
    pub notes: Vec<String>,
}

impl Details {
    pub fn to_tool_text(&self) -> String {
        let p = &self.paper;
        let mut out = format!("{} ({}, {})", p.title, author_short(&p.authors), p.year.map(|y| y.to_string()).unwrap_or_else(|| "n.d.".into()));
        if let Some(v) = &p.venue {
            out.push_str(&format!(". {v}"));
        }
        if let Some(d) = &p.doi {
            out.push_str(&format!("\nDOI: {d}"));
        }
        if let Some(a) = &p.arxiv_id {
            out.push_str(&format!("\narXiv: {a}"));
        }
        if let Some(c) = p.citation_count {
            out.push_str(&format!("\nCited by {c}"));
            if let Some(i) = p.influential_count {
                out.push_str(&format!(" ({i} influential)"));
            }
        }
        if let Some(u) = &p.oa_pdf {
            out.push_str(&format!("\nFree PDF: {u}"));
        }
        if let Some(t) = &p.tldr {
            out.push_str(&format!("\nTL;DR: {t}"));
        }
        if let Some(a) = p.abstract_full.as_ref().or(p.abstract_snippet.as_ref()) {
            out.push_str(&format!("\nAbstract: {a}"));
        }
        for (title, list) in [("References", &self.references), ("Cited by", &self.citations)] {
            if list.is_empty() {
                continue;
            }
            out.push_str(&format!("\n\n{title} (first {}):", list.len()));
            for (i, r) in list.iter().enumerate() {
                let mut line = format!("\n{}. {} ({}, {})", i + 1, r.title, author_short(&r.authors), r.year.map(|y| y.to_string()).unwrap_or_else(|| "n.d.".into()));
                if let Some(d) = &r.doi {
                    line.push_str(&format!(". DOI: {d}"));
                } else if let Some(a) = &r.arxiv_id {
                    line.push_str(&format!(". arXiv: {a}"));
                }
                out.push_str(&line);
            }
        }
        for n in &self.notes {
            out.push_str(&format!("\n\nNote: {n}"));
        }
        out
    }
}

/// Semantic Scholar's id for `id`: a library uid (through its stored ids),
/// a DOI, an arXiv id, a Semantic Scholar paper id or `CorpusId:<n>`.
/// Reads the library: call it off the async runtime.
pub fn s2_id_for(lib: Option<&Library>, id: &str) -> AiResult<String> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AiError::invalid("Give the paper's DOI, arXiv id or library id."));
    }
    if let Some(lib) = lib {
        if let Ok(Some(p)) = lib.read(|c| store::get(c, id, None)) {
            // A DOI or arXiv id first: the same paper asked for by its DOI
            // then shares the cached details.
            let ids = p.ids;
            if let Some(d) = ids.doi.as_deref().filter(|d| bibtex::arxiv_from_doi(d).is_none()) {
                return Ok(format!("DOI:{d}"));
            }
            if let Some(a) = ids.arxiv {
                return Ok(format!("ARXIV:{a}"));
            }
            if let Some(s) = ids.s2 {
                return Ok(s);
            }
            if let Some(d) = ids.doi {
                return Ok(format!("DOI:{d}"));
            }
            return Err(AiError::invalid("That paper has no DOI, arXiv id or Semantic Scholar id to look up."));
        }
    }
    if let Ok(pid) = literature::parse_paper_id(id) {
        return Ok(match pid {
            PaperId::Doi(d) => format!("DOI:{d}"),
            PaperId::Arxiv(a) => format!("ARXIV:{a}"),
        });
    }
    let lower = id.to_ascii_lowercase();
    if let Some(n) = lower.strip_prefix("corpusid:").filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())) {
        return Ok(format!("CorpusId:{n}"));
    }
    if id.len() == 40 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(lower);
    }
    Err(AiError::invalid("Give a DOI (like 10.1038/nature14539), an arXiv id (like 2101.00001) or a paper from your library."))
}

/// Characters a URL path can't carry, percent-encoded (`/` and `:` stay).
fn encode_path(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:;()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn s2_get(ctx: &NetCtx, url: reqwest::Url) -> AiResult<Value> {
    let client = ctx.client()?;
    let interval = if ctx.s2_key.is_some() { S2_KEY_INTERVAL } else { S2_INTERVAL };
    net::pace(ctx, &net::host_key(url.as_str()), interval).await?;
    let mut req = client.get(url).header(ACCEPT, "application/json");
    if let Some(k) = &ctx.s2_key {
        let mut v = HeaderValue::from_str(k.expose())
            .map_err(|_| AiError::new(Kind::BadKey, "The saved key can't be used. Replace it in Settings > AI > Web."))?;
        v.set_sensitive(true);
        req = req.header("x-api-key", v);
    }
    let reply = net::send(ctx, req, "Semantic Scholar").await?;
    if reply.status == StatusCode::NOT_FOUND {
        return Err(AiError::new(Kind::NotFound, "Semantic Scholar doesn't know that paper."));
    }
    if !reply.status.is_success() {
        return Err(net::service_error(reply.status, &reply.headers, "Semantic Scholar"));
    }
    serde_json::from_str(&reply.body).map_err(|_| AiError::new(Kind::BadResponse, "Semantic Scholar sent an answer Texo couldn't read."))
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A Semantic Scholar paper object as a `Paper`.
fn s2_paper(v: &Value) -> Option<Paper> {
    let title = v.get("title").and_then(Value::as_str).map(collapse).filter(|t| !t.is_empty())?;
    let ids = v.get("externalIds");
    let doi = ids
        .and_then(|i| i.get("DOI"))
        .and_then(Value::as_str)
        .map(bibtex::clean_doi)
        .filter(|d| d.starts_with("10."))
        .map(|d| d.to_ascii_lowercase());
    let arxiv_id = ids
        .and_then(|i| i.get("ArXiv"))
        .and_then(Value::as_str)
        .and_then(bibtex::parse_arxiv_id)
        .or_else(|| doi.as_deref().and_then(bibtex::arxiv_from_doi));
    let abstract_full = v.get("abstract").and_then(Value::as_str).map(collapse).filter(|a| !a.is_empty()).map(|a| {
        let (s, cut) = net::cap_chars(&a, ABSTRACT_CHARS);
        if cut { format!("{s}…") } else { s }
    });
    let abstract_snippet = abstract_full.as_ref().map(|a| {
        let (s, cut) = net::cap_chars(a, 400);
        if cut { format!("{s}…") } else { s }
    });
    let oa_pdf = v.pointer("/openAccessPdf/url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
    let strings = |x: Option<&Value>| -> Vec<String> {
        x.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    };
    let s2_id = v.get("paperId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    Some(Paper {
        title,
        authors: v
            .get("authors")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default(),
        year: v.get("year").and_then(Value::as_i64).map(|y| y as i32),
        venue: v.get("venue").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        doi,
        arxiv_id,
        abstract_snippet,
        abstract_full,
        url: v.get("url").and_then(Value::as_str).map(str::to_string),
        citation_count: v.get("citationCount").and_then(Value::as_u64),
        influential_count: v.get("influentialCitationCount").and_then(Value::as_u64),
        tldr: v.pointer("/tldr/text").and_then(Value::as_str).map(collapse).filter(|t| !t.is_empty()),
        is_oa: oa_pdf.as_ref().map(|_| true),
        oa_pdf,
        work_type: strings(v.get("publicationTypes")).into_iter().next(),
        fields: strings(v.get("fieldsOfStudy")),
        per_source: vec![literature::SourceHit { source: Source::SemanticScholar, rank: 1, citations: v.get("citationCount").and_then(Value::as_u64) }],
        sources: vec![Source::SemanticScholar.label().into()],
        s2_id,
        ..Paper::default()
    })
}

/// The papers in one list answer (`data[].citedPaper` or `citingPaper`).
fn s2_list(v: &Value, field: &str) -> Vec<Paper> {
    v.get("data")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get(field)).filter_map(s2_paper).take(MAX_RELATED).collect())
        .unwrap_or_default()
}

/// A paper's details with its first references and citing papers, from
/// Semantic Scholar (cached for 14 days; a list that failed isn't cached).
pub async fn paper_details(ctx: &NetCtx, s2_id: &str) -> AiResult<Details> {
    let base = ctx.services.semantic_scholar.trim_end_matches('/');
    let key = format!("details|{base}|{}", s2_id.to_lowercase());
    if let Some(d) = ctx.hooks.cached(Source::SemanticScholar, &key).and_then(|b| serde_json::from_str::<Details>(&b).ok()) {
        return Ok(d);
    }
    let path = format!("{base}/paper/{}", encode_path(s2_id));
    let url = net::with_query(&path, &[("fields", S2_FIELDS)])?;
    let main = s2_get(ctx, url).await?;
    let paper = s2_paper(&main).ok_or_else(|| AiError::new(Kind::BadResponse, "Semantic Scholar sent a paper without a title."))?;
    let mut details = Details { paper, ..Default::default() };
    let limit = MAX_RELATED.to_string();
    let mut complete = true;
    for (what, field, label) in [("references", "citedPaper", "references"), ("citations", "citingPaper", "citing papers")] {
        let url = net::with_query(&format!("{path}/{what}"), &[("fields", S2_REF_FIELDS), ("limit", &limit)])?;
        match s2_get(ctx, url).await {
            Ok(v) => {
                let list = s2_list(&v, field);
                if what == "references" {
                    details.references = list;
                } else {
                    details.citations = list;
                }
            }
            Err(e) if e.kind == Kind::Cancelled => return Err(e),
            Err(_) => {
                complete = false;
                details.notes.push(format!("Semantic Scholar couldn't list the {label} right now."));
            }
        }
    }
    if complete {
        if let Ok(body) = serde_json::to_string(&details) {
            ctx.hooks.store(Source::SemanticScholar, &key, &body, cache::PAPER_TTL);
        }
    }
    Ok(details)
}

/// Papers Semantic Scholar recommends for one paper.
pub async fn recommendations(ctx: &NetCtx, s2_id: &str) -> AiResult<Vec<Paper>> {
    let base = ctx.services.semantic_scholar.trim_end_matches('/');
    let rec_base = match base.strip_suffix("/graph/v1") {
        Some(root) => format!("{root}/recommendations/v1"),
        None => format!("{base}/recommendations/v1"),
    };
    let key = format!("recs|{rec_base}|{}", s2_id.to_lowercase());
    if let Some(list) = ctx.hooks.cached(Source::SemanticScholar, &key).and_then(|b| serde_json::from_str::<Vec<Paper>>(&b).ok()) {
        return Ok(list);
    }
    let limit = MAX_RELATED.to_string();
    let url = net::with_query(&format!("{rec_base}/papers/forpaper/{}", encode_path(s2_id)), &[("fields", S2_REF_FIELDS), ("limit", &limit)])?;
    let v = s2_get(ctx, url).await?;
    let list: Vec<Paper> = v
        .get("recommendedPapers")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(s2_paper).take(MAX_RELATED).collect())
        .unwrap_or_default();
    if let Ok(body) = serde_json::to_string(&list) {
        ctx.hooks.store(Source::SemanticScholar, &key, &body, cache::PAPER_TTL);
    }
    Ok(list)
}

// ---------------------------------------------------- verify_bibliography --

/// The result of checking one `.bib` entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibCheck {
    /// The `.bib` file, project-relative.
    pub file: String,
    pub check: CitationCheck,
    /// The paper came from the cache (no request was sent).
    pub cached: bool,
    /// The check itself failed (offline, busy): not saved, not cached.
    pub failed: bool,
}

/// What the cache keeps for an identifier: the paper it resolved to, or
/// `None` when it resolved to nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFind {
    found: Option<Paper>,
}

/// The cache key of an entry's DOI or arXiv lookup.
fn lookup_key(ctx: &NetCtx, rec: &BibRecord) -> Option<String> {
    match rec.doi() {
        Some(d) => Some(format!("verify|doi|{}|{}", ctx.services.doi, d.to_lowercase())),
        None => rec.arxiv_id().map(|a| format!("verify|arxiv|{}|{a}", ctx.services.arxiv_api)),
    }
}

fn alnum_lower(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The check of `rec` against the paper its DOI or arXiv id resolved to
/// (the same comparison `verify_citation` makes).
fn compare(rec: &BibRecord, found: Option<Paper>) -> CitationCheck {
    let key = rec.key.clone();
    let check = |status, message: &str, differences, found| CitationCheck { key: key.clone(), status, message: message.to_string(), differences, found };
    let Some(found) = found else {
        return match rec.doi() {
            Some(doi) => check(CitationStatus::NotFound, "Its DOI doesn't resolve to any paper; it may have a typo.", vec![format!("DOI {doi} was not found.")], None),
            None => {
                let a = rec.arxiv_id().unwrap_or_default();
                check(CitationStatus::NotFound, "Its arXiv id doesn't match any paper.", vec![format!("arXiv {a} was not found.")], None)
            }
        };
    };
    let title = rec.get("title").map(bibtex::plain);
    let mut diffs = Vec::new();
    if let Some(t) = &title {
        if literature::title_similarity(t, &found.title) < 0.8 {
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
        let a = alnum_lower(first);
        if !a.is_empty() && !alnum_lower(fa).contains(&a) && !found.authors.iter().take(3).any(|x| alnum_lower(x).contains(&a)) {
            diffs.push(format!("The first author differs: the entry says {first}, the paper lists {fa}."));
        }
    }
    if rec.doi().is_none() {
        if let Some(d) = &found.doi {
            if diffs.is_empty() && bibtex::arxiv_from_doi(d).is_none() {
                diffs.push(format!("The entry has no DOI; the paper's DOI is {d}."));
                return check(CitationStatus::Verified, "It matches a real paper (you could add its DOI).", diffs, Some(found));
            }
        }
    }
    if diffs.is_empty() {
        check(CitationStatus::Verified, "It matches a real paper.", diffs, Some(found))
    } else {
        check(CitationStatus::Mismatch, "A paper was found, but some details don't match.", diffs, Some(found))
    }
}

/// Checks one entry. A DOI or arXiv id that was looked up before is
/// answered from the cache.
pub async fn verify_entry(ctx: &NetCtx, file: &str, rec: &BibRecord) -> AiResult<BibCheck> {
    let lookup = lookup_key(ctx, rec);
    if let Some(k) = &lookup {
        if let Some(hit) = ctx.hooks.cached(Source::Crossref, k).and_then(|b| serde_json::from_str::<CachedFind>(&b).ok()) {
            return Ok(BibCheck { file: file.to_string(), check: compare(rec, hit.found), cached: true, failed: false });
        }
    }
    match literature::verify_citation(ctx, rec).await {
        Ok(check) => {
            if let Some(k) = &lookup {
                let ttl = if check.found.is_some() { cache::PAPER_TTL } else { NOT_FOUND_TTL };
                if check.status != CitationStatus::Unchecked {
                    if let Ok(body) = serde_json::to_string(&CachedFind { found: check.found.clone() }) {
                        ctx.hooks.store(Source::Crossref, k, &body, ttl);
                    }
                }
            }
            Ok(BibCheck { file: file.to_string(), check, cached: false, failed: false })
        }
        Err(e) if e.kind == Kind::Cancelled => Err(e),
        Err(e) => Ok(BibCheck {
            file: file.to_string(),
            check: CitationCheck {
                key: rec.key.clone(),
                status: CitationStatus::Unchecked,
                message: format!("It couldn't be checked right now: {}", e.message),
                differences: Vec::new(),
                found: None,
            },
            cached: false,
            failed: true,
        }),
    }
}

/// The entries to check: `keys` (exact, else ignoring case) or every entry,
/// at most `max`. Returns them with the keys that aren't in any file.
pub fn pick_entries(bibs: &[(String, String)], keys: Option<&[String]>, max: usize) -> (Vec<(String, BibRecord)>, Vec<String>, usize) {
    let all: Vec<(String, BibRecord)> =
        bibs.iter().flat_map(|(f, t)| bibtex::parse_entries(t).into_iter().map(move |r| (f.clone(), r))).collect();
    let mut chosen: Vec<(String, BibRecord)> = Vec::new();
    let mut missing = Vec::new();
    match keys.filter(|k| !k.is_empty()) {
        Some(keys) => {
            for k in keys {
                let k = k.trim();
                let hit = all.iter().find(|(_, r)| r.key == k).or_else(|| all.iter().find(|(_, r)| r.key.eq_ignore_ascii_case(k)));
                match hit {
                    Some(e) if !chosen.iter().any(|(_, r)| r.key == e.1.key) => chosen.push(e.clone()),
                    Some(_) => {}
                    None => missing.push(k.to_string()),
                }
            }
        }
        None => {
            let mut seen = HashSet::new();
            for e in all {
                if seen.insert(e.1.key.to_lowercase()) {
                    chosen.push(e);
                }
            }
        }
    }
    let total = chosen.len();
    chosen.truncate(max);
    (chosen, missing, total)
}

fn status_word(s: CitationStatus) -> &'static str {
    match s {
        CitationStatus::Verified => "verified",
        CitationStatus::Mismatch => "mismatch",
        CitationStatus::NotFound => "notFound",
        CitationStatus::Unchecked => "unchecked",
    }
}

/// Saves each check on the project's link to the entry's paper
/// (`project_refs.verify_status`), in one transaction. Failed checks are
/// left out.
pub fn record_checks(conn: &mut Connection, project: &str, checks: &[(BibRecord, BibCheck)], now: i64) -> LibResult<usize> {
    let tx = conn.transaction()?;
    let project_id = store::project_id(&tx, project, None)?;
    let mut saved = 0;
    for (rec, c) in checks.iter().filter(|(_, c)| !c.failed) {
        let Some(up) = store::upsert_one(&tx, &bibsync::entry_input(rec), &Provenance::default(), now)? else { continue };
        let mut note = c.check.message.clone();
        for d in &c.check.differences {
            note.push(' ');
            note.push_str(d);
        }
        tx.execute(
            "UPDATE project_refs SET cite_key = NULL WHERE project_id = ?1 AND cite_key = ?2 AND paper_id <> ?3",
            params![project_id, rec.key, up.id],
        )?;
        tx.execute(
            "INSERT INTO project_refs(project_id, paper_id, cite_key, bib_file, in_bib, verify_status, verify_note, verified_at, added_by, added_at) \
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, 'bib-scan', ?7) \
             ON CONFLICT(project_id, paper_id) DO UPDATE SET cite_key = excluded.cite_key, bib_file = excluded.bib_file, in_bib = 1, \
             verify_status = excluded.verify_status, verify_note = excluded.verify_note, verified_at = excluded.verified_at",
            params![project_id, up.id, rec.key, c.file, status_word(c.check.status), cap(&note, 1000), now],
        )?;
        saved += 1;
    }
    tx.commit()?;
    Ok(saved)
}

/// The checks whose entry is in the project's `.bib` files on disk as it was
/// checked (`disk` is [`super::online::bib_texts`]). An agent reads the .bib
/// through its run's overlay, so an entry it added or changed with
/// insert_bibtex is checked too, but only what is on disk may be recorded as
/// "in this project": the user can still discard the run.
pub fn on_disk(checks: Vec<(BibRecord, BibCheck)>, disk: &[(String, String)]) -> Vec<(BibRecord, BibCheck)> {
    let same_path = |a: &str, b: &str| a.replace('\\', "/").eq_ignore_ascii_case(&b.replace('\\', "/"));
    checks
        .into_iter()
        .filter(|(rec, c)| {
            disk.iter().filter(|(f, _)| same_path(f, &c.file)).any(|(_, text)| {
                bibtex::find_entry(text, &rec.key)
                    .is_some_and(|d| d.entry_type == rec.entry_type && d.key == rec.key && d.fields == rec.fields)
            })
        })
        .collect()
}

/// Saves the checks when there is a library; a failure only costs the
/// "In this project" badges.
pub async fn persist_checks(ctx: &NetCtx, project: &str, checks: Vec<(BibRecord, BibCheck)>) -> Option<String> {
    let lib = ctx.library.clone()?;
    let project = project.to_string();
    match blocking(move || lib.write(|c| record_checks(c, &project, &checks, now_ms()))).await {
        Ok(_) => None,
        Err(e) => Some(format!("The results couldn't be saved in your library. {}", e.plain())),
    }
}

/// The model's text for a batch of checks.
pub fn checks_text(checks: &[BibCheck], missing: &[String], total: usize) -> String {
    let count = |s| checks.iter().filter(|c| !c.failed && c.check.status == s).count();
    let failed = checks.iter().filter(|c| c.failed).count();
    let mut out = format!(
        "Checked {} entr{}: {} verified, {} mismatch, {} not found, {} unchecked",
        checks.len(),
        if checks.len() == 1 { "y" } else { "ies" },
        count(CitationStatus::Verified),
        count(CitationStatus::Mismatch),
        count(CitationStatus::NotFound),
        count(CitationStatus::Unchecked),
    );
    if failed > 0 {
        out.push_str(&format!(", {failed} couldn't be checked"));
    }
    out.push_str(".\n");
    for c in checks {
        out.push_str(&format!("\n{} ({})", c.check.to_tool_text(), c.file));
    }
    if total > checks.len() {
        out.push_str(&format!(
            "\n\nOnly the first {} of {total} entries were checked. Call verify_bibliography again with the other keys.",
            checks.len()
        ));
    }
    if !missing.is_empty() {
        out.push_str(&format!("\n\nNot in any .bib file: {}.", missing.join(", ")));
    }
    out
}

// ------------------------------------------------------------ insert_bibtex --

/// a, b, ..., z, aa, ab, ...
fn suffix(mut n: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push((b'a' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out.iter().rev().collect()
}

/// An entry whose key no `.bib` file uses yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueEntry {
    pub key: String,
    /// The formatted entry with that key.
    pub bibtex: String,
    /// The key the service gave, when it had to change.
    pub renamed_from: Option<String>,
    pub warnings: Vec<String>,
}

/// Gives `entry` a key that is free in every one of `bibs` (`smith2020` →
/// `smith2020a`). Refuses a paper that is already in one of them (same DOI
/// or arXiv id), naming where.
pub fn unique_entry(entry: &BibEntry, bibs: &[(String, String)]) -> Result<UniqueEntry, String> {
    let mut used: HashSet<String> = HashSet::new();
    for (file, text) in bibs {
        for rec in bibtex::parse_entries(text) {
            let same_doi = matches!((&entry.doi, rec.doi()), (Some(a), Some(b)) if a.eq_ignore_ascii_case(&b));
            let same_arxiv = matches!((&entry.arxiv_id, rec.arxiv_id()), (Some(a), Some(b)) if *a == b);
            if same_doi || same_arxiv {
                return Err(format!("This paper is already in {file} as {}. Cite it with \\cite{{{}}}.", rec.key, rec.key));
            }
            used.insert(rec.key.to_lowercase());
        }
    }
    let mut rec = bibtex::parse_entries(&entry.bibtex).into_iter().next().ok_or_else(|| "The BibTeX entry couldn't be read.".to_string())?;
    let base = if rec.key.trim().is_empty() { entry.key.clone() } else { rec.key.clone() };
    let mut key = base.clone();
    let mut n = 0u32;
    while used.contains(&key.to_lowercase()) {
        key = format!("{base}{}", suffix(n));
        n += 1;
    }
    let renamed_from = (key != base).then(|| base.clone());
    rec.key = key.clone();
    Ok(UniqueEntry { key, bibtex: bibtex::format(&rec), renamed_from, warnings: entry.warnings.clone() })
}

/// Where `id` (a DOI or arXiv id) is already cited, as a refusal for the
/// model or the panel. Needs no network.
pub fn already_cited(bibs: &[(String, String)], id: &str) -> Option<String> {
    let wanted = literature::parse_paper_id(id).ok()?;
    for (file, text) in bibs {
        for rec in bibtex::parse_entries(text) {
            let same = match &wanted {
                PaperId::Doi(d) => rec.doi().is_some_and(|x| x.eq_ignore_ascii_case(d)),
                PaperId::Arxiv(a) => rec.arxiv_id().as_deref() == Some(a.as_str()),
            };
            if same {
                return Some(format!("This paper is already in {file} as {}. Cite it with \\cite{{{}}}.", rec.key, rec.key));
            }
        }
    }
    None
}

/// The `.bib` file to add to: `wanted`, else the only one, else a new
/// `references.bib` when there is none.
pub fn pick_bib(bibs: &[(String, String)], wanted: Option<&str>) -> Result<String, String> {
    if let Some(w) = wanted.map(|w| w.trim().replace('\\', "/")).filter(|w| !w.is_empty()) {
        if !w.to_ascii_lowercase().ends_with(".bib") {
            return Err("bib_file must be a .bib file.".into());
        }
        return Ok(w);
    }
    match bibs {
        [] => Ok("references.bib".into()),
        [(only, _)] => Ok(only.clone()),
        many => Err(format!(
            "This project has several .bib files ({}). Say which one with bib_file.",
            many.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// `text` with `entry` appended after a blank line, in the file's own line
/// endings.
pub fn append_entry(text: &str, entry: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let body = entry.trim_end().replace("\r\n", "\n").replace('\n', eol);
    let head = text.trim_end();
    if head.is_empty() {
        format!("{body}{eol}")
    } else {
        format!("{head}{eol}{eol}{body}{eol}")
    }
}

/// What `id` names: the DOI or arXiv id to fetch BibTeX for, and the
/// library paper when it is one. Reads the library: call it off the async
/// runtime.
fn bibtex_source(lib: Option<&Library>, id: &str) -> (Option<String>, Option<LibraryPaper>) {
    if literature::parse_paper_id(id).is_ok() {
        return (Some(id.trim().to_string()), None);
    }
    match lib.and_then(|l| l.read(|c| store::get(c, id, None)).ok().flatten()) {
        Some(p) => (p.ids.doi.clone().or_else(|| p.ids.arxiv.clone()), Some(p)),
        None => (Some(id.trim().to_string()), None),
    }
}

/// The service couldn't be reached or was busy, as opposed to answering
/// that the paper doesn't exist.
fn unreachable(kind: Kind) -> bool {
    matches!(kind, Kind::Offline | Kind::Timeout | Kind::Network | Kind::Tls | Kind::RateLimited | Kind::Server)
}

/// A BibTeX entry for a DOI, an arXiv id or a library paper, fetched
/// through `get_bibtex`. Refuses a paper that one of `bibs` already cites
/// (also when `id` is a library paper with that DOI or arXiv id).
///
/// Only a library paper ever gets an entry built from the library, and
/// only when the service can't be reached, or when the paper has neither
/// id but a paper service found it. That entry says it is unchecked. A
/// paper the service says doesn't exist, or one that only came from a
/// `.bib` file, is refused.
pub async fn fetch_entry(ctx: &NetCtx, id: &str, bibs: &[(String, String)]) -> AiResult<BibEntry> {
    let (lib, wanted) = (ctx.library.clone(), id.to_string());
    let (fetch, paper) = tokio::task::spawn_blocking(move || bibtex_source(lib.as_deref(), &wanted))
        .await
        .map_err(|_| AiError::new(Kind::Other, "Something went wrong inside Texo. Try again."))?;
    if let Some(p) = &paper {
        for x in [&p.ids.doi, &p.ids.arxiv].into_iter().flatten() {
            if let Some(msg) = already_cited(bibs, x) {
                return Err(AiError::invalid(msg));
            }
        }
    }
    match (fetch, paper) {
        (Some(x), paper) => match literature::get_bibtex(ctx, &x).await {
            Ok(e) => Ok(e),
            Err(e) => match paper {
                Some(p) if unreachable(e.kind) => Ok(entry_from_library(
                    &p,
                    "Texo couldn't reach the service to check this entry, so it was built from your library. Check it before you cite it.",
                )),
                _ => Err(e),
            },
        },
        (None, Some(p)) if !p.sources.is_empty() => Ok(entry_from_library(
            &p,
            "This paper has no DOI or arXiv id, so the entry was built from your library and couldn't be checked. Check it before you cite it.",
        )),
        (None, Some(_)) => Err(AiError::invalid(
            "This paper has no DOI or arXiv id and only came from a .bib file, so Texo can't check it. Find it with search_papers or give its DOI or arXiv id.",
        )),
        (None, None) => Err(AiError::invalid("Give a DOI or an arXiv id.")),
    }
}

/// A BibTeX entry built from what the library knows, marked unchecked
/// with `why`. It keeps the paper's DOI and arXiv id, so a `.bib` file
/// that already has the paper still refuses it.
fn entry_from_library(p: &LibraryPaper, why: &str) -> BibEntry {
    let rec = bibsync::paper_record(p, &mut HashSet::new());
    let mut warnings = vec![why.to_string()];
    warnings.extend(bibtex::validate(&rec));
    BibEntry {
        key: rec.key.clone(),
        entry_type: rec.entry_type.clone(),
        bibtex: bibtex::format(&rec),
        title: Some(p.title.clone()),
        year: p.year,
        doi: p.ids.doi.clone(),
        arxiv_id: p.ids.arxiv.clone(),
        warnings,
        source: "library".into(),
    }
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;
