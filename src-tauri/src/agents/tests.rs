//! End-to-end tests of the runtime against the local mock LLM server: a
//! scripted model drives a real run through the loop, tools, overlay,
//! journal, changeset and history. No network, no TeX.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::kinds::{AgentKind, Outcome, Registry};
use super::run_loop::{Events, LoopSpec, RunCx, RunEnv};
use super::runtime::{AgentRuntime, EnvSource};
use super::tools::registry::BoxFut;
use super::types::*;
use crate::ai::error::AiResult;
use crate::ai::http::{ApiKey, Cancel, Endpoint};
use crate::ai::llm::{Msg, ProviderId, RetryPolicy};
use crate::ai::mock::{Canned, MockServer};

#[derive(Default)]
pub(super) struct Rec {
    pub(super) updates: Mutex<Vec<RunSummary>>,
    pub(super) steps: Mutex<Vec<StepEvent>>,
}

impl Events for Rec {
    fn run_updated(&self, run: &RunSummary) {
        self.updates.lock().unwrap().push(run.clone());
    }
    fn step(&self, e: &StepEvent) {
        self.steps.lock().unwrap().push(e.clone());
    }
    fn message(&self, _e: &MessageEvent) {}
}

struct TestEnv {
    base: String,
    fallbacks: Vec<String>,
}

impl EnvSource for TestEnv {
    fn resolve<'a>(&'a self, _: &'a Path, _: &'a dyn AgentKind, _: &'a StartRequest, _: Cancel) -> BoxFut<'a, AiResult<RunEnv>> {
        Box::pin(async move {
            Ok(RunEnv {
                client: crate::ai::http::build_client(false)?,
                endpoint: Endpoint {
                    provider: ProviderId::Custom,
                    label: "Test AI".into(),
                    base_url: format!("{}/v1", self.base),
                    key: Some(ApiKey::new("sk-test-KEY-123456".into())),
                    model: "test-model".into(),
                },
                fallback_models: self.fallbacks.clone(),
                thinking: false,
                policy: RetryPolicy { tries: 1, backoff: Duration::from_millis(1), max_wait: Duration::from_secs(1), rate_limit: false },
                net: None,
                build: None,
                vision: None,
            })
        })
    }
}

pub(super) fn project() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().to_path_buf();
    crate::project::adopt(&root, "Paper", Some("main.tex".into()), Default::default()).unwrap();
    fs::write(root.join("main.tex"), "\\documentclass{article}\n\\begin{document}\n\\section{Intro\nHello.\n\\end{document}\n").unwrap();
    (d, root)
}

/// A kind that runs the standard loop once with the task agent's tools (the
/// real task kind plans first, which these runtime tests don't script).
pub(super) struct Plain;

impl AgentKind for Plain {
    fn id(&self) -> &'static str {
        "plain"
    }
    fn label(&self) -> &'static str {
        "Plain test"
    }
    fn system_prompt(&self) -> String {
        "Test.".into()
    }
    fn tool_names(&self) -> Vec<&'static str> {
        use super::tools::registry::*;
        [FS_READ, FS_WRITE, BUILD, MEMORY].concat()
    }
}

pub(super) fn runtime(server: &MockServer, rec: Arc<Rec>, kinds: Registry) -> AgentRuntime {
    let mut kinds = kinds;
    kinds.register(Arc::new(Plain));
    AgentRuntime::with_kinds(rec, Arc::new(TestEnv { base: server.base_url.clone(), fallbacks: Vec::new() }), kinds)
}

pub(super) fn call(id: &str, name: &str, args: Value) -> Canned {
    Canned::json(
        200,
        json!({"model": "test-model", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": null,
            "tool_calls": [{"id": id, "type": "function", "function": {"name": name, "arguments": args.to_string()}}]}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10}}),
    )
}

pub(super) fn text(content: &str) -> Canned {
    Canned::json(
        200,
        json!({"model": "test-model", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 5}}),
    )
}

pub(super) fn request(kind: &str, prompt: &str) -> StartRequest {
    StartRequest { kind: kind.into(), prompt: prompt.into(), ..Default::default() }
}

