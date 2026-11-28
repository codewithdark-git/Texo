//! The tools the chat model may call. All are read-only for the project,
//! except `remember` (adds a note to the project memory, as the spec asks)
//! and `propose_task`, which never runs anything: it becomes a "Run as task"
//! suggestion in the chat.
//!
//! Every tool is the agents' own (`agents::tools::{fs, memory, web,
//! literature}` and the paper library's pipeline), run over a read-only
//! overlay of the project plus the unsaved editor buffers; only
//! `propose_task` is chat's. Chat has no `insert_bibtex`: it can't change
//! files, so it proposes a task instead.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use serde_json::{json, Value};

use super::store::{clip_line, ProposedTask};
use crate::agents::tools::net::NetCtx;
use crate::agents::overlay::Overlay;
use crate::agents::tools::literature::{SearchOpts, SearchSort};
use crate::agents::tools::{fs as fstools, literature, memory, web};
use crate::library::pipeline;
use crate::library::store::Provenance;
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::llm::{ToolCall, ToolSpec};

/// Tool results are capped at about this many characters (spec: ~12k).
pub const RESULT_CAP: usize = 12_000;
pub const MEMORY_CAP: usize = memory::MAX_BYTES;

/// What the tools may see: the project plus unsaved editor buffers.
pub struct ToolEnv<'a> {
    pub root: &'a Path,
    /// Unsaved editor text by `/`-separated project path.
    pub buffers: &'a HashMap<String, String>,
    pub net: &'a NetCtx,
}

/// The result of one tool call.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    /// Sent back to the model.
    pub content: String,
    pub ok: bool,
    /// Plain words for the chat ("Read main.tex (lines 1-40)").
    pub summary: String,
    pub proposed: Option<ProposedTask>,
    pub ms: u64,
}

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec { name: name.into(), description: description.into(), parameters }
}

/// The tools offered to the chat model. `web_search` only when the user set
/// up a search service.
pub fn specs(web_search: bool) -> Vec<ToolSpec> {
    let mut out = vec![
        spec(
            "list_files",
            "List the project's files. Optional glob such as \"*.tex\" or \"chapters/**\".",
            json!({"type": "object", "properties": {"glob": {"type": "string"}}}),
        ),
        spec(
            "read_file",
            "Read a project file with line numbers. Optional start_line and end_line (1-based).",
            json!({"type": "object", "properties": {
                "path": {"type": "string"},
                "start_line": {"type": "integer"},
                "end_line": {"type": "integer"}
            }, "required": ["path"]}),
        ),
        spec(
            "search",
            "Find text in the project's files (case-insensitive). Optional glob to limit the files.",
            json!({"type": "object", "properties": {
                "pattern": {"type": "string"},
                "glob": {"type": "string"}
            }, "required": ["pattern"]}),
        ),
        spec(
            "library_search",
            "Search the user's paper library offline (papers found earlier and this project's .bib entries). Use it before search_papers.",
            json!({"type": "object", "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"}
            }, "required": ["query"]}),
        ),
        spec(
            "search_papers",
            "Search Semantic Scholar, Crossref and arXiv for papers. limit is 1 to 8; optional year_from, year_to, sort (relevance, cited, newest).",
            json!({"type": "object", "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
                "year_from": {"type": "integer"},
                "year_to": {"type": "integer"},
                "sort": {"type": "string", "enum": ["relevance", "cited", "newest"]}
            }, "required": ["query"]}),
        ),
        spec(
            "paper_details",
            "One paper in depth: full abstract, TL;DR, citation counts, free PDF link, and its first references and citing papers.",
            json!({"type": "object", "properties": {"id": {"type": "string", "description": "DOI, arXiv id or library id"}}, "required": ["id"]}),
        ),
        spec(
            "verify_bibliography",
            "Check the project's .bib entries against real papers (default: all, at most 40). keys narrows it.",
            json!({"type": "object", "properties": {
                "keys": {"type": "array", "items": {"type": "string"}}
            }}),
        ),
        spec(
            "get_bibtex",
            "Get the BibTeX entry for a DOI (10.xxxx/...) or an arXiv id (2101.00001).",
            json!({"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}),
        ),
        spec(
            "fetch_url",
            "Read a public web page or PDF as text.",
            json!({"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}),
        ),
        spec("read_memory", "Read the notes saved for this project.", json!({"type": "object", "properties": {}})),
        spec(
            "remember",
            "Save a short note for future chats and agents (only when the user asks you to remember something).",
            json!({"type": "object", "properties": {"note": {"type": "string"}}, "required": ["note"]}),
        ),
        spec(
            "propose_task",
            "Suggest a task for the task agent when the user wants files changed. The user starts it with one click; you can't change files yourself.",
            json!({"type": "object", "properties": {
                "prompt": {"type": "string", "description": "What the task agent should do, complete and specific."},
                "files": {"type": "array", "items": {"type": "string"}}
            }, "required": ["prompt"]}),
        ),
    ];
    if web_search {
        let at = out.iter().position(|s| s.name == "fetch_url").map_or(out.len(), |i| i + 1);
        out.insert(
            at,
            spec(
                "web_search",
                "Search the web. limit is 1 to 8.",
                json!({"type": "object", "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"}
                }, "required": ["query"]}),
            ),
        );
    }
    out
}

