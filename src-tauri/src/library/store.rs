//! Papers in the library: upserting what services return (matching by
//! identifier, then by fuzzy title, then merging field by field), reading
//! them back for the UI, and the user's own changes (save, tags, notes).

use std::collections::{BTreeMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::dedupe::{self, MatchKind, Probe};
use super::ids::{self, PaperKey};
use super::{fts, LibError, LibResult};

/// Longest abstract kept.
pub const MAX_ABSTRACT_CHARS: usize = 4000;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 40;
const MAX_NOTE_CHARS: usize = 10_000;
/// Most rows one search returns.
pub const MAX_PAGE: i64 = 100;
/// "Found by agents" covers this many days.
const AGENT_FINDS_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// One hit of a paper in one service's results.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceHit {
    /// `crossref`, `openalex`, `s2`, `arxiv` (display names are accepted).
    pub source: String,
    /// The service's own id for the paper; empty uses the paper's best id.
    pub source_id: String,
    pub citations: Option<i64>,
}

/// A paper as a service (or a `.bib` entry, or the user) describes it. The
/// search pipeline converts its `Paper` into this.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperInput {
    pub title: String,
    /// "First Last" or "Last, First", in order.
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub tldr: Option<String>,
    pub work_type: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub doi: Option<String>,
    pub arxiv: Option<String>,
    pub s2: Option<String>,
    pub corpus: Option<String>,
    pub openalex: Option<String>,
    pub pmid: Option<String>,
    pub dblp: Option<String>,
    pub citations: Option<i64>,
    pub influential: Option<i64>,
    pub is_oa: Option<bool>,
    pub oa_status: Option<String>,
    pub oa_pdf_url: Option<String>,
    pub landing_url: Option<String>,
    pub sources: Vec<SourceHit>,
}

impl PaperInput {
    /// Every identifier, canonical and without repeats.
    pub fn keys(&self) -> Vec<PaperKey> {
        let pairs = [
            ("doi", &self.doi),
            ("arxiv", &self.arxiv),
            ("s2", &self.s2),
            ("corpus", &self.corpus),
            ("openalex", &self.openalex),
            ("pmid", &self.pmid),
            ("dblp", &self.dblp),
        ];
        let mut out: Vec<PaperKey> = Vec::new();
        for (scheme, value) in pairs {
            if let Some(k) = value.as_deref().and_then(|v| PaperKey::new(scheme, v)) {
                if !out.contains(&k) {
                    out.push(k);
                }
            }
        }
        out
    }

    /// The source whose metadata ranks highest in this input.
    fn primary_source(&self) -> String {
        self.sources
            .iter()
            .map(|s| source_slug(&s.source))
            .max_by_key(|s| priority(s))
            .unwrap_or_else(|| "user".into())
    }
}

/// Who or what put a batch of papers in the library.
#[derive(Debug, Clone, Default)]
pub struct Provenance {
    /// The agent run that found them (recorded in `run_finds`).
    pub run_id: Option<String>,
    /// The tool that found them (`search_papers`, ...).
    pub tool: Option<String>,
    /// The project folder the run or the user was working in.
    pub project: Option<String>,
    /// Put the papers in "Saved".
    pub save: bool,
}

/// `Semantic Scholar` → `s2` and so on; unknown names are lower-cased.
pub fn source_slug(source: &str) -> String {
    let s = source.trim().to_lowercase();
    match s.as_str() {
        "semantic scholar" | "semanticscholar" | "semantic_scholar" | "s2" => "s2".into(),
        "open alex" | "openalex" => "openalex".into(),
        "crossref" => "crossref".into(),
        "arxiv" => "arxiv".into(),
        _ => s,
    }
}

/// Field priority for title, authors, venue, pages and the other
/// bibliographic fields: Crossref > OpenAlex > Semantic Scholar > arXiv,
/// with a `.bib` entry or a manual add below them all.
fn priority(source: &str) -> u8 {
    match source {
        "crossref" => 4,
        "openalex" => 3,
        "s2" => 2,
        "arxiv" => 1,
        _ => 0,
    }
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref().map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty())
}

fn cap_chars(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        s
    } else {
        s.chars().take(max).collect()
    }
}

/// The library's copy of one paper while it is being merged.
#[derive(Debug, Clone, Default)]
struct Row {
    id: i64,
    title: String,
    authors: Vec<String>,
    year: Option<i32>,
    venue: Option<String>,
    abstract_text: Option<String>,
    tldr: Option<String>,
    work_type: Option<String>,
    volume: Option<String>,
    issue: Option<String>,
    pages: Option<String>,
    publisher: Option<String>,
    citations: Option<i64>,
    influential: Option<i64>,
    counts_updated_at: Option<i64>,
    is_oa: Option<bool>,
    oa_status: Option<String>,
    oa_pdf_url: Option<String>,
    landing_url: Option<String>,
    /// The DOI to show, cite and verify when the row has several.
    doi: Option<String>,
    /// Which source each priority field (and `doi`) came from.
    field_src: BTreeMap<String, String>,
}

