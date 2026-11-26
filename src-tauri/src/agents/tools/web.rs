//! Web tools: `fetch_url` (read one page for the model) and `web_search`
//! (only when the user configured Tavily, Brave or SearXNG).
//!
//! `fetch_url` is the one place where the model picks the address, so it is
//! held to a strict guard against reaching this computer or the local
//! network ("SSRF"):
//! - only `http://` and `https://`, no user name or password in the address;
//! - the host name is resolved first and *every* address it resolves to must
//!   be public: loopback, private, link-local (cloud metadata at
//!   169.254.169.254), CGNAT, multicast, unspecified, documentation and
//!   reserved ranges, IPv4-mapped / -compatible IPv6 and unique-local IPv6
//!   are refused;
//! - the connection itself goes through a resolver applying the same rule,
//!   so a name that changes its answer between the check and the connect
//!   (DNS rebinding) is still refused;
//! - redirects are followed by hand, at most 5, each one checked again;
//! - 15 s in total, 2 MB at most, only HTML, PDF and text;
//! - no proxy (a proxy would resolve names where Texo can't check them).


use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE, LOCATION};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};

use super::html;
use super::net::{self, NetCtx, SearchBackend, USER_AGENT};
use super::pdftext::{self, PdfText};
use crate::ai::error::{AiError, AiResult, Kind};

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_FETCH_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;
/// What the model gets of a page, at most.
pub const MAX_TEXT_CHARS: usize = 12_000;
const FETCH_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const PER_HOST_INTERVAL: Duration = Duration::from_millis(500);

/// Marks resolver refusals inside reqwest's error chain.
const BLOCKED_MARK: &str = "texo-blocked-address";

// ------------------------------------------------------------ the guard --

/// Why an address may not be fetched, or `None` when it is public.
pub fn blocked_reason(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => blocked_v6(v6),
    }
}

fn blocked_v4(ip: Ipv4Addr) -> Option<&'static str> {
    let [a, b, c, _] = ip.octets();
    let reason = if ip.is_unspecified() || a == 0 {
        "an unspecified address"
    } else if ip.is_loopback() {
        "this computer"
    } else if ip.is_private() {
        "the local network"
    } else if ip.is_link_local() {
        "a link-local address (such as a cloud metadata service)"
    } else if a == 100 && (64..128).contains(&b) {
        "a carrier-grade NAT address"
    } else if ip.is_multicast() || ip.is_broadcast() || a >= 240 {
        "a multicast or reserved address"
    } else if (a == 192 && b == 0 && c == 0) || (a == 192 && b == 0 && c == 2) || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113) || (a == 198 && (b == 18 || b == 19)) || (a == 192 && b == 88 && c == 99)
    {
        "a reserved address"
    } else {
        return None;
    };
    Some(reason)
}

fn blocked_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let seg = ip.segments();
    if ip.is_unspecified() {
        return Some("an unspecified address");
    }
    if ip.is_loopback() {
        return Some("this computer");
    }
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated).
    if seg[..5] == [0, 0, 0, 0, 0] && (seg[5] == 0xffff || seg[5] == 0) {
        return Some("an IPv4 address written as IPv6");
    }
    // NAT64 (64:ff9b::/96) carries a real IPv4 address: judge that one.
    if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        let v4 = Ipv4Addr::new((seg[6] >> 8) as u8, seg[6] as u8, (seg[7] >> 8) as u8, seg[7] as u8);
        return blocked_v4(v4);
    }
    // 6to4 (2002::/16) embeds an IPv4 address too.
    if seg[0] == 0x2002 {
        let v4 = Ipv4Addr::new((seg[1] >> 8) as u8, seg[1] as u8, (seg[2] >> 8) as u8, seg[2] as u8);
        return blocked_v4(v4);
    }
    if seg[0] & 0xfe00 == 0xfc00 {
        return Some("the local network");
    }
    if seg[0] & 0xffc0 == 0xfe80 || seg[0] & 0xffc0 == 0xfec0 {
        return Some("a link-local address");
    }
    if seg[0] & 0xff00 == 0xff00 {
        return Some("a multicast address");
    }
    // Documentation, Teredo, ORCHID and other special ranges.
    if (seg[0] == 0x2001 && seg[1] == 0xdb8) || (seg[0] == 0x2001 && seg[1] < 0x200) || (seg[0] == 0x100 && seg[1..4] == [0, 0, 0]) {
        return Some("a reserved address");
    }
    // Only global unicast (2000::/3) is public.
    if seg[0] & 0xe000 != 0x2000 {
        return Some("a reserved address");
    }
    None
}

