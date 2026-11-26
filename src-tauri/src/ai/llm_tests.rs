//! Tests for the LLM layer against the local mock server (no network).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::ai::llm_wire::{self as wire};
use crate::ai::mock::{runtime, Canned, MockServer};

const KEY: &str = "nvapi-TESTKEY-0123456789abcdef";

fn ep(server: &MockServer, provider: ProviderId, model: &str) -> Endpoint {
    Endpoint {
        provider,
        label: "Test AI".into(),
        base_url: format!("{}/v1", server.base_url),
        key: Some(ApiKey::new(KEY.into())),
        model: model.into(),
    }
}

fn fast() -> RetryPolicy {
    RetryPolicy { tries: 3, backoff: Duration::from_millis(1), max_wait: Duration::from_secs(60), rate_limit: false }
}

fn tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "read_file".into(),
            description: "Read a file".into(),
            parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
        },
        ToolSpec {
            name: "compile_check".into(),
            description: "Compile".into(),
            parameters: json!({"type": "object", "properties": {}}),
        },
    ]
}

fn req(messages: Vec<Msg>) -> LlmRequest {
    LlmRequest { system: "SYS".into(), messages, tools: tools(), policy: fast(), ..Default::default() }
}

fn oa_text(content: &str) -> Canned {
    Canned::json(
        200,
        json!({"model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
               "usage": {"prompt_tokens": 11, "completion_tokens": 7}}),
    )
}

fn oa_calls(calls: Value, finish: &str) -> Canned {
    Canned::json(
        200,
        json!({"model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": null, "tool_calls": calls}, "finish_reason": finish}]}),
    )
}

fn client() -> reqwest::Client {
    build_client(false).unwrap()
}

fn sample_history() -> Vec<Msg> {
    let call = ToolCall { id: "call_1".into(), name: "read_file".into(), arguments: json!({"path": "main.tex"}), invalid_arguments: None };
    vec![
        Msg::User {
            content: vec![
                Part::Text { text: "Fix this".into() },
                Part::Image { mime: "image/png".into(), data_url: "data:image/png;base64,AAAA".into() },
            ],
        },
        Msg::Assistant { text: "Looking.".into(), tool_calls: vec![call.clone()], replay: None },
        Msg::tool_result(&call, "1: \\documentclass{article}", false),
    ]
}

// ------------------------------------------------------- bodies --

#[test]
fn openai_body_has_tools_images_and_tool_messages() {
    let server = MockServer::start(vec![]);
    let e = ep(&server, ProviderId::Groq, "openai/gpt-oss-120b");
    let mut r = req(sample_history());
    r.tool_choice = ToolChoice::Required;
    let b = wire::openai_body(&e, &r, &Adapt::default(), false);
    assert_eq!(b["model"], "openai/gpt-oss-120b");
    assert_eq!(b["max_tokens"], 8192);
    assert_eq!(b["stream"], false);
    assert!(b.get("temperature").is_none());
    assert!(b.get("chat_template_kwargs").is_none());
    assert_eq!(b["tool_choice"], "required");
    assert_eq!(b["tools"][0]["type"], "function");
    assert_eq!(b["tools"][0]["function"]["name"], "read_file");
    let m = b["messages"].as_array().unwrap();
    assert_eq!(m[0], json!({"role": "system", "content": "SYS"}));
    assert_eq!(m[1]["content"][0], json!({"type": "text", "text": "Fix this"}));
    assert_eq!(m[1]["content"][1], json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}));
    assert_eq!(m[2]["role"], "assistant");
    assert_eq!(m[2]["tool_calls"][0]["id"], "call_1");
    assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], "{\"path\":\"main.tex\"}");
    assert_eq!(m[3], json!({"role": "tool", "tool_call_id": "call_1", "content": "1: \\documentclass{article}"}));
}

#[test]
fn nemotron_gets_chat_template_kwargs_and_inline_images_on_request() {
    let server = MockServer::start(vec![]);
    let e = ep(&server, ProviderId::Nvidia, "nvidia/nemotron-3-ultra-550b-a55b");
    let mut r = req(sample_history());
    r.thinking = true;
    let b = wire::openai_body(&e, &r, &Adapt::default(), true);
    assert_eq!(b["chat_template_kwargs"], json!({"enable_thinking": true, "force_nonempty_content": true}));
    assert_eq!(b["stream"], true);
    assert_eq!(b["stream_options"]["include_usage"], true);
    let a = Adapt { inline_images: true, max_tokens_cap: Some(4096), ..Adapt::default() };
    let b = wire::openai_body(&e, &r, &a, false);
    assert_eq!(b["messages"][1]["content"], "Fix this\n<img src=\"data:image/png;base64,AAAA\" />");
    assert_eq!(b["max_tokens"], 4096);
    // Not for other NVIDIA models, nor for Nemotron on other providers.
    let e2 = ep(&server, ProviderId::Nvidia, "moonshotai/kimi-k3.1-pro");
    assert!(wire::openai_body(&e2, &r, &Adapt::default(), false).get("chat_template_kwargs").is_none());
    let e3 = ep(&server, ProviderId::Openrouter, "nvidia/nemotron-3-ultra-550b-a55b:free");
    assert!(wire::openai_body(&e3, &r, &Adapt::default(), false).get("chat_template_kwargs").is_none());
}

#[test]
fn text_tools_body_moves_tools_into_the_prompt() {
    let server = MockServer::start(vec![]);
    let e = ep(&server, ProviderId::Nvidia, "some/model");
    let a = Adapt { text_tools: true, ..Adapt::default() };
    let b = wire::openai_body(&e, &req(sample_history()), &a, false);
    assert!(b.get("tools").is_none());
    assert!(b.get("tool_choice").is_none());
    let sys = b["messages"][0]["content"].as_str().unwrap();
    assert!(sys.starts_with("SYS"));
    assert!(sys.contains("Action: tool_name {"));
    assert!(sys.contains("- read_file: Read a file"));
    assert_eq!(b["messages"][2]["content"], "Looking.\nAction: read_file {\"path\":\"main.tex\"}");
    assert!(b["messages"][2].get("tool_calls").is_none());
    assert_eq!(b["messages"][3]["role"], "user");
    assert!(b["messages"][3]["content"].as_str().unwrap().starts_with("Observation: [read_file]"));
}

