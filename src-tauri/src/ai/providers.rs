//! The AI providers Texo can talk to. Every URL here was checked against the
//! provider's own documentation:
//! - NVIDIA API Catalog: `https://integrate.api.nvidia.com/v1/chat/completions`,
//!   `Authorization: Bearer`, models at `/v1/models`. Its hosted schema has no
//!   `response_format`, so JSON is asked for in the prompt.
//! - OpenRouter: `https://openrouter.ai/api/v1/chat/completions`, Bearer,
//!   `response_format` with `json_schema`; free models end in `:free`.
//! - Groq: `https://api.groq.com/openai/v1`, Bearer; `json_object` works on
//!   every model (`json_schema` only on a few).
//! - Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/`,
//!   Bearer, models at `/models`.
//! - Anthropic: native Messages API at `https://api.anthropic.com/v1/messages`
//!   with `x-api-key` and `anthropic-version`.
//!
//! Model IDs change often, so lists are fetched at run time. The preferred
//! IDs below only rank what the provider actually returns.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Nvidia,
    Openrouter,
    Groq,
    Gemini,
    Anthropic,
    Custom,
}

impl ProviderId {
    #[cfg(test)]
    pub const ALL: [ProviderId; 6] = [
        ProviderId::Nvidia,
        ProviderId::Openrouter,
        ProviderId::Groq,
        ProviderId::Gemini,
        ProviderId::Anthropic,
        ProviderId::Custom,
    ];

    /// Name used for the credential-store entry.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Nvidia => "nvidia",
            ProviderId::Openrouter => "openrouter",
            ProviderId::Groq => "groq",
            ProviderId::Gemini => "gemini",
            ProviderId::Anthropic => "anthropic",
            ProviderId::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
    /// `POST {base}/chat/completions`, `GET {base}/models`.
    OpenAi,
    /// `POST {base}/messages`, `GET {base}/models`.
    Anthropic,
}

/// How the provider can be held to a JSON answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Structured {
    /// `response_format: {type: "json_schema", ...}` (or Claude's
    /// `output_config.format`).
    JsonSchema,
    /// `response_format: {type: "json_object"}`.
    JsonObject,
    /// Only the prompt asks for JSON; the answer is extracted and checked.
    None,
}

pub struct Provider {
    pub id: ProviderId,
    pub label: &'static str,
    pub api: Api,
    /// Empty for the custom provider, whose URL comes from settings.
    pub base_url: &'static str,
    pub key_required: bool,
    /// Where to create a key.
    pub key_url: Option<&'static str>,
    pub structured: Structured,
    /// Model IDs to suggest first when the provider lists them.
    pub preferred_models: &'static [&'static str],
    /// Used without a model list (Claude's current default model).
    pub default_model: Option<&'static str>,
    /// One or two plain sentences shown in Settings > AI.
    pub how_to: &'static str,
}

pub const CLAUDE_DEFAULT_MODEL: &str = "claude-opus-5-5";

