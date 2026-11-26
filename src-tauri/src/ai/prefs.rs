//! AI preferences, kept in `ai.json` next to `settings.json` (never any keys).
//!
//! Every change re-reads the file, applies the change and writes it back
//! atomically, so two Texo windows don't overwrite each other's choices with
//! stale copies.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::error::{AiError, AiResult, Kind};
use super::providers::ProviderId;

pub const FILE: &str = "ai.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// AI help can be turned off entirely.
    pub enabled: bool,
    pub provider: ProviderId,
    /// The model picked for each provider.
    pub models: BTreeMap<ProviderId, String>,
    /// Base URL of the custom OpenAI-compatible server.
    pub custom_base_url: Option<String>,
    /// Providers whose privacy notice the user has accepted.
    pub notice_accepted: Vec<ProviderId>,
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            enabled: true,
            provider: ProviderId::Nvidia,
            models: BTreeMap::new(),
            custom_base_url: None,
            notice_accepted: Vec::new(),
        }
    }
}

/// A change from the UI. Missing fields stay as they are.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettingsPatch {
    pub enabled: Option<bool>,
    pub provider: Option<ProviderId>,
    /// Sets (or, with `model: null`, forgets) the model for one provider.
    pub model: Option<ModelChoice>,
    /// An empty string removes it.
    pub custom_base_url: Option<String>,
    /// Records that the user accepted the notice for this provider.
    pub accept_notice: Option<ProviderId>,
    /// Forgets every accepted notice, so each is shown again.
    pub reset_notices: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub provider: ProviderId,
    pub model: Option<String>,
}

pub struct Prefs {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Prefs {
    pub fn new(config_dir: &Path) -> Self {
        Prefs { path: config_dir.join(FILE), lock: Mutex::new(()) }
    }

    pub fn load(&self) -> AiSettings {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn apply(&self, patch: &AiSettingsPatch) -> AiResult<AiSettings> {
        // Validate before touching the file.
        if let Some(choice) = &patch.model {
            if let Some(m) = &choice.model {
                check_model_id(m)?;
            }
        }
        let url = match &patch.custom_base_url {
            Some(u) if u.trim().is_empty() => Some(None),
            Some(u) => Some(Some(check_base_url(u)?)),
            None => None,
        };
        self.update(|s| {
            if let Some(e) = patch.enabled {
                s.enabled = e;
            }
            if let Some(p) = patch.provider {
                s.provider = p;
            }
            if let Some(choice) = &patch.model {
                match &choice.model {
                    Some(m) => {
                        s.models.insert(choice.provider, m.trim().to_string());
                    }
                    None => {
                        s.models.remove(&choice.provider);
                    }
                }
            }
            if let Some(u) = url {
                s.custom_base_url = u;
            }
            if patch.reset_notices == Some(true) {
                s.notice_accepted.clear();
            }
            if let Some(p) = patch.accept_notice {
                if !s.notice_accepted.contains(&p) {
                    s.notice_accepted.push(p);
                }
            }
        })
    }

    pub fn update(&self, change: impl FnOnce(&mut AiSettings)) -> AiResult<AiSettings> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = self.load();
        change(&mut s);
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&s).map_err(|e| AiError::new(Kind::Other, e.to_string()))?)?;
        if let Err(err) = fs::rename(&tmp, &self.path) {
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }
        Ok(s)
    }
}

pub fn check_model_id(id: &str) -> AiResult<()> {
    let id = id.trim();
    if id.is_empty() || id.len() > 200 || id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AiError::invalid("That model name isn't valid."));
    }
    Ok(())
}

/// A custom server must use HTTPS, except on this computer (a local Ollama
/// or LM Studio), so a key is never sent in the clear over a network.
pub fn check_base_url(url: &str) -> AiResult<String> {
    let url = url.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AiError::invalid("Enter the server address, like http://localhost:11434/v1."))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AiError::invalid("Leave the user name and password out of the address."));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AiError::invalid("The address shouldn't contain \"?\" or \"#\"."));
    }
    let Some(host) = parsed.host_str().filter(|h| !h.is_empty()) else {
        return Err(AiError::invalid("The address needs a server name."));
    };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let local = host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    match parsed.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => {
            return Err(AiError::invalid(
                "Use an https:// address for servers on other computers (http:// is only allowed for this computer).",
            ))
        }
        _ => return Err(AiError::invalid("The address must start with https:// or http://.")),
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_nvidia_and_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let p = Prefs::new(dir.path());
        let s = p.load();
        assert!(s.enabled);
        assert_eq!(s.provider, ProviderId::Nvidia);
        assert!(s.notice_accepted.is_empty());
    }

    #[test]
    fn patches_merge_with_what_is_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let a = Prefs::new(dir.path());
        let b = Prefs::new(dir.path()); // another Texo window
        a.apply(&AiSettingsPatch {
            model: Some(ModelChoice { provider: ProviderId::Groq, model: Some("openai/gpt-oss-120b".into()) }),
            ..Default::default()
        })
        .unwrap();
        let s = b
            .apply(&AiSettingsPatch { accept_notice: Some(ProviderId::Groq), ..Default::default() })
            .unwrap();
        assert_eq!(s.models.get(&ProviderId::Groq).map(String::as_str), Some("openai/gpt-oss-120b"));
        assert_eq!(s.notice_accepted, vec![ProviderId::Groq]);

        let s = a
            .apply(&AiSettingsPatch {
                enabled: Some(false),
                provider: Some(ProviderId::Custom),
                custom_base_url: Some("http://localhost:11434/v1/".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(!s.enabled);
        assert_eq!(s.custom_base_url.as_deref(), Some("http://localhost:11434/v1"));
        assert_eq!(s.notice_accepted, vec![ProviderId::Groq]);
        let text = fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(text.contains("\"groq\""));

        let s = a.apply(&AiSettingsPatch { custom_base_url: Some("".into()), reset_notices: Some(true), ..Default::default() }).unwrap();
        assert_eq!(s.custom_base_url, None);
        assert!(s.notice_accepted.is_empty());
    }

    #[test]
    fn base_urls_are_checked() {
        assert!(check_base_url("https://example.com/v1").is_ok());
        assert!(check_base_url("http://127.0.0.1:1234/v1").is_ok());
        assert!(check_base_url("http://[::1]:8080/v1").is_ok());
        assert!(check_base_url("http://example.com/v1").is_err());
        assert!(check_base_url("ftp://localhost/v1").is_err());
        assert!(check_base_url("https://user:pw@example.com/v1").is_err());
        assert!(check_base_url("https://example.com/v1?key=x").is_err());
        assert!(check_base_url("not a url").is_err());
    }

    #[test]
    fn bad_model_ids_are_rejected_before_saving() {
        let dir = tempfile::tempdir().unwrap();
        let p = Prefs::new(dir.path());
        let err = p
            .apply(&AiSettingsPatch {
                model: Some(ModelChoice { provider: ProviderId::Nvidia, model: Some("has space".into()) }),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.kind, Kind::InvalidInput);
        assert!(!dir.path().join(FILE).exists());
    }
}
