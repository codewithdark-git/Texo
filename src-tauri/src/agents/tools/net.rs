//! Shared plumbing for the agents' web and literature tools: the context a
//! tool call runs with (cancel switch, service addresses, the user's optional
//! service keys), polite pacing per host, a small in-memory cache, and plain
//! messages for HTTP failures.
//!
//! Nothing here sends anything about the user: requests carry only the app
//! name and version in the User-Agent, plus the contact e-mail for Crossref
//! when (and only when) the user entered one in Settings > AI > Web.

// The agent runtime that calls these tools lands separately in v1.2.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::HeaderMap;
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::{self, ApiKey, Cancel};

/// Sent with every request: the app name and version, nothing else.
pub const USER_AGENT: &str = concat!("Texo/", env!("CARGO_PKG_VERSION"), " (desktop LaTeX editor)");

/// Literature and search APIs answer within this, or we give up on them.
pub const API_TIMEOUT: Duration = Duration::from_secs(20);

/// Hosts the literature client may be redirected to (doi.org hands BibTeX
/// requests to the registration agencies). Anything else stops the redirect.
const REDIRECT_HOSTS: &[&str] = &[
    "doi.org",
    "dx.doi.org",
    "data.crosscite.org",
    "api.crossref.org",
    "data.crossref.org",
    "api.datacite.org",
    "data.datacite.org",
    "data.jalc.org",
    "api.japanlinkcenter.org",
    "export.arxiv.org",
    "arxiv.org",
    "api.openalex.org",
    "api.semanticscholar.org",
];

/// Addresses of the services the tools talk to. Tests point them at a
/// local mock server.
#[derive(Debug, Clone)]
pub struct Services {
    pub arxiv_api: String,
    pub arxiv_bibtex: String,
    pub crossref: String,
    pub semantic_scholar: String,
    pub openalex: String,
    pub doi: String,
    pub tavily: String,
    pub brave: String,
    /// Wait between requests to the same host. Off in tests.
    pub pacing: bool,
}

impl Default for Services {
    fn default() -> Self {
        Services {
            arxiv_api: "https://export.arxiv.org/api/query".into(),
            arxiv_bibtex: "https://arxiv.org/bibtex".into(),
            crossref: "https://api.crossref.org".into(),
            semantic_scholar: "https://api.semanticscholar.org/graph/v1".into(),
            openalex: "https://api.openalex.org".into(),
            doi: "https://doi.org".into(),
            tavily: "https://api.tavily.com/search".into(),
            brave: "https://api.search.brave.com/res/v1/web/search".into(),
            pacing: true,
        }
    }
}

/// The web search service the user configured, with what it needs.
#[derive(Debug, Clone)]
pub enum SearchBackend {
    Tavily(ApiKey),
    Brave(ApiKey),
    /// Base URL of a SearXNG instance (its JSON output must be enabled).
    Searxng(String),
}

impl SearchBackend {
    pub fn label(&self) -> &'static str {
        match self {
            SearchBackend::Tavily(_) => "Tavily",
            SearchBackend::Brave(_) => "Brave Search",
            SearchBackend::Searxng(_) => "SearXNG",
        }
    }
}

/// What one tool call runs with. Cheap to clone; clones share the cancel
/// switch and the HTTP clients.
#[derive(Clone)]
pub struct NetCtx {
    pub cancel: Cancel,
    pub services: Services,
    /// The user's free OpenAlex key, if they added one.
    pub openalex_key: Option<ApiKey>,
    /// Sent to Crossref as `mailto` only when the user entered it.
    pub contact_email: Option<String>,
    /// `None`: no web search configured, so `web_search` isn't offered.
    pub search: Option<SearchBackend>,
    pub(crate) fetch: super::web::FetchConfig,
    client: Arc<OnceLock<AiResult<Client>>>,
}

impl NetCtx {
    pub fn new(cancel: Cancel) -> Self {
        NetCtx {
            cancel,
            services: Services::default(),
            openalex_key: None,
            contact_email: None,
            search: None,
            fetch: super::web::FetchConfig::default(),
            client: Arc::new(OnceLock::new()),
        }
    }

