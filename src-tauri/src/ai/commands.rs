//! Tauri commands of the AI helper, and the logic behind them (kept apart
//! from Tauri so tests can drive it against a local mock server).
//!
//! Commands: `ai_get_settings`, `ai_update_settings`, `ai_list_providers`,
//! `ai_key_status`, `ai_set_key`, `ai_clear_key`, `ai_list_models`,
//! `ai_test_connection`, `ai_preview_context`, `ai_explain_and_fix`,
//! `ai_cancel`, `ai_check_edits`, `ai_install_package`.
//! Event: `ai-progress` ([`Progress`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _, State};

use super::context::{self, CompileInput, ContextSummary, Environment, PreviousAttempt};
use super::error::{AiError, AiResult, Kind};
use super::http::{self, ApiKey, Cancel, Endpoint, ModelInfo};
use super::install::{self, InstallResult, Manager};
use super::keystore::{KeyStatus, KeyStore, SecretBackend, SystemKeyring};
use super::prefs::{AiSettings, AiSettingsPatch, Prefs};
use super::prompt::{self, Confidence};
use super::providers::{self, Api, ProviderId, Structured};
use super::validate::{self, CheckedEdit, EditInput};
use super::{anthropic, openai, PROGRESS_EVENT};
use crate::compile::{self, Toolchains};
use crate::AppState;

pub struct AiState {
    prefs: Prefs,
    /// Shared so a key can be read off the async runtime (see `endpoint`).
    keys: std::sync::Arc<KeyStore>,
    client: OnceLock<AiResult<Client>>,
    running: Mutex<HashMap<String, Cancel>>,
    use_proxy: bool,
    /// Tests point every provider at a local mock server.
    base_override: Option<String>,
}

impl AiState {
    /// `config_dir` holds `ai.json`; `data_dir` holds the key file used when
    /// there is no credential store.
    pub fn new(config_dir: &Path, data_dir: &Path) -> Self {
        AiState::with_backend(config_dir, data_dir, Box::new(SystemKeyring))
    }

    fn with_backend(config_dir: &Path, data_dir: &Path, backend: Box<dyn SecretBackend>) -> Self {
        AiState {
            prefs: Prefs::new(config_dir),
            keys: std::sync::Arc::new(KeyStore::new(backend, data_dir)),
            client: OnceLock::new(),
            running: Mutex::new(HashMap::new()),
            use_proxy: true,
            base_override: None,
        }
    }

    fn client(&self) -> AiResult<Client> {
        self.client.get_or_init(|| http::build_client(self.use_proxy)).clone()
    }

    fn running(&self) -> std::sync::MutexGuard<'_, HashMap<String, Cancel>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Removes a request from the running list when it ends, however it ends.
struct RunGuard<'a> {
    state: &'a AiState,
    id: String,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.state.running().remove(&self.id);
    }
}