/// `extra_json`: where fields came from, and the preferred DOI.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Extra {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    src: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    doi: Option<String>,
}

fn parse_extra(json: Option<String>) -> Extra {
    json.and_then(|e| serde_json::from_str(&e).ok()).unwrap_or_default()
}

/// How good a DOI is to cite: a published version beats a preprint, then
/// the source's field priority decides.
fn doi_rank(doi: &str, source: &str) -> (bool, u8) {
    (!ids::is_preprint_doi(doi), priority(source))
}

fn first_author_norm(authors: &[String]) -> Option<String> {
    authors.first().and_then(|a| dedupe::surname_norm(a))
}

fn load_row(tx: &Connection, id: i64) -> LibResult<Row> {
    Ok(tx.query_row(
        "SELECT id, title, authors_json, year, venue, abstract, tldr, work_type, volume, issue, pages, publisher, \
         citation_count, influential_count, counts_updated_at, is_oa, oa_status, oa_pdf_url, landing_url, extra_json \
         FROM papers WHERE id = ?1",
        params![id],
        |r| {
            let authors: String = r.get(2)?;
            let extra = parse_extra(r.get(19)?);
            Ok(Row {
                id: r.get(0)?,
                title: r.get(1)?,
                authors: serde_json::from_str(&authors).unwrap_or_default(),
                year: r.get(3)?,
                venue: r.get(4)?,
                abstract_text: r.get(5)?,
                tldr: r.get(6)?,
                work_type: r.get(7)?,
                volume: r.get(8)?,
                issue: r.get(9)?,
                pages: r.get(10)?,
                publisher: r.get(11)?,
                citations: r.get(12)?,
                influential: r.get(13)?,
                counts_updated_at: r.get(14)?,
                is_oa: r.get::<_, Option<i64>>(15)?.map(|v| v != 0),
                oa_status: r.get(16)?,
                oa_pdf_url: r.get(17)?,
                landing_url: r.get(18)?,
                doi: extra.doi,
                field_src: extra.src,
            })
        },
    )?)
}

/// Folds `p` into `row`: priority fields go to the better source, the
/// longest abstract wins, TL;DR and influential citations come from
/// Semantic Scholar, citation counts keep the highest.
fn merge_into(row: &mut Row, p: &PaperInput, now: i64) {
    let src = p.primary_source();
    let rank = priority(&src);
    // An empty field takes any value; a filled one only a better source's.
    let wins = |row: &Row, field: &str, empty: bool| -> bool {
        empty || row.field_src.get(field).map(|s| priority(s)).unwrap_or(0) < rank
    };
    macro_rules! take {
        ($field:literal, $slot:expr, $value:expr) => {
            if let Some(v) = $value {
                let empty = $slot.is_none();
                if wins(row, $field, empty) {
                    $slot = Some(v);
                    row.field_src.insert($field.to_string(), src.clone());
                }
            }
        };
    }
    let title = clean(&Some(p.title.clone()));
    if let Some(t) = title {
        if wins(row, "title", row.title.is_empty()) {
            row.title = t;
            row.field_src.insert("title".into(), src.clone());
        }
    }
    let authors: Vec<String> = p.authors.iter().map(|a| a.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|a| !a.is_empty()).collect();
    if !authors.is_empty() && wins(row, "authors", row.authors.is_empty()) {
        row.authors = authors;
        row.field_src.insert("authors".into(), src.clone());
    }
    take!("venue", row.venue, clean(&p.venue));
    take!("year", row.year, p.year);
    take!("pages", row.pages, clean(&p.pages));
    take!("volume", row.volume, clean(&p.volume));
    take!("issue", row.issue, clean(&p.issue));
    take!("publisher", row.publisher, clean(&p.publisher));
    take!("work_type", row.work_type, clean(&p.work_type));
    let doi = p.keys().into_iter().find_map(|k| match k {
        PaperKey::Doi(d) => Some(d),
        _ => None,
    });
    if let Some(d) = doi {
        let better = match &row.doi {
            None => true,
            Some(old) => doi_rank(&d, &src) > doi_rank(old, row.field_src.get("doi").map(String::as_str).unwrap_or("")),
        };
        if better {
            row.doi = Some(d);
            row.field_src.insert("doi".into(), src.clone());
        }
    }

    if let Some(a) = p.abstract_text.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        let a = cap_chars(a.to_string(), MAX_ABSTRACT_CHARS);
        if row.abstract_text.as_ref().is_none_or(|old| a.chars().count() > old.chars().count()) {
            row.abstract_text = Some(a);
        }
    }
    let from_s2 = src == "s2" || p.sources.iter().any(|s| source_slug(&s.source) == "s2");
    if let Some(t) = clean(&p.tldr) {
        if from_s2 || row.tldr.is_none() {
            row.tldr = Some(t);
        }
    }
    if let Some(i) = p.influential {
        if from_s2 || row.influential.is_none() {
            row.influential = Some(i);
            row.counts_updated_at = Some(now);
        }
    }
    let best_hit = p.sources.iter().filter_map(|s| s.citations).max();
    if let Some(c) = p.citations.into_iter().chain(best_hit).max() {
        row.citations = Some(row.citations.map_or(c, |old| old.max(c)));
        row.counts_updated_at = Some(now);
    }
    if let Some(oa) = p.is_oa {
        row.is_oa = Some(oa || row.is_oa.unwrap_or(false));
    }
    if row.oa_status.is_none() {
        row.oa_status = clean(&p.oa_status);
    }
    if row.oa_pdf_url.is_none() {
        row.oa_pdf_url = clean(&p.oa_pdf_url);
    }
    if row.landing_url.is_none() {
        row.landing_url = clean(&p.landing_url);
    }
}

