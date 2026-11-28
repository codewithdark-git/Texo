//! Library commands that go to the network: the online search of the
//! Papers panel (with a `library-progress` event per source), checking a
//! project's citations, a BibTeX entry with a key the project doesn't use
//! yet, and a paper's references, citing papers and recommendations.
//!
//! They all use the same context as the agents' tools (keys from the
//! credential store, never sent to the webview), and they all work when the
//! library is unavailable: results are then returned without being saved.
//! A long request can be stopped with `library_cancel`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _, State};

use super::pipeline::{self, BibCheck, Listener, UniqueEntry};
use super::store::{LibraryPaper, Provenance};
use super::{bibsync, LibraryState};
use crate::agents::tools::literature::{self, SearchOpts, SearchSort, SourceEvent, SourceSet, SourceState, MAX_PAPERS_UI};
use crate::agents::tools::net::NetCtx;
use crate::agents::tools::web_settings;
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::Cancel;
use crate::AppState;

/// The event a running request reports on.
pub const PROGRESS_EVENT: &str = "library-progress";
/// The most entries one "Check all citations" checks.
pub const MAX_UI_VERIFY: usize = 300;

type Shared<'a> = State<'a, Mutex<AppState>>;

/// Payload of `library-progress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryProgress {
    pub request_id: String,
    /// `s2`, `crossref`, `arxiv`, `openalex`, or `verify` for a citation check.
    pub source: String,
    /// `pending`, `waiting`, `ok`, `degraded` or `skipped`.
    pub state: &'static str,
    /// Plain words: "waiting 3s", "12 results", why it failed, or the key
    /// being checked.
    pub detail: Option<String>,
    /// Citation checks: entries finished so far, and how many in all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

/// A source event as the panel's chip shows it.
pub fn progress_of(request_id: &str, ev: &SourceEvent) -> LibraryProgress {
    let (state, detail) = match &ev.state {
        SourceState::Pending => ("pending", None),
        SourceState::Waiting(ms) => ("waiting", Some(format!("waiting {}s", ms.div_ceil(1000)))),
        SourceState::Ok(1) => ("ok", Some("1 result".to_string())),
        SourceState::Ok(n) => ("ok", Some(format!("{n} results"))),
        SourceState::Degraded(note) => ("degraded", Some(note.clone())),
        SourceState::Skipped(reason) => ("skipped", Some(reason.clone())),
    };
    LibraryProgress { request_id: request_id.to_string(), source: ev.source.key().to_string(), state, detail, done: None, total: None }
}

/// Where progress goes (the app emits it; tests collect it).
pub type Emit = Arc<dyn Fn(LibraryProgress) + Send + Sync>;

// -------------------------------------------------------------- running --

fn running() -> MutexGuard<'static, HashMap<String, Cancel>> {
    static R: OnceLock<Mutex<HashMap<String, Cancel>>> = OnceLock::new();
    R.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Takes a request off the running list however it ends.
struct Guard(String);

impl Drop for Guard {
    fn drop(&mut self) {
        running().remove(&self.0);
    }
}

fn begin(request_id: &str) -> AiResult<(Cancel, Guard)> {
    let id = request_id.trim();
    if id.is_empty() || id.len() > 100 {
        return Err(AiError::invalid("The request needs a short id."));
    }
    let mut r = running();
    if r.contains_key(id) {
        return Err(AiError::invalid("That request is already running."));
    }
    let cancel = Cancel::default();
    r.insert(id.to_string(), cancel.clone());
    Ok((cancel, Guard(id.to_string())))
}

/// Stops a running online search or citation check.
#[tauri::command]
pub fn library_cancel(request_id: String) {
    if let Some(c) = running().get(request_id.trim()) {
        c.cancel();
    }
}

// -------------------------------------------------------------- helpers --

fn project_dir(state: &Shared<'_>, project: &str) -> AiResult<PathBuf> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(crate::commands::known_project(&s, project)?.0)
}

/// The tools' context, with the library plugged in (also when the settings
/// can't be read: then without keys).
async fn context(app: &AppHandle, cancel: Cancel) -> NetCtx {
    match web_settings::net_ctx(app, cancel.clone()).await {
        Ok(c) => c,
        Err(_) => {
            let mut c = NetCtx::new(cancel);
            pipeline::attach(&mut c, app.try_state::<LibraryState>().and_then(|s| s.0.clone()));
            c
        }
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AiResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|_| AiError::new(Kind::Other, "Something went wrong inside Texo. Try again."))
}