// ---------------------------------------------------------------- types --

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: ProviderId,
    pub label: &'static str,
    pub key_required: bool,
    pub key_url: Option<&'static str>,
    pub how_to: &'static str,
    /// The custom provider's address comes from settings.
    pub base_url: Option<String>,
    pub structured: Structured,
    /// The model picked for this provider, if any.
    pub model: Option<String>,
    pub key: KeyStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub ok: bool,
    pub message: String,
    pub model_count: usize,
    /// The model that will be used (picked, or Texo's suggestion).
    pub model: Option<String>,
    /// Whether the picked model is in the provider's list (null when no
    /// model was picked).
    pub model_available: Option<bool>,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPreview {
    pub provider: ProviderId,
    pub provider_label: &'static str,
    pub summary: ContextSummary,
    /// Exactly what would be sent after the instructions.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvAction {
    /// Always "install_package" for now.
    pub kind: &'static str,
    pub manager: Manager,
    pub package: String,
    pub why: String,
    /// Texo found the package manager and can run it.
    pub available: bool,
    /// The command Texo would run, to show before confirming.
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixResult {
    pub request_id: String,
    pub provider: ProviderId,
    /// The model that answered.
    pub model: String,
    pub summary: String,
    pub cause: String,
    pub steps: Vec<String>,
    /// Every suggested edit, checked against the files on disk; `ok: false`
    /// ones carry a `reason` and must not be applied.
    pub edits: Vec<CheckedEdit>,
    pub env_actions: Vec<EnvAction>,
    pub confidence: Confidence,
    /// What was sent to the provider.
    pub sent: ContextSummary,
    /// Remarks for the UI ("one suggestion was dropped ...").
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Gathering,
    Asking,
    Checking,
}

/// Payload of `ai-progress` events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub request_id: String,
    pub stage: Stage,
    pub message: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FixRequest {
    pub request_id: String,
    pub compile: CompileInput,
    /// Index into `compile.issues` of the issue the user clicked.
    pub focus: Option<usize>,
    /// Earlier rounds of the fix loop (the last 3 are used).
    pub previous: Vec<PreviousAttempt>,
}

// ---------------------------------------------------------------- logic --

fn blocking_err(_: tokio::task::JoinError) -> AiError {
    AiError::new(Kind::Other, "Something went wrong inside Texo. Try again.")
}

impl AiState {
    pub fn settings(&self) -> AiSettings {
        self.prefs.load()
    }

    fn provider_infos(&self) -> Vec<ProviderInfo> {
        let s = self.prefs.load();
        providers::all()
            .iter()
            .map(|p| ProviderInfo {
                id: p.id,
                label: p.label,
                key_required: p.key_required,
                key_url: p.key_url,
                how_to: p.how_to,
                base_url: if p.id == ProviderId::Custom {
                    s.custom_base_url.clone()
                } else {
                    Some(p.base_url.to_string())
                },
                structured: p.structured,
                model: s.models.get(&p.id).cloned().or(p.default_model.map(str::to_string)),
                key: self.keys.status(p.id),
            })
            .collect()
    }

    /// Endpoint for `provider` without a model yet. The key is read off the
    /// async runtime: the credential store can block (an unlock prompt on
    /// Linux).
    async fn endpoint(&self, provider: ProviderId, settings: &AiSettings) -> AiResult<Endpoint> {
        let p = providers::get(provider);
        let keys = self.keys.clone();
        let key: Option<ApiKey> = blocking(move || keys.get(provider).map(|(k, _)| k)).await?;
        if p.key_required && key.is_none() {
            return Err(AiError::new(
                Kind::NoKey,
                format!("Add your {} API key in Settings > AI first.", p.label),
            ));
        }
        let base_url = if let Some(base) = &self.base_override {
            base.clone()
        } else if provider == ProviderId::Custom {
            settings.custom_base_url.clone().ok_or_else(|| {
                AiError::invalid("Enter your server's address in Settings > AI first.")
            })?
        } else {
            p.base_url.to_string()
        };
        Ok(Endpoint { provider, label: p.label.to_string(), base_url, key, model: String::new() })
    }

    async fn list_models_at(&self, ep: &Endpoint, cancel: &Cancel) -> AiResult<Vec<ModelInfo>> {
        let client = self.client()?;
        match providers::get(ep.provider).api {
            Api::OpenAi => openai::list_models(&client, ep, cancel).await,
            Api::Anthropic => anthropic::list_models(&client, ep, cancel).await,
        }
    }

    pub async fn list_models(&self, provider: ProviderId) -> AiResult<Vec<ModelInfo>> {
        let settings = self.prefs.load();
        let ep = self.endpoint(provider, &settings).await?;
        self.list_models_at(&ep, &Cancel::default()).await
    }

    pub async fn test_connection(&self, provider: ProviderId) -> AiResult<ConnectionTest> {
        let settings = self.prefs.load();
        let ep = self.endpoint(provider, &settings).await?;
        let start = Instant::now();
        let models = self.list_models_at(&ep, &Cancel::default()).await?;
        let picked = settings.models.get(&provider).cloned();
        let available = picked.as_ref().map(|m| models.iter().any(|x| &x.id == m));
        let model = picked
            .or_else(|| models.iter().find(|m| m.recommended).map(|m| m.id.clone()))
            .or_else(|| providers::get(provider).default_model.map(str::to_string));
        let label = providers::get(provider).label;
        let message = match available {
            Some(false) => format!(
                "Connected to {label}, but the chosen model isn't in its list any more. Pick another one."
            ),
            _ if models.is_empty() => format!("Connected to {label}, but it lists no models."),
            _ => format!("Connected to {label}. {} models available.", models.len()),
        };
        Ok(ConnectionTest {
            ok: available != Some(false) && !models.is_empty(),
            message,
            model_count: models.len(),
            model,
            model_available: available,
            latency_ms: start.elapsed().as_millis() as u64,
        })
    }

    /// The picked model, else the provider's default, else Texo's suggestion
    /// from the live model list (remembered for next time).
    async fn pick_model(&self, ep: &Endpoint, settings: &AiSettings, cancel: &Cancel) -> AiResult<String> {
        if let Some(m) = settings.models.get(&ep.provider) {
            return Ok(m.clone());
        }
        if let Some(m) = providers::get(ep.provider).default_model {
            return Ok(m.to_string());
        }
        let models = self.list_models_at(ep, cancel).await?;
        let pick = models
            .iter()
            .find(|m| m.recommended)
            .or_else(|| models.first())
            .map(|m| m.id.clone())
            .ok_or_else(|| {
                AiError::new(Kind::NotFound, format!("{} lists no models Texo can use. Pick one in Settings > AI.", ep.label))
            })?;
        let provider = ep.provider;
        let remembered = pick.clone();
        let _ = self.prefs.update(move |s| {
            s.models.entry(provider).or_insert(remembered);
        });
        Ok(pick)
    }

    fn check_gate(&self, settings: &AiSettings) -> AiResult<()> {
        if !settings.enabled {
            return Err(AiError::new(Kind::Disabled, "AI help is turned off. Turn it on in Settings > AI."));
        }
        if !settings.notice_accepted.contains(&settings.provider) {
            return Err(AiError::new(
                Kind::NoticeRequired,
                format!(
                    "Before anything is sent to {}, please read and accept the privacy notice.",
                    providers::get(settings.provider).label
                ),
            ));
        }
        Ok(())
    }

    /// For the chat (v1.2): the HTTP client and the endpoint of the chosen
    /// provider, after the on/off and privacy-notice checks. `model` (when
    /// not blank) is used as is, otherwise the picked or suggested model.
    pub(crate) async fn llm_endpoint(&self, model: Option<String>, cancel: &Cancel) -> AiResult<(Client, Endpoint)> {
        let settings = self.prefs.load();
        self.check_gate(&settings)?;
        let mut ep = self.endpoint(settings.provider, &settings).await?;
        ep.model = match model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()) {
            Some(m) => m,
            None => self.pick_model(&ep, &settings, cancel).await?,
        };
        Ok((self.client()?, ep))
    }

    pub async fn explain(
        &self,
        root: &Path,
        req: FixRequest,
        tools: &Toolchains,
        progress: impl Fn(Stage, &str),
    ) -> AiResult<FixResult> {
        let settings = self.prefs.load();
        self.check_gate(&settings)?;
        let request_id = if req.request_id.trim().is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            req.request_id.clone()
        };
        let cancel = Cancel::default();
        self.running().insert(request_id.clone(), cancel.clone());
        let _guard = RunGuard { state: self, id: request_id.clone() };

        progress(Stage::Gathering, "Collecting the error and the lines around it…");
        let env = Environment { distribution: tools.distribution.clone(), os: os_name() };
        let gathered = {
            let root = root.to_path_buf();
            let compile_input = req.compile.clone();
            let previous: Vec<PreviousAttempt> = req.previous.iter().rev().take(3).rev().cloned().collect();
            let focus = req.focus;
            tokio::task::spawn_blocking(move || context::gather(&root, &compile_input, focus, &previous, &env))
                .await
                .map_err(blocking_err)?
        };
        cancel.check()?;

        let mut ep = self.endpoint(settings.provider, &settings).await?;
        ep.model = self.pick_model(&ep, &settings, &cancel).await?;
        progress(Stage::Asking, &format!("Asking {}…", ep.label));
        let client = self.client()?;
        let user = prompt::user_message(&gathered.text);
        let schema = prompt::schema();
        let p = providers::get(ep.provider);
        let answer = match p.api {
            Api::OpenAi => openai::chat(&client, &ep, prompt::SYSTEM_PROMPT, &user, p.structured, &schema, &cancel).await?,
            Api::Anthropic => anthropic::chat(&client, &ep, prompt::SYSTEM_PROMPT, &user, &schema, &cancel).await?,
        };
        cancel.check()?;

        progress(Stage::Checking, "Checking the suggested changes…");
        let Some(raw) = prompt::parse_answer(&answer.text) else {
            return Err(if answer.truncated {
                openai::truncated(&ep.label)
            } else {
                AiError::new(
                    Kind::BadResponse,
                    format!("{}'s answer wasn't in the expected form. Try again, or pick another model.", ep.label),
                )
            });
        };
        let mut notes = Vec::new();
        let edits = {
            let root = root.to_path_buf();
            let edits = raw.edits.clone();
            tokio::task::spawn_blocking(move || validate::check_edits(&root, &edits, &HashMap::new()))
                .await
                .map_err(blocking_err)?
        };
        let rejected = edits.iter().filter(|e| !e.ok).count();
        if rejected > 0 {
            notes.push(format!(
                "{rejected} suggested change{} can't be applied safely and {} shown for information only.",
                if rejected == 1 { "" } else { "s" },
                if rejected == 1 { "is" } else { "are" }
            ));
        }
        let env_actions = env_actions(&raw.env_actions, tools, &mut notes);
        if gathered.summary.truncated {
            notes.push("Some of the log or files were shortened to keep the request small.".into());
        }
        Ok(FixResult {
            request_id,
            provider: ep.provider,
            model: answer.model,
            summary: raw.summary,
            cause: raw.cause,
            steps: raw.steps,
            edits,
            env_actions,
            confidence: raw.confidence,
            sent: gathered.summary,
            notes,
        })
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        match self.running().get(request_id) {
            Some(c) => {
                c.cancel();
                true
            }
            None => false,
        }
    }
}

