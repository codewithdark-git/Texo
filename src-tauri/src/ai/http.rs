//! HTTP plumbing shared by the providers: one client (rustls, proxy settings
//! from the environment), timeouts, cancellation, a cap on response size, and
//! the mapping from HTTP failures to plain messages.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::{Client, RequestBuilder, StatusCode};
use tokio::sync::Notify;

use super::error::{sanitize, AiError, AiResult, Kind};

/// Model answers with thinking can take a while.
pub const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// An API key. It can't be printed or serialized by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn new(key: String) -> Self {
        ApiKey(key)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey([hidden])")
    }
}

/// Where and how to reach one provider for one request.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub provider: super::providers::ProviderId,
    /// Shown in messages ("NVIDIA didn't accept the API key").
    pub label: String,
    /// Without a trailing slash, e.g. `https://integrate.api.nvidia.com/v1`.
    pub base_url: String,
    pub key: Option<ApiKey>,
    pub model: String,
}

impl Endpoint {
    pub fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url.trim_end_matches('/'), path.trim_start_matches('/'))
    }
}

/// One entry of a provider's model list.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    /// Known to cost nothing (OpenRouter's free models); null when unknown.
    pub free: Option<bool>,
    pub context_length: Option<u64>,
    /// Texo's suggestion for this provider.
    pub recommended: bool,
}

/// A model's text answer, before it is parsed.
#[derive(Debug, Clone)]
pub struct ChatAnswer {
    pub text: String,
    /// The answer hit the output limit.
    pub truncated: bool,
    /// The model that actually answered (may differ after a fallback).
    pub model: String,
}

/// Builds the shared client. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
/// `NO_PROXY` are honoured (and the system proxy on Windows and macOS).
pub fn build_client(use_proxy: bool) -> AiResult<Client> {
    let mut builder = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("Texo/", env!("CARGO_PKG_VERSION")));
    if !use_proxy {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| {
        AiError::new(Kind::Tls, "Texo couldn't set up a secure connection on this computer.")
    })
}

/// A cancel switch for one request. `cancel()` before or during the request
/// both work.
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
        // Stores a permit in case nobody is waiting yet.
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> AiResult<()> {
        if self.is_cancelled() {
            Err(AiError::cancelled())
        } else {
            Ok(())
        }
    }

    /// Runs `fut` until it finishes or the request is cancelled.
    pub async fn run<T>(&self, fut: impl std::future::Future<Output = AiResult<T>>) -> AiResult<T> {
        self.check()?;
        tokio::select! {
            res = fut => res,
            _ = self.wait() => Err(AiError::cancelled()),
        }
    }

    async fn wait(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            self.notify.notified().await;
        }
    }
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: String,
}

/// Sends a request and reads the reply (status not checked yet).
pub async fn send(
    req: RequestBuilder,
    timeout: Duration,
    cancel: &Cancel,
    label: &str,
) -> AiResult<Reply> {
    cancel
        .run(async {
            let mut resp = req
                .timeout(timeout)
                .send()
                .await
                .map_err(|e| map_transport(&e, label))?;
            let status = resp.status();
            let headers = resp.headers().clone();
            let mut body = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|e| map_transport(&e, label))? {
                if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(AiError::new(
                        Kind::BadResponse,
                        format!("{label} sent an unexpectedly large reply."),
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Reply { status, headers, body: String::from_utf8_lossy(&body).into_owned() })
        })
        .await
}

/// Turns a connection-level failure into a plain message. The URL and the
/// underlying error text are left out: they can contain proxy credentials.
pub fn map_transport(err: &reqwest::Error, label: &str) -> AiError {
    if err.is_timeout() {
        return AiError::new(
            Kind::Timeout,
            format!("{label} took too long to answer. Try again, or pick a faster model."),
        );
    }
    let chain = error_chain(err).to_ascii_lowercase();
    if chain.contains("certificate") || chain.contains("tls") || chain.contains("handshake") {
        return AiError::new(
            Kind::Tls,
            format!(
                "Texo couldn't make a secure connection to {label}. A firewall, proxy or \
                 antivirus may be inspecting HTTPS traffic."
            ),
        );
    }
    if err.is_connect() {
        return AiError::new(
            Kind::Offline,
            format!(
                "Texo couldn't reach {label}. Check your internet connection (or the server \
                 address, for a custom provider)."
            ),
        );
    }
    AiError::new(Kind::Network, format!("The connection to {label} failed. Try again."))
}

fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(s) = source {
        out.push_str(": ");
        out.push_str(&s.to_string());
        source = s.source();
    }
    out
}

/// Seconds from a `Retry-After` header (the HTTP-date form is ignored).
pub fn retry_after(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get("retry-after")?.to_str().ok()?.trim();
    value
        .parse::<u64>()
        .ok()
        .or_else(|| value.parse::<f64>().ok().filter(|v| *v >= 0.0).map(|v| v.ceil() as u64))
}