    /// The client for the fixed literature and search APIs: honours the
    /// proxy settings, and follows redirects only between known API hosts
    /// (or within the host first asked).
    pub fn client(&self) -> AiResult<Client> {
        self.client.get_or_init(build_api_client).clone()
    }

    /// Whether `web_search` should be offered to the model.
    pub fn web_search_available(&self) -> bool {
        self.search.is_some()
    }
}

fn build_api_client() -> AiResult<Client> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.stop();
        }
        let first_host = attempt.previous().first().and_then(|u| u.host_str()).map(str::to_ascii_lowercase);
        let url = attempt.url();
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let known = url.scheme() == "https" && REDIRECT_HOSTS.contains(&host.as_str());
        let same = first_host.as_deref() == Some(host.as_str());
        if known || same {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT)
        .redirect(policy)
        .build()
        .map_err(|_| AiError::new(Kind::Tls, "Texo couldn't set up a secure connection on this computer."))
}

// --------------------------------------------------------------- pacing --

fn next_slots() -> &'static Mutex<HashMap<String, Instant>> {
    static M: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Waits (cancellably) until a request to `host` may go, keeping at least
/// `interval` between requests to the same host, also across parallel runs.
pub async fn pace(ctx: &NetCtx, host: &str, interval: Duration) -> AiResult<()> {
    if !ctx.services.pacing || interval.is_zero() {
        return ctx.cancel.check();
    }
    let wait = {
        let mut map = next_slots().lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let slot = map.get(host).copied().filter(|t| *t > now).unwrap_or(now);
        map.insert(host.to_string(), slot + interval);
        slot.saturating_duration_since(now)
    };
    sleep(ctx, wait).await
}

/// A cancellable sleep.
pub async fn sleep(ctx: &NetCtx, d: Duration) -> AiResult<()> {
    if d.is_zero() {
        return ctx.cancel.check();
    }
    ctx.cancel
        .run(async {
            tokio::time::sleep(d).await;
            Ok(())
        })
        .await
}

// ---------------------------------------------------------------- cache --

const CACHE_CAP: usize = 256;

fn cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cache_get<T: DeserializeOwned>(key: &str) -> Option<T> {
    let mut map = cache().lock().unwrap_or_else(|e| e.into_inner());
    match map.get(key) {
        Some((expires, value)) if *expires > Instant::now() => serde_json::from_str(value).ok(),
        Some(_) => {
            map.remove(key);
            None
        }
        None => None,
    }
}

pub fn cache_put<T: Serialize>(key: &str, value: &T, ttl: Duration) {
    let Ok(text) = serde_json::to_string(value) else { return };
    let mut map = cache().lock().unwrap_or_else(|e| e.into_inner());
    if map.len() >= CACHE_CAP && !map.contains_key(key) {
        let now = Instant::now();
        map.retain(|_, (exp, _)| *exp > now);
        if map.len() >= CACHE_CAP {
            if let Some(oldest) = map.iter().min_by_key(|(_, (exp, _))| *exp).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
    }
    map.insert(key.to_string(), (Instant::now() + ttl, text));
}

// ----------------------------------------------------------------- HTTP --

pub struct ApiReply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: String,
}

/// Sends a request to one of the fixed APIs (status not checked yet).
pub async fn send(ctx: &NetCtx, req: RequestBuilder, label: &str) -> AiResult<ApiReply> {
    let r = http::send(req, API_TIMEOUT, &ctx.cancel, label).await?;
    Ok(ApiReply { status: r.status, headers: r.headers, body: r.body })
}

