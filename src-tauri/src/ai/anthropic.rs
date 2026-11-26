//! Anthropic Claude through the native Messages API (raw HTTP; there is no
//! official Rust SDK).
//!
//! `POST {base}/messages` with `x-api-key`, `anthropic-version: 2026-10-21`
//! and `anthropic-beta: server-side-fallback-2026-07-01`. The body uses
//! adaptive thinking, an explicit `output_config.effort`, structured output
//! through `output_config.format`, and `fallbacks: "default"` so a request
//! the model declines is retried server-side on the recommended fallback
//! model. No sampling parameters (temperature, top_p, top_k) are sent: the
//! API rejects them.
//!
//! The reply is `{model, content: [{type: "text", text} | {type: "thinking"}
//! | {type: "fallback"} ...], stop_reason, stop_details?}`; `stop_reason`
//! `"refusal"` and `"max_tokens"` are handled before reading the text.

use reqwest::Client;
use serde_json::{json, Value};

use super::error::{AiError, AiResult, Kind};
use super::http::{self, Cancel, ChatAnswer, Endpoint, ModelInfo};
use super::openai::truncated;
use super::providers::{self, ProviderId};

pub const API_VERSION: &str = "2026-10-21";
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 16000;
/// Explaining a compile error is a focused task; medium keeps answers quick.
const EFFORT: &str = "medium";

fn request(client: &Client, ep: &Endpoint, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    let mut req = client
        .request(method, ep.url(path))
        .header("anthropic-version", API_VERSION)
        .header("accept", "application/json");
    if let Some(key) = &ep.key {
        req = req.header("x-api-key", key.expose());
    }
    req
}

pub fn body(model: &str, system: &str, user: &str, schema: &Value, full: bool) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{ "role": "user", "content": user }],
        "output_config": {
            "format": { "type": "json_schema", "schema": schema }
        },
    });
    if full {
        body["thinking"] = json!({ "type": "adaptive" });
        body["output_config"]["effort"] = json!(EFFORT);
        body["fallbacks"] = json!("default");
    }
    body
}

pub async fn chat(
    client: &Client,
    ep: &Endpoint,
    system: &str,
    user: &str,
    schema: &Value,
    cancel: &Cancel,
) -> AiResult<ChatAnswer> {
    match chat_once(client, ep, system, user, schema, true, cancel).await {
        // An older model the user picked may not take adaptive thinking,
        // effort or fallbacks; retry once with the plain request.
        Err(e) if e.kind == Kind::BadRequest && mentions_optional_feature(&e.message) => {
            chat_once(client, ep, system, user, schema, false, cancel).await
        }
        other => other,
    }
}

fn mentions_optional_feature(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    ["thinking", "effort", "fallback", "adaptive"].iter().any(|w| m.contains(w))
}

async fn chat_once(
    client: &Client,
    ep: &Endpoint,
    system: &str,
    user: &str,
    schema: &Value,
    full: bool,
    cancel: &Cancel,
) -> AiResult<ChatAnswer> {
    let mut req = request(client, ep, reqwest::Method::POST, "messages")
        .json(&body(&ep.model, system, user, schema, full));
    if full {
        req = req.header("anthropic-beta", FALLBACK_BETA);
    }
    let reply = http::send(req, http::CHAT_TIMEOUT, cancel, &ep.label).await?;
    if !reply.status.is_success() {
        let detail = http::error_detail(&reply.body);
        return Err(http::map_status(reply.status, &reply.headers, detail.as_deref(), &ep.label, ep.key.as_ref()));
    }
    parse_reply(&reply.body, ep)
}