/// Maps a non-success HTTP status to a plain message. `detail` is the
/// provider's own error text, if any; it is sanitized before use.
pub fn map_status(
    status: StatusCode,
    headers: &HeaderMap,
    detail: Option<&str>,
    label: &str,
    key: Option<&ApiKey>,
) -> AiError {
    let detail = detail
        .map(|d| sanitize(d, key.map(ApiKey::expose)))
        .filter(|d| !d.is_empty());
    let with_detail = |text: String| match &detail {
        Some(d) => format!("{text} ({label} said: {d})"),
        None => text,
    };
    let code = status.as_u16();
    let mut err = match code {
        401 => AiError::new(
            Kind::BadKey,
            format!("{label} didn't accept the API key. Check it in Settings > AI, or create a new one."),
        ),
        402 => AiError::new(
            Kind::Payment,
            with_detail(format!("Your {label} account has no credit left for this model. Pick a free model or add credit.")),
        ),
        403 => AiError::new(
            Kind::Forbidden,
            with_detail(format!("{label} refused the request: this key may not have access to the chosen model.")),
        ),
        404 => AiError::new(
            Kind::NotFound,
            with_detail(format!("{label} doesn't know the chosen model (or the address is wrong). Pick another model in Settings > AI.")),
        ),
        408 | 504 => AiError::new(
            Kind::Timeout,
            format!("{label} took too long to answer. Try again in a moment."),
        ),
        413 => AiError::new(
            Kind::TooLarge,
            format!("The request was too large for {label}. Try a model with a larger context."),
        ),
        429 => AiError::new(
            Kind::RateLimited,
            format!("{label} says too many requests were made. Wait a moment and try again."),
        ),
        400 | 422 => AiError::new(
            Kind::BadRequest,
            with_detail(format!("{label} couldn't handle the request.")),
        ),
        500..=599 => AiError::new(
            Kind::Server,
            format!("{label} is having trouble right now (error {code}). Try again in a few minutes."),
        ),
        _ => AiError::new(Kind::Other, with_detail(format!("{label} answered with error {code}."))),
    };
    if code == 429 || code == 529 || code == 503 {
        err.retry_after_secs = retry_after(headers);
        if let Some(secs) = err.retry_after_secs {
            err.message = format!("{} You can try again in about {secs} seconds.", err.message);
        }
    }
    err
}

/// The `message` of an `{ "error": { "message": ... } }` body (OpenAI and
/// Anthropic shapes), or of `{ "error": "..." }`.
pub fn error_detail(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let e = v.get("error")?;
    e.get("message")
        .and_then(|m| m.as_str())
        .or_else(|| e.as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(retry: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(r) = retry {
            h.insert("retry-after", HeaderValue::from_str(r).unwrap());
        }
        h
    }

    #[test]
    fn status_codes_map_to_kinds() {
        let h = headers(None);
        let k = |c: u16| map_status(StatusCode::from_u16(c).unwrap(), &h, None, "X", None).kind;
        assert_eq!(k(401), Kind::BadKey);
        assert_eq!(k(402), Kind::Payment);
        assert_eq!(k(403), Kind::Forbidden);
        assert_eq!(k(404), Kind::NotFound);
        assert_eq!(k(429), Kind::RateLimited);
        assert_eq!(k(400), Kind::BadRequest);
        assert_eq!(k(500), Kind::Server);
        assert_eq!(k(503), Kind::Server);
        assert_eq!(k(529), Kind::Server);
        assert_eq!(k(504), Kind::Timeout);
    }

    #[test]
    fn rate_limit_reads_retry_after() {
        let err = map_status(StatusCode::TOO_MANY_REQUESTS, &headers(Some("17")), None, "Groq", None);
        assert_eq!(err.retry_after_secs, Some(17));
        assert!(err.message.contains("17 seconds"));
        let err = map_status(StatusCode::TOO_MANY_REQUESTS, &headers(Some("2.5")), None, "Groq", None);
        assert_eq!(err.retry_after_secs, Some(3));
        let err = map_status(
            StatusCode::TOO_MANY_REQUESTS,
            &headers(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            None,
            "Groq",
            None,
        );
        assert_eq!(err.retry_after_secs, None);
    }

    #[test]
    fn provider_detail_is_sanitized() {
        let key = ApiKey::new("sk-secret-1234567890abcdef".into());
        let err = map_status(
            StatusCode::BAD_REQUEST,
            &headers(None),
            Some("bad key sk-secret-1234567890abcdef in request"),
            "X",
            Some(&key),
        );
        assert!(!err.message.contains("sk-secret-1234567890abcdef"));
        // 401 never echoes provider text at all.
        let err = map_status(StatusCode::UNAUTHORIZED, &headers(None), Some("anything"), "X", Some(&key));
        assert!(!err.message.contains("anything"));
    }

    #[test]
    fn api_key_debug_is_hidden() {
        let key = ApiKey::new("nvapi-verysecret".into());
        assert_eq!(format!("{key:?}"), "ApiKey([hidden])");
    }

    #[test]
    fn error_detail_reads_both_shapes() {
        assert_eq!(error_detail(r#"{"error":{"message":"m1"}}"#).as_deref(), Some("m1"));
        assert_eq!(
            error_detail(r#"{"type":"error","error":{"type":"x","message":"m2"}}"#).as_deref(),
            Some("m2")
        );
        assert_eq!(error_detail(r#"{"error":"m3"}"#).as_deref(), Some("m3"));
        assert_eq!(error_detail("not json"), None);
    }

    #[test]
    fn cancel_before_and_during() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let c = Cancel::default();
            c.cancel();
            let r = c.run(async { Ok::<_, AiError>(1) }).await;
            assert_eq!(r.unwrap_err().kind, Kind::Cancelled);

            let c = Cancel::default();
            let c2 = c.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                c2.cancel();
            });
            let r = c
                .run(async {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok::<_, AiError>(1)
                })
                .await;
            assert_eq!(r.unwrap_err().kind, Kind::Cancelled);
        });
    }
}