#[test]
fn react_requests_stop_before_an_invented_observation() {
    // F9: the model must not write its own tool results.
    let server = MockServer::start(vec![]);
    let a = Adapt { text_tools: true, ..Adapt::default() };
    let b = wire::openai_body(&ep(&server, ProviderId::Nvidia, "some/model"), &req(sample_history()), &a, false);
    assert_eq!(b["stop"], json!([wire::REACT_STOP]));
    let b = wire::anthropic_body(&ep(&server, ProviderId::Anthropic, "claude-opus-5-5"), &req(sample_history()), &a, false);
    assert_eq!(b["stop_sequences"], json!([wire::REACT_STOP]));
    // Native tools: no stop sequence.
    let b = wire::openai_body(&ep(&server, ProviderId::Nvidia, "some/model"), &req(sample_history()), &Adapt::default(), false);
    assert!(b.get("stop").is_none());
}

#[test]
fn last_react_round_offers_no_tools_and_hides_action_lines() {
    // F10: the answer-only round (tool_choice None) in ReAct mode.
    let server = MockServer::start(vec![oa_text("Here is what I found.
Action: read_file {\"path\": \"x.tex\"}")]);
    let e = ep(&server, ProviderId::Custom, "local/model");
    let a = Adapt { text_tools: true, ..Adapt::default() };
    let mut r = req(sample_history());
    r.tool_choice = ToolChoice::None;
    let b = wire::openai_body(&e, &r, &a, false);
    let sys = b["messages"][0]["content"].as_str().unwrap();
    assert!(!sys.contains("Available tools"), "{sys}");
    assert!(sys.contains("Don't use any more tools"));
    assert!(b.get("stop").is_none());
    // Earlier calls stay in the history as text.
    assert!(b["messages"][2]["content"].as_str().unwrap().contains("Action: read_file"));

    let mut session = LlmSession::new(e);
    session.adapt.text_tools = true;
    let reply = runtime().block_on(session.complete(&client(), &r, &Cancel::default(), None)).unwrap();
    assert_eq!(reply.text, "Here is what I found.");
    assert!(reply.tool_calls.is_empty());
}

#[test]
fn anthropic_body_follows_the_messages_api() {
    let server = MockServer::start(vec![]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let mut history = sample_history();
    // A second tool result in a row merges into the same user message.
    history.push(Msg::Tool { tool_call_id: "call:2".into(), name: "compile_check".into(), content: "failed".into(), is_error: true });
    history.push(Msg::user("go on"));
    let mut r = req(history);
    r.tool_choice = ToolChoice::Required;
    r.temperature = Some(0.7);
    let b = wire::anthropic_body(&e, &r, &Adapt::default(), false);
    assert_eq!(b["model"], "claude-opus-5-5");
    assert_eq!(b["max_tokens"], 16000);
    assert_eq!(b["system"], "SYS");
    assert_eq!(b["thinking"], json!({"type": "adaptive"}));
    assert_eq!(b["output_config"]["effort"], "medium");
    assert!(b.get("temperature").is_none());
    assert!(b.get("top_p").is_none());
    // Forcing a tool doesn't mix with thinking.
    assert_eq!(b["tool_choice"], json!({"type": "auto"}));
    assert_eq!(b["tools"][0]["input_schema"]["required"][0], "path");
    let m = b["messages"].as_array().unwrap();
    assert_eq!(m.len(), 3);
    assert_eq!(m[0]["content"][1], json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}));
    assert_eq!(m[1]["content"][1]["type"], "tool_use");
    assert_eq!(m[1]["content"][1]["input"], json!({"path": "main.tex"}));
    let results = m[2]["content"].as_array().unwrap();
    assert_eq!(results[0]["tool_use_id"], "call_1");
    assert_eq!(results[1]["tool_use_id"], "call_2");
    assert_eq!(results[1]["is_error"], true);
    assert_eq!(results[2], json!({"type": "text", "text": "go on"}));

    let mut r2 = r.clone();
    r2.thinking = true;
    r2.effort = None;
    assert_eq!(wire::anthropic_body(&e, &r2, &Adapt::default(), false)["output_config"]["effort"], "high");
    r2.effort = Some("low".into());
    assert_eq!(wire::anthropic_body(&e, &r2, &Adapt::default(), true)["output_config"]["effort"], "low");
    let plain = wire::anthropic_body(&e, &r, &Adapt { plain_anthropic: true, ..Adapt::default() }, true);
    assert!(plain.get("thinking").is_none());
    assert!(plain.get("output_config").is_none());
    assert_eq!(plain["tool_choice"], json!({"type": "any"}));
    assert_eq!(plain["stream"], true);
}