/// Looks host names up. The system resolver in the app; a fixed table in
/// tests.
pub trait Lookup: Send + Sync {
    fn lookup(&self, host: String) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>>;
}

pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup(&self, host: String) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            Ok(addrs.map(|a| a.ip()).collect())
        })
    }
}

/// How `fetch_url` connects. Tests swap in a table resolver and may allow
/// their own mock server's address.
#[derive(Clone)]
pub struct FetchConfig {
    pub(crate) lookup: Arc<dyn Lookup>,
    /// Addresses allowed despite the rule. Only tests set this.
    pub(crate) allow: Vec<IpAddr>,
    client: Arc<OnceLock<AiResult<Client>>>,
}

impl Default for FetchConfig {
    fn default() -> Self {
        FetchConfig { lookup: Arc::new(SystemLookup), allow: Vec::new(), client: Arc::new(OnceLock::new()) }
    }
}

impl FetchConfig {
    fn check_ip(&self, ip: IpAddr) -> AiResult<()> {
        if self.allow.contains(&ip) {
            return Ok(());
        }
        match blocked_reason(ip) {
            Some(why) => Err(blocked(why)),
            None => Ok(()),
        }
    }

    fn client(&self) -> AiResult<Client> {
        self.client
            .get_or_init(|| {
                let resolver = GuardedResolver { config: FetchConfig { client: Arc::new(OnceLock::new()), ..self.clone() } };
                Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .user_agent(USER_AGENT)
                    .redirect(reqwest::redirect::Policy::none())
                    .no_proxy()
                    .dns_resolver(Arc::new(resolver))
                    .build()
                    .map_err(|_| AiError::new(Kind::Tls, "Texo couldn't set up a secure connection on this computer."))
            })
            .clone()
    }

    /// Checks one address before it is requested: scheme, credentials, and
    /// every IP the host resolves to.
    pub async fn check_url(&self, url: &Url) -> AiResult<()> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(AiError::invalid("Only http:// and https:// addresses can be opened."));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(AiError::invalid("Addresses with a user name or password can't be opened."));
        }
        if url.port() == Some(0) {
            return Err(AiError::invalid("That address isn't valid."));
        }
        // The URL parser has already normalised numeric hosts ("0x7f.1",
        // "2130706433") to dotted IPv4, and IPv6 to "[...]".
        let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
            return Err(AiError::invalid("That address has no server name."));
        };
        let literal = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
        match literal.parse::<IpAddr>() {
            Ok(ip) => self.check_ip(ip),
            Err(_) => {
                let name = host.trim_end_matches('.').to_ascii_lowercase();
                if name == "localhost" || name.ends_with(".localhost") {
                    return Err(blocked("this computer"));
                }
                let ips = self.lookup.lookup(name).await.map_err(|_| {
                    AiError::new(Kind::NotFound, "That web address doesn't exist (its server name couldn't be found).")
                })?;
                if ips.is_empty() {
                    return Err(AiError::new(Kind::NotFound, "That web address doesn't exist (its server name couldn't be found)."));
                }
                for ip in ips {
                    self.check_ip(ip)?;
                }
                Ok(())
            }
        }
    }
}

fn blocked(why: &str) -> AiError {
    AiError::new(
        Kind::Forbidden,
        format!("For safety, Texo doesn't open addresses on {why}. Only public web pages can be read."),
    )
}