fn arg_str<'v>(args: &'v Value, names: &[&str]) -> Option<&'v str> {
    names.iter().find_map(|n| args.get(*n).and_then(Value::as_str)).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_u64(args: &Value, name: &str) -> Option<u64> {
    let v = args.get(name)?;
    v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).or_else(|| v.as_str()?.trim().parse().ok())
}

fn need<'v>(args: &'v Value, names: &[&str]) -> AiResult<&'v str> {
    arg_str(args, names).ok_or_else(|| AiError::invalid(format!("Missing \"{}\".", names[0])))
}

/// Runs one tool call. Never fails: problems come back as an error result
/// the model can read.
pub async fn run(env: &ToolEnv<'_>, call: &ToolCall) -> ToolOutcome {
    let start = Instant::now();
    let mut proposed = None;
    let (result, summary) = if call.invalid_arguments.is_some() {
        let m = if call.cut_off() {
            call.invalid_message()
        } else {
            "The arguments weren't valid JSON. Call the tool again with a JSON object.".to_string()
        };
        (Err(AiError::invalid(m)), format!("Couldn't use {}", call.name))
    } else {
        let a = &call.arguments;
        match call.name.as_str() {
            "list_files" => {
                let glob = arg_str(a, &["glob", "pattern"]);
                (list_files(env, glob).await, "Listed the project's files".to_string())
            }
            "read_file" => {
                let path = arg_str(a, &["path", "file"]).unwrap_or_default().to_string();
                let (s, e) = (arg_u64(a, "start_line"), arg_u64(a, "end_line"));
                let what = match (s, e) {
                    (Some(s), Some(e)) => format!("Read {path} (lines {s}-{e})"),
                    (Some(s), None) => format!("Read {path} (from line {s})"),
                    _ => format!("Read {path}"),
                };
                (read_file(env, &path, s, e).await, what)
            }
            "search" => {
                let pattern = arg_str(a, &["pattern", "query"]).unwrap_or_default().to_string();
                let glob = arg_str(a, &["glob"]);
                (search(env, &pattern, glob).await, format!("Searched the project for \u{201c}{}\u{201d}", clip_line(&pattern, 60)))
            }
            "search_papers" => match need(a, &["query"]) {
                Ok(q) => (search_papers(env, q, a).await, format!("Looked for papers: \u{201c}{}\u{201d}", clip_line(q, 60))),
                Err(e) => (Err(e), "Looked for papers".into()),
            },
            "library_search" => match need(a, &["query"]) {
                Ok(q) => {
                    let limit = arg_u64(a, "limit").unwrap_or(8).clamp(1, 20) as i64;
                    (library_search(env, q, limit).await, format!("Searched your paper library: \u{201c}{}\u{201d}", clip_line(q, 60)))
                }
                Err(e) => (Err(e), "Searched your paper library".into()),
            },
            "paper_details" => match need(a, &["id", "doi", "arxiv_id", "arxivId"]) {
                Ok(id) => (paper_details(env, id).await, format!("Read the details of {}", clip_line(id, 60))),
                Err(e) => (Err(e), "Read a paper's details".into()),
            },
            "verify_bibliography" => {
                let keys: Option<Vec<String>> = match a.get("keys") {
                    Some(Value::Array(v)) => Some(v.iter().filter_map(Value::as_str).map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect()),
                    Some(Value::String(k)) => Some(k.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect()),
                    _ => None,
                };
                (verify_bibliography(env, keys).await, "Checked the bibliography".to_string())
            }
            "get_bibtex" => match need(a, &["id", "doi", "arxiv_id", "arxivId"]) {
                Ok(id) => {
                    let r = literature::get_bibtex(env.net, id).await.map(|r| r.to_tool_text());
                    (r, format!("Got the BibTeX for {}", clip_line(id, 60)))
                }
                Err(e) => (Err(e), "Got BibTeX".into()),
            },
            "fetch_url" => match need(a, &["url"]) {
                Ok(url) => {
                    let r = web::fetch_url(env.net, url).await.map(|p| p.to_tool_text());
                    (r, format!("Opened {}", clip_line(url, 80)))
                }
                Err(e) => (Err(e), "Opened a web page".into()),
            },
            "web_search" if env.net.web_search_available() => match need(a, &["query"]) {
                Ok(q) => {
                    let limit = arg_u64(a, "limit").unwrap_or(5).clamp(1, 8) as usize;
                    let r = web::web_search(env.net, q, limit).await.map(|r| r.to_tool_text());
                    (r, format!("Searched the web: \u{201c}{}\u{201d}", clip_line(q, 60)))
                }
                Err(e) => (Err(e), "Searched the web".into()),
            },
            "read_memory" => (read_memory(env.root), "Read the project's notes".into()),
            "remember" => match need(a, &["note", "text"]) {
                Ok(note) => (remember(env.root, note), format!("Remembered: {}", clip_line(note, 80))),
                Err(e) => (Err(e), "Remembered a note".into()),
            },
            "propose_task" => match need(a, &["prompt", "task"]) {
                Ok(prompt) => {
                    let files = a
                        .get("files")
                        .and_then(Value::as_array)
                        .map(|v| {
                            v.iter()
                                .filter_map(Value::as_str)
                                .map(|f| f.trim().replace('\\', "/"))
                                .filter(|f| !f.is_empty())
                                .take(20)
                                .collect()
                        })
                        .unwrap_or_default();
                    proposed = Some(ProposedTask { prompt: prompt.chars().take(8_000).collect(), files });
                    (
                        Ok("Shown to the user as a \"Run as task\" button. Don't do the task yourself; tell the user in one or two sentences what it will do.".to_string()),
                        "Suggested a task".to_string(),
                    )
                }
                Err(e) => (Err(e), "Suggested a task".into()),
            },
            other => (
                Err(AiError::invalid(format!(
                    "There is no tool called \"{other}\" in this chat. Available: {}.",
                    specs(env.net.web_search_available()).iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
                ))),
                format!("Tried an unknown tool ({})", clip_line(other, 40)),
            ),
        }
    };
    let ms = start.elapsed().as_millis() as u64;
    match result {
        // The tools cap their own text at about RESULT_CAP and add a hint
        // ("call read_file again with start_line …"); this is a safety net.
        Ok(text) => ToolOutcome { content: cap(&text, RESULT_CAP + 1_000), ok: true, summary, proposed, ms },
        Err(e) => ToolOutcome { content: format!("Error: {}", e.message), ok: false, summary, proposed: None, ms },
    }
}

