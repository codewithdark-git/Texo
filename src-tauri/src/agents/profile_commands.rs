//! Tauri commands for agent profiles, the agents' defaults and the project
//! memory (Settings ▸ AI ▸ Agents and Memory).
//!
//! Profiles: `agent_profiles_list`, `agent_profiles_save`,
//! `agent_profiles_delete`, `agent_profiles_reset`, `agent_defaults_save`.
//! Memory: `memory_get`, `memory_set`, `memory_clear`, `memory_add`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::AppState;

use super::profiles::{self, AgentDefaults, Profile, ProfilesView, Scope};
use super::tools::memory;

type Shared<'a> = State<'a, Mutex<AppState>>;

fn config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path().app_config_dir().map_err(|_| AppError::msg("Texo's settings folder can't be found."))
}

fn project_dir(state: &Shared<'_>, project: &str) -> AppResult<PathBuf> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(crate::commands::known_project(&s, project)?.0)
}

fn maybe_project(state: &Shared<'_>, project: Option<&str>) -> AppResult<Option<PathBuf>> {
    match project.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => project_dir(state, p).map(Some),
        None => Ok(None),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|_| AppError::msg("Something went wrong inside Texo. Try again."))?
}

/// Built-in, global and (with `project`) project profiles merged, plus the
/// defaults.
#[tauri::command]
pub async fn agent_profiles_list(app: AppHandle, state: Shared<'_>, project: Option<String>) -> AppResult<ProfilesView> {
    let cfg = config_dir(&app)?;
    let dir = maybe_project(&state, project.as_deref())?;
    blocking(move || Ok(profiles::load(&cfg, dir.as_deref()))).await
}

/// Creates (empty `id`) or replaces a profile in the global or project
/// file. Saving a built-in's id overrides that built-in.
#[tauri::command]
pub async fn agent_profiles_save(
    app: AppHandle,
    state: Shared<'_>,
    project: Option<String>,
    scope: Scope,
    profile: Profile,
) -> AppResult<ProfilesView> {
    let cfg = config_dir(&app)?;
    let dir = maybe_project(&state, project.as_deref())?;
    blocking(move || profiles::save(&cfg, dir.as_deref(), scope, &profile)).await
}

/// Deletes a profile from one file (the UI asks first). Built-ins can only
/// be reset.
#[tauri::command]
pub async fn agent_profiles_delete(
    app: AppHandle,
    state: Shared<'_>,
    project: Option<String>,
    scope: Scope,
    id: String,
) -> AppResult<ProfilesView> {
    let cfg = config_dir(&app)?;
    let dir = maybe_project(&state, project.as_deref())?;
    blocking(move || profiles::delete(&cfg, dir.as_deref(), scope, &id)).await
}

/// Removes the user's changes to a built-in profile (global and project).
#[tauri::command]
pub async fn agent_profiles_reset(app: AppHandle, state: Shared<'_>, project: Option<String>, id: String) -> AppResult<ProfilesView> {
    let cfg = config_dir(&app)?;
    let dir = maybe_project(&state, project.as_deref())?;
    blocking(move || profiles::reset(&cfg, dir.as_deref(), &id)).await
}

/// Saves the defaults: model per role and provider, max parallel runs.
#[tauri::command]
pub async fn agent_defaults_save(
    app: AppHandle,
    state: Shared<'_>,
    project: Option<String>,
    defaults: AgentDefaults,
) -> AppResult<ProfilesView> {
    let cfg = config_dir(&app)?;
    let dir = maybe_project(&state, project.as_deref())?;
    let parallel = defaults.max_parallel as usize;
    let view = blocking(move || profiles::save_defaults(&cfg, dir.as_deref(), &defaults)).await?;
    if let Some(rt) = app.try_state::<super::runtime::AgentRuntime>() {
        rt.set_max_parallel(parallel);
    }
    Ok(view)
}

/// The project memory as the Memory view shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub text: String,
    pub bytes: usize,
    pub max_bytes: usize,
}

fn info(dir: &std::path::Path) -> MemoryInfo {
    let text = memory::read(dir);
    MemoryInfo { bytes: text.len(), text, max_bytes: memory::MAX_BYTES }
}

#[tauri::command]
pub async fn memory_get(state: Shared<'_>, project: String) -> AppResult<MemoryInfo> {
    let dir = project_dir(&state, &project)?;
    blocking(move || Ok(info(&dir))).await
}

/// Replaces the memory (refused over 8 KB; blank text clears it).
#[tauri::command]
pub async fn memory_set(state: Shared<'_>, project: String, text: String) -> AppResult<MemoryInfo> {
    let dir = project_dir(&state, &project)?;
    blocking(move || {
        memory::set(&dir, &text)?;
        Ok(info(&dir))
    })
    .await
}

/// Deletes the memory (the UI asks first).
#[tauri::command]
pub async fn memory_clear(state: Shared<'_>, project: String) -> AppResult<MemoryInfo> {
    let dir = project_dir(&state, &project)?;
    blocking(move || {
        memory::clear(&dir)?;
        Ok(info(&dir))
    })
    .await
}

/// Adds one note, as `remember` does ("Remember this for next time?" after
/// a rejected change).
#[tauri::command]
pub async fn memory_add(state: Shared<'_>, project: String, note: String) -> AppResult<MemoryInfo> {
    let dir = project_dir(&state, &project)?;
    blocking(move || {
        memory::remember(&dir, &note)?;
        Ok(info(&dir))
    })
    .await
}