/// The project's `.bib` files (those its main document uses, else all) as
/// (project-relative path, text).
pub fn bib_texts(root: &Path) -> Vec<(String, String)> {
    bibsync::bib_files(root)
        .into_iter()
        .filter_map(|f| {
            let text = crate::bibinputs::read_text(&f)?;
            let rel = f.strip_prefix(root).unwrap_or(&f).to_string_lossy().replace('\\', "/");
            Some((rel, text))
        })
        .collect()
}

/// Saves papers fetched for the panel (as seen, not "Saved") and returns
/// them as the panel shows them.
async fn as_items(ctx: &NetCtx, papers: Vec<literature::Paper>, project: Option<String>) -> Vec<LibraryPaper> {
    let fallback: Vec<LibraryPaper> = papers.iter().map(pipeline::unsaved_paper).collect();
    let Some(lib) = ctx.library.clone() else { return fallback };
    let prov = Provenance { project, ..Default::default() };
    match blocking(move || pipeline::store_papers(&lib, &papers, &prov)).await {
        Ok(Ok((items, _))) => items,
        _ => fallback,
    }
}

// ---------------------------------------------------------------- search --

/// The panel's search options; missing ones don't filter.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OnlineOpts {
    /// 1-25 (default 10).
    pub limit: Option<usize>,
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    pub oa_only: bool,
    /// "relevance", "cited" or "newest".
    pub sort: Option<String>,
    /// Narrows the sources left on in Settings (missing ones stay on).
    pub sources: Option<SourceSet>,
}