#[test]
fn anthropic_replay_is_sent_back_only_to_the_same_model() {
    let server = MockServer::start(vec![]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let blocks = json!([{"type": "thinking", "thinking": "t", "signature": "sig"}, {"type": "text", "text": "Hi"}]);
    let msg = |model: &str| Msg::Assistant {
        text: "Hi".into(),
        tool_calls: vec![],
        replay: Some(Replay { model: model.into(), blocks: blocks.clone() }),
    };
    let r = req(vec![Msg::user("a"), msg("claude-opus-5-5")]);
    assert_eq!(wire::anthropic_body(&e, &r, &Adapt::default(), false)["messages"][1]["content"], blocks);
    let r = req(vec![Msg::user("a"), msg("claude-opus-5")]);
    assert_eq!(wire::anthropic_body(&e, &r, &Adapt::default(), false)["messages"][1]["content"], json!([{"type": "text", "text": "Hi"}]));
}

#[test]
fn json_mode_uses_structured_output_where_supported() {
    let server = MockServer::start(vec![]);
    let schema = json!({"type": "object", "properties": {"a": {"type": "string"}}});
    let mut r = LlmRequest { system: "S".into(), messages: vec![Msg::user("u")], json: Some(schema.clone()), ..Default::default() };
    let b = wire::openai_body(&ep(&server, ProviderId::Openrouter, "x"), &r, &Adapt::default(), false);
    assert_eq!(b["response_format"]["type"], "json_schema");
    assert_eq!(b["response_format"]["json_schema"]["schema"], schema);
    let b = wire::openai_body(&ep(&server, ProviderId::Groq, "x"), &r, &Adapt::default(), false);
    assert_eq!(b["response_format"]["type"], "json_object");
    let b = wire::openai_body(&ep(&server, ProviderId::Nvidia, "x"), &r, &Adapt::default(), false);
    assert!(b.get("response_format").is_none());
    assert!(b["messages"][0]["content"].as_str().unwrap().contains("JSON Schema"));
    let b = wire::anthropic_body(&ep(&server, ProviderId::Anthropic, "claude-opus-5-5"), &r, &Adapt::default(), false);
    assert_eq!(b["output_config"]["format"]["type"], "json_schema");
    // With tools, structured output is left to the prompt.
    r.tools = tools();
    let b = wire::openai_body(&ep(&server, ProviderId::Openrouter, "x"), &r, &Adapt::default(), false);
    assert!(b.get("response_format").is_none());
}

// ---------------------------------------------- round trips (OpenAI) --

#[test]
fn native_tool_calls_with_doubled_names_and_broken_json() {
    let server = MockServer::start(vec![oa_calls(
        json!([
            {"id": "a1", "type": "function", "function": {"name": "read_fileread_file", "arguments": "{\"path\": \"main.tex\",}"}},
            {"id": "", "type": "function", "function": {"name": "compile_check", "arguments": ""}},
            {"id": "a1", "type": "function", "function": {"name": "read_file", "arguments": "{{nope"}},
        ]),
        "tool_calls",
    )]);
    let e = ep(&server, ProviderId::Nvidia, "some/model");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.stop, StopReason::ToolUse);
    assert_eq!(reply.tool_calls.len(), 3);
    assert_eq!(reply.tool_calls[0].name, "read_file");
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "main.tex"}));
    assert_eq!(reply.tool_calls[1].arguments, json!({}));
    assert_eq!(reply.tool_calls[1].id.len(), 9);
    // Duplicate id replaced, unreadable arguments reported.
    assert_ne!(reply.tool_calls[2].id, "a1");
    assert_eq!(reply.tool_calls[2].invalid_arguments.as_deref(), Some("{{nope"));
    let rec = &server.recorded()[0];
    assert_eq!(rec.path, "/v1/chat/completions");
    assert_eq!(rec.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
}

#[test]
fn text_tool_calls_and_thinking_are_cleaned_up() {
    let server = MockServer::start(vec![Canned::json(
        200,
        json!({"choices": [{"message": {
            "role": "assistant",
            "reasoning_content": "secret chain of thought",
            "content": "<think>plan</think>I'll check.\n<tool_call>{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.tex\"}}</tool_call>"
        }, "finish_reason": "stop"}]}),
    )]);
    let e = ep(&server, ProviderId::Nvidia, "some/model");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.text, "I'll check.");
    assert!(!reply.text.contains("secret"));
    assert_eq!(reply.tool_calls[0].name, "read_file");
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "a.tex"}));
    assert!(!reply.tool_calls[0].id.is_empty());
    assert_eq!(reply.model, "some/model");
    // The assistant message for the history keeps the calls.
    match reply.to_msg() {
        Msg::Assistant { tool_calls, .. } => assert_eq!(tool_calls.len(), 1),
        _ => panic!(),
    }
}

#[test]
fn empty_200_is_retried() {
    let server = MockServer::start(vec![
        oa_text(""),
        Canned::json(200, json!({"choices": []})),
        oa_text("<think>only thinking</think>"),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "some/model");
    let err = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::BadResponse);
    assert!(err.message.contains("empty"));
    assert_eq!(server.recorded().len(), 3);

    let server = MockServer::start(vec![oa_text("   "), oa_text("Done.")]);
    let e = ep(&server, ProviderId::Nvidia, "some/model");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.text, "Done.");
    assert_eq!(reply.stop, StopReason::EndTurn);
    assert_eq!(reply.usage, Usage { input_tokens: 11, output_tokens: 7 });
    assert!(matches!(reply.notices[0], Notice::Retrying { attempt: 2, .. }));
}