/// The resolver the fetch client connects with: the same rule as
/// [`FetchConfig::check_url`], applied to the addresses actually used.
struct GuardedResolver {
    config: FetchConfig,
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let config = self.config.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let ips = config.lookup.lookup(host).await?;
            if ips.is_empty() {
                return Err(Box::new(std::io::Error::new(std::io::ErrorKind::NotFound, "no addresses"))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            for ip in &ips {
                if config.check_ip(*ip).is_err() {
                    return Err(Box::new(std::io::Error::new(std::io::ErrorKind::PermissionDenied, BLOCKED_MARK))
                        as Box<dyn std::error::Error + Send + Sync>);
                }
            }
            let addrs: Vec<SocketAddr> = ips.into_iter().map(|ip| SocketAddr::new(ip, 0)).collect();
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

// ------------------------------------------------------------ fetch_url --

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageKind {
    Html,
    Pdf,
    Text,
}

/// A page read for the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    /// Where the page was read from, after redirects.
    pub url: String,
    pub title: Option<String>,
    pub kind: PageKind,
    /// Readable text, at most [`MAX_TEXT_CHARS`] characters.
    pub text: String,
    /// The text was cut (page longer than the cap, or than 2 MB).
    pub truncated: bool,
    /// A remark for the model ("PDF not readable", ...).
    pub note: Option<String>,
}

impl FetchedPage {
    /// The tool result handed to the model.
    pub fn to_tool_text(&self) -> String {
        let mut out = format!("URL: {}\n", self.url);
        if let Some(t) = &self.title {
            out.push_str(&format!("Title: {t}\n"));
        }
        if let Some(n) = &self.note {
            out.push_str(&format!("Note: {n}\n"));
        }
        out.push('\n');
        out.push_str(&self.text);
        if self.truncated {
            out.push_str("\n\n[... the rest of the page was cut off]");
        }
        out
    }
}

/// Reads one public web page (HTML, PDF or text) as plain text.
pub async fn fetch_url(ctx: &NetCtx, address: &str) -> AiResult<FetchedPage> {
    let address = address.trim();
    if address.is_empty() || address.len() > 2048 {
        return Err(AiError::invalid("Give a full web address, like https://example.org/page."));
    }
    let mut url = Url::parse(address).map_err(|_| AiError::invalid("Give a full web address, like https://example.org/page."))?;
    url.set_fragment(None);
    let cache_key = format!("fetch|{url}");
    if let Some(hit) = net::cache_get::<FetchedPage>(&cache_key) {
        return Ok(hit);
    }
    let config = &ctx.fetch;
    let client = config.client()?;
    let deadline = Instant::now() + FETCH_TIMEOUT;
    let mut redirects = 0;
    let resp = loop {
        config.check_url(&url).await?;
        net::pace(ctx, &net::host_key(url.as_str()), PER_HOST_INTERVAL).await?;
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(too_slow());
        }
        let req = client
            .get(url.clone())
            .header(ACCEPT, "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.1")
            .timeout(left);
        let resp = ctx.cancel.run(async { req.send().await.map_err(|e| map_fetch_error(&e)) }).await?;
        if resp.status().is_redirection() && resp.status() != StatusCode::NOT_MODIFIED {
            let Some(next) = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()) else {
                return Err(AiError::new(Kind::BadResponse, "The page sent a redirect without saying where to."));
            };
            if redirects >= MAX_REDIRECTS {
                return Err(AiError::new(Kind::BadResponse, "The page redirected too many times."));
            }
            redirects += 1;
            url = url.join(next).map_err(|_| AiError::new(Kind::BadResponse, "The page redirected to an invalid address."))?;
            url.set_fragment(None);
            continue;
        }
        break resp;
    };
    let status = resp.status();
    if !status.is_success() {
        return Err(page_status_error(status));
    }
    let headers = resp.headers().clone();
    let final_url = url.to_string();
    let declared = content_type(&headers);
    if let Some(ct) = &declared {
        if kind_for(ct).is_none() && !is_generic(ct) {
            return Err(unsupported());
        }
    }
    let too_big_declared = resp.content_length().is_some_and(|n| n as usize > MAX_FETCH_BYTES);
    if too_big_declared && declared.as_deref().and_then(kind_for) == Some(PageKind::Pdf) {
        return Err(AiError::new(Kind::TooLarge, "That PDF is larger than 2 MB, which is more than Texo reads."));
    }
    let (bytes, cut) = read_capped(ctx, resp, deadline).await?;
    let kind = match declared.as_deref().and_then(kind_for) {
        Some(k) => k,
        None => sniff(&bytes).ok_or_else(unsupported)?,
    };
    let charset = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').find_map(|p| p.trim().strip_prefix("charset=").map(|c| c.trim_matches('"').to_ascii_lowercase())));
    let page = match kind {
        PageKind::Pdf => {
            if cut {
                return Err(AiError::new(Kind::TooLarge, "That PDF is larger than 2 MB, which is more than Texo reads."));
            }
            match pdftext::extract(&bytes) {
                PdfText::Text(t) => build_page(final_url, None, kind, &t, cut, None),
                PdfText::NotReadable(why) => FetchedPage {
                    url: final_url,
                    title: None,
                    kind,
                    text: String::new(),
                    truncated: false,
                    note: Some(format!("PDF not readable: {why}")),
                },
            }
        }
        PageKind::Html => {
            let text = decode_text(&bytes, charset.as_deref().or_else(|| meta_charset(&bytes)));
            let e = html::html_to_text(&text);
            let note = e.text.trim().is_empty().then(|| {
                "The page has no readable text (it may need JavaScript, which Texo doesn't run).".to_string()
            });
            build_page(final_url, e.title, kind, &e.text, cut, note)
        }
        PageKind::Text => {
            let text = decode_text(&bytes, charset.as_deref());
            build_page(final_url, None, kind, &text, cut, None)
        }
    };
    net::cache_put(&cache_key, &page, FETCH_CACHE_TTL);
    Ok(page)
}