fn os_name() -> &'static str {
    if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    }
}

/// Keeps valid install suggestions, using the package manager of the
/// distribution actually installed.
fn env_actions(raw: &[prompt::RawEnvAction], tools: &Toolchains, notes: &mut Vec<String>) -> Vec<EnvAction> {
    let installed = Manager::for_distribution(tools.distribution.as_deref());
    let mut out: Vec<EnvAction> = Vec::new();
    let mut dropped = 0;
    for a in raw {
        let package = a.package.trim().to_string();
        let manager = installed.or_else(|| Manager::parse(&a.manager));
        let (Some(manager), true, true) = (manager, a.kind == "install_package", validate::valid_package(&package)) else {
            dropped += 1;
            continue;
        };
        if out.iter().any(|o| o.package == package) {
            continue;
        }
        out.push(EnvAction {
            kind: "install_package",
            manager,
            available: install::find_tool(tools, manager).is_some(),
            command: manager.command_line(&package),
            package,
            why: a.why.clone(),
        });
    }
    if dropped > 0 {
        notes.push("A suggested installation was left out because it wasn't valid.".into());
    }
    out
}

// ------------------------------------------------------------- commands --

type Shared<'a> = State<'a, Mutex<AppState>>;

fn project_dir(state: &Shared<'_>, path: &str) -> AiResult<(PathBuf, PathBuf)> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    let dir = crate::commands::known_project(&s, path)?.0;
    Ok((dir, s.tools_dir.clone()))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AiResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(blocking_err)
}

