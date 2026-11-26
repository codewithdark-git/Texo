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
use crate::agents::types::{one_line, Report};
use crate::ai::http::Cancel;
use crate::ai::llm::ToolSpec;

use super::build::{self, BuildState};
use super::net::NetCtx;
use super::{fs as fstools, literature, memory, web};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a tool call has to work with. Cheap to clone.
#[derive(Clone)]
pub struct ToolCx {
    pub root: PathBuf,
    #[allow(dead_code)] // for kinds' own tools
    pub run_id: String,
    pub kind: String,
    pub overlay: Arc<Mutex<Overlay>>,
    pub build: Arc<BuildState>,
    /// `None`: no web or literature tools in this run.
    pub net: Option<NetCtx>,
    pub cancel: Cancel,
}

impl ToolCx {
    pub fn overlay(&self) -> std::sync::MutexGuard<'_, Overlay> {
        self.overlay.lock().unwrap_or_else(|e| e.into_inner())
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
}

impl ToolOutput {
    pub fn ok(content: impl Into<String>, summary: impl Into<String>) -> Self {
        ToolOutput { content: content.into(), ok: true, summary: summary.into(), control: None }
    }
    pub fn err(message: impl Into<String>) -> Self {
        let m = message.into();
        ToolOutput { summary: one_line(&m, 160), content: format!("Error: {m}"), ok: false, control: None }
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

pub const FS_READ: &[&str] = &[LIST_FILES, READ_FILE, SEARCH];
pub const FS_WRITE: &[&str] = &[EDIT_FILE, WRITE_FILE, DELETE_FILE];
pub const BUILD: &[&str] = &[COMPILE_CHECK, EXPLAIN_LOG];
pub const LITERATURE: &[&str] = &[SEARCH_PAPERS, GET_BIBTEX, VERIFY_CITATION];
pub const WEB: &[&str] = &[FETCH_URL, WEB_SEARCH];
pub const MEMORY: &[&str] = &[READ_MEMORY, REMEMBER];
pub const REPORT: &[&str] = &[SUBMIT_REPORT];

/// Tools whose results are text from outside the project (web pages, paper
/// metadata and abstracts) that could carry planted instructions. After one
/// of them ran, `remember` is refused for the rest of the run (or chat turn).
pub fn brings_outside_text(name: &str) -> bool {
    LITERATURE.contains(&name) || WEB.contains(&name)
}

/// Every built-in tool name.
#[allow(dead_code)] // for the profiles editor
pub fn all_names() -> Vec<&'static str> {
    [FS_READ, FS_WRITE, BUILD, LITERATURE, WEB, MEMORY, REPORT].concat()
}

/// The built-in tools named in `names` (unknown names skipped). Web and
/// literature tools need `net`; `web_search` only when one is configured.
pub fn tools_by_name(names: &[&str], net: Option<&NetCtx>) -> Vec<Arc<dyn Tool>> {
    let mut out: Vec<Arc<dyn Tool>> = Vec::new();
    for name in names {
        let Some(b) = Builtin::from_name(name) else { continue };
        if out.iter().any(|t| t.spec().name == *name) {
            continue;
        }
        let needs_net = LITERATURE.contains(name) || WEB.contains(name);
        if needs_net && net.is_none() {
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
                "Search arXiv, Crossref and Semantic Scholar for papers. Returns title, authors, year, venue, DOI, arXiv id.",
                schema(json!({"query": {"type": "string"}, "limit": {"type": "integer", "description": "1-8"}}), &["query"]),
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
                let limit = n(args, "limit").unwrap_or(5).clamp(1, 8) as usize;
                let r = literature::search_papers(net(cx)?, &q, limit).await.map_err(ai)?;
                let summary = format!("Searched papers for \"{}\": {} found", one_line(&q, 60), r.papers.len());
                ToolOutput::ok(crate::agents::types::cap(&r.to_tool_text(), fstools::MAX_RESULT_CHARS), summary)
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
                let r = literature::verify_citation_in(net(cx)?, &bib, &key).await.map_err(ai)?;
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
                }
            }
        })
    }
}

fn net(cx: &ToolCx) -> Result<&NetCtx, ToolOutput> {
    cx.net.as_ref().ok_or_else(|| ToolOutput::err("Web access isn't available in this run."))
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
        !matches!(self, Builtin::EditFile | Builtin::WriteFile | Builtin::DeleteFile)
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
