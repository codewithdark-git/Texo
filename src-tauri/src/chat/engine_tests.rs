//! Chat turns against the local mock server (no network, no real keys).

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::ai::http::{build_client, ApiKey};
use crate::ai::llm::ProviderId;
use crate::ai::mock::{runtime, Canned, MockServer};

const KEY: &str = "nvapi-TESTKEY-0123456789abcdef";
const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

fn ep(server: &MockServer, provider: ProviderId, model: &str) -> Endpoint {
    Endpoint {
        provider,
        label: "Test AI".into(),
        base_url: format!("{}/v1", server.base_url),
        key: Some(ApiKey::new(KEY.into())),
        model: model.into(),
    }
}

fn cfg() -> TurnConfig {
    TurnConfig {
        policy: RetryPolicy { tries: 2, backoff: Duration::from_millis(1), max_wait: Duration::from_secs(5), rate_limit: false },
        ..Default::default()
    }
}

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n").unwrap();
    dir
}

fn chunk(delta: Value, finish: Option<&str>) -> String {
    json!({"model": "m", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}).to_string()
}

fn oa_text(content: &str) -> Canned {
    Canned::json(
        200,
        json!({"model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
               "usage": {"prompt_tokens": 10, "completion_tokens": 5}}),
    )
}

fn oa_call(name: &str, args: Value) -> Canned {
    Canned::json(
        200,
        json!({"model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": null,
            "tool_calls": [{"id": format!("call_{name}"), "type": "function", "function": {"name": name, "arguments": args.to_string()}}]},
            "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 3}}),
    )
}

type Events = Arc<Mutex<Vec<EventBody>>>;

fn sink() -> (Events, impl Fn(EventBody) + Send + Sync) {
    let ev: Events = Arc::new(Mutex::new(Vec::new()));
    let e2 = ev.clone();
    (ev, move |b: EventBody| e2.lock().unwrap().push(b))
}

/// The answer text the way the UI builds it from the events.
fn shown(events: &[EventBody]) -> String {
    let mut s = String::new();
    for e in events {
        match e {
            EventBody::Delta { text } => s.push_str(text),
            EventBody::Replace { text } => s = text.clone(),
            _ => {}
        }
    }
    s
}

fn send(text: &str) -> ChatSendRequest {
    ChatSendRequest { chat_id: "c1".into(), request_id: "r1".into(), text: text.into(), ..Default::default() }
}

#[allow(clippy::too_many_arguments)]
fn turn(
    server: &MockServer,
    e: Endpoint,
    c: &TurnConfig,
    root: &Path,
    earlier: &[ChatMessage],
    req: &ChatSendRequest,
    cancel: &Cancel,
) -> (ChatMessage, Vec<EventBody>) {
    let _ = server;
    let prepared = prepare(root, req).unwrap();
    let net = NetCtx::new(cancel.clone());
    let (events, emit) = sink();
    let msg = runtime().block_on(run_turn(&build_client(false).unwrap(), e, c, root, earlier, &prepared, &net, cancel, &emit));
    let ev = events.lock().unwrap().clone();
    (msg, ev)
}

fn user_texts(body: &Value) -> Vec<String> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| match &m["content"] {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
            _ => String::new(),
        })
        .collect()
}