fn parse_reply(body: &str, ep: &Endpoint) -> AiResult<ChatAnswer> {
    let bad = || AiError::new(Kind::BadResponse, format!("{} sent a reply Texo couldn't read.", ep.label));
    let v: Value = serde_json::from_str(body).map_err(|_| bad())?;
    match v["stop_reason"].as_str() {
        Some("refusal") => {
            return Err(AiError::new(
                Kind::Refused,
                "Claude declined to help with this request. Try again, or pick another provider.",
            ))
        }
        Some("max_tokens") => return Err(truncated(&ep.label)),
        _ => {}
    }
    let text: String = v["content"]
        .as_array()
        .ok_or_else(bad)?
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect();
    if text.trim().is_empty() {
        return Err(AiError::new(Kind::BadResponse, format!("{} sent an empty answer. Try again.", ep.label)));
    }
    Ok(ChatAnswer {
        text,
        truncated: false,
        model: v["model"].as_str().unwrap_or(&ep.model).to_string(),
    })
}

pub async fn list_models(client: &Client, ep: &Endpoint, cancel: &Cancel) -> AiResult<Vec<ModelInfo>> {
    let req = request(client, ep, reqwest::Method::GET, "models?limit=100");
    let reply = http::send(req, http::LIST_TIMEOUT, cancel, &ep.label).await?;
    if !reply.status.is_success() {
        let detail = http::error_detail(&reply.body);
        return Err(http::map_status(reply.status, &reply.headers, detail.as_deref(), &ep.label, ep.key.as_ref()));
    }
    parse_models(&reply.body)
        .ok_or_else(|| AiError::new(Kind::BadResponse, format!("{} sent a model list Texo couldn't read.", ep.label)))
}

