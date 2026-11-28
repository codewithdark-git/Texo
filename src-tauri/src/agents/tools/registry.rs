//! The tool interface the agent loop uses, and the built-in tools (stable
//! names, small flat JSON schemas).
//!
//! A kind picks its tools by name ([`tools_by_name`]) and may add its own by
//! implementing [`Tool`] (e.g. chat's `propose_task`).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::agents::overlay::Overlay;
use crate::agents::types::{one_line, PlanStatus, ProgressUpdate, Report};
use crate::library::pipeline;
use crate::library::store::Provenance;
use crate::ai::http::Cancel;
use crate::ai::llm::ToolSpec;

use super::build::{self, BuildState};
use super::literature::{SearchOpts, SearchSort, SourceEvent};
use super::net::NetCtx;
use super::{fs as fstools, literature, memory, web};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Where a tool sends progress while it runs (the run's card).
pub type ProgressFn = Arc<dyn Fn(ProgressUpdate) + Send + Sync>;

/// What a tool call has to work with. Cheap to clone.
#[derive(Clone)]
pub struct ToolCx {
    pub root: PathBuf,
    pub run_id: String,
    pub kind: String,
    pub overlay: Arc<Mutex<Overlay>>,
    pub build: Arc<BuildState>,
    /// `None`: no web or literature tools in this run.
    pub net: Option<NetCtx>,
    pub cancel: Cancel,
    /// `None`: nobody shows progress (tests, chat).
    pub progress: Option<ProgressFn>,
}

impl ToolCx {
    pub fn overlay(&self) -> std::sync::MutexGuard<'_, Overlay> {
        self.overlay.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends sub-progress of the running tool (per-source chips, a detail
    /// line, phases, counts). Does nothing without a listener.
    pub fn progress(&self, update: ProgressUpdate) {
        if let Some(f) = &self.progress {
            f(update);
        }
    }
}

/// Something a tool asks the loop to do after it.
#[derive(Debug, Clone, PartialEq)]
pub enum Control {
    /// End the run with this report (`submit_report`).
    Finish(Report),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutput {
    /// What the model sees.
    pub content: String,
    pub ok: bool,
    /// One line for the step list.
    pub summary: String,
    pub control: Option<Control>,
    /// Structured data for the run card (e.g. `{papers: [...]}`); kept in
    /// the step, capped. Never sent to the model. (Boxed: keeps the
    /// output small.)
    pub data: Option<Box<Value>>,
}

impl ToolOutput {
    pub fn ok(content: impl Into<String>, summary: impl Into<String>) -> Self {
        ToolOutput { content: content.into(), ok: true, summary: summary.into(), control: None, data: None }
    }
    pub fn err(message: impl Into<String>) -> Self {
        let m = message.into();
        ToolOutput { summary: one_line(&m, 160), content: format!("Error: {m}"), ok: false, control: None, data: None }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(Box::new(data));
        self
    }
}

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    /// Doesn't change the overlay (sub-runs of read-only kinds use these).
    fn read_only(&self) -> bool {
        true
    }
    fn call<'a>(&'a self, cx: &'a ToolCx, args: &'a Value) -> BoxFut<'a, ToolOutput>;
}

// ------------------------------------------------------------ names --

pub const LIST_FILES: &str = "list_files";
pub const READ_FILE: &str = "read_file";
pub const SEARCH: &str = "search";
pub const EDIT_FILE: &str = "edit_file";
pub const WRITE_FILE: &str = "write_file";
pub const DELETE_FILE: &str = "delete_file";
pub const COMPILE_CHECK: &str = "compile_check";
pub const EXPLAIN_LOG: &str = "explain_log";
pub const SEARCH_PAPERS: &str = "search_papers";
pub const GET_BIBTEX: &str = "get_bibtex";
pub const VERIFY_CITATION: &str = "verify_citation";
pub const FETCH_URL: &str = "fetch_url";
pub const WEB_SEARCH: &str = "web_search";
pub const READ_MEMORY: &str = "read_memory";
pub const REMEMBER: &str = "remember";
pub const SUBMIT_REPORT: &str = "submit_report";
pub const UPDATE_PLAN: &str = "update_plan";
pub const LIBRARY_SEARCH: &str = "library_search";
pub const PAPER_DETAILS: &str = "paper_details";
pub const VERIFY_BIBLIOGRAPHY: &str = "verify_bibliography";
pub const INSERT_BIBTEX: &str = "insert_bibtex";

pub const FS_READ: &[&str] = &[LIST_FILES, READ_FILE, SEARCH];
pub const FS_WRITE: &[&str] = &[EDIT_FILE, WRITE_FILE, DELETE_FILE];
pub const BUILD: &[&str] = &[COMPILE_CHECK, EXPLAIN_LOG];
pub const LITERATURE: &[&str] = &[SEARCH_PAPERS, GET_BIBTEX, VERIFY_CITATION, LIBRARY_SEARCH, PAPER_DETAILS, VERIFY_BIBLIOGRAPHY];
/// Adds BibTeX to a `.bib` file through the overlay: only for kinds that
/// may change files (it is left out otherwise, see [`tools_by_name`]).
pub const BIB_WRITE: &[&str] = &[INSERT_BIBTEX];
pub const WEB: &[&str] = &[FETCH_URL, WEB_SEARCH];
pub const MEMORY: &[&str] = &[READ_MEMORY, REMEMBER];
pub const REPORT: &[&str] = &[SUBMIT_REPORT];
pub const PLAN: &[&str] = &[UPDATE_PLAN];

/// Tools whose results are text from outside the project (web pages, paper
/// metadata and abstracts) that could carry planted instructions. After one
/// of them ran, `remember` is refused for the rest of the run (or chat turn).
pub fn brings_outside_text(name: &str) -> bool {
    LITERATURE.contains(&name) || BIB_WRITE.contains(&name) || WEB.contains(&name)
}

/// Every built-in tool name.
#[allow(dead_code)] // for the profiles editor
pub fn all_names() -> Vec<&'static str> {
    [FS_READ, FS_WRITE, BUILD, LITERATURE, BIB_WRITE, WEB, MEMORY, REPORT, PLAN].concat()
}