pub(super) fn wait(rt: &AgentRuntime, root: &Path, id: &str, what: impl Fn(&AgentRun) -> bool) -> AgentRun {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let run = rt.get(root, id).unwrap();
        if what(&run) {
            return run;
        }
        assert!(Instant::now() < until, "timed out; run is {:?}: {:?}", run.status, run.error);
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(super) fn finished(r: &AgentRun) -> bool {
    !r.status.is_active() && r.finished_at.is_some()
}

#[test]
fn scripted_fixer_run_reads_edits_finishes_and_applies() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        call("c1", "read_file", json!({"path": "main.tex"})),
        call("c2", "edit_file", json!({"path": "main.tex", "old": "\\section{Intro\n", "new": "\\section{Intro}\n", "reason": "Close the brace"})),
        text("Fixed the missing brace after \\section{Intro in main.tex."),
    ]);
    let rec = Arc::new(Rec::default());
    let rt = runtime(&server, rec.clone(), Registry::default());
    let mut req = request("fixer", "Fix the compile error");
    req.dirty_buffers = vec![];
    let started = rt.start(root.clone(), root.to_string_lossy().into_owned(), req).unwrap();
    assert_eq!(started.status, RunStatus::Queued);
    let run = wait(&rt, &root, &started.id, finished);

    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);
    assert_eq!(run.model, "test-model");
    assert!(run.start_commit.is_some(), "the before-run snapshot");
    let tools: Vec<(&str, bool)> = run.steps.iter().filter_map(|s| s.tool.as_deref().map(|t| (t, s.ok))).collect();
    assert_eq!(tools, [("read_file", true), ("edit_file", true)]);
    let last = run.steps.last().unwrap();
    assert_eq!(last.kind, StepKind::Message);
    assert!(run.final_message.as_deref().unwrap().contains("Fixed the missing brace"));
    assert_eq!(run.usage.llm_calls, 3);
    assert_eq!(run.usage.tool_calls, 2);
    assert_eq!(run.usage.input_tokens, 250);
    // The step numbers are 1..n.
    assert!(run.steps.iter().enumerate().all(|(i, s)| s.n as usize == i + 1));

    // The changeset: one modified file; the disk is untouched until apply.
    assert_eq!(run.changeset.len(), 1);
    let c = &run.changeset[0];
    assert_eq!(c.file, "main.tex");
    assert_eq!(c.reason, "Close the brace");
    assert!(c.new_text.as_deref().unwrap().contains("\\section{Intro}\n"));
    assert!(fs::read_to_string(root.join("main.tex")).unwrap().contains("\\section{Intro\n"));
    let view = rt.changeset(&root, &run.id).unwrap();
    assert_eq!(view.files[0].status, FileStatus::Modified);
    assert_eq!(view.files[0].hunks.len(), 1);
    assert!(!view.files[0].conflict);

    // What the model saw: the tools, and the numbered file in the result.
    let reqs = server.recorded();
    assert_eq!(reqs.len(), 3);
    let first = reqs[0].json();
    let names: Vec<&str> = first["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"edit_file") && names.contains(&"compile_check") && !names.contains(&"fetch_url"));
    assert!(first["messages"][0]["content"].as_str().unwrap().contains("You fix compile errors"));
    let second = reqs[1].json();
    let tool_msg = second["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
    assert!(tool_msg["content"].as_str().unwrap().contains("3| \\section{Intro"));

    // The journal persists and lists after a "restart" (a new runtime).
    assert!(root.join(format!(".texo/ai/runs/{}.json", run.id)).is_file());
    let rt2 = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let listed = rt2.list(&root);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pending_files, 1);

    // Events: queued → running → … → awaiting_review; one step event per step.
    let statuses: Vec<RunStatus> = rec.updates.lock().unwrap().iter().map(|u| u.status).collect();
    assert_eq!(statuses.first(), Some(&RunStatus::Queued));
    assert!(statuses.contains(&RunStatus::Running));
    assert_eq!(statuses.last(), Some(&RunStatus::AwaitingReview));
    assert_eq!(rec.steps.lock().unwrap().len(), run.steps.len());

    // Apply: written through history with the AI author.
    let res = rt2.apply(&root, &run.id, &[Decision { file: "main.tex".into(), accept: true, ..Default::default() }]).unwrap();
    assert_eq!(res.written, ["main.tex"]);
    assert!(res.commit.is_some(), "{:?}", res.history_error);
    assert_eq!(res.run.status, RunStatus::Done);
    assert!(fs::read_to_string(root.join("main.tex")).unwrap().contains("\\section{Intro}\n"));
    let after = rt2.get(&root, &run.id).unwrap();
    assert_eq!(after.changeset[0].state, FileState::Applied);
    assert_eq!(after.apply_commits.len(), 1);

    rt2.delete(&root, &run.id).unwrap();
    assert!(rt2.list(&root).is_empty());
}