#[test]
fn streams_the_answer() {
    let server = MockServer::start(vec![Canned::sse(vec![
        chunk(json!({"role": "assistant", "content": "Your paper "}), None),
        chunk(json!({"content": "<think>hidden</think>looks fine."}), None),
        chunk(json!({}), Some("stop")),
        json!({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4}}).to_string(),
        "[DONE]".into(),
    ])
    .chunk_delay(5)]);
    let dir = project();
    let (msg, events) =
        turn(&server, ep(&server, ProviderId::Custom, "x"), &cfg(), dir.path(), &[], &send("Is it ok?"), &Cancel::default());
    assert_eq!(msg.text, "Your paper looks fine.");
    assert_eq!(msg.role, ChatRole::Assistant);
    assert!(msg.error.is_none() && !msg.stopped);
    assert_eq!(msg.usage, Some(Usage { input_tokens: 12, output_tokens: 4 }));
    assert_eq!(shown(&events), "Your paper looks fine.");
    assert!(events.iter().filter(|e| matches!(e, EventBody::Delta { .. })).count() >= 2, "streamed in pieces");
    let rec = server.recorded();
    let body = rec[0].json();
    assert_eq!(body["stream"], true);
    assert!(body["messages"][0]["content"].as_str().unwrap().contains("main.tex"), "the system prompt lists the files");
    assert!(body["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "propose_task"));
    assert!(!body["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "edit_file"), "read-only tools only");
    assert!(!body.to_string().contains(KEY), "the key only travels in the header");
}

#[test]
fn tool_call_then_answer() {
    let server = MockServer::start(vec![
        oa_call("read_file", json!({"path": "main.tex"})),
        oa_text("Line 3 says Hello."),
    ]);
    let dir = project();
    let (msg, events) = turn(
        &server,
        ep(&server, ProviderId::Custom, "x"),
        &cfg(),
        dir.path(),
        &[],
        &send("What does line 3 say?"),
        &Cancel::default(),
    );
    assert_eq!(msg.text, "Line 3 says Hello.");
    assert_eq!(msg.tools.len(), 1);
    assert_eq!(msg.tools[0].name, "read_file");
    assert_eq!(msg.tools[0].summary, "Read main.tex");
    assert!(msg.tools[0].ok);
    assert_eq!(msg.usage, Some(Usage { input_tokens: 17, output_tokens: 8 }));
    assert!(events.iter().any(|e| matches!(e, EventBody::ToolStarted { summary, .. } if summary == "Reading main.tex")));
    assert!(events.iter().any(|e| matches!(e, EventBody::ToolFinished { tool } if tool.ok)));
    let second = server.recorded()[1].json();
    let msgs = second["messages"].as_array().unwrap();
    let tool = msgs.iter().find(|m| m["role"] == "tool").expect("tool result sent back");
    assert_eq!(tool["tool_call_id"], "call_read_file");
    assert!(tool["content"].as_str().unwrap().contains("3| Hello"));
}

#[test]
fn propose_task_becomes_a_suggestion() {
    let server = MockServer::start(vec![
        oa_call("propose_task", json!({"prompt": "Rewrite the abstract in plain English", "files": ["main.tex"]})),
        oa_text("I prepared a task that rewrites the abstract."),
    ]);
    let dir = project();
    let before = fs::read_to_string(dir.path().join("main.tex")).unwrap();
    let (msg, events) = turn(
        &server,
        ep(&server, ProviderId::Custom, "x"),
        &cfg(),
        dir.path(),
        &[],
        &send("Please rewrite my abstract"),
        &Cancel::default(),
    );
    let task = msg.proposed_task.expect("a proposed task");
    assert_eq!(task.prompt, "Rewrite the abstract in plain English");
    assert_eq!(task.files, vec!["main.tex".to_string()]);
    assert!(events.iter().any(|e| matches!(e, EventBody::ProposedTask { .. })));
    assert_eq!(fs::read_to_string(dir.path().join("main.tex")).unwrap(), before, "nothing was changed");
}

#[test]
fn step_cap_forces_an_answer() {
    let server = MockServer::start(vec![
        oa_call("list_files", json!({})),
        oa_call("list_files", json!({"glob": "*.tex"})),
        oa_text("Done looking."),
    ]);
    let dir = project();
    let c = TurnConfig { max_rounds: 2, ..cfg() };
    let (msg, _) =
        turn(&server, ep(&server, ProviderId::Custom, "x"), &c, dir.path(), &[], &send("Look around"), &Cancel::default());
    assert_eq!(msg.text, "Done looking.");
    assert_eq!(msg.tools.len(), 2);
    let rec = server.recorded();
    assert_eq!(rec.len(), 3);
    assert_eq!(rec[2].json()["tool_choice"], "none", "the last round may not call tools");
}

#[test]
fn step_cap_reached_with_more_calls_is_reported() {
    let server = MockServer::start(vec![oa_call("list_files", json!({})), oa_call("list_files", json!({}))]);
    let dir = project();
    let c = TurnConfig { max_rounds: 1, ..cfg() };
    let (msg, _) = turn(&server, ep(&server, ProviderId::Custom, "x"), &c, dir.path(), &[], &send("Hi"), &Cancel::default());
    assert!(msg.notices.iter().any(|n| n.contains("Stopped looking things up")));
    assert!(msg.error.is_some(), "no answer text: says so");
}

#[test]
fn cancel_keeps_the_partial_answer() {
    let many: Vec<String> = (0..200).map(|i| chunk(json!({"content": format!("w{i} ")}), None)).collect();
    let server = MockServer::start(vec![Canned::sse(many).chunk_delay(15)]);
    let dir = project();
    let cancel = Cancel::default();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        c2.cancel();
    });
    let start = std::time::Instant::now();
    let (msg, _) = turn(&server, ep(&server, ProviderId::Custom, "x"), &cfg(), dir.path(), &[], &send("Go"), &cancel);
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(msg.stopped);
    assert!(msg.error.is_none());
    assert!(msg.text.starts_with("w0 "), "{}", msg.text);
}

#[test]
fn provider_errors_are_recorded_without_the_key() {
    let server = MockServer::start(vec![Canned::json(401, json!({"error": {"message": format!("bad key {KEY}")}}))]);
    let dir = project();
    let (msg, _) = turn(&server, ep(&server, ProviderId::Custom, "x"), &cfg(), dir.path(), &[], &send("Hi"), &Cancel::default());
    let err = msg.error.expect("an error");
    assert_eq!(err.kind, "badKey");
    assert!(!err.message.contains("TESTKEY"));
    assert!(!serde_json::to_string(&msg.notices).unwrap().contains("TESTKEY"));
}

#[test]
fn earlier_turns_are_sent_as_history() {
    let server = MockServer::start(vec![oa_text("Second answer.")]);
    let dir = project();
    let mut q = ChatMessage::new(ChatRole::User, "First question");
    q.context_text = "<file path=\"main.tex\">old</file>".into();
    let a = ChatMessage::new(ChatRole::Assistant, "First answer.");
    let (msg, _) = turn(
        &server,
        ep(&server, ProviderId::Custom, "x"),
        &cfg(),
        dir.path(),
        &[q, a],
        &send("Follow-up"),
        &Cancel::default(),
    );
    assert_eq!(msg.text, "Second answer.");
    let body = server.recorded()[0].json();
    let msgs = body["messages"].as_array().unwrap();
    let roles: Vec<&str> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, vec!["system", "user", "assistant", "user"]);
    let users = user_texts(&body);
    assert!(users[0].contains("<file path=\"main.tex\">old</file>"), "earlier context is kept");
    assert!(users[1].ends_with("Follow-up"));
}