#[test]
fn rate_limits_retry_then_switch_to_the_fallback_model() {
    let limited = || Canned::json(429, json!({"error": {"message": "slow down"}}));
    let server = MockServer::start(vec![
        limited().header("retry-after", "0"),
        limited(),
        limited(),
        oa_text("from fallback"),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "nvidia/nemotron-3-ultra-550b-a55b");
    let mut r = req(vec![Msg::user("hi")]);
    r.fallback_models = vec!["nvidia/nemotron-3-ultra-550b-a55b".into(), "moonshotai/kimi-k3.1-pro".into()];
    let mut session = LlmSession::new(e);
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let mut sink = move |e: StreamEvent| ev2.lock().unwrap().push(e);
    let reply = runtime().block_on(session.complete(&client(), &r, &Cancel::default(), Some(&mut sink))).unwrap();
    assert_eq!(reply.text, "from fallback");
    assert_eq!(reply.model, "m");
    assert_eq!(session.model(), "moonshotai/kimi-k3.1-pro");
    let switched: Vec<&Notice> = reply.notices.iter().filter(|n| matches!(n, Notice::ModelSwitched { .. })).collect();
    assert_eq!(switched.len(), 1);
    match switched[0] {
        Notice::ModelSwitched { from, to, reason } => {
            assert_eq!(from, "nvidia/nemotron-3-ultra-550b-a55b");
            assert_eq!(to, "moonshotai/kimi-k3.1-pro");
            assert!(reason.contains("limiting"));
        }
        _ => unreachable!(),
    }
    assert!(switched[0].message().starts_with("Switched from"));
    assert!(events.lock().unwrap().iter().any(|e| matches!(e, StreamEvent::Notice(Notice::ModelSwitched { .. }))));
    let recs = server.recorded();
    assert_eq!(recs.len(), 4);
    assert_eq!(recs[2].json()["model"], "nvidia/nemotron-3-ultra-550b-a55b");
    assert_eq!(recs[3].json()["model"], "moonshotai/kimi-k3.1-pro");
    // The Nemotron-only kwargs went away with the switch.
    assert!(recs[3].json().get("chat_template_kwargs").is_none());
}

#[test]
fn long_retry_after_gives_up_without_waiting() {
    let server = MockServer::start(vec![Canned::json(429, json!({"error": {"message": "slow"}})).header("retry-after", "3600")]);
    let e = ep(&server, ProviderId::Groq, "x");
    let start = std::time::Instant::now();
    let err = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::RateLimited);
    assert_eq!(err.retry_after_secs, Some(3600));
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn server_errors_without_fallback_fail_after_three_tries() {
    let e500 = || Canned::json(503, json!({"error": {"message": format!("down {KEY}")}}));
    let server = MockServer::start(vec![e500(), e500(), e500()]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let err = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::Server);
    assert!(!err.message.contains(KEY));
    assert_eq!(server.recorded().len(), 3);
}

#[test]
fn broken_connections_retry_but_never_switch_model() {
    // A body shorter than its content-length: the connection drops mid-reply.
    let broken = || Canned::json(200, json!({"x": 1})).header("content-length", "5000");
    let server = MockServer::start(vec![broken(), broken(), broken(), oa_text("never reached")]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let mut r = req(vec![Msg::user("hi")]);
    r.fallback_models = vec!["other/model".into()];
    let err = runtime().block_on(complete(&client(), &e, r, &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::Network, "{err:?}");
    let recs = server.recorded();
    assert_eq!(recs.len(), 3);
    assert!(recs.iter().all(|r| r.json()["model"] == "x"));
}

#[test]
fn unknown_model_switches_immediately() {
    let server = MockServer::start(vec![
        Canned::json(404, json!({"error": {"message": "model not found"}})),
        oa_text("ok"),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "gone/model");
    let mut r = req(vec![Msg::user("hi")]);
    r.fallback_models = vec!["other/model".into()];
    let reply = runtime().block_on(complete(&client(), &e, r, &Cancel::default())).unwrap();
    assert_eq!(reply.text, "ok");
    assert!(matches!(&reply.notices[0], Notice::ModelSwitched { to, .. } if to == "other/model"));
    assert_eq!(server.recorded().len(), 2);
}

#[test]
fn a_400_about_tools_switches_the_session_to_react() {
    let server = MockServer::start(vec![
        Canned::json(400, json!({"error": {"message": "This model does not support tools"}})),
        oa_text("Let me look.\nAction: read_file {\"path\": \"main.tex\"}"),
        oa_text("All done."),
    ]);
    let e = ep(&server, ProviderId::Custom, "local/model");
    let mut session = LlmSession::new(e);
    let c = client();
    let rt = runtime();
    let mut r = req(vec![Msg::user("hi")]);
    let reply = rt.block_on(session.complete(&c, &r, &Cancel::default(), None)).unwrap();
    assert!(reply.text_tools);
    assert!(session.text_tools());
    assert_eq!(reply.notices, vec![Notice::TextTools]);
    assert_eq!(reply.text, "Let me look.");
    assert_eq!(reply.tool_calls[0].name, "read_file");
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "main.tex"}));
    r.messages.push(reply.to_msg());
    r.messages.push(Msg::tool_result(&reply.tool_calls[0], "1: hello", false));
    let reply2 = rt.block_on(session.complete(&c, &r, &Cancel::default(), None)).unwrap();
    assert_eq!(reply2.text, "All done.");
    let recs = server.recorded();
    assert!(recs[0].json().get("tools").is_some());
    assert!(recs[1].json().get("tools").is_none());
    let third = recs[2].json();
    assert!(third.get("tools").is_none());
    let msgs = third["messages"].as_array().unwrap();
    assert_eq!(msgs[2]["content"], "Let me look.\nAction: read_file {\"path\":\"main.tex\"}");
    assert!(msgs[3]["content"].as_str().unwrap().starts_with("Observation: [read_file]\n1: hello"));
}

#[test]
fn max_tokens_falls_back_to_4096() {
    let server = MockServer::start(vec![
        Canned::json(400, json!({"error": {"message": "max_tokens must be less than or equal to 4096"}})),
        oa_text("ok"),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.notices, vec![Notice::MaxTokensLowered { from: 8192, to: 4096 }]);
    let recs = server.recorded();
    assert_eq!(recs[0].json()["max_tokens"], 8192);
    assert_eq!(recs[1].json()["max_tokens"], 4096);
}

#[test]
fn rejected_image_parts_are_retried_inline() {
    let server = MockServer::start(vec![
        Canned::json(400, json!({"error": {"message": "Input should be a valid string"}})),
        oa_text("I see a figure."),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let mut r = req(vec![sample_history().remove(0)]);
    r.tools.clear();
    let reply = runtime().block_on(complete(&client(), &e, r, &Cancel::default())).unwrap();
    assert_eq!(reply.notices, vec![Notice::ImagesInline]);
    let recs = server.recorded();
    assert!(recs[0].json()["messages"][1]["content"].is_array());
    assert_eq!(recs[1].json()["messages"][1]["content"], "Fix this\n<img src=\"data:image/png;base64,AAAA\" />");
}

#[test]
fn other_400s_fail_with_a_sanitized_message() {
    let server = MockServer::start(vec![Canned::json(400, json!({"error": {"message": format!("bad request for key {KEY}")}}))]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let mut r = req(vec![Msg::user("hi")]);
    r.tools.clear();
    let err = runtime().block_on(complete(&client(), &e, r, &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::BadRequest);
    assert!(!err.message.contains(KEY), "{}", err.message);
    assert!(!format!("{err:?}").contains(KEY));
    assert_eq!(server.recorded().len(), 1);
}

#[test]
fn openrouter_error_inside_a_200_is_retried() {
    let server = MockServer::start(vec![
        Canned::json(200, json!({"error": {"code": 429, "message": "upstream rate limited"}})),
        oa_text("fine"),
    ]);
    let e = ep(&server, ProviderId::Openrouter, "x:free");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.text, "fine");
    assert_eq!(server.recorded()[0].header("x-openrouter-title"), Some("Texo"));
}

#[test]
fn cut_off_tool_calls_come_back_marked_and_never_runnable() {
    // F1: a write cut off at the output limit is handed back as a cut-off
    // call (so the caller tells the model to make smaller calls), not an
    // error that ends the run.
    let server = MockServer::start(vec![oa_calls(
        json!([{"id": "a", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\": \"ma"}}]),
        "length",
    )]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.stop, StopReason::ToolUse);
    let call = &reply.tool_calls[0];
    assert!(call.cut_off());
    assert_eq!(call.arguments, json!({}));
    assert!(call.invalid_message().contains("cut off"));
    assert!(call.invalid_message().contains("edit_file"));

    let server = MockServer::start(vec![Canned::json(
        200,
        json!({"choices": [{"message": {"content": "A long answer that"}, "finish_reason": "length"}]}),
    )]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.stop, StopReason::MaxTokens);
}

#[test]
fn reasoning_that_uses_up_the_limit_is_retried_with_less_thinking() {
    // F1: Nemotron thinking used the whole budget and wrote nothing.
    let empty_cut = || Canned::json(200, json!({"choices": [{"message": {"content": "", "reasoning_content": "long"}, "finish_reason": "length"}]}));
    let server = MockServer::start(vec![empty_cut(), oa_text("Short answer.")]);
    let e = ep(&server, ProviderId::Nvidia, "nvidia/nemotron-3-ultra-550b-a55b");
    let mut r = req(vec![Msg::user("hi")]);
    r.thinking = true;
    let mut session = LlmSession::new(e);
    let reply = runtime().block_on(session.complete(&client(), &r, &Cancel::default(), None)).unwrap();
    assert_eq!(reply.text, "Short answer.");
    assert_eq!(reply.notices, vec![Notice::LessThinking]);
    let recs = server.recorded();
    assert_eq!(recs[0].json()["chat_template_kwargs"]["enable_thinking"], true);
    assert_eq!(recs[1].json()["chat_template_kwargs"]["enable_thinking"], false);
    // Less thinking is for one request only.
    let server2 = MockServer::start(vec![oa_text("next")]);
    session = LlmSession::new(ep(&server2, ProviderId::Nvidia, "nvidia/nemotron-3-ultra-550b-a55b"));
    runtime().block_on(session.complete(&client(), &r, &Cancel::default(), None)).unwrap();
    assert_eq!(server2.recorded()[0].json()["chat_template_kwargs"]["enable_thinking"], true);

    // Still nothing after the retry: the next model is tried.
    let server = MockServer::start(vec![empty_cut(), empty_cut(), oa_text("from fallback")]);
    let e = ep(&server, ProviderId::Nvidia, "nvidia/nemotron-3-ultra-550b-a55b");
    r.fallback_models = vec!["moonshotai/kimi-k3.1-pro".into()];
    let reply = runtime().block_on(complete(&client(), &e, r.clone(), &Cancel::default())).unwrap();
    assert_eq!(reply.text, "from fallback");
    assert!(reply.notices.iter().any(|n| matches!(n, Notice::ModelSwitched { .. })));
}

#[test]
fn half_finished_tool_arguments_never_run() {
    // F3: an unterminated string must not be "repaired" into a short file.
    let (args, invalid) = wire::parse_args(wire::RawArgs::Text("{\"path\":\"main.tex\",\"text\":\"\\documentclass".into()));
    assert_eq!(args, json!({}));
    assert!(invalid.is_some());
    // Missing closing braces alone are still repaired.
    let (args, invalid) = wire::parse_args(wire::RawArgs::Text("{\"path\": \"a.tex\"".into()));
    assert_eq!(args, json!({"path": "a.tex"}));
    assert!(invalid.is_none());
}

#[test]
fn json_answers_are_parsed() {
    let server = MockServer::start(vec![oa_text("```json\n{\"verdict\": \"ok\",}\n```")]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let r = LlmRequest { messages: vec![Msg::user("u")], json: Some(json!({"type": "object"})), policy: fast(), ..Default::default() };
    let reply = runtime().block_on(complete(&client(), &e, r, &Cancel::default())).unwrap();
    assert_eq!(reply.json, Some(json!({"verdict": "ok"})));
}

// ------------------------------------------------------- streaming --

fn chunk(delta: Value, finish: Option<&str>) -> String {
    json!({"model": "m", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}).to_string()
}

fn collect() -> (Arc<Mutex<Vec<StreamEvent>>>, impl FnMut(StreamEvent) + Send) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    (events, move |e: StreamEvent| ev2.lock().unwrap().push(e))
}

/// Replays the events the way the UI does.
fn shown(events: &[StreamEvent]) -> String {
    let mut s = String::new();
    for e in events {
        match e {
            StreamEvent::Text(t) => s.push_str(t),
            StreamEvent::Reset => s.clear(),
            StreamEvent::Notice(_) => {}
        }
    }
    s
}

#[test]
fn openai_stream_with_thinking_text_and_tool_call_deltas() {
    let server = MockServer::start(vec![Canned::sse(vec![
        chunk(json!({"role": "assistant", "reasoning_content": "hidden"}), None),
        chunk(json!({"content": "<thi"}), None),
        chunk(json!({"content": "nk>plan</think>"}), None),
        chunk(json!({"content": "Reading "}), None),
        chunk(json!({"content": "the file."}), None),
        chunk(json!({"tool_calls": [{"index": 0, "id": "c1", "type": "function", "function": {"name": "read_file", "arguments": ""}}]}), None),
        // A server that repeats the name in every chunk.
        chunk(json!({"tool_calls": [{"index": 0, "function": {"name": "read_file", "arguments": "{\"pa"}}]}), None),
        chunk(json!({"tool_calls": [{"index": 0, "function": {"arguments": "th\": \"main.tex\"}"}}]}), None),
        chunk(json!({}), Some("tool_calls")),
        json!({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 9}}).to_string(),
        "[DONE]".into(),
    ])
    .chunk_delay(5)]);
    let e = ep(&server, ProviderId::Nvidia, "nvidia/nemotron-3.5-lightning-30b-a3b");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "Reading the file.");
    assert_eq!(reply.tool_calls.len(), 1);
    assert_eq!(reply.tool_calls[0].id, "c1");
    assert_eq!(reply.tool_calls[0].name, "read_file");
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "main.tex"}));
    assert_eq!(reply.usage, Usage { input_tokens: 5, output_tokens: 9 });
    let events = events.lock().unwrap();
    assert_eq!(shown(&events), "Reading the file.");
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::Text(t) if t.contains("plan") || t.contains("<"))));
    assert!(events.iter().filter(|e| matches!(e, StreamEvent::Text(_))).count() >= 2);
    let body = server.recorded()[0].json();
    assert_eq!(body["stream"], true);
    assert_eq!(server.recorded()[0].header("accept"), Some("text/event-stream"));
}