#[test]
fn loop_guard_stops_a_repeating_model() {
    let (_d, root) = project();
    let same = || call("c", "read_file", json!({"path": "main.tex"}));
    let server = MockServer::start(vec![same(), same(), same(), text("never reached")]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("plain", "Read it")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.error.as_deref().unwrap().contains("repeating the same step (read_file)"), "{:?}", run.error);
    assert_eq!(server.recorded().len(), 3);
    assert!(!run.steps.last().unwrap().ok);
}

#[test]
fn step_limit_keeps_the_changes_for_review() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        call("c1", "write_file", json!({"path": "notes.md", "text": "a\n"})),
        call("c2", "read_file", json!({"path": "notes.md"})),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let mut req = request("plain", "Write notes");
    req.options.max_steps = Some(2);
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview);
    assert!(run.error.as_deref().unwrap().contains("all 2 of its steps"));
    assert_eq!(run.changeset[0].file, "notes.md");
    assert_eq!(run.changeset[0].base_text, None);
}

#[test]
fn cancel_stops_a_working_run_and_a_queued_one() {
    let (_d, root) = project();
    // Every reply is slow; the server answers one connection at a time.
    let server = MockServer::start((0..5).map(|_| text("late").delay(8000)).collect());
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    // Spawned tasks take the slots in any order: start the 4th once the
    // first three are working.
    let mut ids: Vec<String> =
        (0..3).map(|i| rt.start(root.clone(), "p".into(), request("plain", &format!("Task {i}"))).unwrap().id).collect();
    for id in &ids[..3] {
        wait(&rt, &root, id, |r| r.status == RunStatus::Running);
    }
    ids.push(rt.start(root.clone(), "p".into(), request("plain", "Task 3")).unwrap().id);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(rt.get(&root, &ids[3]).unwrap().status, RunStatus::Queued, "only 3 at once");
    let t = Instant::now();
    assert!(rt.cancel(&ids[0]));
    let run = wait(&rt, &root, &ids[0], finished);
    assert_eq!(run.status, RunStatus::Cancelled);
    assert!(t.elapsed() < Duration::from_secs(5), "cancel is quick");
    // The queued run gets the freed slot; cancel it and the rest.
    for id in &ids[1..] {
        rt.cancel(id);
    }
    for id in &ids[1..] {
        assert_eq!(wait(&rt, &root, id, finished).status, RunStatus::Cancelled);
    }
    assert!(!rt.cancel(&ids[0]), "no longer running");
}

/// A kind that plans, pauses for the user, then runs two sub-runs at once.
struct Paused;

impl AgentKind for Paused {
    fn id(&self) -> &'static str {
        "paused"
    }
    fn label(&self) -> &'static str {
        "Paused test"
    }
    fn system_prompt(&self) -> String {
        "Test.".into()
    }
    fn tool_names(&self) -> Vec<&'static str> {
        vec!["read_file"]
    }
    fn drive<'a>(&'a self, cx: &'a RunCx) -> BoxFut<'a, AiResult<Outcome>> {
        Box::pin(async move {
            cx.message("1. Ask the user\n2. Two reviewers");
            let answer = cx.await_input(json!({"plan": ["a", "b"]})).await?;
            let mut spec = cx.default_spec(self);
            let specs: Vec<LoopSpec> = ["methods", "clarity"]
                .iter()
                .map(|p| LoopSpec { sub: Some(p.to_string()), messages: vec![Msg::user(format!("Review as {p}"))], ..spec.clone() })
                .collect();
            spec.sub = None;
            let outs = cx.sub_runs(specs).await;
            let texts: Vec<String> = outs.into_iter().map(|o| o.map(|o| o.text).unwrap_or_default()).collect();
            Ok(Outcome { message: Some(format!("{answer} / {}", texts.join(" + "))), ..Default::default() })
        })
    }
}