fn write_row(tx: &Transaction<'_>, row: &Row, now: i64) -> LibResult<()> {
    let extra = Extra { src: row.field_src.clone(), doi: row.doi.clone() };
    tx.execute(
        "UPDATE papers SET title = ?2, title_norm = ?3, first_author_norm = ?4, authors_json = ?5, authors_text = ?6, \
         abstract = ?7, tldr = ?8, year = ?9, venue = ?10, work_type = ?11, volume = ?12, issue = ?13, pages = ?14, \
         publisher = ?15, citation_count = ?16, influential_count = ?17, counts_updated_at = ?18, is_oa = ?19, \
         oa_status = ?20, oa_pdf_url = ?21, landing_url = ?22, extra_json = ?23, updated_at = ?24, last_seen_at = ?24 \
         WHERE id = ?1",
        params![
            row.id,
            row.title,
            dedupe::fold(&row.title),
            first_author_norm(&row.authors),
            serde_json::to_string(&row.authors)?,
            row.authors.join("; "),
            row.abstract_text,
            row.tldr,
            row.year,
            row.venue,
            row.work_type,
            row.volume,
            row.issue,
            row.pages,
            row.publisher,
            row.citations,
            row.influential,
            row.counts_updated_at,
            row.is_oa.map(i64::from),
            row.oa_status,
            row.oa_pdf_url,
            row.landing_url,
            serde_json::to_string(&extra)?,
            now,
        ],
    )?;
    Ok(())
}