#[test]
fn streamed_text_tool_call_is_hidden_and_parsed() {
    let server = MockServer::start(vec![Canned::sse(vec![
        chunk(json!({"content": "Checking. <tool"}), None),
        chunk(json!({"content": "_call>{\"name\": \"compile_check\", \"arguments\": {}}</tool_call>"}), Some("stop")),
        "[DONE]".into(),
    ])]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.tool_calls[0].name, "compile_check");
    assert_eq!(reply.text, "Checking.");
    assert_eq!(shown(&events.lock().unwrap()), "Checking.");
}

#[test]
fn server_that_ignores_stream_still_works() {
    let server = MockServer::start(vec![oa_text("whole answer")]);
    let e = ep(&server, ProviderId::Gemini, "gemini-9-flash");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "whole answer");
    assert_eq!(shown(&events.lock().unwrap()), "whole answer");
}

#[test]
fn stream_refused_falls_back_to_a_plain_request() {
    let server = MockServer::start(vec![
        Canned::json(400, json!({"error": {"message": "stream_options is not supported"}})),
        oa_text("plain answer"),
    ]);
    let e = ep(&server, ProviderId::Custom, "x");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "plain answer");
    assert_eq!(reply.notices, vec![Notice::StreamingOff]);
    let recs = server.recorded();
    assert_eq!(recs[0].json()["stream"], true);
    assert_eq!(recs[1].json()["stream"], false);
    assert_eq!(shown(&events.lock().unwrap()), "plain answer");
}