#[test]
fn awaiting_input_resumes_and_sub_runs_run_in_parallel() {
    let (_d, root) = project();
    let server = MockServer::start(vec![text("review one"), text("review two")]);
    let mut kinds = Registry::default();
    kinds.register(Arc::new(Paused));
    let rt = runtime(&server, Arc::new(Rec::default()), kinds);
    let id = rt.start(root.clone(), "p".into(), request("paused", "Review")).unwrap().id;
    let run = wait(&rt, &root, &id, |r| r.status == RunStatus::AwaitingInput);
    assert_eq!(run.awaiting, Some(json!({"plan": ["a", "b"]})));
    assert_eq!(run.steps[0].kind, StepKind::Message);
    assert!(rt.respond("nope", json!(1)).is_err());
    rt.respond(&id, json!("approved")).unwrap();
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done, "{:?}", run.error);
    let msg = run.final_message.unwrap();
    assert!(msg.starts_with("\"approved\" / "), "{msg}");
    assert!(msg.contains("review one") && msg.contains("review two"));
    let subs: Vec<&str> = run.steps.iter().filter_map(|s| s.sub.as_deref()).collect();
    assert_eq!(subs.len(), 2);
    assert!(rt.respond(&id, json!(1)).is_err(), "not waiting any more");
}

#[test]
fn unknown_kinds_and_bad_attachments_are_refused_up_front() {
    let (_d, root) = project();
    let server = MockServer::start(vec![]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    assert!(rt.start(root.clone(), "p".into(), request("wizard", "x")).is_err());
    assert!(rt.start(root.clone(), "p".into(), request("task", "  ")).is_err());
    let mut req = request("task", "Look");
    req.attachments.push(Attachment { name: "x.exe".into(), mime: "application/octet-stream".into(), data_base64: Some("TVo=".into()), ..Default::default() });
    assert!(rt.start(root.clone(), "p".into(), req).unwrap_err().to_string().contains("can't be attached"));
    assert!(rt.list(&root).is_empty());
}

#[test]
fn provider_errors_fail_the_run_without_the_key() {
    let (_d, root) = project();
    let server = MockServer::start(vec![Canned::json(401, json!({"error": {"message": "bad key sk-test-KEY-123456"}}))]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("plain", "Go")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Failed);
    let err = run.error.unwrap();
    assert!(!err.contains("sk-test-KEY-123456"), "{err}");
    let journal = fs::read_to_string(root.join(format!(".texo/ai/runs/{id}.json"))).unwrap();
    assert!(!journal.contains("sk-test-KEY-123456"));
}

#[test]
fn a_fallback_model_switch_shows_in_the_run_log() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        Canned::json(404, json!({"error": {"message": "model not found"}})),
        Canned::json(
            200,
            json!({"model": "backup-model", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "All good."}}]}),
        ),
    ]);
    let env = TestEnv { base: server.base_url.clone(), fallbacks: vec!["backup-model".into()] };
    let mut kinds = Registry::default();
    kinds.register(Arc::new(Plain));
    let rt = AgentRuntime::with_kinds(Arc::new(Rec::default()), Arc::new(env), kinds);
    let id = rt.start(root.clone(), "p".into(), request("plain", "Check")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done, "{:?}", run.error);
    let notice = run.steps.iter().find(|s| s.notice).expect("a notice step");
    assert!(notice.text.as_deref().unwrap().contains("Switched from test-model to backup-model"), "{:?}", notice.text);
    assert_eq!(run.model, "backup-model");
    assert_eq!(server.recorded()[1].json()["model"], "backup-model");
}

