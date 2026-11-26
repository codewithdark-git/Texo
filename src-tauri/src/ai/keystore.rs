//! API keys, one per provider. They go to the OS credential store (Windows
//! Credential Manager, macOS Keychain, the Secret Service on Linux). When
//! there is none — common on minimal Linux desktops — they go to a file in
//! the app data folder that only the user can read, and the UI says so.
//!
//! Keys never leave this module except as an [`ApiKey`], which can't be
//! printed or serialized.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::error::{AiError, AiResult, Kind};
use super::http::ApiKey;
use super::providers::ProviderId;

const SERVICE: &str = "app.texo.desktop.ai";
pub const FALLBACK_FILE: &str = "ai-keys.json";
const MAX_KEY_LEN: usize = 512;

/// A place that can hold secrets.
pub trait SecretBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, ()>;
    fn set(&self, account: &str, secret: &str) -> Result<(), ()>;
    fn delete(&self, account: &str) -> Result<(), ()>;
}

/// The OS credential store, through the `keyring` crate. Errors are reduced
/// to `()`: platform messages are not shown to the user.
pub struct SystemKeyring;

impl SecretBackend for SystemKeyring {
    fn get(&self, account: &str) -> Result<Option<String>, ()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| ())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), ()> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|_| ())
    }

    fn delete(&self, account: &str) -> Result<(), ()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|_| ())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Storage {
    /// The OS credential store.
    Keychain,
    /// A user-only file in the app data folder (less secure).
    File,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub provider: ProviderId,
    pub has_key: bool,
    /// Where the key is kept, when there is one.
    pub storage: Option<Storage>,
    /// Shown when the key is stored less securely.
    pub warning: Option<String>,
}

/// A key for a service that isn't an AI provider: the literature and web
/// search services the agents can use. Kept next to the provider keys, under
/// account names that can't clash with them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceSecret {
    /// OpenAlex (literature search).
    Openalex,
    /// Tavily (web search).
    Tavily,
    /// Brave Search API (web search).
    Brave,
}

impl ServiceSecret {
    pub const ALL: [ServiceSecret; 3] = [ServiceSecret::Openalex, ServiceSecret::Tavily, ServiceSecret::Brave];

    /// The account name in the credential store (and key file).
    pub fn account(self) -> &'static str {
        match self {
            ServiceSecret::Openalex => "web.openalex",
            ServiceSecret::Tavily => "web.tavily",
            ServiceSecret::Brave => "web.brave",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub secret: ServiceSecret,
    pub has_key: bool,
    pub storage: Option<Storage>,
    pub warning: Option<String>,
}

const FILE_WARNING: &str = "This computer has no password store Texo can use, so the key is \
    saved in a file only your user account can read. That is less secure than a password store.";

pub struct KeyStore {
    backend: Box<dyn SecretBackend>,
    file: PathBuf,
}

impl KeyStore {
    pub fn new(backend: Box<dyn SecretBackend>, data_dir: &Path) -> Self {
        KeyStore { backend, file: data_dir.join(FALLBACK_FILE) }
    }

    pub fn status(&self, provider: ProviderId) -> KeyStatus {
        let storage = self.get(provider).map(|(_, s)| s);
        KeyStatus {
            provider,
            has_key: storage.is_some(),
            storage,
            warning: (storage == Some(Storage::File)).then(|| FILE_WARNING.to_string()),
        }
    }

    pub fn get(&self, provider: ProviderId) -> Option<(ApiKey, Storage)> {
        self.get_account(provider.as_str())
    }

    pub fn set(&self, provider: ProviderId, key: &str) -> AiResult<KeyStatus> {
        self.set_account(provider.as_str(), key)?;
        Ok(self.status(provider))
    }

    pub fn clear(&self, provider: ProviderId) -> AiResult<KeyStatus> {
        self.clear_account(provider.as_str())?;
        Ok(self.status(provider))
    }

    // ------------------------------------------ keys for other services --

    pub fn secret_status(&self, secret: ServiceSecret) -> SecretStatus {
        let storage = self.get_secret(secret).map(|(_, s)| s);
        SecretStatus {
            secret,
            has_key: storage.is_some(),
            storage,
            warning: (storage == Some(Storage::File)).then(|| FILE_WARNING.to_string()),
        }
    }

    pub fn get_secret(&self, secret: ServiceSecret) -> Option<(ApiKey, Storage)> {
        self.get_account(secret.account())
    }

    pub fn set_secret(&self, secret: ServiceSecret, key: &str) -> AiResult<SecretStatus> {
        self.set_account(secret.account(), key)?;
        Ok(self.secret_status(secret))
    }