#[test]
fn attachments_are_encoded() {
    let server = MockServer::start(vec![oa_text("A red dot.")]);
    let dir = project();
    let mut req = send("What is this?");
    req.attachments = vec![
        AttachmentIn { name: "dot.png".into(), mime: "image/png".into(), text: None, data_url: Some(PNG.into()) },
        AttachmentIn { name: "notes.txt".into(), mime: "text/plain".into(), text: Some("my \"notes\"".into()), data_url: None },
    ];
    req.mentions = vec!["@main.tex".into()];
    req.current_file = Some(CurrentFile {
        file: "main.tex".into(),
        text: None,
        selection: Some(Selection { start_line: 3, end_line: 3, text: "Hello".into() }),
    });
    let (msg, _) = turn(&server, ep(&server, ProviderId::Custom, "some-vl-model"), &cfg(), dir.path(), &[], &req, &Cancel::default());
    assert_eq!(msg.text, "A red dot.");
    let body = server.recorded()[0].json();
    let user = body["messages"].as_array().unwrap().iter().find(|m| m["role"] == "user").unwrap().clone();
    let parts = user["content"].as_array().unwrap();
    let text = parts[0]["text"].as_str().unwrap();
    assert!(text.contains("<selection file=\"main.tex\" lines=\"3-3\">\nHello\n</selection>"), "{text}");
    assert!(text.contains("<file path=\"main.tex\">"), "the mention");
    assert!(text.contains("<attachment name=\"notes.txt\">\nmy \"notes\"\n</attachment>"));
    assert!(text.ends_with("What is this?"));
    let image = parts.iter().find(|p| p["type"] == "image_url").expect("image part");
    assert_eq!(image["image_url"]["url"], PNG);
}