/// The row an identifier already belongs to.
fn find_by_keys(tx: &Connection, keys: &[PaperKey]) -> LibResult<Option<i64>> {
    let mut stmt = tx.prepare_cached("SELECT paper_id FROM paper_ids WHERE scheme = ?1 AND value = ?2")?;
    for k in keys {
        if let Some(id) = stmt.query_row(params![k.scheme(), k.value()], |r| r.get(0)).optional()? {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Whether a candidate row holds an identifier that rules out the incoming
/// paper: an id in a scheme the incoming paper also has. The incoming ids
/// matched no row (`find_by_keys` came first), so sharing a scheme means two
/// different values: two publisher DOIs, two arXiv ids, two ids in one
/// database. Preprint-server DOIs don't count, since a preprint and its
/// published version carry one each.
fn ids_conflict(tx: &Connection, candidate: i64, keys: &[PaperKey]) -> LibResult<bool> {
    let counts = |k: &PaperKey| !matches!(k, PaperKey::Doi(d) if ids::is_preprint_doi(d));
    let schemes: HashSet<&str> = keys.iter().filter(|k| counts(k)).map(PaperKey::scheme).collect();
    if schemes.is_empty() {
        return Ok(false);
    }
    let mut stmt = tx.prepare_cached("SELECT scheme, value FROM paper_ids WHERE paper_id = ?1")?;
    let rows = stmt.query_map(params![candidate], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (scheme, value) = row?;
        if schemes.contains(scheme.as_str()) && PaperKey::new(&scheme, &value).is_none_or(|k| counts(&k)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The best fuzzy candidate: (row id, how good). Candidates share the first
/// characters of the folded title and a year within one. The prefix is
/// looked up as a range so it uses `papers_title_year`, and when a block is
/// large the titles closest in length (then year) are compared first. A
/// candidate whose title numbers differ (Part I and Part II) or that holds a
/// conflicting identifier is never a match, not even a probable one.
fn find_fuzzy(tx: &Connection, title: &str, year: Option<i32>, first_author: Option<&str>, keys: &[PaperKey]) -> LibResult<Option<(i64, MatchKind)>> {
    let folded = dedupe::fold(title);
    let title_norm = folded.as_str();
    let prefix = dedupe::block_prefix(title_norm);
    if prefix.chars().count() < dedupe::BLOCK_PREFIX {
        return Ok(None);
    }
    // U+10FFFF sorts after every character, so this is "starts with prefix".
    let upper = format!("{prefix}\u{10FFFF}");
    let len = title_norm.chars().count() as i64;
    let mut stmt = tx.prepare_cached(
        "SELECT id, coalesce(dup_of, id), title_norm, year, first_author_norm, title FROM papers \
         WHERE title_norm >= ?1 AND title_norm < ?2 AND (?3 IS NULL OR year IS NULL OR abs(year - ?3) <= 1) \
         ORDER BY abs(length(title_norm) - ?4), coalesce(abs(year - ?3), 0), id LIMIT ?5",
    )?;
    let rows = stmt.query_map(params![prefix, upper, year, len, dedupe::BLOCK_LIMIT], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i32>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let me = Probe { title_norm, year, first_author };
    let my_numerals = dedupe::numerals(title);
    let mut scored: Vec<(i64, i64, MatchKind, f64)> = Vec::new();
    for row in rows {
        let (id, root, norm, y, author, raw) = row?;
        let other = Probe { title_norm: &norm, year: y, first_author: author.as_deref() };
        let kind = dedupe::match_kind(&me, &other);
        if kind == MatchKind::None || dedupe::numerals(&raw) != my_numerals {
            continue;
        }
        let sim = dedupe::jaro_winkler(title_norm, &norm);
        let score = if kind == MatchKind::Strong { 2.0 + sim } else { sim };
        scored.push((id, root, kind, score));
    }
    // Best first (ties keep the query's order); the identifier check, a
    // query per row, stops at the first candidate that passes it.
    scored.sort_by(|a, b| b.3.total_cmp(&a.3));
    for (id, root, kind, _) in scored {
        if ids_conflict(tx, id, keys)? {
            continue;
        }
        let target = if kind == MatchKind::Strong { id } else { root };
        return Ok(Some((target, kind)));
    }
    Ok(None)
}

fn new_uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// What one upsert did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upserted {
    pub id: i64,
    pub uid: String,
    /// A new row (not merged into an existing one).
    pub created: bool,
}

/// Adds or merges one paper inside an open transaction.
pub fn upsert_one(tx: &Transaction<'_>, p: &PaperInput, prov: &Provenance, now: i64) -> LibResult<Option<Upserted>> {
    let keys = p.keys();
    let title = clean(&Some(p.title.clone())).unwrap_or_default();
    let mut existing = find_by_keys(tx, &keys)?;
    let mut dup_of = None;
    let title_norm = dedupe::fold(&title);
    if existing.is_none() {
        let author = first_author_norm(&p.authors);
        match find_fuzzy(tx, &title, p.year, author.as_deref(), &keys)? {
            Some((id, MatchKind::Strong)) => existing = Some(id),
            Some((id, MatchKind::Probable)) => dup_of = Some(id),
            _ => {}
        }
    }
    let (id, created) = match existing {
        Some(id) => (id, false),
        None => {
            if title.is_empty() {
                // Nothing to show and nothing to match on later.
                return Ok(None);
            }
            tx.execute(
                "INSERT INTO papers(uid, title, title_norm, created_at, updated_at, last_seen_at, dup_of) \
                 VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?5)",
                params![new_uid(), title, title_norm, now, dup_of],
            )?;
            (tx.last_insert_rowid(), true)
        }
    };
    let mut row = load_row(tx, id)?;
    if created {
        row.title.clear();
    }
    merge_into(&mut row, p, now);
    write_row(tx, &row, now)?;

    let mut ins_id = tx.prepare_cached("INSERT OR IGNORE INTO paper_ids(paper_id, scheme, value) VALUES (?1, ?2, ?3)")?;
    for k in &keys {
        ins_id.execute(params![id, k.scheme(), k.value()])?;
    }
    let fallback_id = keys.first().map(|k| format!("{}:{}", k.scheme(), k.value())).unwrap_or_else(|| title_norm.clone());
    let mut ins_src = tx.prepare_cached(
        "INSERT INTO paper_sources(paper_id, source, source_id, fetched_at, citation_count) VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(source, source_id) DO UPDATE SET fetched_at = excluded.fetched_at, \
         citation_count = coalesce(excluded.citation_count, paper_sources.citation_count)",
    )?;
    for s in &p.sources {
        let source = source_slug(&s.source);
        if source.is_empty() {
            continue;
        }
        let sid = if s.source_id.trim().is_empty() { fallback_id.clone() } else { s.source_id.trim().to_string() };
        ins_src.execute(params![id, source, sid, now, s.citations])?;
    }
    let project_id = match &prov.project {
        Some(path) => Some(project_id(tx, path, None)?),
        None => None,
    };
    if let Some(run) = &prov.run_id {
        tx.execute(
            "INSERT INTO run_finds(run_id, project_id, paper_id, tool, at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(run_id, paper_id) DO UPDATE SET at = excluded.at",
            params![run, project_id, id, prov.tool, now],
        )?;
    }
    if prov.save {
        tx.execute("UPDATE papers SET saved_at = coalesce(saved_at, ?2) WHERE id = ?1", params![id, now])?;
    }
    let uid: String = tx.query_row("SELECT uid FROM papers WHERE id = ?1", params![id], |r| r.get(0))?;
    Ok(Some(Upserted { id, uid, created }))
}

/// Adds or merges a batch in one transaction; returns the uid of each paper
/// in input order (papers with neither a title nor a known id are skipped).
#[allow(dead_code)] // called by the online search pipeline and the agents' tools
pub fn upsert_papers(conn: &mut Connection, papers: &[PaperInput], prov: &Provenance, now: i64) -> LibResult<Vec<String>> {
    let tx = conn.transaction()?;
    let mut out = Vec::new();
    for p in papers {
        if let Some(u) = upsert_one(&tx, p, prov, now)? {
            out.push(u.uid);
        }
    }
    tx.commit()?;
    Ok(out)
}

/// The `projects` row for a folder, created when missing.
pub fn project_id(conn: &Connection, path: &str, name: Option<&str>) -> LibResult<i64> {
    conn.execute(
        "INSERT INTO projects(path, name) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET name = coalesce(excluded.name, projects.name)",
        params![path, name],
    )?;
    Ok(conn.query_row("SELECT id FROM projects WHERE path = ?1", params![path], |r| r.get(0))?)
}

// ---- Reading -------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OaInfo {
    pub status: Option<String>,
    pub pdf_url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperIds {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openalex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corpus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pmid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dblp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub source: String,
    pub fetched_at: i64,
    pub citations: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProject {
    pub cite_key: Option<String>,
    pub bib_file: Option<String>,
    /// `verified` | `mismatch` | `notFound` | `unchecked`, or null before a check.
    pub verify: Option<String>,
    pub verify_note: Option<String>,
    pub in_bib: bool,
    pub added_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFind {
    pub run_id: String,
    pub tool: Option<String>,
    pub at: i64,
}

/// A paper as the UI shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPaper {
    pub uid: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub tldr: Option<String>,
    pub citations: Option<i64>,
    pub influential: Option<i64>,
    pub oa: Option<OaInfo>,
    pub ids: PaperIds,
    pub sources: Vec<SourceInfo>,
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_project: Option<InProject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dup_of: Option<String>,
    /// Matched words are wrapped in `\u{2}` … `\u{3}` (never HTML).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub tags: Vec<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub work_type: Option<String>,
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub pages: Option<String>,
    pub publisher: Option<String>,
    pub found_by: Vec<RunFind>,
    pub last_seen_at: i64,
}

const PAPER_COLUMNS: &str = "p.id, p.uid, p.title, p.authors_json, p.year, p.venue, p.abstract, p.tldr, p.citation_count, \
    p.influential_count, p.is_oa, p.oa_status, p.oa_pdf_url, p.landing_url, p.saved_at, p.note, p.work_type, p.volume, \
    p.issue, p.pages, p.publisher, (SELECT d.uid FROM papers d WHERE d.id = p.dup_of), p.last_seen_at";

fn paper_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, LibraryPaper)> {
    let authors: String = r.get(3)?;
    let is_oa: Option<i64> = r.get(10)?;
    let oa_status: Option<String> = r.get(11)?;
    let oa_pdf: Option<String> = r.get(12)?;
    let oa = (is_oa == Some(1) || oa_status.is_some() || oa_pdf.is_some()).then_some(OaInfo { status: oa_status, pdf_url: oa_pdf });
    let saved_at: Option<i64> = r.get(14)?;
    Ok((
        r.get(0)?,
        LibraryPaper {
            uid: r.get(1)?,
            title: r.get(2)?,
            authors: serde_json::from_str(&authors).unwrap_or_default(),
            year: r.get(4)?,
            venue: r.get(5)?,
            abstract_text: r.get(6)?,
            tldr: r.get(7)?,
            citations: r.get(8)?,
            influential: r.get(9)?,
            oa,
            ids: PaperIds::default(),
            sources: Vec::new(),
            saved: saved_at.is_some(),
            in_project: None,
            dup_of: r.get(21)?,
            snippet: None,
            tags: Vec::new(),
            note: r.get(15)?,
            url: r.get(13)?,
            work_type: r.get(16)?,
            volume: r.get(17)?,
            issue: r.get(18)?,
            pages: r.get(19)?,
            publisher: r.get(20)?,
            found_by: Vec::new(),
            last_seen_at: r.get(22)?,
        },
    ))
}

/// Fills ids, sources, tags, agent finds and (for `project`) the project link.
fn complete(conn: &Connection, id: i64, p: &mut LibraryPaper, project: Option<&str>) -> LibResult<()> {
    let mut stmt = conn.prepare_cached("SELECT scheme, value FROM paper_ids WHERE paper_id = ?1 ORDER BY scheme, value")?;
    let id_rows = stmt.query_map(params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut dois: Vec<String> = Vec::new();
    for row in id_rows {
        let (scheme, value) = row?;
        let slot = match scheme.as_str() {
            "doi" => {
                dois.push(value);
                continue;
            }
            "arxiv" => &mut p.ids.arxiv,
            "s2" => &mut p.ids.s2,
            "openalex" => &mut p.ids.openalex,
            "corpus" => &mut p.ids.corpus,
            "pmid" => &mut p.ids.pmid,
            "dblp" => &mut p.ids.dblp,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value);
        }
    }
    if !dois.is_empty() {
        // The DOI the merge preferred, else a published one, else any.
        let mut stmt = conn.prepare_cached("SELECT extra_json FROM papers WHERE id = ?1")?;
        let preferred = parse_extra(stmt.query_row(params![id], |r| r.get(0))?).doi;
        p.ids.doi = preferred
            .filter(|d| dois.contains(d))
            .or_else(|| dois.iter().find(|d| !ids::is_preprint_doi(d)).cloned())
            .or_else(|| dois.first().cloned());
    }
    let mut stmt = conn.prepare_cached(
        "SELECT source, max(fetched_at), max(citation_count) FROM paper_sources WHERE paper_id = ?1 GROUP BY source ORDER BY source",
    )?;
    p.sources = stmt
        .query_map(params![id], |r| Ok(SourceInfo { source: r.get(0)?, fetched_at: r.get(1)?, citations: r.get(2)? }))?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare_cached("SELECT t.name FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id = ?1 ORDER BY t.name COLLATE NOCASE")?;
    p.tags = stmt.query_map(params![id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare_cached("SELECT run_id, tool, at FROM run_finds WHERE paper_id = ?1 ORDER BY at DESC LIMIT 10")?;
    p.found_by = stmt
        .query_map(params![id], |r| Ok(RunFind { run_id: r.get(0)?, tool: r.get(1)?, at: r.get(2)? }))?
        .collect::<Result<_, _>>()?;
    if let Some(path) = project {
        p.in_project = conn
            .query_row(
                "SELECT r.cite_key, r.bib_file, r.verify_status, r.verify_note, r.in_bib, r.added_by FROM project_refs r \
                 JOIN projects j ON j.id = r.project_id WHERE j.path = ?1 AND r.paper_id = ?2",
                params![path, id],
                |r| {
                    Ok(InProject {
                        cite_key: r.get(0)?,
                        bib_file: r.get(1)?,
                        verify: r.get(2)?,
                        verify_note: r.get(3)?,
                        in_bib: r.get::<_, i64>(4)? != 0,
                        added_by: r.get(5)?,
                    })
                },
            )
            .optional()?;
    }
    Ok(())
}

/// The row id for a uid, or for a DOI / arXiv id / OpenAlex id.
pub fn resolve(conn: &Connection, id: &str) -> LibResult<Option<i64>> {
    let id = id.trim();
    if let Some(row) = conn.query_row("SELECT id FROM papers WHERE uid = ?1", params![id], |r| r.get(0)).optional()? {
        return Ok(Some(row));
    }
    match PaperKey::parse(id) {
        Some(k) => find_by_keys(conn, &[k]),
        None => Ok(None),
    }
}

fn not_found() -> LibError {
    LibError::msg("That paper isn't in your library any more.")
}

fn must_resolve(conn: &Connection, id: &str) -> LibResult<i64> {
    resolve(conn, id)?.ok_or_else(not_found)
}

fn by_row_id(conn: &Connection, id: i64, project: Option<&str>) -> LibResult<LibraryPaper> {
    let (_, mut p) = conn.query_row(&format!("SELECT {PAPER_COLUMNS} FROM papers p WHERE p.id = ?1"), params![id], paper_from_row)?;
    complete(conn, id, &mut p, project)?;
    Ok(p)
}

/// One paper with everything the details drawer shows.
pub fn get(conn: &Connection, id: &str, project: Option<&str>) -> LibResult<Option<LibraryPaper>> {
    match resolve(conn, id)? {
        Some(row) => by_row_id(conn, row, project).map(Some),
        None => Ok(None),
    }
}

pub fn save(conn: &Connection, uid: &str, now: i64) -> LibResult<()> {
    let id = must_resolve(conn, uid)?;
    conn.execute("UPDATE papers SET saved_at = coalesce(saved_at, ?2), updated_at = ?2 WHERE id = ?1", params![id, now])?;
    Ok(())
}

pub fn unsave(conn: &Connection, uid: &str, now: i64) -> LibResult<()> {
    let id = must_resolve(conn, uid)?;
    conn.execute("UPDATE papers SET saved_at = NULL, updated_at = ?2 WHERE id = ?1", params![id, now])?;
    Ok(())
}

/// Deletes the paper and everything that hangs off it.
pub fn remove(conn: &mut Connection, uid: &str) -> LibResult<()> {
    let tx = conn.transaction()?;
    let id = must_resolve(&tx, uid)?;
    tx.execute("UPDATE papers SET dup_of = NULL WHERE dup_of = ?1", params![id])?;
    tx.execute("DELETE FROM papers WHERE id = ?1", params![id])?;
    tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)", [])?;
    tx.commit()?;
    Ok(())
}

/// Replaces the paper's tags; returns them as stored.
pub fn set_tags(conn: &mut Connection, uid: &str, tags: &[String], now: i64) -> LibResult<Vec<String>> {
    let mut clean_tags: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for t in tags {
        let t = cap_chars(t.split_whitespace().collect::<Vec<_>>().join(" "), MAX_TAG_CHARS);
        if !t.is_empty() && seen.insert(t.to_lowercase()) {
            clean_tags.push(t);
        }
    }
    if clean_tags.len() > MAX_TAGS {
        return Err(LibError::msg(format!("A paper can have at most {MAX_TAGS} tags.")));
    }
    let tx = conn.transaction()?;
    let id = must_resolve(&tx, uid)?;
    tx.execute("DELETE FROM paper_tags WHERE paper_id = ?1", params![id])?;
    for t in &clean_tags {
        let existing: Option<i64> =
            tx.query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE", params![t], |r| r.get(0)).optional()?;
        let tag_id = match existing {
            Some(tid) => tid,
            None => {
                tx.execute("INSERT INTO tags(name) VALUES (?1)", params![t])?;
                tx.last_insert_rowid()
            }
        };
        tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id, tag_id) VALUES (?1, ?2)", params![id, tag_id])?;
    }
    tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)", [])?;
    tx.execute("UPDATE papers SET updated_at = ?2 WHERE id = ?1", params![id, now])?;
    let p = by_row_id(&tx, id, None)?;
    tx.commit()?;
    Ok(p.tags)
}

/// Sets (or with an empty text, clears) the paper's note.
pub fn set_note(conn: &Connection, uid: &str, note: Option<&str>, now: i64) -> LibResult<()> {
    let id = must_resolve(conn, uid)?;
    let note = note.map(str::trim).filter(|n| !n.is_empty()).map(|n| cap_chars(n.to_string(), MAX_NOTE_CHARS));
    conn.execute("UPDATE papers SET note = ?2, updated_at = ?3 WHERE id = ?1", params![id, note, now])?;
    Ok(())
}

// ---- Search --------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    #[default]
    All,
    Saved,
    /// Papers linked to `LibraryFilters::project`.
    Project,
    /// Papers an agent found in the last 30 days.
    Agents,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sort {
    #[default]
    Relevance,
    Cited,
    Newest,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryFilters {
    pub scope: Scope,
    /// The open project: used by the Project scope and for "In project" badges.
    pub project: Option<String>,
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    pub oa_only: bool,
    pub min_citations: Option<i64>,
    /// Only papers seen from this source (`s2`, `crossref`, ...).
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub items: Vec<LibraryPaper>,
    pub total: i64,
}

/// Full-text search over the library (title matches weigh most), with
/// filters, a sort and paging. An empty query lists everything in scope.
pub fn search_local(
    conn: &Connection,
    query: &str,
    filters: &LibraryFilters,
    sort: Sort,
    limit: i64,
    offset: i64,
    now: i64,
) -> LibResult<SearchPage> {
    let fts_query = fts::sanitize_query(query);
    let text = !fts_query.is_empty();
    let mut args: Vec<Value> = Vec::new();
    let mut wh: Vec<String> = Vec::new();
    let from = if text {
        args.push(Value::Text(fts_query));
        wh.push("papers_fts MATCH ?".into());
        "papers p JOIN papers_fts ON papers_fts.rowid = p.id"
    } else {
        "papers p"
    };
    if let Some(y) = filters.year_from {
        wh.push("p.year >= ?".into());
        args.push(Value::Integer(y.into()));
    }
    if let Some(y) = filters.year_to {
        wh.push("p.year <= ?".into());
        args.push(Value::Integer(y.into()));
    }
    if filters.oa_only {
        wh.push("(p.is_oa = 1 OR p.oa_pdf_url IS NOT NULL)".into());
    }
    if let Some(c) = filters.min_citations.filter(|c| *c > 0) {
        wh.push("coalesce(p.citation_count, 0) >= ?".into());
        args.push(Value::Integer(c));
    }
    if let Some(s) = filters.source.as_deref().map(source_slug).filter(|s| !s.is_empty()) {
        wh.push("EXISTS (SELECT 1 FROM paper_sources s WHERE s.paper_id = p.id AND s.source = ?)".into());
        args.push(Value::Text(s));
    }
    match filters.scope {
        Scope::All => {}
        Scope::Saved => wh.push("p.saved_at IS NOT NULL".into()),
        Scope::Project => {
            wh.push("EXISTS (SELECT 1 FROM project_refs r JOIN projects j ON j.id = r.project_id WHERE r.paper_id = p.id AND j.path = ?)".into());
            args.push(Value::Text(filters.project.clone().unwrap_or_default()));
        }
        Scope::Agents => {
            wh.push("EXISTS (SELECT 1 FROM run_finds f WHERE f.paper_id = p.id AND f.at >= ?)".into());
            args.push(Value::Integer(now - AGENT_FINDS_MS));
        }
    }
    let where_sql = if wh.is_empty() { String::new() } else { format!("WHERE {}", wh.join(" AND ")) };
    let total: i64 = conn.query_row(&format!("SELECT count(*) FROM {from} {where_sql}"), params_from_iter(args.iter()), |r| r.get(0))?;

    let order = match (sort, text) {
        (Sort::Relevance, true) => "bm25(papers_fts, 10.0, 4.0, 1.0, 1.0, 2.0) ASC, p.id DESC",
        (Sort::Relevance, false) => "coalesce(p.saved_at, 0) DESC, p.last_seen_at DESC, p.id DESC",
        (Sort::Cited, _) => "p.citation_count IS NULL, p.citation_count DESC, p.id DESC",
        (Sort::Newest, _) => "p.year IS NULL, p.year DESC, p.last_seen_at DESC, p.id DESC",
    };
    let snippet = if text {
        format!("snippet(papers_fts, -1, char({}), char({}), '…', 16)", fts::MARK_START as u32, fts::MARK_END as u32)
    } else {
        "NULL".into()
    };
    let sql = format!("SELECT {PAPER_COLUMNS}, {snippet} FROM {from} {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    args.push(Value::Integer(limit.clamp(1, MAX_PAGE)));
    args.push(Value::Integer(offset.max(0)));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        let (id, mut p) = paper_from_row(r)?;
        p.snippet = r.get(23)?;
        Ok((id, p))
    })?;
    let mut items = Vec::new();
    for row in rows {
        let (id, mut p) = row?;
        complete(conn, id, &mut p, filters.project.as_deref())?;
        items.push(p);
    }
    Ok(SearchPage { items, total })
}

/// The papers linked to a project, by cite key.
pub fn project_refs(conn: &Connection, project: &str) -> LibResult<Vec<LibraryPaper>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PAPER_COLUMNS} FROM papers p JOIN project_refs r ON r.paper_id = p.id JOIN projects j ON j.id = r.project_id \
         WHERE j.path = ?1 ORDER BY r.cite_key IS NULL, r.cite_key COLLATE NOCASE, p.title COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map(params![project], paper_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, mut p) = row?;
        complete(conn, id, &mut p, Some(project))?;
        out.push(p);
    }
    Ok(out)
}

/// Saved papers, newest first (the default export).
pub fn saved(conn: &Connection) -> LibResult<Vec<LibraryPaper>> {
    let mut stmt = conn.prepare(&format!("SELECT {PAPER_COLUMNS} FROM papers p WHERE p.saved_at IS NOT NULL ORDER BY p.saved_at DESC"))?;
    let rows = stmt.query_map([], paper_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, mut p) = row?;
        complete(conn, id, &mut p, None)?;
        out.push(p);
    }
    Ok(out)
}

/// The papers with these uids, in that order (unknown ones are skipped).
pub fn many(conn: &Connection, uids: &[String]) -> LibResult<Vec<LibraryPaper>> {
    let mut out = Vec::new();
    for uid in uids {
        if let Some(p) = get(conn, uid, None)? {
            out.push(p);
        }
    }
    Ok(out)
}
