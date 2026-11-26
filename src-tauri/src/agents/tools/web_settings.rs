//! Settings > AI > Web: the optional keys (OpenAlex, Tavily, Brave), the
//! SearXNG address, which web search to use, and an optional contact e-mail
//! for Crossref's polite pool.
//!
//! Keys go to the same credential store as the provider keys
//! ([`KeyStore`] service secrets) and never reach the webview: the UI only
//! sees whether one is set. The rest is kept in `ai-web.json` next to
//! `ai.json`, re-read and written atomically on every change.
//!
//! Commands: `web_tools_status`, `web_tools_set_key`, `web_tools_clear_key`,
//! `web_tools_update_settings`.


use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _};

use super::net::{NetCtx, SearchBackend};
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::Cancel;
use crate::ai::keystore::{KeyStore, SecretBackend, SecretStatus, ServiceSecret, SystemKeyring};

pub const FILE: &str = "ai-web.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchProvider {
    Tavily,
    Brave,
    Searxng,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebSettings {
    /// The web search to use. `None`: the first one set up (Tavily, Brave,
    /// SearXNG), or none.
    pub search_provider: Option<SearchProvider>,
    /// Base address of a SearXNG instance.
    pub searxng_url: Option<String>,
    /// Sent to Crossref as `mailto` (their "polite pool"), only when set.
    pub contact_email: Option<String>,
}

/// A change from the UI. Missing fields stay as they are; an empty string
/// clears a text field.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebSettingsPatch {
    /// `"auto"` goes back to the first one set up.
    pub search_provider: Option<String>,
    pub searxng_url: Option<String>,
    pub contact_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebToolsStatus {
    pub settings: WebSettings,
    /// One per [`ServiceSecret`]: openalex, tavily, brave.
    pub keys: Vec<SecretStatus>,
    /// The search the agents will use now, if any.
    pub active_search: Option<SearchProvider>,
    /// Whether the agents get the `web_search` tool.
    pub web_search_available: bool,
    /// Whether OpenAlex joins the paper search.
    pub openalex_enabled: bool,
}

pub struct WebPrefs {
    path: PathBuf,
    lock: Mutex<()>,
}

impl WebPrefs {
    pub fn new(config_dir: &Path) -> Self {
        WebPrefs { path: config_dir.join(FILE), lock: Mutex::new(()) }
    }

    pub fn load(&self) -> WebSettings {
        fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn apply(&self, patch: &WebSettingsPatch) -> AiResult<WebSettings> {
        let provider = match patch.search_provider.as_deref().map(str::trim) {
            None => None,
            Some("" | "auto") => Some(None),
            Some("tavily") => Some(Some(SearchProvider::Tavily)),
            Some("brave") => Some(Some(SearchProvider::Brave)),
            Some("searxng") => Some(Some(SearchProvider::Searxng)),
            Some(_) => return Err(AiError::invalid("Pick Tavily, Brave or SearXNG.")),
        };
        let url = match patch.searxng_url.as_deref().map(str::trim) {
            None => None,
            Some("") => Some(None),
            Some(u) => Some(Some(check_searxng_url(u)?)),
        };
        let email = match patch.contact_email.as_deref().map(str::trim) {
            None => None,
            Some("") => Some(None),
            Some(e) => Some(Some(check_email(e)?)),
        };
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = self.load();
        if let Some(p) = provider {
            s.search_provider = p;
        }
        if let Some(u) = url {
            s.searxng_url = u;
        }
        if let Some(e) = email {
            s.contact_email = e;
        }
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&s).map_err(|e| AiError::new(Kind::Other, e.to_string()))?;
        fs::write(&tmp, text)?;
        if let Err(err) = fs::rename(&tmp, &self.path) {
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }
        Ok(s)
    }
}

/// A SearXNG address: http(s), a server name, no user name or password,
/// no query. Plain http is allowed (no key is sent; it is often on the
/// user's own network).
pub fn check_searxng_url(url: &str) -> AiResult<String> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix("/search").unwrap_or(url);
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AiError::invalid("Enter the SearXNG address, like https://searx.example.org."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AiError::invalid("The address must start with https:// or http://."));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AiError::invalid("Leave the user name and password out of the address."));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AiError::invalid("The address shouldn't contain \"?\" or \"#\"."));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(AiError::invalid("The address needs a server name."));
    }
    Ok(url.to_string())
}

fn check_email(e: &str) -> AiResult<String> {
    let ok = e.len() <= 254
        && !e.chars().any(|c| c.is_whitespace() || c.is_control() || "<>\"(),;:[]\\".contains(c))
        && e.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if ok {
        Ok(e.to_string())
    } else {
        Err(AiError::invalid("That doesn't look like an e-mail address."))
    }
}