/// The built-in tools named in `names` (unknown names skipped). Web and
/// literature tools need `net`; `web_search` only when one is configured;
/// `insert_bibtex` only next to a tool that changes files.
pub fn tools_by_name(names: &[&str], net: Option<&NetCtx>) -> Vec<Arc<dyn Tool>> {
    let mut out: Vec<Arc<dyn Tool>> = Vec::new();
    let writes = names.iter().any(|n| FS_WRITE.contains(n));
    for name in names {
        let Some(b) = Builtin::from_name(name) else { continue };
        if out.iter().any(|t| t.spec().name == *name) {
            continue;
        }
        let needs_net = LITERATURE.contains(name) || BIB_WRITE.contains(name) || WEB.contains(name);
        if needs_net && net.is_none() {
            continue;
        }
        if BIB_WRITE.contains(name) && !writes {
            continue;
        }
        if *name == WEB_SEARCH && !net.is_some_and(NetCtx::web_search_available) {
            continue;
        }
        out.push(Arc::new(b));
    }
    out
}

// --------------------------------------------------------- builtins --

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Builtin {
    ListFiles,
    ReadFile,
    Search,
    EditFile,
    WriteFile,
    DeleteFile,
    CompileCheck,
    ExplainLog,
    SearchPapers,
    GetBibtex,
    VerifyCitation,
    FetchUrl,
    WebSearch,
    ReadMemory,
    Remember,
    SubmitReport,
    UpdatePlan,
    LibrarySearch,
    PaperDetails,
    VerifyBibliography,
    InsertBibtex,
}

fn schema(props: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": props, "required": required})
}

