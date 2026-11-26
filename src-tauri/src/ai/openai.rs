//! OpenAI-compatible chat completions (NVIDIA, OpenRouter, Groq, Gemini and
//! custom servers such as Ollama or LM Studio).
//!
//! Request: `POST {base}/chat/completions` with `Authorization: Bearer <key>`
//! and `{model, messages, max_tokens, temperature, response_format?}`.
//! Reply: `{choices: [{message: {content}, finish_reason}], model}`.
//! Models: `GET {base}/models` → `{data: [{id, ...}]}`.

use reqwest::Client;
use serde_json::{json, Value};

use super::error::{AiError, AiResult, Kind};
use super::http::{self, Cancel, ChatAnswer, Endpoint, ModelInfo};
use super::providers::{self, ProviderId, Structured};

/// NVIDIA's hosted models accept at most 4096.
const MAX_TOKENS: u32 = 4096;

fn request(client: &Client, ep: &Endpoint, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    let mut req = client.request(method, ep.url(path)).header("accept", "application/json");
    if let Some(key) = &ep.key {
        req = req.bearer_auth(key.expose());
    }
    if ep.provider == ProviderId::Openrouter {
        // Optional app attribution; nothing about the user.
        req = req.header("X-OpenRouter-Title", "Texo");
    }
    req
}

fn response_format(structured: Structured, schema: &Value) -> Option<Value> {
    match structured {
        Structured::JsonSchema => Some(json!({
            "type": "json_schema",
            "json_schema": { "name": "texo_fix", "strict": true, "schema": schema }
        })),
        Structured::JsonObject => Some(json!({ "type": "json_object" })),
        Structured::None => None,
    }
}

pub async fn chat(
    client: &Client,
    ep: &Endpoint,
    system: &str,
    user: &str,
    structured: Structured,
    schema: &Value,
    cancel: &Cancel,
) -> AiResult<ChatAnswer> {
    let format = response_format(structured, schema);
    match chat_once(client, ep, system, user, format.as_ref(), cancel).await {
        // Not every model behind a provider supports structured output; the
        // prompt asks for JSON anyway, so try once more without it.
        Err(e) if format.is_some() && e.kind == Kind::BadRequest => {
            chat_once(client, ep, system, user, None, cancel).await
        }
        other => other,
    }
}

async fn chat_once(
    client: &Client,
    ep: &Endpoint,
    system: &str,
    user: &str,
    format: Option<&Value>,
    cancel: &Cancel,
) -> AiResult<ChatAnswer> {
    let mut body = json!({
        "model": ep.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "max_tokens": MAX_TOKENS,
        "temperature": 0.2,
        "stream": false,
    });
    if let Some(f) = format {
        body["response_format"] = f.clone();
    }
    let req = request(client, ep, reqwest::Method::POST, "chat/completions").json(&body);
    let reply = http::send(req, http::CHAT_TIMEOUT, cancel, &ep.label).await?;
    if !reply.status.is_success() {
        let detail = http::error_detail(&reply.body);
        return Err(http::map_status(reply.status, &reply.headers, detail.as_deref(), &ep.label, ep.key.as_ref()));
    }
    parse_chat(&reply.body, ep)
}