    pub fn clear_secret(&self, secret: ServiceSecret) -> AiResult<SecretStatus> {
        self.clear_account(secret.account())?;
        Ok(self.secret_status(secret))
    }

    // ------------------------------------------------------ by account --

    fn get_account(&self, account: &str) -> Option<(ApiKey, Storage)> {
        if let Ok(Some(key)) = self.backend.get(account) {
            if !key.is_empty() {
                return Some((ApiKey::new(key), Storage::Keychain));
            }
        }
        self.read_file()
            .remove(account)
            .filter(|k| !k.is_empty())
            .map(|k| (ApiKey::new(k), Storage::File))
    }

    fn set_account(&self, account: &str, key: &str) -> AiResult<()> {
        let key = clean_key(key)?;
        // Read it back: without a real store, `keyring` may "succeed" with an
        // in-memory mock that forgets the key.
        let in_keychain = self.backend.set(account, &key).is_ok()
            && matches!(self.backend.get(account), Ok(Some(ref k)) if *k == key);
        if in_keychain {
            self.remove_from_file(account)?;
        } else {
            let mut keys = self.read_file();
            keys.insert(account.to_string(), key);
            self.write_file(&keys)?;
        }
        Ok(())
    }

    fn clear_account(&self, account: &str) -> AiResult<()> {
        let keychain_ok = self.backend.delete(account).is_ok();
        self.remove_from_file(account)?;
        if self.get_account(account).is_some() && !keychain_ok {
            return Err(AiError::new(
                Kind::KeyStore,
                "Texo couldn't remove the key from the system password store. Remove the entry \
                 \"app.texo.desktop.ai\" there yourself.",
            ));
        }
        Ok(())
    }

    fn read_file(&self) -> BTreeMap<String, String> {
        fs::read_to_string(&self.file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn remove_from_file(&self, account: &str) -> AiResult<()> {
        let mut keys = self.read_file();
        if keys.remove(account).is_some() {
            if keys.is_empty() {
                fs::remove_file(&self.file).map_err(|_| store_error())?;
            } else {
                self.write_file(&keys)?;
            }
        }
        Ok(())
    }

    fn write_file(&self, keys: &BTreeMap<String, String>) -> AiResult<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|_| store_error())?;
        }
        let tmp = self.file.with_extension("json.tmp");
        let text = serde_json::to_string(keys).map_err(|_| store_error())?;
        write_private(&tmp, text.as_bytes()).map_err(|_| store_error())?;
        if fs::rename(&tmp, &self.file).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err(store_error());
        }
        Ok(())
    }
}

fn store_error() -> AiError {
    AiError::new(Kind::KeyStore, "Texo couldn't save the API key on this computer.")
}