#[tauri::command]
pub async fn ai_get_settings(ai: State<'_, AiState>) -> AiResult<AiSettings> {
    Ok(ai.settings())
}

#[tauri::command]
pub async fn ai_update_settings(ai: State<'_, AiState>, patch: AiSettingsPatch) -> AiResult<AiSettings> {
    ai.prefs.apply(&patch)
}

// The credential store can block (an unlock prompt on Linux), so key work
// runs off the async runtime.

#[tauri::command]
pub async fn ai_list_providers(app: AppHandle) -> AiResult<Vec<ProviderInfo>> {
    blocking(move || app.state::<AiState>().provider_infos()).await
}

#[tauri::command]
pub async fn ai_key_status(app: AppHandle, provider: ProviderId) -> AiResult<KeyStatus> {
    blocking(move || app.state::<AiState>().keys.status(provider)).await
}

#[tauri::command]
pub async fn ai_set_key(app: AppHandle, provider: ProviderId, key: String) -> AiResult<KeyStatus> {
    blocking(move || app.state::<AiState>().keys.set(provider, &key)).await?
}

#[tauri::command]
pub async fn ai_clear_key(app: AppHandle, provider: ProviderId) -> AiResult<KeyStatus> {
    blocking(move || app.state::<AiState>().keys.clear(provider)).await?
}