fn parse_models(body: &str) -> Option<Vec<ModelInfo>> {
    let v: Value = serde_json::from_str(body).ok()?;
    let preferred = providers::get(ProviderId::Anthropic).preferred_models;
    let mut out: Vec<ModelInfo> = v["data"]
        .as_array()?
        .iter()
        .filter(|m| m["lifecycle"].as_str() != Some("retired"))
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_string();
            Some(ModelInfo {
                recommended: preferred.contains(&id.as_str()),
                label: m["display_name"].as_str().unwrap_or(&id).to_string(),
                free: Some(false),
                context_length: m["max_input_tokens"].as_u64().filter(|n| *n > 0),
                id,
            })
        })
        .collect();
    // Newest first, as the API lists them, but the suggestion on top.
    out.sort_by_key(|m| !m.recommended);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http::{build_client, ApiKey};
    use crate::ai::mock::{runtime, Canned, MockServer};

    const KEY: &str = "sk-ant-TESTKEY-0123456789abcdef";

    fn ep(server: &MockServer) -> Endpoint {
        Endpoint {
            provider: ProviderId::Anthropic,
            label: "Anthropic Claude".into(),
            base_url: format!("{}/v1", server.base_url),
            key: Some(ApiKey::new(KEY.into())),
            model: "claude-opus-5-5".into(),
        }
    }

    fn reply(stop: &str, content: Value) -> Canned {
        Canned::json(
            200,
            json!({"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                   "content": content, "stop_reason": stop,
                   "usage": {"input_tokens": 10, "output_tokens": 5}}),
        )
    }

    #[test]
    fn sends_native_headers_and_body() {
        let server = MockServer::start(vec![reply(
            "end_turn",
            json!([{"type": "thinking", "thinking": "", "signature": "s"},
                   {"type": "text", "text": "{\"summary\":\"ok\"}"}]),
        )]);
        let client = build_client(false).unwrap();
        let schema = json!({"type": "object", "additionalProperties": false});
        let ans = runtime()
            .block_on(chat(&client, &ep(&server), "SYS", "USER", &schema, &Cancel::default()))
            .unwrap();
        assert_eq!(ans.text, "{\"summary\":\"ok\"}");
        assert_eq!(ans.model, "claude-opus-5-5");

        let req = &server.recorded()[0];
        assert_eq!(req.path, "/v1/messages");
        assert_eq!(req.header("x-api-key"), Some(KEY));
        assert_eq!(req.header("authorization"), None);
        assert_eq!(req.header("anthropic-version"), Some(API_VERSION));
        assert_eq!(req.header("anthropic-beta"), Some(FALLBACK_BETA));
        let body = req.json();
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["system"], "SYS");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "USER");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["output_config"]["effort"], "medium");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["output_config"]["format"]["schema"], schema);
        assert_eq!(body["fallbacks"], "default");
        for banned in ["temperature", "top_p", "top_k", "budget_tokens"] {
            assert!(body.get(banned).is_none(), "{banned} must not be sent");
        }
    }

    #[test]
    fn refusal_and_max_tokens_are_errors() {
        let server = MockServer::start(vec![
            reply("refusal", json!([])),
            reply("max_tokens", json!([{"type": "text", "text": "{\"summ"}])),
        ]);
        let client = build_client(false).unwrap();
        let rt = runtime();
        let e1 = rt.block_on(chat(&client, &ep(&server), "S", "U", &json!({}), &Cancel::default())).unwrap_err();
        assert_eq!(e1.kind, Kind::Refused);
        let e2 = rt.block_on(chat(&client, &ep(&server), "S", "U", &json!({}), &Cancel::default())).unwrap_err();
        assert_eq!(e2.kind, Kind::Truncated);
    }

    #[test]
    fn fallback_answer_is_read_and_model_reported() {
        let server = MockServer::start(vec![Canned::json(200, json!({
            "model": "claude-opus-4-8", "stop_reason": "end_turn",
            "content": [
                {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}},
                {"type": "text", "text": "{}"}
            ]}))]);
        let client = build_client(false).unwrap();
        let ans = runtime()
            .block_on(chat(&client, &ep(&server), "S", "U", &json!({}), &Cancel::default()))
            .unwrap();
        assert_eq!(ans.model, "claude-opus-4-8");
        assert_eq!(ans.text, "{}");
    }

    #[test]
    fn old_model_400_retries_without_optional_features() {
        let server = MockServer::start(vec![
            Canned::json(400, json!({"type": "error", "error": {"type": "invalid_request_error",
                "message": "thinking.type: adaptive is not supported on this model"}})),
            reply("end_turn", json!([{"type": "text", "text": "{}"}])),
        ]);
        let client = build_client(false).unwrap();
        runtime().block_on(chat(&client, &ep(&server), "S", "U", &json!({}), &Cancel::default())).unwrap();
        let reqs = server.recorded();
        assert_eq!(reqs.len(), 2);
        let second = reqs[1].json();
        assert!(second.get("thinking").is_none());
        assert!(second.get("fallbacks").is_none());
        assert!(second["output_config"].get("effort").is_none());
        assert_eq!(reqs[1].header("anthropic-beta"), None);
    }

    #[test]
    fn errors_map_and_hide_the_key() {
        for (status, kind) in [(401, Kind::BadKey), (404, Kind::NotFound), (429, Kind::RateLimited), (529, Kind::Server)] {
            let server = MockServer::start(vec![Canned::json(status, json!({"type": "error",
                "error": {"type": "x", "message": format!("problem with {KEY}")}})).header("retry-after", "5")]);
            let client = build_client(false).unwrap();
            let err = runtime()
                .block_on(chat(&client, &ep(&server), "S", "U", &json!({}), &Cancel::default()))
                .unwrap_err();
            assert_eq!(err.kind, kind);
            assert!(!err.message.contains(KEY));
            if status == 429 || status == 529 {
                assert_eq!(err.retry_after_secs, Some(5));
            }
        }
    }

    #[test]
    fn model_list_skips_retired_and_suggests_the_default() {
        let server = MockServer::start(vec![Canned::json(200, json!({"data": [
            {"id": "claude-fable-5-2", "display_name": "Claude Fable 5.2", "lifecycle": "active", "type": "model"},
            {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "lifecycle": "active", "type": "model"},
            {"id": "claude-old", "display_name": "Old", "lifecycle": "retired", "type": "model"},
        ], "has_more": false}))]);
        let client = build_client(false).unwrap();
        let models = runtime().block_on(list_models(&client, &ep(&server), &Cancel::default())).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-opus-5-5");
        assert!(models[0].recommended);
        let req = &server.recorded()[0];
        assert_eq!(req.path, "/v1/models?limit=100");
        assert_eq!(req.header("x-api-key"), Some(KEY));
        assert_eq!(req.header("anthropic-version"), Some(API_VERSION));
    }
}