/// Settings plus keys, for the commands and for building a [`NetCtx`].
pub struct WebTools {
    prefs: WebPrefs,
    keys: KeyStore,
}

impl WebTools {
    pub fn new(config_dir: &Path, data_dir: &Path) -> Self {
        WebTools::with_backend(config_dir, data_dir, Box::new(SystemKeyring))
    }

    pub fn with_backend(config_dir: &Path, data_dir: &Path, backend: Box<dyn SecretBackend>) -> Self {
        WebTools { prefs: WebPrefs::new(config_dir), keys: KeyStore::new(backend, data_dir) }
    }

    pub fn from_app(app: &AppHandle) -> AiResult<Self> {
        let path_err = |_| AiError::new(Kind::Other, "Texo couldn't find its settings folder.");
        let config = app.path().app_config_dir().map_err(path_err)?;
        let data = app.path().app_data_dir().map_err(path_err)?;
        Ok(WebTools::new(&config, &data))
    }

    fn search_backend(&self, s: &WebSettings) -> Option<SearchBackend> {
        let tavily = || self.keys.get_secret(ServiceSecret::Tavily).map(|(k, _)| SearchBackend::Tavily(k));
        let brave = || self.keys.get_secret(ServiceSecret::Brave).map(|(k, _)| SearchBackend::Brave(k));
        let searx = || s.searxng_url.clone().map(SearchBackend::Searxng);
        match s.search_provider {
            Some(SearchProvider::Tavily) => tavily(),
            Some(SearchProvider::Brave) => brave(),
            Some(SearchProvider::Searxng) => searx(),
            None => tavily().or_else(brave).or_else(searx),
        }
    }

    pub fn status(&self) -> WebToolsStatus {
        let settings = self.prefs.load();
        let active = self.search_backend(&settings).map(|b| match b {
            SearchBackend::Tavily(_) => SearchProvider::Tavily,
            SearchBackend::Brave(_) => SearchProvider::Brave,
            SearchBackend::Searxng(_) => SearchProvider::Searxng,
        });
        let keys: Vec<SecretStatus> = ServiceSecret::ALL.iter().map(|s| self.keys.secret_status(*s)).collect();
        let openalex_enabled = keys.iter().any(|k| k.secret == ServiceSecret::Openalex && k.has_key);
        WebToolsStatus { settings, keys, active_search: active, web_search_available: active.is_some(), openalex_enabled }
    }

    pub fn set_key(&self, secret: ServiceSecret, key: &str) -> AiResult<WebToolsStatus> {
        self.keys.set_secret(secret, key)?;
        Ok(self.status())
    }

    pub fn clear_key(&self, secret: ServiceSecret) -> AiResult<WebToolsStatus> {
        self.keys.clear_secret(secret)?;
        Ok(self.status())
    }

    pub fn update(&self, patch: &WebSettingsPatch) -> AiResult<WebToolsStatus> {
        self.prefs.apply(patch)?;
        Ok(self.status())
    }

    /// The context the agents' web and literature tools run with. Reads
    /// the credential store, which can block: call it off the async
    /// runtime (see [`net_ctx`]).
    pub fn net_ctx(&self, cancel: Cancel) -> NetCtx {
        let settings = self.prefs.load();
        let mut ctx = NetCtx::new(cancel);
        ctx.openalex_key = self.keys.get_secret(ServiceSecret::Openalex).map(|(k, _)| k);
        ctx.contact_email = settings.contact_email.clone();
        ctx.search = self.search_backend(&settings);
        ctx
    }
}

/// Builds the tool context for one agent run (keys read off the async
/// runtime). The agent runtime calls this when a run starts.
pub async fn net_ctx(app: &AppHandle, cancel: Cancel) -> AiResult<NetCtx> {
    let app = app.clone();
    blocking(move || Ok(WebTools::from_app(&app)?.net_ctx(cancel))).await
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AiResult<T> + Send + 'static) -> AiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| AiError::new(Kind::Other, "Something went wrong inside Texo. Try again."))?
}

// ------------------------------------------------------------- commands --

#[tauri::command]
pub async fn web_tools_status(app: AppHandle) -> AiResult<WebToolsStatus> {
    blocking(move || Ok(WebTools::from_app(&app)?.status())).await
}

#[tauri::command]
pub async fn web_tools_set_key(app: AppHandle, secret: ServiceSecret, key: String) -> AiResult<WebToolsStatus> {
    blocking(move || WebTools::from_app(&app)?.set_key(secret, &key)).await
}

