//! Tauri commands of the agents runtime, and the app's versions of its
//! event sink and environment.
//!
//! Commands: `agent_start`, `agent_list`, `agent_get`, `agent_cancel`,
//! `agent_respond`, `agent_changeset`, `agent_apply`, `agent_discard`,
//! `agent_delete`. Events: `agent-run-updated` ([`RunSummary`]),
//! `agent-step` ([`StepEvent`]), `agent-message` ([`MessageEvent`]).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::error::AiResult;
use crate::ai::http::Cancel;
use crate::ai::llm::RetryPolicy;
use crate::ai::AiState;
use crate::error::{AppError, AppResult};
use crate::AppState;

use super::kinds::AgentKind;
use super::run_loop::{Events, RunEnv};
use super::runtime::{AgentRuntime, EnvSource};
use super::tools::build::BuildEnv;
use super::tools::registry::BoxFut;
use super::types::{
    AgentRun, ApplyResult, Changeset, Decision, MessageEvent, RunSummary, StartRequest, StepEvent, MESSAGE_EVENT,
    RUN_UPDATED_EVENT, STEP_EVENT,
};

/// Sends run updates to the app's windows.
pub struct TauriEvents(pub AppHandle);

impl Events for TauriEvents {
    fn run_updated(&self, run: &RunSummary) {
        let _ = self.0.emit(RUN_UPDATED_EVENT, run);
    }
    fn step(&self, event: &StepEvent) {
        let _ = self.0.emit(STEP_EVENT, event);
    }
    fn message(&self, event: &MessageEvent) {
        let _ = self.0.emit(MESSAGE_EVENT, event);
    }
}

/// Reads Settings > AI (provider, key, model), the web settings and the
/// compiler settings for a run.
pub struct TauriEnv(pub AppHandle);

impl EnvSource for TauriEnv {
    fn resolve<'a>(
        &'a self,
        root: &'a Path,
        kind: &'a dyn AgentKind,
        request: &'a StartRequest,
        cancel: Cancel,
    ) -> BoxFut<'a, AiResult<RunEnv>> {
        Box::pin(async move {
            let app = self.0.clone();
            let ai = app.state::<AiState>();
            let settings = ai.settings();
            let opts = &request.options;
            // The default models for this kind's role (Settings ▸ AI ▸
            // Agents, else the spec's NVIDIA / Claude defaults), resolved
            // against the provider's live model list, with the user's own
            // pick as the last fallback.
            let defaults = match app.path().app_config_dir() {
                Ok(dir) => super::profiles::load_defaults(&dir),
                Err(_) => Default::default(),
            };
            let has_roles = defaults.role(settings.provider, kind.role()).is_some();
            let live = if has_roles { super::profiles::live_models(&ai, settings.provider).await } else { Vec::new() };
            let choice = super::profiles::role_models(&defaults, settings.provider, kind.role(), &live);
            let model = opts.model.clone().filter(|m| !m.trim().is_empty()).or_else(|| choice.as_ref().map(|c| c.model.clone()));
            let (client, endpoint) = ai.llm_endpoint(model, &cancel).await?;
            let mut fallback_models: Vec<String> = match &opts.fallback_models {
                Some(f) => f.clone(),
                None => choice.as_ref().map(|c| c.fallbacks.clone()).unwrap_or_default(),
            };
            if let Some(mine) = settings.models.get(&settings.provider) {
                if *mine != endpoint.model && !fallback_models.contains(mine) {
                    fallback_models.push(mine.clone());
                }
            }
            let thinking = opts.thinking.or(choice.as_ref().and_then(|c| c.thinking)).unwrap_or(false);
            let vision = super::profiles::vision_fallback(&defaults, settings.provider, &live)
                .filter(|v| v.model != endpoint.model);
            let net = crate::agents::tools::web_settings::net_ctx(&app, cancel.clone()).await.ok();
            let build = {
                let state = app.state::<Mutex<AppState>>();
                let s = state.lock().unwrap_or_else(|e| e.into_inner());
                BuildEnv {
                    tools_dir: s.tools_dir.clone(),
                    compiler: s.settings.compiler,
                    trusted: s.settings.trusted_projects.iter().any(|p| crate::project::same_path(p, root)),
                }
            };
            Ok(RunEnv { client, endpoint, fallback_models, thinking, policy: RetryPolicy::default(), net, build: Some(build), vision })
        })
    }
}