#[tauri::command]
pub async fn ai_list_models(ai: State<'_, AiState>, provider: ProviderId) -> AiResult<Vec<ModelInfo>> {
    ai.list_models(provider).await
}

#[tauri::command]
pub async fn ai_test_connection(ai: State<'_, AiState>, provider: ProviderId) -> AiResult<ConnectionTest> {
    ai.test_connection(provider).await
}

/// What `ai_explain_and_fix` would send, without sending anything.
#[tauri::command]
pub async fn ai_preview_context(
    ai: State<'_, AiState>,
    state: Shared<'_>,
    path: String,
    compile: CompileInput,
    focus: Option<usize>,
) -> AiResult<ContextPreview> {
    let (dir, tools_dir) = project_dir(&state, &path)?;
    let provider = ai.settings().provider;
    let gathered = blocking(move || {
        let tools = compile::detect(&tools_dir);
        let env = Environment { distribution: tools.distribution, os: os_name() };
        context::gather(&dir, &compile, focus, &[], &env)
    })
    .await?;
    Ok(ContextPreview {
        provider,
        provider_label: providers::get(provider).label,
        summary: gathered.summary,
        text: gathered.text,
    })
}

#[tauri::command]
pub async fn ai_explain_and_fix(
    app: AppHandle,
    ai: State<'_, AiState>,
    state: Shared<'_>,
    path: String,
    request: FixRequest,
) -> AiResult<FixResult> {
    let (dir, tools_dir) = project_dir(&state, &path)?;
    let tools = blocking(move || compile::detect(&tools_dir)).await?;
    let request_id = request.request_id.clone();
    ai.explain(&dir, request, &tools, |stage, message| {
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress { request_id: request_id.clone(), stage, message: message.to_string() },
        );
    })
    .await
}

#[tauri::command]
pub async fn ai_cancel(ai: State<'_, AiState>, request_id: String) -> AiResult<bool> {
    Ok(ai.cancel(&request_id))
}

/// Re-checks edits right before applying them, against the editor's current
/// text (`buffers`: project-relative path → content) or the file on disk.
#[tauri::command]
pub async fn ai_check_edits(
    state: Shared<'_>,
    path: String,
    edits: Vec<EditInput>,
    buffers: Option<HashMap<String, String>>,
) -> AiResult<Vec<CheckedEdit>> {
    let (dir, _) = project_dir(&state, &path)?;
    let buffers: HashMap<String, String> = buffers
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (validate::normalize_rel(&k), v))
        .collect();
    blocking(move || validate::check_edits(&dir, &edits, &buffers)).await
}

/// Runs the package manager. The UI must ask the user to confirm first.
#[tauri::command]
pub async fn ai_install_package(state: Shared<'_>, manager: Manager, package: String) -> AiResult<InstallResult> {
    if !validate::valid_package(&package) {
        return Err(AiError::invalid("That isn't a valid package name."));
    }
    // The same lock as the one-click install: one package manager at a time.
    let Some(lock) = crate::texpkg::InstallLock::try_take() else {
        return Err(AiError::new(Kind::Other, crate::texpkg::BUSY_MESSAGE));
    };
    let tools_dir = state.lock().unwrap_or_else(|e| e.into_inner()).tools_dir.clone();
    blocking(move || {
        let _lock = lock;
        let tools = compile::detect(&tools_dir);
        let Some(tool) = install::find_tool(&tools, manager) else {
            return Err(AiError::new(
                Kind::NotFound,
                match manager {
                    Manager::Miktex => "Texo couldn't find MiKTeX's package manager. Install the package with MiKTeX Console.",
                    Manager::Texlive => "Texo couldn't find TeX Live's package manager (tlmgr). Install the package with your system's package manager.",
                },
            ));
        };
        install::install(&tool, manager, &package)
    })
    .await?
}