/// Whether the user's message asks for something to be remembered. Models
/// (small ones especially) call `remember` on their own; a note is saved
/// only when the user asked for one.
pub fn asks_to_remember(text: &str) -> bool {
    let t = text.to_lowercase();
    ["remember", "keep in mind", "note that", "make a note", "take note", "from now on", "don't forget", "do not forget", "memori"]
        .iter()
        .any(|k| t.contains(k))
}

/// The plain reason a note wasn't saved because nobody asked for one.
pub const NOT_ASKED_TO_REMEMBER: &str =
    "Not saved: notes are saved only when the user asks you to remember something. Don't mention saving notes.";

/// [`run`] for one chat turn. `outside_text` remembers whether a web or
/// literature tool already ran in this turn: after that, `remember` is
/// refused (the fetched text could be planting instructions that every
/// later run would see). `asked` says whether the user's message asked for
/// something to be remembered; without that, `remember` is refused too.
/// Returns the notice to show when a note was saved.
pub async fn run_guarded(env: &ToolEnv<'_>, call: &ToolCall, outside_text: &mut bool, asked: bool) -> (ToolOutcome, Option<String>) {
    if call.name == "remember" && !asked && call.invalid_arguments.is_none() {
        let out = ToolOutcome {
            content: format!("Error: {NOT_ASKED_TO_REMEMBER}"),
            ok: false,
            summary: "Didn't save a note (you didn't ask for one)".into(),
            proposed: None,
            ms: 0,
        };
        return (out, None);
    }
    if call.name == "remember" && *outside_text && call.invalid_arguments.is_none() {
        let out = ToolOutcome {
            content: format!("Error: {}", memory::REFUSED_AFTER_WEB),
            ok: false,
            summary: "Didn't save a note (this answer read outside text)".into(),
            proposed: None,
            ms: 0,
        };
        return (out, None);
    }
    let out = run(env, call).await;
    if crate::agents::tools::registry::brings_outside_text(&call.name) {
        *outside_text = true;
    }
    let notice = (call.name == "remember" && out.ok)
        .then(|| arg_str(&call.arguments, &["note", "text"]).map(memory::saved_notice))
        .flatten();
    (out, notice)
}