#[test]
fn error_inside_a_stream_is_retried_and_the_ui_reset() {
    let server = MockServer::start(vec![
        Canned::sse(vec![
            chunk(json!({"content": "Partial "}), None),
            json!({"error": {"code": 503, "message": "overloaded"}}).to_string(),
        ]),
        Canned::sse(vec![chunk(json!({"content": "Fresh answer"}), Some("stop")), "[DONE]".into()]),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "Fresh answer");
    let events = events.lock().unwrap();
    assert!(events.contains(&StreamEvent::Reset));
    assert_eq!(shown(&events), "Fresh answer");
}

#[test]
fn a_stream_that_stops_without_finishing_is_never_used() {
    // F3: no finish_reason and no [DONE]: half a write_file must not run.
    let server = MockServer::start(vec![
        Canned::sse(vec![
            chunk(json!({"tool_calls": [{"index": 0, "id": "w", "function": {"name": "read_file", "arguments": "{\"path\": \"main"}}]}), None),
        ]),
        Canned::sse(vec![chunk(json!({"content": "Whole answer"}), Some("stop")), "[DONE]".into()]),
    ]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "Whole answer");
    assert!(reply.tool_calls.is_empty());
    assert!(reply.notices.iter().any(|n| matches!(n, Notice::Retrying { .. })));
    assert_eq!(shown(&events.lock().unwrap()), "Whole answer");
    assert_eq!(server.recorded().len(), 2);
}

#[test]
fn vllm_error_objects_are_errors_not_answers() {
    // F3: `{"object": "error"}` mid-stream, then [DONE].
    let server = MockServer::start(vec![
        Canned::sse(vec![
            chunk(json!({"content": "Half an ans"}), None),
            json!({"object": "error", "message": "internal error", "code": 500}).to_string(),
            "[DONE]".into(),
        ]),
        Canned::sse(vec![chunk(json!({"content": "Fine"}), Some("stop")), "[DONE]".into()]),
    ]);
    let e = ep(&server, ProviderId::Custom, "x");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "Fine");
    assert_eq!(shown(&events.lock().unwrap()), "Fine");
    // The same shape in a whole (non-streamed) body.
    let server = MockServer::start(vec![
        Canned::json(200, json!({"object": "error", "message": "overloaded", "code": 503})),
        oa_text("ok"),
    ]);
    let e = ep(&server, ProviderId::Custom, "x");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.text, "ok");
}