#[test]
fn pictures_are_described_for_a_model_that_cannot_see() {
    let server = MockServer::start(vec![oa_text("1. A red dot on white."), oa_text("It's a red dot.")]);
    let dir = project();
    let mut req = send("What is this?");
    req.attachments = vec![AttachmentIn { name: "dot.png".into(), mime: "image/png".into(), text: None, data_url: Some(PNG.into()) }];
    let c = TurnConfig { vision: Some(VisionHelper { model: "vision/model-vl".into(), fallbacks: vec![] }), ..cfg() };
    let (msg, _) = turn(
        &server,
        ep(&server, ProviderId::Nvidia, "nvidia/nemotron-3.5-lightning-30b-a3b"),
        &c,
        dir.path(),
        &[],
        &req,
        &Cancel::default(),
    );
    assert_eq!(msg.text, "It's a red dot.");
    assert!(msg.notices.iter().any(|n| n.contains("described them first")), "{:?}", msg.notices);
    let rec = server.recorded();
    assert_eq!(rec[0].json()["model"], "vision/model-vl");
    assert!(rec[0].body.contains("image_url"));
    let chat = rec[1].json();
    assert_eq!(chat["model"], "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert!(!rec[1].body.contains("image_url"), "no picture data for the blind model");
    assert!(user_texts(&chat)[0].contains("A red dot on white."));
}

#[test]
fn prepare_checks_the_message() {
    let dir = project();
    assert!(prepare(dir.path(), &send("   ")).is_err());
    let mut r = send("x");
    r.attachments = vec![AttachmentIn { name: "a.exe".into(), mime: "application/octet-stream".into(), text: None, data_url: None }];
    assert!(prepare(dir.path(), &r).unwrap_err().message.contains("can't read"));
    r.attachments = vec![AttachmentIn { name: "a.bmp".into(), mime: "image/bmp".into(), text: None, data_url: Some("data:image/bmp;base64,AAAA".into()) }];
    assert!(prepare(dir.path(), &r).is_err());
    r.attachments = vec![AttachmentIn { name: "a.png".into(), mime: "image/png".into(), text: None, data_url: Some("data:image/png;base64,@@@".into()) }];
    assert!(prepare(dir.path(), &r).is_err(), "not base64");
    r.attachments = vec![AttachmentIn { name: "a.jpg".into(), mime: "image/jpg".into(), text: None, data_url: Some("AAAA".into()) }];
    let p = prepare(dir.path(), &r).unwrap();
    assert_eq!(p.images, vec![Part::Image { mime: "image/jpeg".into(), data_url: "data:image/jpeg;base64,AAAA".into() }]);
    assert_eq!(p.user.attachments[0].kind, AttachmentKind::Image);
    r.attachments = (0..11).map(|i| AttachmentIn { name: format!("{i}.txt"), mime: "text/plain".into(), text: Some("t".into()), data_url: None }).collect();
    assert!(prepare(dir.path(), &r).is_err());

    // Mentions that can't be read become notes, not errors; .texo is refused.
    let mut r = send("x");
    r.mentions = vec!["missing.tex".into(), ".texo/ai/memory.md".into(), "main.tex".into(), "main.tex".into()];
    r.dirty_buffers = vec![DirtyBuffer { file: "main.tex".into(), text: "UNSAVED".into() }];
    let p = prepare(dir.path(), &r).unwrap();
    assert_eq!(p.notices.len(), 2, "{:?}", p.notices);
    assert_eq!(p.user.context.len(), 1);
    assert!(p.user.context_text.contains("UNSAVED"), "unsaved editor text wins");
}