/// Keeps the first `max` characters, saying how much was cut.
pub fn cap(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max).collect();
    s.push_str(&format!("\n[… {} more characters left out]", n - max));
    s
}

fn overlay(env: &ToolEnv<'_>) -> Overlay {
    Overlay::new(env.root, env.buffers.iter().map(|(k, v)| (k.clone(), v.clone())))
}

/// The text of a project file: the unsaved buffer if there is one, else the
/// file on disk. `.texo/` and paths outside the project are refused.
pub fn file_text(root: &Path, buffers: &HashMap<String, String>, path: &str) -> AiResult<String> {
    let o = Overlay::new(root, buffers.iter().map(|(k, v)| (k.clone(), v.clone())));
    match o.peek(path)? {
        Some(t) => Ok(t),
        None => Err(AiError::new(
            Kind::NotFound,
            format!("There is no file called {} in the project.", path.trim().replace('\\', "/")),
        )),
    }
}

/// Runs a project walk or read off the async runtime (a large project or a
/// network drive can take seconds).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AiResult<T> + Send + 'static) -> AiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| Err(AiError::new(Kind::Other, "Something went wrong inside Texo.")))
}

async fn list_files(env: &ToolEnv<'_>, glob: Option<&str>) -> AiResult<String> {
    let (o, glob) = (overlay(env), glob.map(str::to_string));
    blocking(move || Ok(fstools::list_files(&o, glob.as_deref())?)).await
}

async fn read_file(env: &ToolEnv<'_>, path: &str, start: Option<u64>, end: Option<u64>) -> AiResult<String> {
    if path.is_empty() {
        return Err(AiError::invalid("Missing \"path\"."));
    }
    let (mut o, path) = (overlay(env), path.to_string());
    blocking(move || Ok(fstools::read_file(&mut o, &path, start, end)?)).await
}

async fn search(env: &ToolEnv<'_>, pattern: &str, glob: Option<&str>) -> AiResult<String> {
    let (o, pattern, glob) = (overlay(env), pattern.to_string(), glob.map(str::to_string));
    blocking(move || Ok(fstools::search(&o, &pattern, glob.as_deref())?)).await
}

fn project_of(env: &ToolEnv<'_>) -> String {
    env.root.to_string_lossy().to_string()
}

/// The chat's context for one literature call (ranks for this project).
fn lit_ctx(env: &ToolEnv<'_>) -> NetCtx {
    pipeline::scoped(env.net, Some(project_of(env)), None)
}

