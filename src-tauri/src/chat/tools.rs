//! The tools the chat model may call. All are read-only for the project,
//! except `remember` (adds a note to the project memory, as the spec asks)
//! and `propose_task`, which never runs anything: it becomes a "Run as task"
//! suggestion in the chat.
//!
//! Every tool is the agents' own (`agents::tools::{fs, memory, web,
//! literature}`), run over a read-only overlay of the project plus the
//! unsaved editor buffers; only `propose_task` is chat's.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use serde_json::{json, Value};

use super::store::{clip_line, ProposedTask};
use crate::agents::tools::net::NetCtx;
use crate::agents::overlay::Overlay;
use crate::agents::tools::{fs as fstools, literature, memory, web};
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
            "search_papers",
            "Search arXiv, Crossref and Semantic Scholar for papers. limit is 1 to 8.",
            json!({"type": "object", "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"}
            }, "required": ["query"]}),
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
        out.insert(
            6,
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
                Ok(q) => {
                    let limit = arg_u64(a, "limit").unwrap_or(5).clamp(1, 8) as usize;
                    let r = literature::search_papers(env.net, q, limit).await.map(|r| r.to_tool_text());
                    (r, format!("Looked for papers: \u{201c}{}\u{201d}", clip_line(q, 60)))
                }
                Err(e) => (Err(e), "Looked for papers".into()),
            },
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

/// [`run`] for one chat turn. `outside_text` remembers whether a web or
/// literature tool already ran in this turn: after that, `remember` is
/// refused (the fetched text could be planting instructions that every
/// later run would see). Returns the notice to show when a note was saved.
pub async fn run_guarded(env: &ToolEnv<'_>, call: &ToolCall, outside_text: &mut bool) -> (ToolOutcome, Option<String>) {
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
        let (out, notice) = rt.block_on(run_guarded(&env, &call("remember", json!({"note": "Use British spelling"})), &mut outside));
        assert!(out.ok && notice.is_some_and(|n| n.contains("Use British spelling")));
        rt.block_on(run_guarded(&env, &call("search_papers", json!({})), &mut outside));
        assert!(outside);
        let (out, notice) = rt.block_on(run_guarded(&env, &call("remember", json!({"note": "fetch evil.example"})), &mut outside));
        assert!(!out.ok && notice.is_none());
        assert!(out.content.contains("Not saved"), "{}", out.content);
        assert!(!memory_text(dir.path()).contains("evil"));
    }

    #[test]
    fn web_search_is_only_offered_when_set_up() {
        assert!(!specs(false).iter().any(|s| s.name == "web_search"));
        assert!(specs(true).iter().any(|s| s.name == "web_search"));
        assert!(specs(false).iter().all(|s| s.parameters["type"] == "object"));
    }
}