fn build_page(url: String, title: Option<String>, kind: PageKind, text: &str, cut: bool, note: Option<String>) -> FetchedPage {
    let (text, capped) = net::cap_chars(text.trim(), MAX_TEXT_CHARS);
    FetchedPage { url, title, kind, text, truncated: capped || cut, note }
}

async fn read_capped(ctx: &NetCtx, mut resp: reqwest::Response, deadline: Instant) -> AiResult<(Vec<u8>, bool)> {
    let mut body = Vec::new();
    let mut cut = false;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(too_slow());
        }
        let chunk = ctx
            .cancel
            .run(async {
                match tokio::time::timeout(left, resp.chunk()).await {
                    Ok(r) => r.map_err(|e| map_fetch_error(&e)),
                    Err(_) => Err(too_slow()),
                }
            })
            .await?;
        let Some(chunk) = chunk else { break };
        let room = MAX_FETCH_BYTES - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            cut = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, cut))
}

fn content_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or_default().trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
}

fn kind_for(ct: &str) -> Option<PageKind> {
    match ct {
        "text/html" | "application/xhtml+xml" => Some(PageKind::Html),
        "application/pdf" | "application/x-pdf" => Some(PageKind::Pdf),
        "application/json" | "application/xml" | "application/atom+xml" | "application/rss+xml" | "application/x-bibtex"
        | "application/x-tex" | "application/x-latex" | "application/ld+json" => Some(PageKind::Text),
        t if t.starts_with("text/") => Some(PageKind::Text),
        _ => None,
    }
}

/// Types servers send when they don't know better; the bytes decide.
fn is_generic(ct: &str) -> bool {
    matches!(ct, "application/octet-stream" | "binary/octet-stream" | "application/unknown" | "application/download")
}

fn sniff(bytes: &[u8]) -> Option<PageKind> {
    if bytes.starts_with(b"%PDF-") {
        return Some(PageKind::Pdf);
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    if head.trim_start().starts_with("<!doctype html") || head.contains("<html") {
        return Some(PageKind::Html);
    }
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.contains(&0) {
        return None;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => Some(PageKind::Text),
        // Cut in the middle of a character at the end of the sample.
        Err(e) if e.error_len().is_none() => Some(PageKind::Text),
        Err(_) => None,
    }
}

fn meta_charset(bytes: &[u8]) -> Option<&'static str> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
    if head.contains("charset=iso-8859-1") || head.contains("charset=\"iso-8859-1\"") || head.contains("charset=windows-1252") || head.contains("charset=\"windows-1252\"") {
        Some("windows-1252")
    } else {
        None
    }
}