/// A plain message for a failed answer from a literature or search service.
/// The service's own text and the address are left out (the address can
/// hold a key).
pub fn service_error(status: StatusCode, headers: &HeaderMap, label: &str) -> AiError {
    let code = status.as_u16();
    let mut err = match code {
        401 | 403 => AiError::new(
            Kind::BadKey,
            format!("{label} didn't accept the request. If it needs a key, check it in Settings > AI > Web."),
        ),
        404 => AiError::new(Kind::NotFound, format!("{label} doesn't know that item.")),
        408 | 504 => AiError::new(Kind::Timeout, format!("{label} took too long to answer.")),
        429 => AiError::new(Kind::RateLimited, format!("{label} is busy (too many requests). Try again in a minute.")),
        400 | 422 => AiError::new(Kind::BadRequest, format!("{label} couldn't handle the request.")),
        500..=599 => AiError::new(Kind::Server, format!("{label} is having trouble right now (error {code}).")),
        _ => AiError::new(Kind::Other, format!("{label} answered with error {code}.")),
    };
    if code == 429 || code == 503 {
        err.retry_after_secs = http::retry_after(headers);
    }
    err
}

/// Builds `base?k=v&...` with proper encoding.
pub fn with_query(base: &str, pairs: &[(&str, &str)]) -> AiResult<reqwest::Url> {
    let mut url = reqwest::Url::parse(base).map_err(|_| AiError::invalid("A service address is not valid."))?;
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in pairs {
            q.append_pair(k, v);
        }
    }
    Ok(url)
}

/// `host[:port]` of a URL, the key for pacing and caching.
pub fn host_key(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| match u.port() {
            Some(p) => format!("{h}:{p}"),
            None => h.to_string(),
        }))
        .unwrap_or_else(|| url.to_string())
}

/// Cuts `text` to at most `max` characters, at a word boundary when one is
/// near. Returns whether it was cut.
pub fn cap_chars(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    let cut: String = text.chars().take(max).collect();
    let trimmed = match cut.rfind(char::is_whitespace) {
        Some(i) if i + 40 >= cut.len() || i > cut.len() * 9 / 10 => cut[..i].to_string(),
        _ => cut,
    };
    (trimmed, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trip_and_expiry() {
        cache_put("net-test-a", &vec![1, 2, 3], Duration::from_secs(60));
        assert_eq!(cache_get::<Vec<i32>>("net-test-a"), Some(vec![1, 2, 3]));
        cache_put("net-test-b", &"x", Duration::from_millis(0));
        assert_eq!(cache_get::<String>("net-test-b"), None);
    }

    #[test]
    fn caps_on_a_word_boundary() {
        let (t, cut) = cap_chars("hello world again", 13);
        assert!(cut);
        assert_eq!(t, "hello world");
        let (t, cut) = cap_chars("short", 10);
        assert!(!cut);
        assert_eq!(t, "short");
        let (t, _) = cap_chars("ééééé", 3);
        assert_eq!(t, "ééé");
    }

    #[test]
    fn pacing_spaces_requests_to_one_host() {
        let rt = crate::ai::mock::runtime();
        rt.block_on(async {
            let ctx = NetCtx::new(Cancel::default());
            let t0 = Instant::now();
            pace(&ctx, "pace-test.example", Duration::from_millis(60)).await.unwrap();
            pace(&ctx, "pace-test.example", Duration::from_millis(60)).await.unwrap();
            pace(&ctx, "other-host.example", Duration::from_millis(60)).await.unwrap();
            let el = t0.elapsed();
            assert!(el >= Duration::from_millis(55) && el < Duration::from_millis(500), "{el:?}");
        });
    }

    #[test]
    fn errors_never_carry_the_address() {
        let e = service_error(StatusCode::FORBIDDEN, &HeaderMap::new(), "OpenAlex");
        assert_eq!(e.kind, Kind::BadKey);
        assert!(!e.message.contains("http"));
        let e = service_error(StatusCode::TOO_MANY_REQUESTS, &HeaderMap::new(), "X");
        assert_eq!(e.kind, Kind::RateLimited);
    }

    #[test]
    fn user_agent_names_only_the_app() {
        assert!(USER_AGENT.starts_with("Texo/"));
        assert!(!USER_AGENT.contains('@'));
    }
}