#[test]
fn a_cut_off_write_is_answered_and_the_run_goes_on() {
    let (_d, root) = project();
    let cut = Canned::json(
        200,
        json!({"model": "test-model", "choices": [{"index": 0, "finish_reason": "length", "message": {"role": "assistant", "content": null,
            "tool_calls": [{"id": "w1", "type": "function", "function": {"name": "write_file",
                "arguments": "{\"path\": \"main.tex\", \"text\": \"\\\\documentclass{article}\\n\\\\begin{doc"}}]}}]}),
    );
    let server = MockServer::start(vec![cut, text("I'll use smaller edits.")]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("plain", "Rewrite main.tex")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_ne!(run.status, RunStatus::Failed, "{:?}", run.error);
    // Nothing was written, and the model was told why.
    assert!(run.changeset.is_empty());
    let second = server.recorded()[1].json();
    let msgs = second["messages"].as_array().unwrap();
    let tool = msgs.iter().find(|m| m["role"] == "tool").expect("a tool result");
    assert!(tool["content"].as_str().unwrap().contains("cut off"), "{tool}");
    assert!(tool["content"].as_str().unwrap().contains("edit_file"));
}

/// F2: the loop guard counts repeats since the last change, so checking or
/// reading again after an edit isn't "the same step".
#[test]
fn loop_guard_resets_after_a_change() {
    let (_d, root) = project();
    let read = || call("r", "read_file", json!({"path": "main.tex"}));
    let check = || call("c", "compile_check", json!({}));
    let write = |n: u32| call("w", "write_file", json!({"path": "notes.md", "text": format!("v{n}\n")}));
    let server = MockServer::start(vec![check(), read(), write(1), check(), read(), write(2), check(), read(), text("Done.")]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("plain", "Edit and check")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);
    assert_eq!(server.recorded().len(), 9);
}

/// SEC-2: auto-apply never saves a change that adds shell escape, for any
/// kind; build configuration can't be written at all.
#[test]
fn auto_apply_holds_back_shell_escape_for_every_kind() {
    let (_d, root) = project();
    let before = fs::read_to_string(root.join("main.tex")).unwrap();
    let server = MockServer::start(vec![
        call("w1", "write_file", json!({"path": "latexmkrc", "text": "system('calc');"})),
        call("e1", "edit_file", json!({"path": "main.tex", "old": "Hello.", "new": "Hello.\n\\immediate\\write18{curl x}"})),
        text("Done."),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let mut req = request("plain", "Do it");
    req.options.auto_apply = true;
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);
    assert_eq!(run.changeset.len(), 1, "the latexmkrc write was refused");
    assert_eq!(run.changeset[0].file, "main.tex");
    assert!(run.changeset[0].attention.iter().any(|a| a.contains("\\write18")), "{:?}", run.changeset[0].attention);
    assert_eq!(run.changeset[0].state, FileState::Pending);
    assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), before);
    assert!(!root.join("latexmkrc").exists());
    // With auto-apply on, the prompt doesn't claim a review that won't happen.
    let system = server.recorded()[0].json()["messages"][0]["content"].as_str().unwrap_or_default().to_string();
    assert!(!system.contains("for review before anything is saved"), "{system}");
}

/// F11: deleting a working run removes its journal for good (no later save
/// brings it back).
#[test]
fn deleting_a_working_run_keeps_its_journal_gone() {
    let (_d, root) = project();
    let server = MockServer::start(vec![text("late").delay(3000)]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("plain", "Slow")).unwrap().id;
    wait(&rt, &root, &id, |r| r.status == RunStatus::Running);
    let journal = root.join(".texo/ai/runs").join(format!("{id}.json"));
    assert!(journal.exists());
    rt.delete(&root, &id).unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while rt.list(&root).iter().any(|r| r.id == id) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(200));
    assert!(!journal.exists(), "the journal came back");
    assert!(!rt.list(&root).iter().any(|r| r.id == id));
}