/// UTF-8 (lossy), or Latin-1 / Windows-1252 when the page says so.
fn decode_text(bytes: &[u8], charset: Option<&str>) -> String {
    match charset {
        Some("iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "us-ascii") => {
            bytes.iter().map(|&b| b as char).collect()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn too_slow() -> AiError {
    AiError::new(Kind::Timeout, "The page took too long to load (more than 15 seconds).")
}

fn unsupported() -> AiError {
    AiError::new(
        Kind::InvalidInput,
        "That address isn't a web page, PDF or text file (images, videos and downloads aren't opened).",
    )
}

fn page_status_error(status: StatusCode) -> AiError {
    let code = status.as_u16();
    match code {
        401 | 403 => AiError::new(Kind::Forbidden, format!("The page refused access (error {code}); it may need a login.")),
        404 | 410 => AiError::new(Kind::NotFound, format!("The page doesn't exist (error {code}).")),
        429 => AiError::new(Kind::RateLimited, "The site says too many requests were made. Try later."),
        500..=599 => AiError::new(Kind::Server, format!("The site is having trouble (error {code}).")),
        _ => AiError::new(Kind::Other, format!("The page answered with error {code}.")),
    }
}

fn map_fetch_error(err: &reqwest::Error) -> AiError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(s) = source {
        if s.to_string().contains(BLOCKED_MARK) {
            return blocked("the local network or this computer");
        }
        source = s.source();
    }
    if err.is_timeout() {
        return too_slow();
    }
    if err.is_connect() {
        return AiError::new(Kind::Offline, "Texo couldn't reach that site. Check the address and your internet connection.");
    }
    AiError::new(Kind::Network, "The connection to that site failed.")
}

// ----------------------------------------------------------- web_search --

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub query: String,
    /// "Tavily", "Brave Search" or "SearXNG".
    pub source: String,
    pub hits: Vec<SearchHit>,
}

impl WebSearchResult {
    pub fn to_tool_text(&self) -> String {
        if self.hits.is_empty() {
            return format!("No web results for \"{}\".", self.query);
        }
        let mut out = format!("Web results for \"{}\" (from {}):\n", self.query, self.source);
        for (i, h) in self.hits.iter().enumerate() {
            out.push_str(&format!("\n{}. {}\n   {}\n   {}\n", i + 1, h.title, h.url, h.snippet));
        }
        out
    }
}

/// Searches the web with the service the user configured. Errors with a
/// plain message when none is.
pub async fn web_search(ctx: &NetCtx, query: &str, limit: usize) -> AiResult<WebSearchResult> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 400 {
        return Err(AiError::invalid("Give a short search query."));
    }
    let Some(backend) = &ctx.search else {
        return Err(AiError::new(
            Kind::NoKey,
            "Web search isn't set up. Add a Tavily or Brave key, or a SearXNG address, in Settings > AI > Web.",
        ));
    };
    let limit = limit.clamp(1, 10);
    let label = backend.label();
    let cache_key = format!("search|{label}|{limit}|{query}");
    if let Some(hit) = net::cache_get::<WebSearchResult>(&cache_key) {
        return Ok(hit);
    }
    let client = ctx.client()?;
    let (url_for_pace, req) = match backend {
        SearchBackend::Tavily(key) => (
            ctx.services.tavily.clone(),
            client
                .post(&ctx.services.tavily)
                .bearer_auth(key.expose())
                .json(&serde_json::json!({ "query": query, "max_results": limit, "search_depth": "basic" })),
        ),
        SearchBackend::Brave(key) => {
            let url = net::with_query(&ctx.services.brave, &[("q", query), ("count", &limit.to_string())])?;
            (
                ctx.services.brave.clone(),
                client.get(url).header("X-Subscription-Token", key.expose()).header(ACCEPT, "application/json"),
            )
        }
        SearchBackend::Searxng(base) => {
            let url = net::with_query(&format!("{}/search", base.trim_end_matches('/')), &[("q", query), ("format", "json")])?;
            (base.clone(), client.get(url).header(ACCEPT, "application/json"))
        }
    };
    net::pace(ctx, &net::host_key(&url_for_pace), Duration::from_millis(1000)).await?;
    let reply = net::send(ctx, req, label).await?;
    if !reply.status.is_success() {
        if matches!(backend, SearchBackend::Searxng(_)) && reply.status == StatusCode::FORBIDDEN {
            return Err(AiError::new(
                Kind::Forbidden,
                "The SearXNG server refused JSON results. Its owner must enable the \"json\" format in settings.yml.",
            ));
        }
        return Err(net::service_error(reply.status, &reply.headers, label));
    }
    let v: serde_json::Value = serde_json::from_str(&reply.body)
        .map_err(|_| AiError::new(Kind::BadResponse, format!("{label} sent an answer Texo couldn't read.")))?;
    let items = match backend {
        SearchBackend::Tavily(_) => v.get("results"),
        SearchBackend::Brave(_) => v.get("web").and_then(|w| w.get("results")),
        SearchBackend::Searxng(_) => v.get("results"),
    };
    let snippet_field = match backend {
        SearchBackend::Brave(_) => "description",
        _ => "content",
    };
    let hits = items
        .and_then(|i| i.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let url = r.get("url")?.as_str()?.to_string();
                    if !(url.starts_with("http://") || url.starts_with("https://")) {
                        return None;
                    }
                    let title = html::decode_entities(r.get("title").and_then(|t| t.as_str()).unwrap_or(&url));
                    let snippet = r.get(snippet_field).and_then(|t| t.as_str()).unwrap_or_default();
                    let snippet = html::html_to_text(snippet).text;
                    Some(SearchHit { title: strip_tags(&title), url, snippet: net::cap_chars(&snippet, 400).0 })
                })
                .take(limit)
                .collect()
        })
        .unwrap_or_default();
    let result = WebSearchResult { query: query.to_string(), source: label.to_string(), hits };
    net::cache_put(&cache_key, &result, Duration::from_secs(30 * 60));
    Ok(result)
}