impl OnlineOpts {
    fn search_opts(&self) -> AiResult<SearchOpts> {
        let sort = match self.sort.as_deref() {
            Some(s) => SearchSort::parse(s).ok_or_else(|| AiError::invalid("Sort by relevance, cited or newest."))?,
            None => SearchSort::Relevance,
        };
        Ok(SearchOpts {
            limit: self.limit.unwrap_or(10).clamp(1, MAX_PAPERS_UI),
            year_from: self.year_from,
            year_to: self.year_to,
            oa_only: self.oa_only,
            sort,
            sources: self.sources.unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineResult {
    pub items: Vec<LibraryPaper>,
    /// Plain remarks: a source that was busy or unreachable.
    pub notes: Vec<String>,
    /// The papers are in the library (uids are real ones, not `online:`).
    pub stored: bool,
    /// Why they couldn't be stored.
    pub warning: Option<String>,
}

/// The online search behind `library_search_online`.
pub async fn search_online(ctx: &NetCtx, request_id: &str, query: &str, opts: &OnlineOpts, project: Option<String>, emit: Emit) -> AiResult<OnlineResult> {
    let rid = request_id.to_string();
    let listener: Listener = Arc::new(move |ev: &SourceEvent| emit(progress_of(&rid, ev)));
    let c = pipeline::scoped(ctx, project.clone(), Some(listener));
    let prov = Provenance { project, ..Default::default() };
    let found = pipeline::search_and_store(&c, query, &opts.search_opts()?, prov).await?;
    let stored = ctx.library.is_some() && found.warning.is_none();
    let warning = match (&found.warning, ctx.library.is_some()) {
        (Some(w), _) => Some(w.clone()),
        (None, false) => Some("Your paper library is unavailable, so these results aren't saved.".into()),
        (None, true) => None,
    };
    Ok(OnlineResult { items: found.items, notes: found.search.notes, stored, warning })
}

/// Searches the paper services; progress comes as `library-progress`
/// events with this `request_id`.
#[tauri::command]
pub async fn library_search_online(
    app: AppHandle,
    state: Shared<'_>,
    request_id: String,
    query: String,
    opts: Option<OnlineOpts>,
    project: Option<String>,
) -> AiResult<OnlineResult> {
    if let Some(p) = &project {
        project_dir(&state, p)?;
    }
    let (cancel, _guard) = begin(&request_id)?;
    let ctx = context(&app, cancel).await;
    let emitter = app.clone();
    let emit: Emit = Arc::new(move |p| {
        let _ = emitter.emit(PROGRESS_EVENT, p);
    });
    search_online(&ctx, request_id.trim(), &query, &opts.unwrap_or_default(), project, emit).await
}

// ---------------------------------------------------------------- verify --

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub checks: Vec<BibCheck>,
    /// Asked-for keys that aren't in any `.bib` file.
    pub missing: Vec<String>,
    /// Entries that could have been checked (more than `checks` when capped).
    pub total: usize,
    /// Why the results couldn't be saved in the library.
    pub warning: Option<String>,
}

/// Checks `keys` (or every entry) of `bibs`, one at a time, reporting each
/// key as it starts. A cancel keeps (and saves) the checks done so far,
/// then fails with "Stopped.".
pub async fn verify_all(
    ctx: &NetCtx,
    request_id: &str,
    project: &str,
    bibs: &[(String, String)],
    keys: Option<&[String]>,
    max: usize,
    emit: Emit,
) -> AiResult<VerifyReport> {
    let (entries, missing, total) = pipeline::pick_entries(bibs, keys, max);
    let n = entries.len();
    let progress = |state, detail: Option<String>, done| LibraryProgress {
        request_id: request_id.to_string(),
        source: "verify".into(),
        state,
        detail,
        done: Some(done),
        total: Some(n),
    };
    let mut done: Vec<(crate::agents::tools::bibtex::BibRecord, BibCheck)> = Vec::new();
    let mut stopped = None;
    for (i, (file, rec)) in entries.iter().enumerate() {
        if let Err(e) = ctx.cancel.check() {
            stopped = Some(e);
            break;
        }
        emit(progress("pending", Some(rec.key.clone()), i));
        match pipeline::verify_entry(ctx, file, rec).await {
            Ok(c) => done.push((rec.clone(), c)),
            Err(e) => {
                stopped = Some(e);
                break;
            }
        }
    }
    let checks: Vec<BibCheck> = done.iter().map(|(_, c)| c.clone()).collect();
    let warning = pipeline::persist_checks(ctx, project, done).await;
    if let Some(e) = stopped {
        return Err(e);
    }
    emit(progress("ok", None, n));
    Ok(VerifyReport { checks, missing, total, warning })
}

/// "Check all citations": checks the project's `.bib` entries (or `keys`)
/// and saves each status on the project's links.
#[tauri::command]
pub async fn library_verify(
    app: AppHandle,
    state: Shared<'_>,
    request_id: String,
    project: String,
    keys: Option<Vec<String>>,
) -> AiResult<VerifyReport> {
    let dir = project_dir(&state, &project)?;
    let (cancel, _guard) = begin(&request_id)?;
    let ctx = context(&app, cancel).await;
    let bibs = blocking(move || bib_texts(&dir)).await?;
    let emitter = app.clone();
    let emit: Emit = Arc::new(move |p| {
        let _ = emitter.emit(PROGRESS_EVENT, p);
    });
    verify_all(&ctx, request_id.trim(), &project, &bibs, keys.as_deref(), MAX_UI_VERIFY, emit).await
}

// --------------------------------------------------------------- bibtex --

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibtexFor {
    #[serde(flatten)]
    pub entry: UniqueEntry,
    /// The `.bib` file to add it to: the one asked for, or the only one;
    /// `null` when the project has several and none was named.
    pub bib_file: Option<String>,
}

/// The BibTeX entry for `entry` with a key none of `bibs` uses.
pub fn bibtex_for(entry: &literature::BibEntry, bibs: &[(String, String)], bib_file: Option<&str>) -> AiResult<BibtexFor> {
    let entry = pipeline::unique_entry(entry, bibs).map_err(AiError::invalid)?;
    // Saved without review, so only plain formatting may come from the online source.
    if let Some(msg) = super::bibsafety::refusal(&entry.bibtex) {
        return Err(AiError::invalid(msg));
    }
    let bib_file = match bib_file.filter(|f| !f.trim().is_empty()) {
        Some(f) => Some(pipeline::pick_bib(bibs, Some(f)).map_err(AiError::invalid)?),
        None => pipeline::pick_bib(bibs, None).ok(),
    };
    Ok(BibtexFor { entry, bib_file })
}

/// "Add to bibliography": a BibTeX entry for a library paper, DOI or
/// arXiv id, with a key that no `.bib` file of the project uses yet. The
/// frontend inserts it.
#[tauri::command]
pub async fn library_bibtex_for(
    app: AppHandle,
    state: Shared<'_>,
    project: String,
    id: String,
    bib_file: Option<String>,
) -> AiResult<BibtexFor> {
    let dir = project_dir(&state, &project)?;
    let bibs = blocking(move || bib_texts(&dir)).await?;
    if let Some(msg) = pipeline::already_cited(&bibs, &id) {
        return Err(AiError::invalid(msg));
    }
    let ctx = context(&app, Cancel::default()).await;
    let entry = pipeline::fetch_entry(&ctx, &id, &bibs).await?;
    bibtex_for(&entry, &bibs, bib_file.as_deref())
}

// -------------------------------------------------------------- related --

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Related {
    References,
    Citations,
    Recommendations,
}

/// A paper's references, the papers citing it, or similar papers
/// (Semantic Scholar), saved as seen and returned as the panel shows them.
pub async fn related(ctx: &NetCtx, id: &str, kind: Related, project: Option<String>) -> AiResult<Vec<LibraryPaper>> {
    let (lib, wanted) = (ctx.library.clone(), id.to_string());
    let s2 = blocking(move || pipeline::s2_id_for(lib.as_deref(), &wanted)).await??;
    let papers = match kind {
        Related::References => pipeline::paper_details(ctx, &s2).await?.references,
        Related::Citations => pipeline::paper_details(ctx, &s2).await?.citations,
        Related::Recommendations => pipeline::recommendations(ctx, &s2).await?,
    };
    Ok(as_items(ctx, papers, project).await)
}

#[tauri::command]
pub async fn library_related(
    app: AppHandle,
    state: Shared<'_>,
    id: String,
    kind: Related,
    project: Option<String>,
) -> AiResult<Vec<LibraryPaper>> {
    if let Some(p) = &project {
        project_dir(&state, p)?;
    }
    let ctx = context(&app, Cancel::default()).await;
    related(&ctx, &id, kind, project).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::tools::literature::Source;

    #[test]
    fn progress_events_say_what_each_source_is_doing() {
        let ev = |state| SourceEvent { source: Source::Arxiv, state };
        let p = progress_of("r1", &ev(SourceState::Waiting(2500)));
        assert_eq!((p.source.as_str(), p.state, p.detail.as_deref()), ("arxiv", "waiting", Some("waiting 3s")));
        assert_eq!(progress_of("r1", &ev(SourceState::Ok(1))).detail.as_deref(), Some("1 result"));
        assert_eq!(progress_of("r1", &ev(SourceState::Ok(12))).detail.as_deref(), Some("12 results"));
        assert_eq!(progress_of("r1", &ev(SourceState::Skipped("Key not set".into()))).state, "skipped");
        let json = serde_json::to_value(progress_of("r1", &ev(SourceState::Pending))).unwrap();
        assert_eq!(json, serde_json::json!({"requestId": "r1", "source": "arxiv", "state": "pending", "detail": null}));
    }

    #[test]
    fn a_request_id_runs_once_and_can_be_cancelled() {
        let (cancel, guard) = begin("lib-test-1").unwrap();
        assert!(begin("lib-test-1").is_err());
        library_cancel("lib-test-1".into());
        assert!(cancel.is_cancelled());
        drop(guard);
        assert!(begin("lib-test-1").is_ok());
        assert!(begin("  ").is_err());
    }

    #[test]
    fn options_map_to_the_search() {
        let o: OnlineOpts = serde_json::from_value(serde_json::json!({"limit": 99, "yearFrom": 2020, "sort": "cited", "sources": {"arxiv": false}})).unwrap();
        let s = o.search_opts().unwrap();
        assert_eq!(s.limit, MAX_PAPERS_UI);
        assert_eq!(s.year_from, Some(2020));
        assert_eq!(s.sort, SearchSort::Cited);
        assert!(!s.sources.arxiv && s.sources.s2 && s.sources.crossref);
        let bad: OnlineOpts = serde_json::from_value(serde_json::json!({"sort": "random"})).unwrap();
        assert!(bad.search_opts().is_err());
    }
}