#[test]
fn streamed_calls_without_index_stay_separate() {
    // F4: each call in its own chunk at position 0, no `index`.
    let server = MockServer::start(vec![Canned::sse(vec![
        chunk(json!({"tool_calls": [{"id": "c1", "function": {"name": "read_file", "arguments": "{\"path\": \"a.tex\"}"}}]}), None),
        chunk(json!({"tool_calls": [{"id": "c2", "function": {"name": "read_file", "arguments": "{\"path\": \"b.tex\"}"}}]}), None),
        chunk(json!({"tool_calls": [{"id": "c3", "function": {"name": "compile_check", "arguments": "{}"}}]}), Some("tool_calls")),
        "[DONE]".into(),
    ])]);
    let e = ep(&server, ProviderId::Gemini, "gemini-9-flash");
    let (_events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    let names: Vec<&str> = reply.tool_calls.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["read_file", "read_file", "compile_check"]);
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "a.tex"}));
    assert_eq!(reply.tool_calls[1].arguments, json!({"path": "b.tex"}));
    assert_eq!(reply.tool_calls[1].id, "c2");

    // Without ids either: a new name after a whole argument object.
    let server = MockServer::start(vec![Canned::sse(vec![
        chunk(json!({"tool_calls": [{"function": {"name": "read_file", "arguments": "{\"path\": "}}]}), None),
        chunk(json!({"tool_calls": [{"function": {"arguments": "\"a.tex\"}"}}]}), None),
        chunk(json!({"tool_calls": [{"function": {"name": "compile_check", "arguments": "{}"}}]}), Some("tool_calls")),
        "[DONE]".into(),
    ])]);
    let e = ep(&server, ProviderId::Custom, "x");
    let (_events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    let names: Vec<&str> = reply.tool_calls.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["read_file", "compile_check"]);
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "a.tex"}));
}

#[test]
fn cancel_stops_a_stream() {
    let many: Vec<String> = (0..200).map(|i| chunk(json!({"content": format!("w{i} ")}), None)).collect();
    let server = MockServer::start(vec![Canned::sse(many).chunk_delay(20)]);
    let e = ep(&server, ProviderId::Nvidia, "x");
    let cancel = Cancel::default();
    let c2 = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        c2.cancel();
    });
    let (_events, mut sink) = collect();
    let start = std::time::Instant::now();
    let err = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &cancel, &mut sink)).unwrap_err();
    assert_eq!(err.kind, Kind::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(2));
}

// ------------------------------------------------------- Anthropic --

#[test]
fn anthropic_tool_use_round_trip() {
    let server = MockServer::start(vec![Canned::json(
        200,
        json!({"model": "claude-opus-5-5", "stop_reason": "tool_use",
               "content": [
                 {"type": "thinking", "thinking": "", "signature": "SIG"},
                 {"type": "text", "text": "Let me check."},
                 {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "main.tex"}}],
               "usage": {"input_tokens": 100, "cache_read_input_tokens": 20, "output_tokens": 30}}),
    )]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.stop, StopReason::ToolUse);
    assert_eq!(reply.text, "Let me check.");
    assert_eq!(reply.tool_calls[0].id, "toolu_1");
    assert_eq!(reply.usage, Usage { input_tokens: 120, output_tokens: 30 });
    let replay = reply.replay.clone().unwrap();
    assert_eq!(replay.model, "claude-opus-5-5");
    assert_eq!(replay.blocks[0]["signature"], "SIG");
    assert_eq!(replay.blocks.as_array().unwrap().len(), 3);
    let rec = &server.recorded()[0];
    assert_eq!(rec.path, "/v1/messages");
    assert_eq!(rec.header("x-api-key"), Some(KEY));
    assert_eq!(rec.header("anthropic-version"), Some(crate::ai::anthropic::API_VERSION));
    assert!(rec.header("authorization").is_none());
}

#[test]
fn anthropic_refusal_and_truncation() {
    let server = MockServer::start(vec![Canned::json(
        200,
        json!({"stop_reason": "refusal", "content": [{"type": "text", "text": "partial"}]}),
    )]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let err = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::Refused);

    let cut = || {
        Canned::json(
            200,
            json!({"stop_reason": "max_tokens", "content": [{"type": "tool_use", "id": "t", "name": "read_file", "input": {"path": "m"}}]}),
        )
    };
    let server = MockServer::start(vec![cut(), cut()]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    // One retry with effort low, then the call comes back cut off.
    assert_eq!(reply.notices, vec![Notice::LessThinking]);
    assert!(reply.tool_calls[0].cut_off());
    let recs = server.recorded();
    assert_eq!(recs[1].json()["output_config"]["effort"], "low");

    // Nothing usable at all: a clear "cut off" error.
    let empty = || Canned::json(200, json!({"stop_reason": "max_tokens", "content": [{"type": "thinking", "thinking": "", "signature": "S"}]}));
    let server = MockServer::start(vec![empty(), empty()]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let err = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap_err();
    assert_eq!(err.kind, Kind::Truncated);
}

#[test]
fn anthropic_old_model_retries_without_thinking() {
    let server = MockServer::start(vec![
        Canned::json(400, json!({"type": "error", "error": {"type": "invalid_request_error", "message": "thinking.type: adaptive is not supported"}})),
        Canned::json(200, json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "hello"}]})),
    ]);
    let e = ep(&server, ProviderId::Anthropic, "claude-old");
    let reply = runtime().block_on(complete(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default())).unwrap();
    assert_eq!(reply.text, "hello");
    let recs = server.recorded();
    assert!(recs[0].json().get("thinking").is_some());
    assert!(recs[1].json().get("thinking").is_none());
}

fn an_event(kind: &str, data: Value) -> String {
    format!("event: {kind}\ndata: {data}")
}