/// Creates the file readable and writable by its owner only (0600) on Unix.
/// On Windows, files in the user's AppData are private to the user already.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let _ = fs::remove_file(path);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// Trims what was pasted and rejects things that can't be a key. The key
/// itself never appears in the message.
pub fn clean_key(key: &str) -> AiResult<String> {
    let key = key.trim();
    let key = key.strip_prefix("Bearer ").unwrap_or(key).trim();
    if key.is_empty() {
        return Err(AiError::invalid("Paste an API key first."));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(AiError::invalid("That doesn't look like an API key: it is too long."));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control() || !c.is_ascii()) {
        return Err(AiError::invalid(
            "That doesn't look like an API key: it contains spaces or unusual characters.",
        ));
    }
    Ok(key.to_string())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A working credential store, in memory.
    #[derive(Default)]
    pub struct MemBackend(pub Mutex<HashMap<String, String>>);

    impl SecretBackend for MemBackend {
        fn get(&self, a: &str) -> Result<Option<String>, ()> {
            Ok(self.0.lock().unwrap().get(a).cloned())
        }
        fn set(&self, a: &str, s: &str) -> Result<(), ()> {
            self.0.lock().unwrap().insert(a.into(), s.into());
            Ok(())
        }
        fn delete(&self, a: &str) -> Result<(), ()> {
            self.0.lock().unwrap().remove(a);
            Ok(())
        }
    }

    /// No credential store at all (minimal Linux).
    pub struct NoBackend;

    impl SecretBackend for NoBackend {
        fn get(&self, _: &str) -> Result<Option<String>, ()> {
            Err(())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), ()> {
            Err(())
        }
        fn delete(&self, _: &str) -> Result<(), ()> {
            Err(())
        }
    }

    /// Accepts writes but forgets them (keyring's mock store).
    pub struct ForgetfulBackend;

    impl SecretBackend for ForgetfulBackend {
        fn get(&self, _: &str) -> Result<Option<String>, ()> {
            Ok(None)
        }
        fn set(&self, _: &str, _: &str) -> Result<(), ()> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), ()> {
            Ok(())
        }
    }

    const KEY: &str = "nvapi-abcDEF0123456789-secret";

    #[test]
    fn keychain_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = KeyStore::new(Box::new(MemBackend::default()), dir.path());
        assert!(!store.status(ProviderId::Nvidia).has_key);
        let st = store.set(ProviderId::Nvidia, &format!("  {KEY}\n")).unwrap();
        assert_eq!(st.storage, Some(Storage::Keychain));
        assert!(st.warning.is_none());
        let (key, _) = store.get(ProviderId::Nvidia).unwrap();
        assert_eq!(key.expose(), KEY);
        // Other providers are separate.
        assert!(!store.status(ProviderId::Groq).has_key);
        assert!(!dir.path().join(FALLBACK_FILE).exists());
        let st = store.clear(ProviderId::Nvidia).unwrap();
        assert!(!st.has_key);
    }

    #[test]
    fn falls_back_to_a_private_file_without_a_store() {
        for backend in [Box::new(NoBackend) as Box<dyn SecretBackend>, Box::new(ForgetfulBackend)] {
            let dir = tempfile::tempdir().unwrap();
            let store = KeyStore::new(backend, dir.path());
            let st = store.set(ProviderId::Groq, KEY).unwrap();
            assert_eq!(st.storage, Some(Storage::File));
            assert!(st.warning.as_deref().unwrap().contains("less secure"));
            assert_eq!(store.get(ProviderId::Groq).unwrap().0.expose(), KEY);
            let file = dir.path().join(FALLBACK_FILE);
            assert!(file.exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
            store.clear(ProviderId::Groq).unwrap();
            assert!(store.get(ProviderId::Groq).is_none());
            assert!(!file.exists());
        }
    }

    #[test]
    fn moving_to_the_keychain_removes_the_file_copy() {
        let dir = tempfile::tempdir().unwrap();
        KeyStore::new(Box::new(NoBackend), dir.path()).set(ProviderId::Gemini, KEY).unwrap();
        let store = KeyStore::new(Box::new(MemBackend::default()), dir.path());
        store.set(ProviderId::Gemini, KEY).unwrap();
        assert!(!dir.path().join(FALLBACK_FILE).exists());
        assert_eq!(store.status(ProviderId::Gemini).storage, Some(Storage::Keychain));
    }

    #[test]
    fn bad_keys_are_rejected_without_echoing_them() {
        for bad in ["", "   ", "has space inside", "tab\tkey", "ключ"] {
            let err = clean_key(bad).unwrap_err();
            assert_eq!(err.kind, Kind::InvalidInput);
            if !bad.trim().is_empty() {
                assert!(!err.message.contains(bad.trim()));
            }
        }
        assert!(clean_key(&"x".repeat(600)).is_err());
        assert_eq!(clean_key("Bearer sk-abc").unwrap(), "sk-abc");
    }

    #[test]
    fn service_secrets_are_separate_from_provider_keys() {
        for backend in [Box::new(MemBackend::default()) as Box<dyn SecretBackend>, Box::new(NoBackend)] {
            let dir = tempfile::tempdir().unwrap();
            let store = KeyStore::new(backend, dir.path());
            store.set(ProviderId::Nvidia, KEY).unwrap();
            let st = store.set_secret(ServiceSecret::Tavily, "tvly-0123456789abcdef").unwrap();
            assert!(st.has_key);
            assert!(!store.secret_status(ServiceSecret::Brave).has_key);
            assert_eq!(store.get_secret(ServiceSecret::Tavily).unwrap().0.expose(), "tvly-0123456789abcdef");
            assert_eq!(store.get(ProviderId::Nvidia).unwrap().0.expose(), KEY);
            let json = serde_json::to_string(&st).unwrap();
            assert!(!json.contains("tvly-0123456789abcdef"));
            assert!(json.contains("\"secret\":\"tavily\""));
            assert!(!store.clear_secret(ServiceSecret::Tavily).unwrap().has_key);
            // The provider key is untouched.
            assert_eq!(store.get(ProviderId::Nvidia).unwrap().0.expose(), KEY);
            assert!(clean_key("has space").is_err());
            assert!(store.set_secret(ServiceSecret::Openalex, "").is_err());
        }
    }

    #[test]
    fn status_serializes_without_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = KeyStore::new(Box::new(MemBackend::default()), dir.path());
        let st = store.set(ProviderId::Openrouter, KEY).unwrap();
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains(KEY));
        assert!(json.contains("\"hasKey\":true"));
        assert!(json.contains("\"storage\":\"keychain\""));
    }
}