static PROVIDERS: [Provider; 6] = [
    Provider {
        id: ProviderId::Nvidia,
        label: "NVIDIA",
        api: Api::OpenAi,
        base_url: "https://integrate.api.nvidia.com/v1",
        key_required: true,
        key_url: Some("https://build.nvidia.com/settings/api-keys"),
        structured: Structured::None,
        preferred_models: &[
            "moonshotai/kimi-k3.1-pro",
            "mistralai/mistral-large-4-1t-a52b",
            "nvidia/nemotron-3-ultra-550b-a55b",
            "z-ai/glm-5.3-flash",
        ],
        default_model: None,
        how_to: "Sign in at build.nvidia.com (free), open \"API Keys\", create a key \
                 (it starts with \"nvapi-\") and paste it here.",
    },
    Provider {
        id: ProviderId::Openrouter,
        label: "OpenRouter",
        api: Api::OpenAi,
        base_url: "https://openrouter.ai/api/v1",
        key_required: true,
        key_url: Some("https://openrouter.ai/settings/keys"),
        structured: Structured::JsonSchema,
        preferred_models: &[
            "nvidia/nemotron-3-ultra-550b-a55b:free",
            "google/gemma-4-31b-it:free",
        ],
        default_model: None,
        how_to: "Create a free account at openrouter.ai, open \"Keys\", create a key and paste \
                 it here. Models marked \"free\" cost nothing.",
    },
    Provider {
        id: ProviderId::Groq,
        label: "Groq",
        api: Api::OpenAi,
        base_url: "https://api.groq.com/openai/v1",
        key_required: true,
        key_url: Some("https://console.groq.com/keys"),
        structured: Structured::JsonObject,
        preferred_models: &["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
        default_model: None,
        how_to: "Sign in at console.groq.com (free tier), open \"API Keys\", create a key and \
                 paste it here.",
    },
    Provider {
        id: ProviderId::Gemini,
        label: "Google Gemini",
        api: Api::OpenAi,
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        key_required: true,
        key_url: Some("https://aistudio.google.com/apikey"),
        structured: Structured::JsonSchema,
        preferred_models: &[],
        default_model: None,
        how_to: "Sign in to Google AI Studio (aistudio.google.com), choose \"Get API key\", \
                 create a key and paste it here.",
    },
    Provider {
        id: ProviderId::Anthropic,
        label: "Anthropic Claude",
        api: Api::Anthropic,
        base_url: "https://api.anthropic.com/v1",
        key_required: true,
        key_url: Some("https://platform.claude.com/settings/keys"),
        structured: Structured::JsonSchema,
        preferred_models: &[CLAUDE_DEFAULT_MODEL],
        default_model: Some(CLAUDE_DEFAULT_MODEL),
        how_to: "Create an API key in the Claude Console (platform.claude.com, paid usage) \
                 and paste it here.",
    },
    Provider {
        id: ProviderId::Custom,
        label: "Custom (OpenAI-compatible)",
        api: Api::OpenAi,
        base_url: "",
        key_required: false,
        key_url: None,
        structured: Structured::None,
        preferred_models: &[],
        default_model: None,
        how_to: "Any server that speaks the OpenAI chat API. For Ollama on this computer use \
                 http://localhost:11434/v1 (no key); for LM Studio http://localhost:1234/v1.",
    },
];

pub fn get(id: ProviderId) -> &'static Provider {
    PROVIDERS.iter().find(|p| p.id == id).expect("every provider id has an entry")
}

pub fn all() -> &'static [Provider] {
    &PROVIDERS
}

/// Model IDs that are clearly not chat models (embeddings, safety filters,
/// speech, images); they are hidden from the model picker.
pub fn looks_like_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    const NOT_CHAT: &[&str] = &[
        "embed", "rerank", "retriever", "guard", "safety", "moderation", "whisper", "tts",
        "transcribe", "clip", "detector", "pii", "translate", "image-generation", "imagen",
        "veo", "aqa", "starcoder", "calibration", "dall-e", "-audio",
    ];
    !NOT_CHAT.iter().any(|w| id.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_is_listed_once_and_nvidia_is_first() {
        assert_eq!(all()[0].id, ProviderId::Nvidia);
        for id in ProviderId::ALL {
            assert_eq!(all().iter().filter(|p| p.id == id).count(), 1);
            let p = get(id);
            if id != ProviderId::Custom {
                assert!(p.base_url.starts_with("https://"), "{}", p.label);
                assert!(p.key_required);
            }
        }
        assert_eq!(get(ProviderId::Anthropic).api, Api::Anthropic);
        assert_eq!(get(ProviderId::Anthropic).default_model, Some("claude-opus-5-5"));
    }

    #[test]
    fn provider_ids_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&ProviderId::Openrouter).unwrap(), "\"openrouter\"");
        let id: ProviderId = serde_json::from_str("\"gemini\"").unwrap();
        assert_eq!(id, ProviderId::Gemini);
    }

    #[test]
    fn non_chat_models_are_filtered() {
        assert!(looks_like_chat_model("moonshotai/kimi-k3.1-pro"));
        assert!(looks_like_chat_model("claude-opus-5-5"));
        assert!(!looks_like_chat_model("nvidia/nemotron-3.5-embed-8b"));
        assert!(!looks_like_chat_model("nvidia/llama-3.1-nemotron-safety-guard-8b-v3"));
        assert!(!looks_like_chat_model("whisper-large-v3"));
    }
}