#[test]
fn anthropic_stream_with_thinking_text_and_tool_use() {
    let server = MockServer::start(vec![Canned::sse(vec![
        an_event("message_start", json!({"type": "message_start", "message": {"model": "claude-opus-5-5", "usage": {"input_tokens": 50, "output_tokens": 1}}})),
        an_event("content_block_start", json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}})),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "SIG"}})),
        an_event("content_block_stop", json!({"type": "content_block_stop", "index": 0})),
        an_event("content_block_start", json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}})),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Checking "}})),
        ": ping".into(),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "now."}})),
        an_event("content_block_stop", json!({"type": "content_block_stop", "index": 1})),
        an_event("content_block_start", json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_9", "name": "read_file", "input": {}}})),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"path\": "}})),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "\"a.tex\"}"}})),
        an_event("content_block_stop", json!({"type": "content_block_stop", "index": 2})),
        an_event("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 42}})),
        an_event("message_stop", json!({"type": "message_stop"})),
    ])]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let (events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "Checking now.");
    assert_eq!(reply.stop, StopReason::ToolUse);
    assert_eq!(reply.tool_calls[0].id, "toolu_9");
    assert_eq!(reply.tool_calls[0].arguments, json!({"path": "a.tex"}));
    assert_eq!(reply.usage, Usage { input_tokens: 50, output_tokens: 42 });
    let blocks = reply.replay.unwrap().blocks;
    assert_eq!(blocks[0], json!({"type": "thinking", "thinking": "hmm", "signature": "SIG"}));
    assert_eq!(blocks[2]["input"], json!({"path": "a.tex"}));
    assert_eq!(shown(&events.lock().unwrap()), "Checking now.");
    assert_eq!(server.recorded()[0].json()["stream"], true);
}

#[test]
fn anthropic_stream_unreadable_tool_arguments_are_reported() {
    let server = MockServer::start(vec![Canned::sse(vec![
        an_event("message_start", json!({"type": "message_start", "message": {"model": "claude-opus-5-5", "usage": {"input_tokens": 5, "output_tokens": 1}}})),
        an_event("content_block_start", json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}}})),
        an_event("content_block_delta", json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "path = a.tex"}})),
        an_event("content_block_stop", json!({"type": "content_block_stop", "index": 0})),
        an_event("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}})),
        an_event("message_stop", json!({"type": "message_stop"})),
    ])]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let (_events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.tool_calls[0].arguments, json!({}));
    assert_eq!(reply.tool_calls[0].invalid_arguments.as_deref(), Some("path = a.tex"));
    // The replayed block stays valid for the API: an object input, no marker.
    let blocks = reply.replay.unwrap().blocks;
    assert_eq!(blocks[0], json!({"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {}}));
}

#[test]
fn anthropic_overloaded_stream_is_retried() {
    let server = MockServer::start(vec![
        Canned::sse(vec![an_event("error", json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}))]),
        Canned::json(200, json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": "back"}]})),
    ]);
    let e = ep(&server, ProviderId::Anthropic, "claude-opus-5-5");
    let (_events, mut sink) = collect();
    let reply = runtime().block_on(complete_streaming(&client(), &e, req(vec![Msg::user("hi")]), &Cancel::default(), &mut sink)).unwrap();
    assert_eq!(reply.text, "back");
    assert!(matches!(reply.notices[0], Notice::Retrying { .. }));
}

// ---------------------------------------------------- capabilities --

#[test]
fn model_capabilities_follow_the_known_list() {
    let c = model_caps(ProviderId::Nvidia, "nvidia/nemotron-3-ultra-550b-a55b");
    assert!(c.known && c.tools && !c.vision);
    assert_eq!(c.thinking, ThinkingParam::ChatTemplateKwargs);
    assert_eq!(c.context_length, Some(1_000_000));
    assert!(model_caps(ProviderId::Nvidia, "nvidia/nemotron-3.5-super-vl-120b-a12b").vision);
    assert!(model_caps(ProviderId::Nvidia, "moonshotai/kimi-k3.1-pro").vision);
    assert!(model_caps(ProviderId::Openrouter, "google/gemma-4-31b-it:free").vision);
    assert_eq!(model_caps(ProviderId::Openrouter, "nvidia/nemotron-3-ultra-550b-a55b:free").thinking, ThinkingParam::None);
    let claude = model_caps(ProviderId::Anthropic, "claude-opus-5-5");
    assert!(claude.vision && claude.tools);
    assert_eq!(claude.thinking, ThinkingParam::Adaptive);
    let unknown = model_caps(ProviderId::Custom, "llama-x-vision");
    assert!(!unknown.known && unknown.vision && unknown.tools);
    assert!(!model_caps(ProviderId::Custom, "qwen-coder").vision);
    assert_eq!(serde_json::to_value(claude).unwrap()["thinking"], "adaptive");
    // Every spec default is a known model.
    for choice in [NVIDIA_AGENT, NVIDIA_CHAT, NVIDIA_VISION, NVIDIA_REVIEW] {
        assert!(model_caps(ProviderId::Nvidia, choice.model).known, "{}", choice.model);
        for f in choice.fallbacks {
            assert!(model_caps(ProviderId::Nvidia, f).known, "{f}");
        }
    }
    assert!(model_caps(ProviderId::Nvidia, NVIDIA_VISION.model).vision);
}

#[test]
fn messages_serialize_for_journals() {
    let m = sample_history();
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v[0]["role"], "user");
    assert_eq!(v[0]["content"][1]["type"], "image");
    assert_eq!(v[0]["content"][1]["dataUrl"], "data:image/png;base64,AAAA");
    assert_eq!(v[1]["toolCalls"][0]["name"], "read_file");
    assert_eq!(v[2]["toolCallId"], "call_1");
    let back: Vec<Msg> = serde_json::from_value(v).unwrap();
    assert_eq!(back, m);
    let n = serde_json::to_value(Notice::MaxTokensLowered { from: 8192, to: 4096 }).unwrap();
    assert_eq!(n, json!({"kind": "maxTokensLowered", "from": 8192, "to": 4096}));
}