fn parse_chat(body: &str, ep: &Endpoint) -> AiResult<ChatAnswer> {
    let bad = || AiError::new(Kind::BadResponse, format!("{} sent a reply Texo couldn't read.", ep.label));
    let v: Value = serde_json::from_str(body).map_err(|_| bad())?;
    // OpenRouter can report an upstream failure with HTTP 200.
    if v.get("choices").is_none() {
        if let Some(err) = v.get("error") {
            let code = err.get("code").and_then(Value::as_u64).unwrap_or(500) as u16;
            let status = reqwest::StatusCode::from_u16(code).unwrap_or(reqwest::StatusCode::BAD_GATEWAY);
            let detail = err.get("message").and_then(Value::as_str);
            return Err(http::map_status(status, &Default::default(), detail, &ep.label, ep.key.as_ref()));
        }
        return Err(bad());
    }
    let choice = v["choices"].get(0).ok_or_else(bad)?;
    let message = &choice["message"];
    // Content is usually a string; some servers send a list of parts.
    let text = match &message["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let finish = choice["finish_reason"].as_str().unwrap_or_default();
    if text.trim().is_empty() {
        if finish == "length" {
            return Err(truncated(&ep.label));
        }
        if finish == "content_filter" {
            return Err(AiError::new(Kind::Refused, format!("{} declined to answer this request.", ep.label)));
        }
        return Err(AiError::new(Kind::BadResponse, format!("{} sent an empty answer. Try again or pick another model.", ep.label)));
    }
    Ok(ChatAnswer {
        text,
        truncated: finish == "length",
        model: v["model"].as_str().unwrap_or(&ep.model).to_string(),
    })
}

pub fn truncated(label: &str) -> AiError {
    AiError::new(
        Kind::Truncated,
        format!("{label}'s answer was cut off before it was complete. Try again, or pick a model with a longer output."),
    )
}

pub async fn list_models(client: &Client, ep: &Endpoint, cancel: &Cancel) -> AiResult<Vec<ModelInfo>> {
    let req = request(client, ep, reqwest::Method::GET, "models");
    let reply = http::send(req, http::LIST_TIMEOUT, cancel, &ep.label).await?;
    if !reply.status.is_success() {
        let detail = http::error_detail(&reply.body);
        return Err(http::map_status(reply.status, &reply.headers, detail.as_deref(), &ep.label, ep.key.as_ref()));
    }
    parse_models(&reply.body, ep.provider)
        .ok_or_else(|| AiError::new(Kind::BadResponse, format!("{} sent a model list Texo couldn't read.", ep.label)))
}

fn parse_models(body: &str, provider: ProviderId) -> Option<Vec<ModelInfo>> {
    let v: Value = serde_json::from_str(body).ok()?;
    let data = v.get("data").or_else(|| v.get("models"))?.as_array()?;
    let preferred = providers::get(provider).preferred_models;
    let mut out: Vec<ModelInfo> = data
        .iter()
        .filter_map(|m| {
            let raw = m.get("id").and_then(Value::as_str)?;
            // Gemini lists `models/gemini-…`; requests use the bare name.
            let id = raw.strip_prefix("models/").unwrap_or(raw).to_string();
            if !providers::looks_like_chat_model(&id) {
                return None;
            }
            if let Some(outputs) = m.pointer("/architecture/output_modalities").and_then(Value::as_array) {
                if !outputs.iter().any(|o| o.as_str() == Some("text")) {
                    return None;
                }
            }
            let free = if provider == ProviderId::Openrouter {
                let zero = |k: &str| {
                    m.pointer(&format!("/pricing/{k}"))
                        .and_then(Value::as_str)
                        .and_then(|p| p.parse::<f64>().ok())
                        == Some(0.0)
                };
                Some(id.ends_with(":free") || (zero("prompt") && zero("completion")))
            } else {
                None
            };
            let label = m
                .get("name")
                .or_else(|| m.get("display_name"))
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let context_length = m
                .get("context_length")
                .or_else(|| m.get("context_window"))
                .and_then(Value::as_u64);
            Some(ModelInfo { recommended: false, id, label, free, context_length })
        })
        .collect();
    out.sort_by(|a, b| {
        let rank = |m: &ModelInfo| preferred.iter().position(|p| *p == m.id).unwrap_or(usize::MAX);
        rank(a)
            .cmp(&rank(b))
            .then(b.free.unwrap_or(false).cmp(&a.free.unwrap_or(false)))
            .then(a.id.cmp(&b.id))
    });
    out.dedup_by(|a, b| a.id == b.id);
    mark_recommended(&mut out, provider);
    Some(out)
}

/// Marks the model Texo suggests: the first preferred one the provider has,
/// otherwise (OpenRouter) the first free one, otherwise none.
pub fn mark_recommended(models: &mut [ModelInfo], provider: ProviderId) {
    let preferred = providers::get(provider).preferred_models;
    let pick = models
        .iter()
        .position(|m| preferred.contains(&m.id.as_str()))
        .or_else(|| {
            if provider == ProviderId::Openrouter {
                models.iter().position(|m| m.free == Some(true))
            } else if provider == ProviderId::Gemini {
                // Gemini's list changes with each release; prefer a current
                // "flash" model, which is fast and on the free tier.
                models.iter().position(|m| {
                    let id = m.id.to_ascii_lowercase();
                    id.starts_with("gemini") && id.contains("flash") && !id.contains("lite")
                        && !id.contains("image") && !id.contains("live") && !id.contains("preview")
                })
            } else {
                None
            }
        });
    if let Some(i) = pick {
        models[i].recommended = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http::{build_client, ApiKey};
    use crate::ai::mock::{runtime, Canned, MockServer};

    fn ep(server: &MockServer, provider: ProviderId) -> Endpoint {
        Endpoint {
            provider,
            label: "Test AI".into(),
            base_url: format!("{}/v1", server.base_url),
            key: Some(ApiKey::new("nvapi-TESTKEY-0123456789abcdef".into())),
            model: "some/model".into(),
        }
    }

    fn ok_reply(content: &str) -> Canned {
        Canned::json(
            200,
            json!({"id": "x", "model": "some/model", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}
            ]}),
        )
    }

    #[test]
    fn chat_sends_bearer_and_messages_and_reads_content() {
        let server = MockServer::start(vec![ok_reply("{\"summary\":\"hi\"}")]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Nvidia);
        let ans = runtime()
            .block_on(chat(&client, &ep, "SYS", "USER", Structured::None, &json!({}), &Cancel::default()))
            .unwrap();
        assert_eq!(ans.text, "{\"summary\":\"hi\"}");
        assert!(!ans.truncated);
        let req = &server.recorded()[0];
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/v1/chat/completions");
        assert_eq!(req.header("authorization"), Some("Bearer nvapi-TESTKEY-0123456789abcdef"));
        let body = req.json();
        assert_eq!(body["model"], "some/model");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "SYS");
        assert_eq!(body["messages"][1]["content"], "USER");
        assert_eq!(body["max_tokens"], 4096);
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn json_schema_is_sent_and_dropped_after_a_400() {
        let server = MockServer::start(vec![
            Canned::json(400, json!({"error": {"message": "response_format not supported"}})),
            ok_reply("{}"),
        ]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Openrouter);
        runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::JsonSchema, &json!({"type": "object"}), &Cancel::default()))
            .unwrap();
        let reqs = server.recorded();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].json()["response_format"]["type"], "json_schema");
        assert_eq!(reqs[0].json()["response_format"]["json_schema"]["strict"], true);
        assert_eq!(reqs[0].header("x-openrouter-title"), Some("Texo"));
        assert!(reqs[1].json().get("response_format").is_none());
    }

    #[test]
    fn json_object_mode_for_groq() {
        let server = MockServer::start(vec![ok_reply("{}")]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Groq);
        runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::JsonObject, &json!({}), &Cancel::default()))
            .unwrap();
        assert_eq!(server.recorded()[0].json()["response_format"]["type"], "json_object");
    }

    #[test]
    fn custom_without_key_sends_no_authorization() {
        let server = MockServer::start(vec![ok_reply("{}")]);
        let client = build_client(false).unwrap();
        let mut ep = ep(&server, ProviderId::Custom);
        ep.key = None;
        runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::None, &json!({}), &Cancel::default()))
            .unwrap();
        assert_eq!(server.recorded()[0].header("authorization"), None);
    }

    #[test]
    fn http_errors_map_without_leaking_the_key() {
        let key = "nvapi-TESTKEY-0123456789abcdef";
        let cases = vec![
            (Canned::json(401, json!({"error": {"message": format!("Invalid key {key}")}})), Kind::BadKey),
            (Canned::json(403, json!({"error": {"message": format!("no access for {key}")}})), Kind::Forbidden),
            (Canned::json(404, json!({"error": {"message": "model some/model not found"}})), Kind::NotFound),
            (Canned::json(429, json!({"error": {"message": "slow"}})).header("retry-after", "30"), Kind::RateLimited),
            (Canned::json(502, json!({"error": {"message": format!("upstream {key}")}})), Kind::Server),
        ];
        for (reply, kind) in cases {
            let server = MockServer::start(vec![reply]);
            let client = build_client(false).unwrap();
            let ep = ep(&server, ProviderId::Nvidia);
            let err = runtime()
                .block_on(chat(&client, &ep, "S", "U", Structured::None, &json!({}), &Cancel::default()))
                .unwrap_err();
            assert_eq!(err.kind, kind, "{}", err.message);
            assert!(!err.message.contains(key), "{}", err.message);
            assert!(!format!("{err:?}").contains(key));
            assert!(!serde_json::to_string(&err).unwrap().contains(key));
            if kind == Kind::RateLimited {
                assert_eq!(err.retry_after_secs, Some(30));
            }
        }
    }

    #[test]
    fn openrouter_error_inside_a_200() {
        let server = MockServer::start(vec![Canned::json(200, json!({"error": {"code": 429, "message": "rate limited upstream"}}))]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Openrouter);
        let err = runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::None, &json!({}), &Cancel::default()))
            .unwrap_err();
        assert_eq!(err.kind, Kind::RateLimited);
    }

    #[test]
    fn empty_and_cut_off_answers() {
        let server = MockServer::start(vec![Canned::json(200, json!({"choices": [
            {"message": {"content": null}, "finish_reason": "length"}]}))]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Nvidia);
        let err = runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::None, &json!({}), &Cancel::default()))
            .unwrap_err();
        assert_eq!(err.kind, Kind::Truncated);
    }

    #[test]
    fn unreachable_server_is_offline() {
        // Bind and drop to get a port nothing listens on.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let client = build_client(false).unwrap();
        let ep = Endpoint {
            provider: ProviderId::Custom,
            label: "My server".into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            key: Some(ApiKey::new("sk-local-0123456789abcdef0123".into())),
            model: "m".into(),
        };
        let err = runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::None, &json!({}), &Cancel::default()))
            .unwrap_err();
        assert_eq!(err.kind, Kind::Offline, "{}", err.message);
        assert!(!err.message.contains("sk-local"));
        assert!(!err.message.contains("127.0.0.1"));
    }

    #[test]
    fn cancel_stops_a_slow_request() {
        let server = MockServer::start(vec![ok_reply("{}").delay(3000)]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Nvidia);
        let cancel = Cancel::default();
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            c2.cancel();
        });
        let start = std::time::Instant::now();
        let err = runtime()
            .block_on(chat(&client, &ep, "S", "U", Structured::None, &json!({}), &cancel))
            .unwrap_err();
        assert_eq!(err.kind, Kind::Cancelled);
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn model_list_is_filtered_and_ranked() {
        let server = MockServer::start(vec![Canned::json(200, json!({"object": "list", "data": [
            {"id": "z-ai/glm-5.3-flash"},
            {"id": "nvidia/nemotron-3.5-embed-8b"},
            {"id": "moonshotai/kimi-k3.1-pro", "context_window": 1048576},
            {"id": "google/gemma-3-4b-it"},
        ]}))]);
        let client = build_client(false).unwrap();
        let ep = ep(&server, ProviderId::Nvidia);
        let models = runtime().block_on(list_models(&client, &ep, &Cancel::default())).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3-flash", "google/gemma-3-4b-it"]);
        assert!(models[0].recommended);
        assert!(!models[1].recommended);
        assert_eq!(models[0].context_length, Some(1048576));
        let req = &server.recorded()[0];
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/v1/models");
    }

    #[test]
    fn openrouter_free_models_come_first() {
        let body = json!({"data": [
            {"id": "paid/model", "name": "Paid", "pricing": {"prompt": "0.000001", "completion": "0.000002"}},
            {"id": "some/model:free", "name": "Some (free)", "pricing": {"prompt": "0", "completion": "0"}},
            {"id": "img/model", "architecture": {"output_modalities": ["image"]}},
        ]});
        let models = parse_models(&body.to_string(), ProviderId::Openrouter).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "some/model:free");
        assert_eq!(models[0].free, Some(true));
        assert!(models[0].recommended);
        assert_eq!(models[1].free, Some(false));
    }

    #[test]
    fn gemini_model_prefix_is_stripped() {
        let body = json!({"object": "list", "data": [
            {"id": "models/gemini-9-flash", "object": "model"},
            {"id": "models/text-embedding-9", "object": "model"},
        ]});
        let models = parse_models(&body.to_string(), ProviderId::Gemini).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-9-flash");
        assert!(models[0].recommended);
    }
}