#[tauri::command]
pub async fn web_tools_clear_key(app: AppHandle, secret: ServiceSecret) -> AiResult<WebToolsStatus> {
    blocking(move || WebTools::from_app(&app)?.clear_key(secret)).await
}

#[tauri::command]
pub async fn web_tools_update_settings(app: AppHandle, patch: WebSettingsPatch) -> AiResult<WebToolsStatus> {
    blocking(move || WebTools::from_app(&app)?.update(&patch)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::keystore::tests::MemBackend;

    fn tools(dir: &Path) -> WebTools {
        WebTools::with_backend(dir, dir, Box::new(MemBackend::default()))
    }

    #[test]
    fn nothing_configured_means_no_web_search() {
        let dir = tempfile::tempdir().unwrap();
        let t = tools(dir.path());
        let st = t.status();
        assert!(!st.web_search_available);
        assert!(!st.openalex_enabled);
        assert_eq!(st.keys.len(), 3);
        let ctx = t.net_ctx(Cancel::default());
        assert!(ctx.search.is_none() && ctx.openalex_key.is_none() && ctx.contact_email.is_none());
    }

    #[test]
    fn keys_and_choice_of_search() {
        let dir = tempfile::tempdir().unwrap();
        let t = tools(dir.path());
        let st = t.set_key(ServiceSecret::Brave, "brave-0123456789").unwrap();
        assert_eq!(st.active_search, Some(SearchProvider::Brave));
        let st = t.set_key(ServiceSecret::Tavily, "tvly-0123456789").unwrap();
        // Auto picks Tavily first.
        assert_eq!(st.active_search, Some(SearchProvider::Tavily));
        let st = t.update(&WebSettingsPatch { search_provider: Some("brave".into()), ..Default::default() }).unwrap();
        assert_eq!(st.active_search, Some(SearchProvider::Brave));
        // SearXNG chosen without an address: no search.
        let st = t.update(&WebSettingsPatch { search_provider: Some("searxng".into()), ..Default::default() }).unwrap();
        assert!(!st.web_search_available);
        let st = t
            .update(&WebSettingsPatch { searxng_url: Some("http://192.168.1.20:8888/search".into()), ..Default::default() })
            .unwrap();
        assert_eq!(st.settings.searxng_url.as_deref(), Some("http://192.168.1.20:8888"));
        assert_eq!(st.active_search, Some(SearchProvider::Searxng));
        let st = t.update(&WebSettingsPatch { search_provider: Some("auto".into()), ..Default::default() }).unwrap();
        assert_eq!(st.active_search, Some(SearchProvider::Tavily));
        assert!(matches!(t.net_ctx(Cancel::default()).search, Some(SearchBackend::Tavily(_))));
        // The status never carries a key.
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains("tvly-0123456789") && !json.contains("brave-0123456789"));
        assert!(!fs::read_to_string(dir.path().join(FILE)).unwrap().contains("tvly"));
        let st = t.clear_key(ServiceSecret::Tavily).unwrap();
        assert_eq!(st.active_search, Some(SearchProvider::Brave));
        assert!(t.update(&WebSettingsPatch { search_provider: Some("google".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn openalex_key_and_email() {
        let dir = tempfile::tempdir().unwrap();
        let t = tools(dir.path());
        assert!(t.set_key(ServiceSecret::Openalex, "oa key with spaces").is_err());
        assert!(t.set_key(ServiceSecret::Openalex, "oa-0123456789").unwrap().openalex_enabled);
        assert!(t.update(&WebSettingsPatch { contact_email: Some("not-an-email".into()), ..Default::default() }).is_err());
        t.update(&WebSettingsPatch { contact_email: Some(" me@uni.example ".into()), ..Default::default() }).unwrap();
        let ctx = t.net_ctx(Cancel::default());
        assert_eq!(ctx.openalex_key.unwrap().expose(), "oa-0123456789");
        assert_eq!(ctx.contact_email.as_deref(), Some("me@uni.example"));
        let st = t.update(&WebSettingsPatch { contact_email: Some(String::new()), ..Default::default() }).unwrap();
        assert_eq!(st.settings.contact_email, None);
    }

    #[test]
    fn searxng_addresses_are_checked() {
        assert_eq!(check_searxng_url("https://searx.example.org/").unwrap(), "https://searx.example.org");
        assert!(check_searxng_url("http://localhost:8080").is_ok());
        assert!(check_searxng_url("ftp://x.org").is_err());
        assert!(check_searxng_url("https://u:p@x.org").is_err());
        assert!(check_searxng_url("https://x.org/?q=1").is_err());
        assert!(check_searxng_url("nonsense").is_err());
    }
}