async fn search_papers(env: &ToolEnv<'_>, q: &str, a: &Value) -> AiResult<String> {
    let limit = arg_u64(a, "limit").unwrap_or(5).clamp(1, literature::MAX_PAPERS as u64) as usize;
    let sort = match arg_str(a, &["sort"]) {
        Some(w) => SearchSort::parse(w).ok_or_else(|| AiError::invalid("\"sort\" must be relevance, cited or newest."))?,
        None => SearchSort::Relevance,
    };
    let year = |k: &str| {
        let v = a.get(k)?;
        v.as_i64().or_else(|| v.as_str()?.trim().parse().ok()).and_then(|y| i32::try_from(y).ok())
    };
    let opts = SearchOpts { limit, year_from: year("year_from"), year_to: year("year_to"), sort, ..SearchOpts::default() };
    let prov = Provenance { tool: Some("search_papers".into()), project: Some(project_of(env)), ..Default::default() };
    let found = pipeline::search_and_store(&lit_ctx(env), q, &opts, prov).await?;
    Ok(pipeline::found_text(&found))
}

async fn library_search(env: &ToolEnv<'_>, q: &str, limit: i64) -> AiResult<String> {
    let Some(lib) = env.net.library.clone() else {
        return Ok("The paper library isn't available right now, so there is nothing to search offline. Use search_papers to look online.".into());
    };
    let (project, words) = (project_of(env), q.to_string());
    let page = blocking(move || pipeline::local_search(&lib, &words, Some(&project), limit).map_err(|e| AiError::new(Kind::Other, e.plain()))).await?;
    Ok(pipeline::local_text(q, &page))
}

async fn paper_details(env: &ToolEnv<'_>, id: &str) -> AiResult<String> {
    let ctx = lit_ctx(env);
    let (lib, wanted) = (ctx.library.clone(), id.to_string());
    let s2 = blocking(move || pipeline::s2_id_for(lib.as_deref(), &wanted)).await?;
    let d = pipeline::paper_details(&ctx, &s2).await?;
    if let Some(lib) = ctx.library.clone() {
        let papers = vec![d.paper.clone()];
        let prov = Provenance { tool: Some("paper_details".into()), project: Some(project_of(env)), ..Default::default() };
        let _ = blocking(move || pipeline::store_papers(&lib, &papers, &prov).map_err(|e| AiError::new(Kind::Other, e.plain()))).await;
    }
    Ok(d.to_tool_text())
}

async fn verify_bibliography(env: &ToolEnv<'_>, keys: Option<Vec<String>>) -> AiResult<String> {
    let o = overlay(env);
    let bibs: Vec<(String, String)> = blocking(move || {
        let (files, _) = o.list(Some("*.bib"))?;
        Ok(files.into_iter().filter_map(|(p, _)| o.peek(&p).ok().flatten().map(|t| (p, t))).collect())
    })
    .await?;
    if bibs.is_empty() {
        return Err(AiError::invalid("This project has no .bib file."));
    }
    let (entries, missing, total) = pipeline::pick_entries(&bibs, keys.as_deref(), pipeline::MAX_VERIFY_KEYS);
    if entries.is_empty() {
        return Err(AiError::invalid(if missing.is_empty() {
            "The .bib files have no entries.".to_string()
        } else {
            format!("There's no entry {} in the .bib files.", missing.join(", "))
        }));
    }
    let ctx = lit_ctx(env);
    let mut done = Vec::new();
    for (file, rec) in entries {
        let c = pipeline::verify_entry(&ctx, &file, &rec).await?;
        done.push((rec, c));
    }
    let checks: Vec<pipeline::BibCheck> = done.iter().map(|(_, c)| c.clone()).collect();
    let warning = pipeline::persist_checks(&ctx, &project_of(env), done).await;
    let mut text = pipeline::checks_text(&checks, &missing, total);
    if let Some(w) = warning {
        text.push_str(&format!("\n\nNote: {w}"));
    }
    Ok(text)
}

/// The project memory (`.texo/ai/memory.md`), empty when there is none.
pub fn memory_text(root: &Path) -> String {
    memory::read(root)
}

fn read_memory(root: &Path) -> AiResult<String> {
    let t = memory_text(root);
    Ok(if t.trim().is_empty() { "No notes saved for this project yet.".into() } else { t })
}