/// The runtime for the app (call once in `setup`).
pub fn runtime_for(app: &AppHandle) -> AgentRuntime {
    let rt = AgentRuntime::new(std::sync::Arc::new(TauriEvents(app.clone())), std::sync::Arc::new(TauriEnv(app.clone())));
    if let Ok(cfg) = app.path().app_config_dir() {
        rt.set_max_parallel(super::profiles::load_defaults(&cfg).max_parallel as usize);
    }
    rt
}

type Shared<'a> = State<'a, Mutex<AppState>>;

fn project_dir(state: &Shared<'_>, project: &str) -> AppResult<PathBuf> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(crate::commands::known_project(&s, project)?.0)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|_| AppError::msg("Something went wrong inside Texo. Try again."))?
}

/// Starts a run. With `request.profileId`, the profile fills in the kind
/// (when empty) and every option the request leaves open.
#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: Shared<'_>,
    rt: State<'_, AgentRuntime>,
    project: String,
    request: StartRequest,
) -> AppResult<RunSummary> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    let cfg = app.path().app_config_dir().ok();
    blocking(move || {
        let mut request = request;
        if let Some(id) = request.profile_id.clone().filter(|i| !i.trim().is_empty()) {
            let cfg = cfg.ok_or_else(|| AppError::msg("Texo's settings folder can't be found."))?;
            let profile = super::profiles::find(&cfg, Some(&dir), &id)?;
            super::profiles::apply(&profile, &mut request)?;
        }
        rt.start(dir, project, request)
    })
    .await
}

#[tauri::command]
pub async fn agent_list(state: Shared<'_>, rt: State<'_, AgentRuntime>, project: String) -> AppResult<Vec<RunSummary>> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    blocking(move || Ok(rt.list(&dir))).await
}

#[tauri::command]
pub async fn agent_get(state: Shared<'_>, rt: State<'_, AgentRuntime>, project: String, run_id: String) -> AppResult<AgentRun> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    blocking(move || rt.get(&dir, &run_id)).await
}

#[tauri::command]
pub async fn agent_cancel(rt: State<'_, AgentRuntime>, run_id: String) -> AppResult<bool> {
    Ok(rt.cancel(&run_id))
}

/// Answers a run waiting in `awaiting_input` (e.g. an approved plan).
#[tauri::command]
pub async fn agent_respond(rt: State<'_, AgentRuntime>, run_id: String, input: Value) -> AppResult<()> {
    rt.respond(&run_id, input)
}

#[tauri::command]
pub async fn agent_changeset(
    state: Shared<'_>,
    rt: State<'_, AgentRuntime>,
    project: String,
    run_id: String,
) -> AppResult<Changeset> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    blocking(move || rt.changeset(&dir, &run_id)).await
}

#[tauri::command]
pub async fn agent_apply(
    state: Shared<'_>,
    rt: State<'_, AgentRuntime>,
    project: String,
    run_id: String,
    decisions: Vec<Decision>,
) -> AppResult<ApplyResult> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    blocking(move || rt.apply(&dir, &run_id, &decisions)).await
}

#[tauri::command]
pub async fn agent_discard(
    state: Shared<'_>,
    rt: State<'_, AgentRuntime>,
    project: String,
    run_id: String,
) -> AppResult<RunSummary> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    blocking(move || rt.discard(&dir, &run_id)).await
}

#[tauri::command]
pub async fn agent_delete(state: Shared<'_>, rt: State<'_, AgentRuntime>, project: String, run_id: String) -> AppResult<()> {
    let dir = project_dir(&state, &project)?;
    let rt = rt.inner().clone();
    blocking(move || rt.delete(&dir, &run_id)).await
}