fn s(args: &Value, k: &str) -> Option<String> {
    args.get(k).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn n(args: &Value, k: &str) -> Option<u64> {
    args.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

/// A whole number that may be negative or sent as text (a year).
fn int(args: &Value, k: &str) -> Option<i64> {
    args.get(k).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

/// A list of strings, or one comma-separated string.
fn strings(args: &Value, k: &str) -> Option<Vec<String>> {
    let list: Vec<String> = match args.get(k)? {
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Value::String(s) => s.split(',').map(str::to_string).collect(),
        _ => return None,
    };
    let list: Vec<String> = list.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    (!list.is_empty()).then_some(list)
}

fn need(args: &Value, k: &str) -> Result<String, ToolOutput> {
    s(args, k).ok_or_else(|| ToolOutput::err(format!("`{k}` is required.")))
}

impl Builtin {
    pub fn from_name(name: &str) -> Option<Builtin> {
        use Builtin::*;
        Some(match name {
            LIST_FILES => ListFiles,
            READ_FILE => ReadFile,
            SEARCH => Search,
            EDIT_FILE => EditFile,
            WRITE_FILE => WriteFile,
            DELETE_FILE => DeleteFile,
            COMPILE_CHECK => CompileCheck,
            EXPLAIN_LOG => ExplainLog,
            SEARCH_PAPERS => SearchPapers,
            GET_BIBTEX => GetBibtex,
            VERIFY_CITATION => VerifyCitation,
            FETCH_URL => FetchUrl,
            WEB_SEARCH => WebSearch,
            READ_MEMORY => ReadMemory,
            REMEMBER => Remember,
            SUBMIT_REPORT => SubmitReport,
            UPDATE_PLAN => UpdatePlan,
            LIBRARY_SEARCH => LibrarySearch,
            PAPER_DETAILS => PaperDetails,
            VERIFY_BIBLIOGRAPHY => VerifyBibliography,
            INSERT_BIBTEX => InsertBibtex,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        use Builtin::*;
        match self {
            ListFiles => LIST_FILES,
            ReadFile => READ_FILE,
            Search => SEARCH,
            EditFile => EDIT_FILE,
            WriteFile => WRITE_FILE,
            DeleteFile => DELETE_FILE,
            CompileCheck => COMPILE_CHECK,
            ExplainLog => EXPLAIN_LOG,
            SearchPapers => SEARCH_PAPERS,
            GetBibtex => GET_BIBTEX,
            VerifyCitation => VERIFY_CITATION,
            FetchUrl => FETCH_URL,
            WebSearch => WEB_SEARCH,
            ReadMemory => READ_MEMORY,
            Remember => REMEMBER,
            SubmitReport => SUBMIT_REPORT,
            UpdatePlan => UPDATE_PLAN,
            LibrarySearch => LIBRARY_SEARCH,
            PaperDetails => PAPER_DETAILS,
            VerifyBibliography => VERIFY_BIBLIOGRAPHY,
            InsertBibtex => INSERT_BIBTEX,
        }
    }

    fn describe(self) -> (&'static str, Value) {
        use Builtin::*;
        let path = json!({"type": "string", "description": "File path inside the project, e.g. sections/intro.tex"});
        let reason = json!({"type": "string", "description": "Short reason, shown to the user in review"});
        match self {
            ListFiles => (
                "List the project's files. Optional glob such as \"*.tex\" or \"sections/**\".",
                schema(json!({"glob": {"type": "string"}}), &[]),
            ),
            ReadFile => (
                "Read a text file with numbered lines. Use start_line/end_line for long files.",
                schema(json!({"path": path, "start_line": {"type": "integer"}, "end_line": {"type": "integer"}}), &["path"]),
            ),
            Search => (
                "Search the project's text files with a regular expression. Returns file:line: text.",
                schema(json!({"pattern": {"type": "string"}, "glob": {"type": "string"}}), &["pattern"]),
            ),
            EditFile => (
                "Replace text in a file. `old` must match exactly once (copy it from read_file, without the line numbers).",
                schema(json!({"path": path, "old": {"type": "string"}, "new": {"type": "string"}, "reason": reason}), &["path", "old", "new"]),
            ),
            WriteFile => (
                "Create a new file, or replace a small file completely.",
                schema(json!({"path": path, "text": {"type": "string"}, "reason": reason}), &["path", "text"]),
            ),
            DeleteFile => ("Delete a file (the user reviews it first).", schema(json!({"path": path, "reason": reason}), &["path"])),
            CompileCheck => (
                "Compile the project with your changes in a private copy. Returns the status and the first issues.",
                schema(json!({}), &[]),
            ),
            ExplainLog => (
                "Explain an issue from the last compile_check in plain words (issue number from its list; default: the first error).",
                schema(json!({"issue_index": {"type": "integer"}}), &[]),
            ),
            SearchPapers => (
                "Search Semantic Scholar, Crossref and arXiv for papers. Returns title, authors, year, venue, DOI, arXiv id, citations.",
                schema(
                    json!({"query": {"type": "string"}, "limit": {"type": "integer", "description": "1-8"},
                        "year_from": {"type": "integer"}, "year_to": {"type": "integer"},
                        "sort": {"type": "string", "enum": ["relevance", "cited", "newest"]}}),
                    &["query"],
                ),
            ),
            LibrarySearch => (
                "Search the user's paper library offline (papers found earlier and this project's .bib entries). Use it before search_papers.",
                schema(json!({"query": {"type": "string"}, "limit": {"type": "integer", "description": "1-20"}}), &["query"]),
            ),
            PaperDetails => (
                "One paper in depth: full abstract, TL;DR, citation counts, free PDF link, and its first references and citing papers.",
                schema(json!({"id": {"type": "string", "description": "DOI, arXiv id or library id"}}), &["id"]),
            ),
            VerifyBibliography => (
                "Check many .bib entries at once against real papers (default: all entries, at most 40). Use it for whole-bibliography checks.",
                schema(json!({"keys": {"type": "array", "items": {"type": "string"}, "description": "Citation keys; leave out for all"}}), &[]),
            ),
            InsertBibtex => (
                "Add a paper's BibTeX to a .bib file, with a citation key no entry uses yet. The user reviews it.",
                schema(
                    json!({"id": {"type": "string", "description": "DOI, arXiv id or library id"},
                        "bib_file": {"type": "string", "description": "Which .bib file (needed when there are several)"}, "reason": reason}),
                    &["id"],
                ),
            ),
            GetBibtex => (
                "Get a clean BibTeX entry for a DOI or an arXiv id.",
                schema(json!({"id": {"type": "string", "description": "DOI or arXiv id"}}), &["id"]),
            ),
            VerifyCitation => (
                "Check that a .bib entry of this project is a real paper (by DOI or title).",
                schema(json!({"key": {"type": "string", "description": "The citation key"}}), &["key"]),
            ),
            FetchUrl => (
                "Read a public web page or PDF as text (http/https only).",
                schema(json!({"url": {"type": "string"}}), &["url"]),
            ),
            WebSearch => (
                "Search the web. Returns titles, links and snippets.",
                schema(json!({"query": {"type": "string"}, "limit": {"type": "integer"}}), &["query"]),
            ),
            ReadMemory => ("Read the project memory: notes from earlier runs and the user's preferences.", schema(json!({}), &[])),
            Remember => (
                "Save a short note to the project memory for future runs (a preference or a fact about the project).",
                schema(json!({"note": {"type": "string"}}), &["note"]),
            ),
            SubmitReport => (
                "Finish the run with your structured report (a JSON object).",
                schema(json!({"report": {"type": "object"}}), &["report"]),
            ),
            UpdatePlan => (
                "Mark a task of your plan: active when you start it, then done, partly or notDone (add a short note).",
                schema(
                    json!({"n": {"type": "integer", "description": "Task number from the plan"},
                        "status": {"type": "string", "enum": ["active", "done", "partly", "notDone", "skipped"]},
                        "note": {"type": "string"}}),
                    &["n", "status"],
                ),
            ),
        }
    }

    async fn run(self, cx: &ToolCx, args: &Value) -> ToolOutput {
        match self.run_inner(cx, args).await {
            Ok(out) => out,
            Err(out) => out,
        }
    }

    async fn run_inner(self, cx: &ToolCx, args: &Value) -> Result<ToolOutput, ToolOutput> {
        use Builtin::*;
        let app = |e: crate::error::AppError| ToolOutput::err(e.to_string());
        let ai = |e: crate::ai::error::AiError| ToolOutput::err(e.message);
        let reason = s(args, "reason").filter(|r| !r.trim().is_empty());
        Ok(match self {
            ListFiles => {
                let glob = s(args, "glob");
                let ov = cx.overlay.clone();
                let text = blocking(move || {
                    let o = ov.lock().unwrap_or_else(|e| e.into_inner());
                    fstools::list_files(&o, glob.as_deref())
                })
                .await?
                .map_err(app)?;
                let count = text.lines().count();
                ToolOutput::ok(text, format!("Listed {count} file(s)"))
            }
            ReadFile => {
                let path = need(args, "path")?;
                let text = fstools::read_file(&mut cx.overlay(), &path, n(args, "start_line"), n(args, "end_line")).map_err(app)?;
                ToolOutput::ok(text, format!("Read {}", path.trim()))
            }
            Search => {
                let pattern = need(args, "pattern")?;
                let glob = s(args, "glob");
                let ov = cx.overlay.clone();
                let p = pattern.clone();
                let text = blocking(move || {
                    let o = ov.lock().unwrap_or_else(|e| e.into_inner());
                    fstools::search(&o, &p, glob.as_deref())
                })
                .await?
                .map_err(app)?;
                let hits = if text.starts_with("No matches") { 0 } else { text.lines().filter(|l| !l.starts_with('…')).count() };
                ToolOutput::ok(text, format!("Searched for \"{}\": {hits} hit(s)", one_line(&pattern, 60)))
            }
            EditFile => {
                let path = need(args, "path")?;
                let old = need(args, "old")?;
                let new = s(args, "new").unwrap_or_default();
                let why = reason.unwrap_or_else(|| "Edited by the agent".into());
                let text = fstools::edit_file(&mut cx.overlay(), &path, &old, &new, &why).map_err(app)?;
                ToolOutput::ok(text, format!("Edited {}", path.trim()))
            }
            WriteFile => {
                let path = need(args, "path")?;
                let body = need(args, "text")?;
                let why = reason.unwrap_or_else(|| "Written by the agent".into());
                let text = fstools::write_file(&mut cx.overlay(), &path, &body, &why).map_err(app)?;
                let summary = one_line(&text, 120);
                ToolOutput::ok(text, summary)
            }
            DeleteFile => {
                let path = need(args, "path")?;
                let why = reason.unwrap_or_else(|| "Deleted by the agent".into());
                let text = fstools::delete_file(&mut cx.overlay(), &path, &why).map_err(app)?;
                ToolOutput::ok(text, format!("Deleted {}", path.trim()))
            }
            CompileCheck => {
                let text = build::compile_check(cx.build.clone(), cx.root.clone(), cx.overlay.clone(), &cx.cancel).await.map_err(app)?;
                let summary = one_line(&text, 160);
                ToolOutput::ok(text, summary)
            }
            ExplainLog => {
                let text = build::explain_text(cx.build.last().as_ref(), n(args, "issue_index")).map_err(app)?;
                ToolOutput::ok(text, "Explained a compile issue")
            }
            SearchPapers => {
                let q = need(args, "query")?;
                let limit = n(args, "limit").unwrap_or(5).clamp(1, literature::MAX_PAPERS as u64) as usize;
                let sort = match s(args, "sort").filter(|w| !w.trim().is_empty()) {
                    Some(w) => SearchSort::parse(&w).ok_or_else(|| ToolOutput::err("`sort` must be relevance, cited or newest."))?,
                    None => SearchSort::Relevance,
                };
                let year = |k: &str| int(args, k).and_then(|y| i32::try_from(y).ok());
                let opts = SearchOpts { limit, year_from: year("year_from"), year_to: year("year_to"), sort, ..SearchOpts::default() };
                let ctx = lit_ctx(cx)?;
                let found = pipeline::search_and_store(&ctx, &q, &opts, provenance(cx, SEARCH_PAPERS)).await.map_err(ai)?;
                let count = found.items.len();
                count_up(cx, "papersFound", count);
                count_up(cx, "papersNew", found.new);
                let mut summary = format!("Searched papers for \"{}\": {count} found", one_line(&q, 60));
                if found.new > 0 {
                    summary.push_str(&format!(", {} new", found.new));
                }
                let text = crate::agents::types::cap(&pipeline::found_text(&found), fstools::MAX_RESULT_CHARS);
                ToolOutput::ok(text, summary).with_data(pipeline::step_data(&found.items))
            }
            LibrarySearch => {
                let q = need(args, "query")?;
                if q.trim().is_empty() {
                    return Err(ToolOutput::err("Give a few words to search for."));
                }
                let limit = n(args, "limit").unwrap_or(8).clamp(1, 20) as i64;
                let Some(lib) = net(cx)?.library.clone() else {
                    return Ok(ToolOutput::ok(
                        "The paper library isn't available right now, so there is nothing to search offline. Use search_papers to look online.",
                        "The paper library is unavailable",
                    ));
                };
                let (project, words) = (project_of(cx), q.clone());
                let page = blocking(move || pipeline::local_search(&lib, &words, Some(&project), limit))
                    .await?
                    .map_err(|e| ToolOutput::err(e.plain()))?;
                let summary = format!("Searched your library for \"{}\": {} found", one_line(&q, 60), page.items.len());
                let text = crate::agents::types::cap(&pipeline::local_text(q.trim(), &page), fstools::MAX_RESULT_CHARS);
                ToolOutput::ok(text, summary).with_data(pipeline::step_data(&page.items))
            }
            PaperDetails => {
                let id = need(args, "id")?;
                let ctx = lit_ctx(cx)?;
                let (lib, wanted) = (ctx.library.clone(), id.clone());
                let s2 = blocking(move || pipeline::s2_id_for(lib.as_deref(), &wanted)).await?.map_err(ai)?;
                let d = pipeline::paper_details(&ctx, &s2).await.map_err(ai)?;
                let mut items = vec![pipeline::unsaved_paper(&d.paper)];
                if let Some(lib) = ctx.library.clone() {
                    let (papers, prov) = (vec![d.paper.clone()], provenance(cx, PAPER_DETAILS));
                    if let Ok((stored, _)) = blocking(move || pipeline::store_papers(&lib, &papers, &prov)).await? {
                        items = stored;
                    }
                }
                let text = crate::agents::types::cap(&d.to_tool_text(), fstools::MAX_RESULT_CHARS);
                ToolOutput::ok(text, format!("Read the details of \"{}\"", one_line(&d.paper.title, 80))).with_data(pipeline::step_data(&items))
            }
            VerifyBibliography => {
                let keys = strings(args, "keys");
                let bibs = bib_files(cx).map_err(app)?;
                if bibs.is_empty() {
                    return Err(ToolOutput::err("This project has no .bib file."));
                }
                let ctx = lit_ctx(cx)?;
                let (entries, missing, total) = pipeline::pick_entries(&bibs, keys.as_deref(), pipeline::MAX_VERIFY_KEYS);
                if entries.is_empty() {
                    return Err(ToolOutput::err(if missing.is_empty() {
                        "The .bib files have no entries.".to_string()
                    } else {
                        format!("There's no entry {} in the .bib files.", missing.join(", "))
                    }));
                }
                let count = entries.len();
                let mut done = Vec::new();
                for (i, (file, rec)) in entries.into_iter().enumerate() {
                    cx.progress(ProgressUpdate::Detail(format!("Checking {} ({} of {count})", rec.key, i + 1)));
                    let c = pipeline::verify_entry(&ctx, &file, &rec).await.map_err(ai)?;
                    count_up(cx, "keysChecked", 1);
                    done.push((rec, c));
                }
                let checks: Vec<pipeline::BibCheck> = done.iter().map(|(_, c)| c.clone()).collect();
                // Only entries on disk become "in this project" links; one the
                // run added or changed waits for the user's review.
                let root = cx.root.clone();
                let disk = blocking(move || crate::library::online::bib_texts(&root)).await?;
                let warning = pipeline::persist_checks(&ctx, &project_of(cx), pipeline::on_disk(done, &disk)).await;
                let mut text = pipeline::checks_text(&checks, &missing, total);
                if let Some(w) = warning {
                    text.push_str(&format!("\n\nNote: {w}"));
                }
                let fine = checks.iter().filter(|c| !c.failed && c.check.status == literature::CitationStatus::Verified).count();
                let summary = format!("Checked {count} citation(s): {fine} verified, {} to look at", count - fine);
                ToolOutput::ok(crate::agents::types::cap(&text, fstools::MAX_RESULT_CHARS), summary)
            }
            InsertBibtex => {
                let id = need(args, "id")?;
                let bibs = bib_files(cx).map_err(app)?;
                let target = pipeline::pick_bib(&bibs, s(args, "bib_file").as_deref()).map_err(ToolOutput::err)?;
                if let Some(msg) = pipeline::already_cited(&bibs, &id) {
                    return Err(ToolOutput::err(msg));
                }
                let entry = pipeline::fetch_entry(&lit_ctx(cx)?, &id, &bibs).await.map_err(ai)?;
                let unique = pipeline::unique_entry(&entry, &bibs).map_err(ToolOutput::err)?;
                let why = reason.unwrap_or_else(|| format!("Added {} to the bibliography", unique.key));
                let file = {
                    let mut o = cx.overlay();
                    let current = o.peek(&target).map_err(app)?.unwrap_or_default();
                    o.write(&target, &pipeline::append_entry(&current, &unique.bibtex), &why).map_err(app)?
                };
                let renamed = unique.renamed_from.as_ref().map(|k| format!(" ({k} was taken)")).unwrap_or_default();
                let mut text = format!(
                    "Added the entry to {file} as {key}{renamed}. Cite it with \\cite{{{key}}}. The user reviews the change before it is saved.\n\n{}",
                    unique.bibtex,
                    key = unique.key
                );
                for w in &unique.warnings {
                    text.push_str(&format!("\n% Warning: {w}"));
                }
                ToolOutput::ok(text, format!("Added {} to {file}", unique.key))
            }
            GetBibtex => {
                let id = need(args, "id")?;
                let r = literature::get_bibtex(net(cx)?, &id).await.map_err(ai)?;
                let summary = format!("Got BibTeX for {}", one_line(&id, 80));
                ToolOutput::ok(r.to_tool_text(), summary)
            }
            VerifyCitation => {
                let key = need(args, "key")?;
                let bib = bib_text(cx, &key).map_err(app)?;
                let r = literature::verify_citation_in(&lit_ctx(cx)?, &bib, &key).await.map_err(ai)?;
                ToolOutput::ok(r.to_tool_text(), format!("Checked citation {}", one_line(&key, 60)))
            }
            FetchUrl => {
                let url = need(args, "url")?;
                let r = web::fetch_url(net(cx)?, &url).await.map_err(ai)?;
                ToolOutput::ok(r.to_tool_text(), format!("Read {}", one_line(&url, 100)))
            }
            WebSearch => {
                let q = need(args, "query")?;
                let limit = n(args, "limit").unwrap_or(5).clamp(1, 10) as usize;
                let r = web::web_search(net(cx)?, &q, limit).await.map_err(ai)?;
                let summary = format!("Searched the web for \"{}\": {} result(s)", one_line(&q, 60), r.hits.len());
                ToolOutput::ok(r.to_tool_text(), summary)
            }
            ReadMemory => {
                let text = memory::read(&cx.root);
                if text.trim().is_empty() {
                    ToolOutput::ok("The project memory is empty.", "Read the project memory (empty)")
                } else {
                    ToolOutput::ok(text, "Read the project memory")
                }
            }
            Remember => {
                let note = need(args, "note")?;
                let text = memory::remember(&cx.root, &note).map_err(app)?;
                ToolOutput::ok(text, format!("Remembered: {}", one_line(&note, 100)))
            }
            SubmitReport => {
                let value = args.get("report").cloned().unwrap_or_else(|| args.clone());
                let mut data = match value {
                    Value::Object(m) => m,
                    Value::String(s) => match serde_json::from_str::<Value>(&s) {
                        Ok(Value::Object(m)) => m,
                        _ => return Err(ToolOutput::err("`report` must be a JSON object.")),
                    },
                    _ => return Err(ToolOutput::err("`report` must be a JSON object.")),
                };
                let kind = match data.remove("kind") {
                    Some(Value::String(k)) if !k.trim().is_empty() => k,
                    _ => cx.kind.clone(),
                };
                let report = Report { kind, data };
                ToolOutput {
                    content: "Report received. The run is finished.".into(),
                    ok: true,
                    summary: "Submitted the report".into(),
                    control: Some(Control::Finish(report)),
                    data: None,
                }
            }
            UpdatePlan => {
                let Some(n) = n(args, "n").filter(|n| (1..=100).contains(n)) else {
                    return Err(ToolOutput::err("`n` must be the task's number from the plan."));
                };
                let word = need(args, "status")?;
                let status = PlanStatus::parse(&word)
                    .ok_or_else(|| ToolOutput::err("`status` must be active, done, partly, notDone or skipped."))?;
                if cx.progress.is_none() {
                    return Err(ToolOutput::err("There is no plan to update in this run."));
                }
                let note = s(args, "note").map(|t| one_line(&t, 300)).filter(|t| !t.is_empty());
                let task = s(args, "task").map(|t| one_line(&t, 200)).filter(|t| !t.is_empty());
                cx.progress(ProgressUpdate::Plan { n: n as u32, status, note, task });
                ToolOutput::ok("ok", format!("Plan: task {n} {}", plan_word(status)))
            }
        })
    }
}

fn plan_word(s: PlanStatus) -> &'static str {
    match s {
        PlanStatus::Pending => "is pending",
        PlanStatus::Active => "started",
        PlanStatus::Done => "done",
        PlanStatus::Partly => "partly done",
        PlanStatus::NotDone => "not done",
        PlanStatus::Skipped => "skipped",
    }
}

fn net(cx: &ToolCx) -> Result<&NetCtx, ToolOutput> {
    cx.net.as_ref().ok_or_else(|| ToolOutput::err("Web access isn't available in this run."))
}

/// The project folder, as the library names it.
fn project_of(cx: &ToolCx) -> String {
    cx.root.to_string_lossy().to_string()
}

/// Who found what: this run, this tool, this project.
fn provenance(cx: &ToolCx, tool: &str) -> Provenance {
    Provenance { run_id: Some(cx.run_id.clone()), tool: Some(tool.to_string()), project: Some(project_of(cx)), save: false }
}

/// The run's context for one literature call: ranks for this project and
/// shows each source as a chip on the run card.
fn lit_ctx(cx: &ToolCx) -> Result<NetCtx, ToolOutput> {
    let net = net(cx)?;
    let listener = cx.progress.clone().map(|f| -> pipeline::Listener {
        Arc::new(move |ev: &SourceEvent| {
            if let Some(chip) = pipeline::chip(ev) {
                f(ProgressUpdate::Source(chip));
            }
        })
    });
    Ok(pipeline::scoped(net, Some(project_of(cx)), listener))
}

fn count_up(cx: &ToolCx, key: &str, by: usize) {
    if by > 0 {
        cx.progress(ProgressUpdate::Count { key: key.to_string(), by: by as u64 });
    }
}

/// Every `.bib` file of the project in this run's view, with its text.
fn bib_files(cx: &ToolCx) -> crate::error::AppResult<Vec<(String, String)>> {
    let o = cx.overlay();
    let (files, _) = o.list(Some("*.bib"))?;
    Ok(files.into_iter().filter_map(|(path, _)| o.peek(&path).ok().flatten().map(|t| (path, t))).collect())
}

/// The `.bib` text that holds `key` (all the project's .bib files joined).
fn bib_text(cx: &ToolCx, key: &str) -> crate::error::AppResult<String> {
    let o = cx.overlay();
    let (files, _) = o.list(Some("*.bib"))?;
    let mut all = String::new();
    for (path, _) in files {
        if let Ok(Some(t)) = o.peek(&path) {
            if super::bibtex::find_entry(&t, key).is_some() {
                return Ok(t);
            }
            all.push_str(&t);
            all.push('\n');
        }
    }
    Ok(all)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, ToolOutput> {
    tokio::task::spawn_blocking(f).await.map_err(|_| ToolOutput::err("Something went wrong inside Texo."))
}

impl Tool for Builtin {
    fn spec(&self) -> ToolSpec {
        let (description, parameters) = self.describe();
        ToolSpec { name: self.name().to_string(), description: description.to_string(), parameters }
    }

    fn read_only(&self) -> bool {
        !matches!(self, Builtin::EditFile | Builtin::WriteFile | Builtin::DeleteFile | Builtin::InsertBibtex)
    }

    fn call<'a>(&'a self, cx: &'a ToolCx, args: &'a Value) -> BoxFut<'a, ToolOutput> {
        Box::pin(self.run(cx, args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_has_a_small_object_schema() {
        let net = NetCtx::new(Cancel::default());
        let tools = tools_by_name(&all_names(), Some(&net));
        // web_search is left out without a configured search service.
        assert_eq!(tools.len(), all_names().len() - 1);
        for t in &tools {
            let spec = t.spec();
            assert_eq!(spec.parameters["type"], "object", "{}", spec.name);
            assert!(spec.description.len() < 200, "{}", spec.name);
            assert_eq!(Builtin::from_name(&spec.name).map(|b| b.name()), Some(spec.name.as_str()));
        }
        let offline = tools_by_name(&all_names(), None);
        assert!(offline.iter().all(|t| !LITERATURE.contains(&t.spec().name.as_str()) && !WEB.contains(&t.spec().name.as_str())));
        assert!(tools_by_name(&["nope", READ_FILE, READ_FILE], None).len() == 1);
        assert!(!Builtin::EditFile.read_only() && Builtin::ReadFile.read_only());
    }
}
