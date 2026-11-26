//! Errors from the AI helper. They reach the UI as
//! `{ kind, message, retryAfterSecs? }` so it can react (open Settings on a
//! bad key, wait on a rate limit). Messages are written for people who don't
//! know HTTP, and never contain an API key: provider text is passed through
//! [`sanitize`] first.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// AI help is turned off in Settings.
    Disabled,
    /// The user hasn't accepted the privacy notice for this provider yet.
    NoticeRequired,
    NoKey,
    BadKey,
    Forbidden,
    NotFound,
    RateLimited,
    /// The account is out of credits (HTTP 402).
    Payment,
    TooLarge,
    BadRequest,
    Server,
    Offline,
    Tls,
    Timeout,
    Network,
    Cancelled,
    /// The model declined to answer.
    Refused,
    /// The answer was cut off before it was complete.
    Truncated,
    /// The answer couldn't be read as the expected JSON.
    BadResponse,
    InvalidInput,
    KeyStore,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiError {
    pub kind: Kind,
    pub message: String,
    pub retry_after_secs: Option<u64>,
}

impl AiError {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        AiError { kind, message: message.into(), retry_after_secs: None }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        AiError::new(Kind::InvalidInput, message)
    }

    pub fn cancelled() -> Self {
        AiError::new(Kind::Cancelled, "Stopped.")
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AiError {}

impl Serialize for AiError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AiError", 3)?;
        s.serialize_field("kind", &self.kind)?;
        s.serialize_field("message", &self.message)?;
        s.serialize_field("retryAfterSecs", &self.retry_after_secs)?;
        s.end()
    }
}

impl From<crate::error::AppError> for AiError {
    fn from(err: crate::error::AppError) -> Self {
        AiError::new(Kind::Other, err.to_string())
    }
}

impl From<std::io::Error> for AiError {
    fn from(err: std::io::Error) -> Self {
        AiError::new(Kind::Other, format!("Texo couldn't read or write a file: {err}"))
    }
}

pub type AiResult<T> = Result<T, AiError>;

/// Cleans text that came from a provider before it is shown: removes the
/// user's key and anything that looks like a key, drops control characters
/// and keeps it short.
pub fn sanitize(text: &str, key: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(key) = key.filter(|k| k.len() >= 4) {
        out = out.replace(key, "[key hidden]");
    }
    let words: Vec<String> = out
        .split_inclusive(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
        .map(|w| {
            let core = w.trim_end_matches(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',');
            if looks_like_secret(core) {
                w.replacen(core, "[key hidden]", 1)
            } else {
                w.to_string()
            }
        })
        .collect();
    let cleaned: String = words
        .concat()
        .chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    const MAX: usize = 300;
    if cleaned.chars().count() > MAX {
        format!("{}…", cleaned.chars().take(MAX).collect::<String>())
    } else {
        cleaned.to_string()
    }
}

/// Key formats of the supported providers, plus long opaque tokens.
fn looks_like_secret(word: &str) -> bool {
    const PREFIXES: &[&str] = &["nvapi-", "sk-", "gsk_", "AIza", "sk-ant-", "sk-or-", "Bearer"];
    let long_token = word.len() >= 32
        && word.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_alphabetic());
    (PREFIXES.iter().any(|p| word.starts_with(p)) && word.len() >= 12) || long_token
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_object_for_the_ui() {
        let mut err = AiError::new(Kind::RateLimited, "Slow down");
        err.retry_after_secs = Some(12);
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "rateLimited");
        assert_eq!(v["message"], "Slow down");
        assert_eq!(v["retryAfterSecs"], 12);
    }

    #[test]
    fn sanitize_removes_the_key_and_key_like_tokens() {
        let key = "nvapi-ABCDEFGHIJKLMNOP1234567890";
        let text = format!("Invalid key {key} provided. Other: sk-or-v1-0123456789abcdef0123");
        let out = sanitize(&text, Some(key));
        assert!(!out.contains(key));
        assert!(!out.contains("sk-or-v1-0123456789abcdef0123"));
        assert!(out.contains("[key hidden]"));
        // Partial keys are hidden as well.
        let out = sanitize("got Bearer abc and gsk_1234567890abcdef", None);
        assert!(!out.contains("gsk_1234567890abcdef"));
    }

    #[test]
    fn sanitize_keeps_plain_messages_and_truncates() {
        assert_eq!(sanitize("model `x` not found", None), "model `x` not found");
        let long = "word ".repeat(200);
        assert!(sanitize(&long, None).chars().count() <= 301);
        assert_eq!(sanitize("a\u{7}b", None), "a b");
    }
}