// ---------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::keystore::tests::MemBackend;
    use crate::ai::mock::{runtime, Canned, MockServer};
    use crate::ai::prefs::ModelChoice;
    use crate::ai::context::IssueInput;
    use serde_json::json;
    use std::fs;

    const KEY: &str = "nvapi-SECRETKEY-0123456789abcdef";

    struct Setup {
        _dirs: (tempfile::TempDir, tempfile::TempDir),
        project: tempfile::TempDir,
        ai: AiState,
    }

    fn setup(base: Option<&MockServer>, provider: ProviderId, accept: bool) -> Setup {
        let cfg = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut ai = AiState::with_backend(cfg.path(), data.path(), Box::new(MemBackend::default()));
        ai.use_proxy = false;
        ai.base_override = base.map(|s| format!("{}/v1", s.base_url));
        ai.prefs
            .apply(&AiSettingsPatch {
                provider: Some(provider),
                accept_notice: accept.then_some(provider),
                ..Default::default()
            })
            .unwrap();
        let project = tempfile::tempdir().unwrap();
        fs::write(
            project.path().join("main.tex"),
            "\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage{microtype}\n\\begin{document}\nHi\n\\end{document}\n",
        )
        .unwrap();
        Setup { _dirs: (cfg, data), project, ai }
    }

    fn request() -> FixRequest {
        FixRequest {
            request_id: "r1".into(),
            compile: CompileInput {
                status: "failed".into(),
                issues: vec![IssueInput {
                    severity: "error".into(),
                    message: "pdfTeX error (font expansion): auto expansion is only possible with scalable fonts.".into(),
                    file: Some("main.tex".into()),
                    line: Some(5),
                    ..Default::default()
                }],
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn answer() -> String {
        json!({
            "summary": "The fonts needed by microtype are missing.",
            "cause": "cm-super isn't installed.",
            "steps": ["Install cm-super", "Compile again"],
            "edits": [
                {"file": "main.tex", "find": "\\usepackage{microtype}", "replace": "\\usepackage{lmodern}\n\\usepackage{microtype}", "why": "scalable fonts"},
                {"file": "../evil.tex", "find": "x", "replace": "y", "why": "nope"},
                {"file": "main.tex", "find": "\\usepackage{nothere}", "replace": "z", "why": "stale"}
            ],
            "env_actions": [
                {"kind": "install_package", "manager": "miktex", "package": "cm-super", "why": "Type 1 fonts"},
                {"kind": "install_package", "manager": "miktex", "package": "--admin", "why": "bad"}
            ],
            "confidence": "high"
        })
        .to_string()
    }

    fn chat_reply(content: &str) -> Canned {
        Canned::json(200, json!({"model": "kimi", "choices": [{"message": {"content": content}, "finish_reason": "stop"}]}))
    }

    fn miktex() -> Toolchains {
        Toolchains { distribution: Some("MiKTeX".into()), ..Default::default() }
    }

    #[test]
    fn full_round_trip_with_model_discovery() {
        let server = MockServer::start(vec![
            Canned::json(200, json!({"data": [{"id": "z-ai/glm-5.3-flash"}, {"id": "moonshotai/kimi-k3.1-pro"}]})),
            chat_reply(&answer()),
        ]);
        let s = setup(Some(&server), ProviderId::Nvidia, true);
        s.ai.keys.set(ProviderId::Nvidia, KEY).unwrap();
        let stages = Mutex::new(Vec::new());
        let result = runtime()
            .block_on(s.ai.explain(s.project.path(), request(), &miktex(), |st, _| stages.lock().unwrap().push(st)))
            .unwrap();
        assert_eq!(*stages.lock().unwrap(), vec![Stage::Gathering, Stage::Asking, Stage::Checking]);
        assert_eq!(result.request_id, "r1");
        assert_eq!(result.summary, "The fonts needed by microtype are missing.");
        assert_eq!(result.edits.len(), 3);
        assert!(result.edits[0].ok);
        assert_eq!(result.edits[0].line, Some(3));
        assert!(!result.edits[1].ok);
        assert!(!result.edits[2].ok);
        assert_eq!(result.env_actions.len(), 1);
        assert_eq!(result.env_actions[0].package, "cm-super");
        assert_eq!(result.env_actions[0].command, "miktex packages install cm-super");
        assert!(!result.env_actions[0].available);
        assert_eq!(result.notes.len(), 2);
        assert!(result.sent.excerpts.iter().any(|e| e.file == "main.tex"));
        // The recommended model was used and remembered.
        let reqs = server.recorded();
        assert_eq!(reqs[0].path, "/v1/models");
        assert_eq!(reqs[1].json()["model"], "moonshotai/kimi-k3.1-pro");
        assert_eq!(s.ai.settings().models.get(&ProviderId::Nvidia).map(String::as_str), Some("moonshotai/kimi-k3.1-pro"));
        // The prompt carries the error and the file, never the key.
        let body = &reqs[1].body;
        assert!(body.contains("auto expansion is only possible"));
        assert!(body.contains("\\\\usepackage{microtype}"));
        assert!(!body.contains(KEY));
        assert_eq!(reqs[1].header("authorization").unwrap(), format!("Bearer {KEY}"));
        // Nothing the UI receives contains the key.
        assert!(!serde_json::to_string(&result).unwrap().contains(KEY));
        assert!(!serde_json::to_string(&s.ai.provider_infos()).unwrap().contains(KEY));
        assert!(!serde_json::to_string(&s.ai.settings()).unwrap().contains(KEY));
        // The request is no longer running.
        assert!(!s.ai.cancel("r1"));
    }

    #[test]
    fn claude_round_trip() {
        let server = MockServer::start(vec![Canned::json(200, json!({
            "model": "claude-opus-5-5", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": answer()}]}))]);
        let s = setup(Some(&server), ProviderId::Anthropic, true);
        s.ai.keys.set(ProviderId::Anthropic, "sk-ant-api-0123456789abcdef").unwrap();
        let result = runtime().block_on(s.ai.explain(s.project.path(), request(), &miktex(), |_, _| {})).unwrap();
        assert_eq!(result.model, "claude-opus-5-5");
        let req = &server.recorded()[0];
        assert_eq!(req.path, "/v1/messages");
        assert_eq!(req.json()["model"], "claude-opus-5-5");
        assert_eq!(req.json()["system"], prompt::SYSTEM_PROMPT);
    }

    #[test]
    fn gates_come_before_any_network() {
        // No server: a request would fail with Offline, not these kinds.
        let s = setup(None, ProviderId::Nvidia, false);
        let rt = runtime();
        let err = rt.block_on(s.ai.explain(s.project.path(), request(), &miktex(), |_, _| {})).unwrap_err();
        assert_eq!(err.kind, Kind::NoticeRequired);

        s.ai.prefs.apply(&AiSettingsPatch { accept_notice: Some(ProviderId::Nvidia), ..Default::default() }).unwrap();
        let err = rt.block_on(s.ai.explain(s.project.path(), request(), &miktex(), |_, _| {})).unwrap_err();
        assert_eq!(err.kind, Kind::NoKey);
        assert!(err.message.contains("NVIDIA"));

        s.ai.prefs.apply(&AiSettingsPatch { enabled: Some(false), ..Default::default() }).unwrap();
        let err = rt.block_on(s.ai.explain(s.project.path(), request(), &miktex(), |_, _| {})).unwrap_err();
        assert_eq!(err.kind, Kind::Disabled);
    }

    #[test]
    fn bad_key_error_never_contains_the_key() {
        let server = MockServer::start(vec![Canned::json(401, json!({"error": {"message": format!("Authentication failed for {KEY}")}}))]);
        let s = setup(Some(&server), ProviderId::Nvidia, true);
        s.ai.keys.set(ProviderId::Nvidia, KEY).unwrap();
        s.ai.prefs
            .apply(&AiSettingsPatch {
                model: Some(ModelChoice { provider: ProviderId::Nvidia, model: Some("m".into()) }),
                ..Default::default()
            })
            .unwrap();
        let err = runtime().block_on(s.ai.explain(s.project.path(), request(), &miktex(), |_, _| {})).unwrap_err();
        assert_eq!(err.kind, Kind::BadKey);
        assert!(!err.to_string().contains(KEY));
        assert!(!format!("{err:?}").contains(KEY));
        assert!(!serde_json::to_string(&err).unwrap().contains(KEY));
    }

    #[test]
    fn unreadable_answer_is_a_bad_response() {
        let server = MockServer::start(vec![chat_reply("I think you should install cm-super.")]);
        let s = setup(Some(&server), ProviderId::Custom, true);
        s.ai.prefs
            .apply(&AiSettingsPatch {
                model: Some(ModelChoice { provider: ProviderId::Custom, model: Some("llama".into()) }),
                ..Default::default()
            })
            .unwrap();
        let err = runtime().block_on(s.ai.explain(s.project.path(), request(), &miktex(), |_, _| {})).unwrap_err();
        assert_eq!(err.kind, Kind::BadResponse);
        // The custom provider needs no key.
        assert_eq!(server.recorded()[0].header("authorization"), None);
    }

    #[test]
    fn cancel_by_request_id() {
        let server = MockServer::start(vec![chat_reply(&answer()).delay(3000)]);
        let s = setup(Some(&server), ProviderId::Custom, true);
        s.ai.prefs
            .apply(&AiSettingsPatch {
                model: Some(ModelChoice { provider: ProviderId::Custom, model: Some("llama".into()) }),
                ..Default::default()
            })
            .unwrap();
        let ai = &s.ai;
        let tools = miktex();
        let rt = runtime();
        let err = rt
            .block_on(async {
                let canceller = async {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        if ai.cancel("r1") {
                            break;
                        }
                    }
                    std::future::pending::<()>().await;
                };
                tokio::select! {
                    r = ai.explain(s.project.path(), request(), &tools, |_, _| {}) => r,
                    _ = canceller => unreachable!(),
                }
            })
            .unwrap_err();
        assert_eq!(err.kind, Kind::Cancelled);
    }

    #[test]
    fn test_connection_reports_model_availability() {
        let server = MockServer::start(vec![
            Canned::json(200, json!({"data": [{"id": "openai/gpt-oss-120b"}]})),
            Canned::json(200, json!({"data": [{"id": "openai/gpt-oss-120b"}]})),
        ]);
        let s = setup(Some(&server), ProviderId::Groq, false);
        s.ai.keys.set(ProviderId::Groq, "gsk_0123456789abcdef0123").unwrap();
        let rt = runtime();
        let t = rt.block_on(s.ai.test_connection(ProviderId::Groq)).unwrap();
        assert!(t.ok);
        assert_eq!(t.model.as_deref(), Some("openai/gpt-oss-120b"));
        assert_eq!(t.model_available, None);
        s.ai.prefs
            .apply(&AiSettingsPatch {
                model: Some(ModelChoice { provider: ProviderId::Groq, model: Some("gone/model".into()) }),
                ..Default::default()
            })
            .unwrap();
        let t = rt.block_on(s.ai.test_connection(ProviderId::Groq)).unwrap();
        assert!(!t.ok);
        assert_eq!(t.model_available, Some(false));
    }

    #[test]
    fn env_actions_follow_the_installed_distribution() {
        let raw = vec![
            prompt::RawEnvAction { kind: "install_package".into(), manager: "texlive".into(), package: "cm-super".into(), why: "w".into() },
            prompt::RawEnvAction { kind: "install_package".into(), manager: "miktex".into(), package: "cm-super".into(), why: "dup".into() },
            prompt::RawEnvAction { kind: "run_shell".into(), manager: "miktex".into(), package: "x".into(), why: "w".into() },
        ];
        let mut notes = Vec::new();
        let out = env_actions(&raw, &miktex(), &mut notes);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].manager, Manager::Miktex);
        assert_eq!(notes.len(), 1);
        let out = env_actions(&raw, &Toolchains::default(), &mut Vec::new());
        assert_eq!(out[0].manager, Manager::Texlive);
    }
}