fn strip_tags(s: &str) -> String {
    if s.contains('<') {
        html::html_to_text(s).text
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http::{ApiKey, Cancel};
    use crate::ai::mock::{runtime, Canned, MockServer};
    use std::collections::HashMap;

    struct Table(HashMap<String, Vec<IpAddr>>);

    impl Lookup for Table {
        fn lookup(&self, host: String) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
            let r = self.0.get(&host).cloned().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "nx"));
            Box::pin(async move { r })
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    /// A context whose resolver knows `names`, and which may reach the
    /// mock server on 127.0.0.1 (and nothing else private).
    fn ctx(names: &[(&str, &str)], allow_mock: bool) -> NetCtx {
        let mut c = NetCtx::new(Cancel::default());
        c.services.pacing = false;
        let table = names.iter().map(|(n, a)| (n.to_string(), vec![ip(a)])).collect();
        c.fetch = FetchConfig {
            lookup: Arc::new(Table(table)),
            allow: if allow_mock { vec![ip("127.0.0.1")] } else { Vec::new() },
            client: Arc::new(OnceLock::new()),
        };
        c
    }

    fn html(body: &str) -> Canned {
        let mut c = Canned::json(200, serde_json::Value::Null);
        c.body = body.to_string();
        c.content_type = "text/html; charset=utf-8";
        c
    }

    fn redirect(to: &str) -> Canned {
        let mut c = Canned::json(302, serde_json::Value::Null).header("location", to);
        c.body = String::new();
        c
    }

    #[test]
    fn classifies_addresses() {
        for bad in [
            "127.0.0.1", "127.0.0.2", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "240.0.0.1", "192.0.2.1", "::1", "::",
            "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
            "2001:db8::1", "64:ff9b::a00:1", "2002:c0a8:0101::1",
        ] {
            assert!(blocked_reason(ip(bad)).is_some(), "{bad} should be blocked");
        }
        for good in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "64:ff9b::808:808", "2002:0808:0808::1"] {
            assert!(blocked_reason(ip(good)).is_none(), "{good} should be allowed");
        }
    }

    #[test]
    fn refuses_private_targets_before_connecting() {
        let rt = runtime();
        rt.block_on(async {
            let c = ctx(&[("evil.example", "10.0.0.5"), ("rebind.example", "127.0.0.1"), ("meta.example", "169.254.169.254")], false);
            for url in [
                "http://localhost/",
                "http://LOCALHOST./x",
                "http://app.localhost/",
                "http://127.0.0.1/",
                "http://127.0.0.2:8080/",
                "http://10.0.0.1/",
                "http://172.16.5.4/",
                "http://192.168.0.10/",
                "http://169.254.169.254/latest/meta-data/",
                "http://[::1]/",
                "http://[::ffff:127.0.0.1]/",
                "http://[::ffff:7f00:1]/",
                "http://2130706433/",
                "http://0x7f.1/",
                "http://0/",
                "http://evil.example/",
                "http://rebind.example/",
                "https://meta.example/",
            ] {
                let err = fetch_url(&c, url).await.unwrap_err();
                assert_eq!(err.kind, Kind::Forbidden, "{url}: {}", err.message);
                assert!(err.message.contains("For safety"), "{url}");
            }
            for (url, kind) in [
                ("file:///etc/passwd", Kind::InvalidInput),
                ("ftp://example.org/", Kind::InvalidInput),
                ("gopher://example.org/", Kind::InvalidInput),
                ("http://user:pw@example.org/", Kind::InvalidInput),
                ("not a url", Kind::InvalidInput),
                ("http://unknown.example/", Kind::NotFound),
            ] {
                assert_eq!(fetch_url(&c, url).await.unwrap_err().kind, kind, "{url}");
            }
        });
    }

    #[test]
    fn reads_a_page_through_redirects() {
        let rt = runtime();
        rt.block_on(async {
            let target = MockServer::start(vec![html(
                "<html><head><title>Paper page</title></head><body><nav>menu</nav><p>The abstract text.</p></body></html>",
            )]);
            let first = MockServer::start(vec![redirect(&format!("{}/final", target.base_url))]);
            let c = ctx(&[], true);
            let page = fetch_url(&c, &format!("{}/start#frag", first.base_url)).await.unwrap();
            assert_eq!(page.title.as_deref(), Some("Paper page"));
            assert_eq!(page.kind, PageKind::Html);
            assert_eq!(page.text, "The abstract text.");
            assert!(page.url.ends_with("/final"));
            assert!(!page.truncated);
            let rec = first.recorded();
            assert_eq!(rec[0].path, "/start");
            assert!(rec[0].header("user-agent").unwrap().starts_with("Texo/"));
            assert!(page.to_tool_text().contains("Title: Paper page"));
        });
    }

    #[test]
    fn redirects_to_private_addresses_are_refused() {
        let rt = runtime();
        rt.block_on(async {
            for to in [
                "http://169.254.169.254/latest/meta-data/",
                "http://10.0.0.7/admin",
                "http://[::1]:8080/",
                "http://localhost:631/",
                "http://intranet.example/",
                "file:///etc/passwd",
            ] {
                let server = MockServer::start(vec![redirect(to)]);
                let c = ctx(&[("intranet.example", "192.168.10.10")], true);
                let err = fetch_url(&c, &format!("{}/go", server.base_url)).await.unwrap_err();
                assert!(matches!(err.kind, Kind::Forbidden | Kind::InvalidInput), "{to}: {err:?}");
            }
            // A redirect to a relative path stays on the same (allowed) host.
            let server = MockServer::start(vec![redirect("/next"), html("<p>here</p>")]);
            let c = ctx(&[], true);
            assert_eq!(fetch_url(&c, &format!("{}/a", server.base_url)).await.unwrap().text, "here");
        });
    }

    #[test]
    fn stops_after_five_redirects() {
        let rt = runtime();
        rt.block_on(async {
            let server = MockServer::start((0..7).map(|i| redirect(&format!("/r{i}"))).collect());
            let c = ctx(&[], true);
            let err = fetch_url(&c, &format!("{}/start", server.base_url)).await.unwrap_err();
            assert!(err.message.contains("too many times"), "{err:?}");
            assert_eq!(server.recorded().len(), 6);
        });
    }

    #[test]
    fn the_connection_resolver_checks_again() {
        // The pre-check passes (allowed), but the resolver used to connect
        // applies the rule to what the name resolves to now.
        let rt = runtime();
        rt.block_on(async {
            let server = MockServer::start(vec![html("<p>secret</p>")]);
            let port = server.base_url.rsplit(':').next().unwrap().to_string();
            let c = ctx(&[("rebinding.example", "127.0.0.1")], false);
            let resolver = GuardedResolver { config: c.fetch.clone() };
            let Ok(name) = "rebinding.example".parse::<reqwest::dns::Name>() else { panic!("name") };
            let res = reqwest::dns::Resolve::resolve(&resolver, name).await;
            assert!(res.is_err());
            let err = c.fetch.check_url(&Url::parse(&format!("http://rebinding.example:{port}/")).unwrap()).await.unwrap_err();
            assert_eq!(err.kind, Kind::Forbidden);
        });
    }

    #[test]
    fn content_types_and_caps() {
        let rt = runtime();
        rt.block_on(async {
            let mut img = Canned::json(200, serde_json::Value::Null);
            img.body = "GIF89a....".into();
            img.content_type = "image/gif";
            let mut long = Canned::json(200, serde_json::Value::Null);
            long.body = "word ".repeat(5000);
            long.content_type = "text/plain";
            let mut pdf = Canned::json(200, serde_json::Value::Null);
            pdf.body = String::from_utf8_lossy(&crate::agents::tools::pdftext::tests::sample_pdf_plain(
                "BT (A readable sentence inside a small PDF document for the test.) Tj ET",
            ))
            .into_owned();
            pdf.content_type = "application/pdf";
            let mut bin = Canned::json(200, serde_json::Value::Null);
            bin.body = "\u{0}\u{1}\u{2}binary".into();
            bin.content_type = "application/octet-stream";
            let mut big = Canned::json(200, serde_json::Value::Null);
            big.body = "x".repeat(MAX_FETCH_BYTES + 1000);
            big.content_type = "text/plain";
            let server = MockServer::start(vec![img, long, pdf, bin, big, Canned::json(404, serde_json::json!({}))]);
            let c = ctx(&[], true);
            let b = &server.base_url;
            assert_eq!(fetch_url(&c, &format!("{b}/img")).await.unwrap_err().kind, Kind::InvalidInput);
            let page = fetch_url(&c, &format!("{b}/long")).await.unwrap();
            assert!(page.truncated);
            assert!(page.text.chars().count() <= MAX_TEXT_CHARS);
            let page = fetch_url(&c, &format!("{b}/doc.pdf")).await.unwrap();
            assert_eq!(page.kind, PageKind::Pdf);
            assert!(page.text.contains("A readable sentence"), "{page:?}");
            assert_eq!(fetch_url(&c, &format!("{b}/bin")).await.unwrap_err().kind, Kind::InvalidInput);
            let page = fetch_url(&c, &format!("{b}/big")).await.unwrap();
            assert!(page.truncated);
            assert_eq!(fetch_url(&c, &format!("{b}/missing")).await.unwrap_err().kind, Kind::NotFound);
            // Cached: no new request.
            let n = server.recorded().len();
            fetch_url(&c, &format!("{b}/long")).await.unwrap();
            assert_eq!(server.recorded().len(), n);
        });
    }

    #[test]
    fn unreadable_pdf_says_so() {
        let rt = runtime();
        rt.block_on(async {
            let mut pdf = Canned::json(200, serde_json::Value::Null);
            pdf.body = "%PDF-1.4\n%nothing here\n".into();
            pdf.content_type = "application/pdf";
            let server = MockServer::start(vec![pdf]);
            let page = fetch_url(&ctx(&[], true), &format!("{}/scan.pdf", server.base_url)).await.unwrap();
            assert!(page.note.as_deref().unwrap().starts_with("PDF not readable"));
            assert!(page.text.is_empty());
        });
    }

    #[test]
    fn web_search_backends() {
        let rt = runtime();
        rt.block_on(async {
            let mut c = ctx(&[], false);
            assert!(!c.web_search_available());
            assert_eq!(web_search(&c, "latex", 5).await.unwrap_err().kind, Kind::NoKey);

            let tavily = MockServer::start(vec![Canned::json(
                200,
                serde_json::json!({"query": "q", "results": [
                    {"title": "T1", "url": "https://a.example/1", "content": "Snippet <b>one</b>", "score": 0.9},
                    {"title": "bad", "url": "javascript:alert(1)", "content": "x"}
                ]}),
            )]);
            c.services.tavily = format!("{}/search", tavily.base_url);
            c.search = Some(SearchBackend::Tavily(ApiKey::new("tvly-test-key-123".into())));
            let r = web_search(&c, "tavily query", 5).await.unwrap();
            assert_eq!(r.hits.len(), 1);
            assert_eq!(r.hits[0].snippet, "Snippet one");
            let rec = &tavily.recorded()[0];
            assert_eq!(rec.header("authorization"), Some("Bearer tvly-test-key-123"));
            assert_eq!(rec.json()["query"], "tavily query");
            assert_eq!(rec.json()["max_results"], 5);

            let brave = MockServer::start(vec![Canned::json(
                200,
                serde_json::json!({"web": {"results": [{"title": "B &amp; C", "url": "https://b.example/", "description": "desc"}]}}),
            )]);
            c.services.brave = format!("{}/res/v1/web/search", brave.base_url);
            c.search = Some(SearchBackend::Brave(ApiKey::new("brave-key-123".into())));
            let r = web_search(&c, "brave query", 3).await.unwrap();
            assert_eq!(r.hits[0].title, "B & C");
            assert_eq!(r.source, "Brave Search");
            let rec = &brave.recorded()[0];
            assert_eq!(rec.header("x-subscription-token"), Some("brave-key-123"));
            assert!(rec.path.contains("q=brave+query") && rec.path.contains("count=3"), "{}", rec.path);

            let searx = MockServer::start(vec![
                Canned::json(200, serde_json::json!({"results": [{"title": "S", "url": "http://s.example/", "content": "c"}]})),
                Canned::json(403, serde_json::json!({})),
            ]);
            c.search = Some(SearchBackend::Searxng(format!("{}/", searx.base_url)));
            let r = web_search(&c, "searx query", 3).await.unwrap();
            assert_eq!(r.hits[0].url, "http://s.example/");
            assert!(searx.recorded()[0].path.starts_with("/search?q=searx+query&format=json"));
            let err = web_search(&c, "searx other", 3).await.unwrap_err();
            assert!(err.message.contains("json"), "{err:?}");
            assert!(r.to_tool_text().contains("1. S"));
        });
    }

    #[test]
    fn search_errors_hide_the_key() {
        let rt = runtime();
        rt.block_on(async {
            let server = MockServer::start(vec![Canned::json(401, serde_json::json!({"detail": "bad key tvly-secret-999"}))]);
            let mut c = ctx(&[], false);
            c.services.tavily = server.base_url.clone();
            c.search = Some(SearchBackend::Tavily(ApiKey::new("tvly-secret-999".into())));
            let err = web_search(&c, "x", 3).await.unwrap_err();
            assert_eq!(err.kind, Kind::BadKey);
            assert!(!err.message.contains("tvly-secret-999"));
        });
    }
}