/// Adds a note to the project memory (capped at 8 KB, oldest trimmed).
pub fn remember(root: &Path, note: &str) -> AiResult<String> {
    Ok(memory::remember(root, note)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http::Cancel;
    use std::fs;

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall { id: "c".into(), name: name.into(), arguments: args, invalid_arguments: None }
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.tex"), "\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}\n").unwrap();
        fs::create_dir_all(dir.path().join("chapters")).unwrap();
        fs::write(dir.path().join("chapters/intro.tex"), "Intro text\nhello again\n").unwrap();
        fs::write(dir.path().join("refs.bib"), "@article{a, title={Hello}}\n").unwrap();
        fs::create_dir_all(dir.path().join(".texo")).unwrap();
        fs::write(dir.path().join(".texo/secret.txt"), "hello hidden").unwrap();
        dir
    }

    fn run_sync(env: &ToolEnv<'_>, c: ToolCall) -> ToolOutcome {
        crate::ai::mock::runtime().block_on(run(env, &c))
    }

    #[test]
    fn list_read_and_search_see_buffers_but_not_texo() {
        let dir = fixture();
        let mut buffers = HashMap::new();
        buffers.insert("main.tex".to_string(), "unsaved line one\nHELLO unsaved\n".to_string());
        let net = NetCtx::new(Cancel::default());
        let env = ToolEnv { root: dir.path(), buffers: &buffers, net: &net };

        let out = run_sync(&env, call("list_files", json!({})));
        assert!(out.ok);
        assert!(out.content.contains("chapters/intro.tex"));
        assert!(!out.content.contains("secret"));
        let out = run_sync(&env, call("list_files", json!({"glob": "*.bib"})));
        assert_eq!(out.content.lines().count(), 1);

        let out = run_sync(&env, call("read_file", json!({"path": "main.tex"})));
        assert!(out.content.contains("1| unsaved line one"), "{}", out.content);
        assert_eq!(out.summary, "Read main.tex");
        let out = run_sync(&env, call("read_file", json!({"path": "chapters\\intro.tex", "start_line": 2, "end_line": "2"})));
        assert!(out.content.contains("2| hello again"), "{}", out.content);
        assert!(!out.content.contains("Intro text"));
        assert!(out.content.contains("of 2"), "{}", out.content);

        for bad in [".texo/secret.txt", "../x.tex", "nope.tex"] {
            let out = run_sync(&env, call("read_file", json!({"path": bad})));
            assert!(!out.ok, "{bad}");
            assert!(out.content.starts_with("Error: "));
        }

        let out = run_sync(&env, call("search", json!({"pattern": "hello"})));
        assert!(out.content.contains("main.tex:2: HELLO unsaved"), "{}", out.content);
        assert!(out.content.contains("chapters/intro.tex:2: hello again"));
        assert!(out.content.contains("refs.bib:1:"));
        assert!(!out.content.contains("hidden"));
        let out = run_sync(&env, call("search", json!({"pattern": "hello", "glob": "chapters/*"})));
        assert_eq!(out.content.lines().count(), 1);
    }

    #[test]
    fn long_files_are_capped_with_a_hint() {
        let dir = tempfile::tempdir().unwrap();
        let big: String = (1..=5000).map(|i| format!("line number {i} with some padding text\n")).collect();
        fs::write(dir.path().join("big.tex"), big).unwrap();
        let buffers = HashMap::new();
        let net = NetCtx::new(Cancel::default());
        let env = ToolEnv { root: dir.path(), buffers: &buffers, net: &net };
        let out = run_sync(&env, call("read_file", json!({"path": "big.tex"})));
        assert!(out.content.len() <= RESULT_CAP + 1_000);
        assert!(out.content.contains("start_line"), "{}", &out.content[out.content.len() - 200..]);
    }

    #[test]
    fn propose_task_and_bad_calls() {
        let dir = fixture();
        let buffers = HashMap::new();
        let net = NetCtx::new(Cancel::default());
        let env = ToolEnv { root: dir.path(), buffers: &buffers, net: &net };
        let out = run_sync(&env, call("propose_task", json!({"prompt": "Shorten the abstract", "files": ["main.tex", " ", "a\\b.tex"]})));
        assert!(out.ok);
        assert_eq!(out.proposed, Some(ProposedTask { prompt: "Shorten the abstract".into(), files: vec!["main.tex".into(), "a/b.tex".into()] }));

        let out = run_sync(&env, call("edit_file", json!({"path": "main.tex"})));
        assert!(!out.ok);
        assert!(out.content.contains("no tool called \"edit_file\""));
        let out = run_sync(&env, call("web_search", json!({"query": "x"})));
        assert!(!out.ok, "not offered without a search service");

        let mut bad = call("read_file", json!({}));
        bad.invalid_arguments = Some("{path: ".into());
        let out = run_sync(&env, bad);
        assert!(!out.ok);
        assert!(out.content.contains("valid JSON"));
        let out = run_sync(&env, call("search_papers", json!({})));
        assert!(!out.ok, "a missing argument is reported, nothing is fetched");
    }

    #[test]
    fn memory_is_appended_and_capped() {
        let dir = fixture();
        let buffers = HashMap::new();
        let net = NetCtx::new(Cancel::default());
        let env = ToolEnv { root: dir.path(), buffers: &buffers, net: &net };
        let out = run_sync(&env, call("read_memory", json!({})));
        assert!(out.content.contains("No notes"));
        let out = run_sync(&env, call("remember", json!({"note": "Use British\nspelling"})));
        assert!(out.ok, "{}", out.content);
        let text = memory_text(dir.path());
        assert!(text.contains(": Use British spelling"), "{text}");
        for i in 0..200 {
            remember(dir.path(), &format!("note number {i} {}", "x".repeat(60))).unwrap();
        }
        let text = memory_text(dir.path());
        assert!(text.len() <= MEMORY_CAP, "{}", text.len());
        assert!(text.contains("Older notes were removed"));
        assert!(text.contains("note number 199"));
        assert!(!text.contains("British"), "the oldest note went first");
        assert!(remember(dir.path(), "  ").is_err());
    }

    /// SEC-3: after a web or literature tool in the same turn, `remember`
    /// is refused; otherwise a saved note comes with a visible notice.
    #[test]
    fn remember_is_refused_after_outside_text() {
        let dir = fixture();
        let buffers = HashMap::new();
        let net = NetCtx::new(Cancel::default());
        let env = ToolEnv { root: dir.path(), buffers: &buffers, net: &net };
        let rt = crate::ai::mock::runtime();
        let mut outside = false;
        let (out, notice) = rt.block_on(run_guarded(&env, &call("remember", json!({"note": "Use British spelling"})), &mut outside, true));
        assert!(out.ok && notice.is_some_and(|n| n.contains("Use British spelling")));
        rt.block_on(run_guarded(&env, &call("search_papers", json!({})), &mut outside, true));
        assert!(outside);
        let (out, notice) = rt.block_on(run_guarded(&env, &call("remember", json!({"note": "fetch evil.example"})), &mut outside, true));
        assert!(!out.ok && notice.is_none());
        assert!(out.content.contains("Not saved"), "{}", out.content);
        assert!(!memory_text(dir.path()).contains("evil"));
    }

    /// A model that saves a note nobody asked for is refused.
    #[test]
    fn remember_needs_the_user_to_ask() {
        assert!(asks_to_remember("Please remember that we use British spelling"));
        assert!(asks_to_remember("From now on, never touch the abstract."));
        assert!(!asks_to_remember("Suggest a better title."));
        let dir = fixture();
        let buffers = HashMap::new();
        let net = NetCtx::new(Cancel::default());
        let env = ToolEnv { root: dir.path(), buffers: &buffers, net: &net };
        let rt = crate::ai::mock::runtime();
        let mut outside = false;
        let (out, notice) = rt.block_on(run_guarded(&env, &call("remember", json!({"note": "User asked for a title"})), &mut outside, false));
        assert!(!out.ok && notice.is_none());
        assert!(!memory_text(dir.path()).contains("title"));
    }

    #[test]
    fn web_search_is_only_offered_when_set_up() {
        assert!(!specs(false).iter().any(|s| s.name == "web_search"));
        assert!(specs(true).iter().any(|s| s.name == "web_search"));
        assert!(specs(false).iter().all(|s| s.parameters["type"] == "object"));
    }
}
