//! Agent profiles ("trainable" agents) and the agents' defaults.
//!
//! A profile is a named setup of an agent kind: its instructions, model and
//! fallbacks, tools (a subset of the kind's), auto-apply, step limit and,
//! for reviewers, a [`ReviewSetup`]. Three layers, merged by `id` (later
//! wins, whole profile):
//! 1. the built-in profiles ([`builtins`]),
//! 2. global profiles: `agents.json` in the app config dir (also holds the
//!    defaults: model per role with fallbacks, max parallel runs),
//! 3. project profiles: `<project>/.texo/ai/agents.json`.
//!
//! Saving a profile with a built-in's id overrides that built-in; "reset"
//! removes the overrides. Commands are in `profile_commands.rs`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::llm::{ModelChoice, ProviderId};
use crate::error::{AppError, AppResult};

use super::attach::VisionFallback;
use super::kinds::{ModelRole, Registry};
use super::review::ReviewSetup;
use super::types::StartRequest;

pub const FILE_NAME: &str = "agents.json";
pub const VERSION: u32 = 1;
pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_INSTRUCTIONS_CHARS: usize = 8000;
pub const MAX_FALLBACKS: usize = 8;
pub const MAX_STEPS_LIMIT: u32 = 200;
pub const DEFAULT_MAX_PARALLEL: u8 = 3;
/// The Claude default for every role (spec "Defaults").
pub const CLAUDE_MODEL: &str = "claude-opus-5-5";

/// Where a profile in the merged list comes from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    #[default]
    Builtin,
    Global,
    Project,
}

/// Which file a save or delete goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Global,
    Project,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Lowercase letters, digits and `-`; made from the name when empty.
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// fixer / reviewer / rebuttal / task / chat.
    pub kind: String,
    /// One line for the "New task" menu.
    #[serde(default)]
    pub description: String,
    /// Added to the kind's system prompt.
    #[serde(default)]
    pub instructions: String,
    /// `None`: the default model for the kind's role.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub fallback_models: Vec<String>,
    /// A subset of the kind's tools; empty: all of them.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Apply the changes when the run finishes (never when something needs
    /// attention).
    #[serde(default)]
    pub auto_apply: bool,
    /// `None`: the kind's limit (fixer 16, reviewer 40, others 24).
    #[serde(default)]
    pub max_steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    /// The model can see images; `None`: from the known model list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// Reviewer setup (reviewer profiles only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewSetup>,
    /// Output only: where this profile comes from.
    #[serde(default)]
    pub source: ProfileSource,
    /// Output only: a built-in profile the user changed.
    #[serde(default)]
    pub overrides_builtin: bool,
}

/// A model with its fallbacks, for one role.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleModels {
    pub model: String,
    #[serde(default)]
    pub fallbacks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
}

impl RoleModels {
    fn from_choice(c: ModelChoice) -> RoleModels {
        RoleModels {
            model: c.model.to_string(),
            fallbacks: c.fallbacks.iter().map(|s| s.to_string()).collect(),
            thinking: Some(c.thinking),
        }
    }

    /// The model and its fallbacks in order.
    pub fn all(&self) -> Vec<String> {
        std::iter::once(self.model.clone()).chain(self.fallbacks.iter().cloned()).filter(|m| !m.trim().is_empty()).collect()
    }

    /// Keeps the models the provider's live list has (in order). An empty
    /// live list (unknown, offline) keeps them all; `None` when none is
    /// available.
    pub fn resolved(&self, live: &[String]) -> Option<RoleModels> {
        let all = self.all();
        let kept: Vec<String> = if live.is_empty() {
            all
        } else {
            all.into_iter().filter_map(|m| live.iter().find(|l| l.eq_ignore_ascii_case(m.trim())).cloned()).collect()
        };
        let (first, rest) = kept.split_first()?;
        let mut fallbacks: Vec<String> = Vec::new();
        for m in rest {
            if m != first && !fallbacks.contains(m) {
                fallbacks.push(m.clone());
            }
        }
        Some(RoleModels { model: first.clone(), fallbacks, thinking: self.thinking })
    }
}

/// The default models per role, for one provider.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<RoleModels>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<RoleModels>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<RoleModels>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<RoleModels>,
}

impl RoleSet {
    pub fn get(&self, role: ModelRole) -> Option<&RoleModels> {
        match role {
            ModelRole::Agent => self.agent.as_ref(),
            ModelRole::Chat => self.chat.as_ref(),
            ModelRole::Vision => self.vision.as_ref(),
            ModelRole::Review => self.review.as_ref(),
        }
    }

    fn slot(&mut self, role: ModelRole) -> &mut Option<RoleModels> {
        match role {
            ModelRole::Agent => &mut self.agent,
            ModelRole::Chat => &mut self.chat,
            ModelRole::Vision => &mut self.vision,
            ModelRole::Review => &mut self.review,
        }
    }
}

const ROLES: [ModelRole; 4] = [ModelRole::Agent, ModelRole::Chat, ModelRole::Vision, ModelRole::Review];

fn max_parallel_default() -> u8 {
    DEFAULT_MAX_PARALLEL
}

/// Settings ▸ AI ▸ Agents defaults (kept in the global `agents.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaults {
    /// Per provider id (`nvidia`, `anthropic`, …): models per role. Roles
    /// the user didn't set use the built-in defaults.
    #[serde(default)]
    pub roles: BTreeMap<String, RoleSet>,
    /// Runs working at the same time (1–5). Saved for the runtime; it
    /// currently always allows 3.
    #[serde(default = "max_parallel_default")]
    pub max_parallel: u8,
}

impl Default for AgentDefaults {
    fn default() -> Self {
        AgentDefaults { roles: BTreeMap::new(), max_parallel: DEFAULT_MAX_PARALLEL }
    }
}

fn provider_key(p: ProviderId) -> String {
    serde_json::to_value(p).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// The spec's defaults for a provider: NVIDIA's role models, Claude for
/// everything on Anthropic; other providers have none (the model picked in
/// Settings is used).
pub fn builtin_roles(provider: ProviderId) -> RoleSet {
    use crate::ai::llm::{NVIDIA_AGENT, NVIDIA_CHAT, NVIDIA_REVIEW, NVIDIA_VISION};
    match provider {
        ProviderId::Nvidia => RoleSet {
            agent: Some(RoleModels::from_choice(NVIDIA_AGENT)),
            chat: Some(RoleModels::from_choice(NVIDIA_CHAT)),
            vision: Some(RoleModels::from_choice(NVIDIA_VISION)),
            review: Some(RoleModels::from_choice(NVIDIA_REVIEW)),
        },
        ProviderId::Anthropic => {
            let claude = |thinking| Some(RoleModels { model: CLAUDE_MODEL.into(), fallbacks: Vec::new(), thinking: Some(thinking) });
            RoleSet { agent: claude(true), chat: claude(false), vision: claude(false), review: claude(true) }
        }
        _ => RoleSet::default(),
    }
}

impl AgentDefaults {
    /// The user's role models over the built-in ones.
    pub fn role(&self, provider: ProviderId, role: ModelRole) -> Option<RoleModels> {
        self.roles
            .get(&provider_key(provider))
            .and_then(|s| s.get(role))
            .filter(|r| !r.model.trim().is_empty())
            .cloned()
            .or_else(|| builtin_roles(provider).get(role).cloned())
    }

    /// Every provider's roles with the built-in defaults filled in (what
    /// the settings page shows).
    pub fn effective(&self) -> AgentDefaults {
        let mut out = self.clone();
        for p in [ProviderId::Nvidia, ProviderId::Anthropic] {
            let set = out.roles.entry(provider_key(p)).or_default();
            for role in ROLES {
                let slot = set.slot(role);
                if slot.as_ref().is_none_or(|r| r.model.trim().is_empty()) {
                    *slot = builtin_roles(p).get(role).cloned();
                }
            }
        }
        out
    }

    /// Trims and checks the user's input.
    pub fn validated(&self) -> AppResult<AgentDefaults> {
        if !(1..=5).contains(&self.max_parallel) {
            return Err(AppError::msg("Runs at the same time must be between 1 and 5."));
        }
        let mut out = AgentDefaults { roles: BTreeMap::new(), max_parallel: self.max_parallel };
        for (provider, set) in &self.roles {
            if serde_json::from_value::<ProviderId>(Value::String(provider.clone())).is_err() {
                return Err(AppError::msg(format!("Texo doesn't know the AI provider \"{provider}\".")));
            }
            let mut clean = RoleSet::default();
            for role in ROLES {
                if let Some(r) = set.get(role) {
                    let model = r.model.trim().to_string();
                    if model.is_empty() {
                        continue;
                    }
                    *clean.slot(role) =
                        Some(RoleModels { model, fallbacks: clean_models(&r.fallbacks)?, thinking: r.thinking });
                }
            }
            if clean != RoleSet::default() {
                out.roles.insert(provider.clone(), clean);
            }
        }
        Ok(out)
    }
}

// ------------------------------------------------------------ built-ins --

pub const BUILTIN_IDS: [&str; 5] = ["fixer", "reviewer", "rebuttal", "task", "chat"];

/// The built-in profiles, one per kind.
pub fn builtins() -> Vec<Profile> {
    let p = |id: &str, name: &str, description: &str, auto_apply: bool| Profile {
        id: id.into(),
        name: name.into(),
        kind: id.into(),
        description: description.into(),
        auto_apply,
        ..Default::default()
    };
    vec![
        p("fixer", "Fix compile errors", "Finds why the document doesn't compile and fixes it.", false),
        Profile {
            review: Some(ReviewSetup::default()),
            ..p(
                "reviewer",
                "Reviewer (generic)",
                "Reviews the paper like a conference reviewer, with scores and file:line notes.",
                // Only the review file it writes when you ask for one.
                true,
            )
        },
        p("rebuttal", "Response to reviewers", "Plans and drafts your answer to the reviewers.", false),
        p("task", "Task agent", "Does what you ask: one or several tasks, with files and images.", false),
        p("chat", "Chat", "Answers questions about your paper.", false),
    ]
}

pub fn is_builtin(id: &str) -> bool {
    BUILTIN_IDS.contains(&id)
}

// ---------------------------------------------------------------- files --

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    profiles: Vec<Profile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    defaults: Option<AgentDefaults>,
}

static WRITE: Mutex<()> = Mutex::new(());

pub fn global_path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

pub fn project_path(dir: &Path) -> PathBuf {
    dir.join(crate::project::META_DIR).join("ai").join(FILE_NAME)
}

/// Reads a profiles file; a missing file is empty, a damaged one is a
/// warning (and is never overwritten without a backup).
fn read_file(path: &Path) -> Result<AgentsFile, String> {
    match fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AgentsFile::default()),
        Err(e) => Err(format!("{} couldn't be read ({e}).", path.display())),
        Ok(text) if text.trim().is_empty() => Ok(AgentsFile::default()),
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} isn't valid ({e}).", path.display())),
    }
}

fn write_file(path: &Path, file: &AgentsFile) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.is_file() && read_file(path).is_err() {
        // Keep the damaged file next to the new one.
        let backup = path.with_extension(format!("broken-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        let _ = fs::rename(path, backup);
    }
    let mut file = file.clone();
    file.version = VERSION;
    for p in &mut file.profiles {
        p.source = ProfileSource::Builtin;
        p.overrides_builtin = false;
    }
    let text = serde_json::to_string_pretty(&file).map_err(|e| AppError::msg(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn scope_path(scope: Scope, config_dir: &Path, project: Option<&Path>) -> AppResult<PathBuf> {
    match scope {
        Scope::Global => Ok(global_path(config_dir)),
        Scope::Project => {
            let dir = project.ok_or_else(|| AppError::msg("Open a project first to save a profile in it."))?;
            Ok(crate::project::meta_subdir(dir, Some("ai"))?.join(FILE_NAME))
        }
    }
}

// ------------------------------------------------------------- merging --

/// The merged profiles and the defaults, for Settings ▸ AI ▸ Agents and the
/// "New task" menu.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    pub profiles: Vec<Profile>,
    /// With the built-in role defaults filled in.
    pub defaults: AgentDefaults,
    pub builtin_ids: Vec<String>,
    /// Files that couldn't be read (their profiles are left out).
    pub warnings: Vec<String>,
}

/// Built-ins, then global, then project profiles; later ones replace
/// earlier ones with the same id.
pub fn merge(global: &[Profile], project: &[Profile]) -> Vec<Profile> {
    let mut out = builtins();
    for (layer, source) in [(global, ProfileSource::Global), (project, ProfileSource::Project)] {
        for p in layer {
            let mut p = p.clone();
            p.source = source;
            p.overrides_builtin = is_builtin(&p.id);
            match out.iter_mut().find(|x| x.id == p.id) {
                Some(slot) => *slot = p,
                None => out.push(p),
            }
        }
    }
    out
}

/// Reads the global defaults (built-ins filled in when the file is missing
/// or damaged).
pub fn load_defaults(config_dir: &Path) -> AgentDefaults {
    read_file(&global_path(config_dir)).ok().and_then(|f| f.defaults).unwrap_or_default()
}

pub fn load(config_dir: &Path, project: Option<&Path>) -> ProfilesView {
    let mut warnings = Vec::new();
    let global = read_file(&global_path(config_dir)).unwrap_or_else(|w| {
        warnings.push(format!("Your global agent profiles couldn't be loaded: {w}"));
        AgentsFile::default()
    });
    let proj = match project {
        Some(dir) => read_file(&project_path(dir)).unwrap_or_else(|w| {
            warnings.push(format!("This project's agent profiles couldn't be loaded: {w}"));
            AgentsFile::default()
        }),
        None => AgentsFile::default(),
    };
    let valid = |ps: Vec<Profile>, warnings: &mut Vec<String>| -> Vec<Profile> {
        ps.into_iter()
            .filter_map(|p| match validate(&p) {
                Ok(v) => Some(v),
                Err(e) => {
                    warnings.push(format!("The profile \"{}\" was skipped: {e}", p.name.trim()));
                    None
                }
            })
            .collect()
    };
    let g = valid(global.profiles, &mut warnings);
    let pr = valid(proj.profiles, &mut warnings);
    ProfilesView {
        profiles: merge(&g, &pr),
        defaults: global.defaults.unwrap_or_default().effective(),
        builtin_ids: BUILTIN_IDS.iter().map(|s| s.to_string()).collect(),
        warnings,
    }
}

/// One profile by id from the merged list.
pub fn find(config_dir: &Path, project: Option<&Path>, id: &str) -> AppResult<Profile> {
    load(config_dir, project)
        .profiles
        .into_iter()
        .find(|p| p.id == id.trim())
        .ok_or_else(|| AppError::msg("That agent profile doesn't exist any more. Pick another one."))
}

// ---------------------------------------------------------- validation --

fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 48 {
            break;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "profile".into()
    } else {
        s
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

fn clean_models(models: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for m in models {
        let m = m.trim();
        if !m.is_empty() && !out.iter().any(|x| x == m) {
            out.push(m.to_string());
        }
    }
    if out.len() > MAX_FALLBACKS {
        return Err(AppError::msg(format!("At most {MAX_FALLBACKS} fallback models can be listed.")));
    }
    Ok(out)
}

/// The tool names a kind can use (its built-ins and its own tools).
pub fn kind_tools(kind: &str) -> Option<Vec<String>> {
    let k = Registry::default().get(kind)?;
    let mut names: Vec<String> = k.tool_names().iter().map(|s| s.to_string()).collect();
    for t in k.extra_tools() {
        let n = t.spec().name;
        if !names.contains(&n) {
            names.push(n);
        }
    }
    Some(names)
}

/// Checks a profile and returns a clean copy (trimmed, deduplicated, the
/// id made from the name when missing, the review setup normalized).
pub fn validate(p: &Profile) -> AppResult<Profile> {
    let mut v = p.clone();
    v.name = v.name.trim().to_string();
    if v.name.is_empty() {
        return Err(AppError::msg("Give the profile a name."));
    }
    if v.name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::msg(format!("The name can be at most {MAX_NAME_CHARS} characters.")));
    }
    v.kind = v.kind.trim().to_string();
    let Some(allowed) = kind_tools(&v.kind) else {
        return Err(AppError::msg(format!("Texo doesn't know the agent kind \"{}\".", v.kind)));
    };
    v.id = v.id.trim().to_string();
    if v.id.is_empty() {
        v.id = slug(&v.name);
    }
    if !valid_id(&v.id) {
        return Err(AppError::msg("A profile id can only have lowercase letters, digits and dashes."));
    }
    if is_builtin(&v.id) && v.id != v.kind {
        return Err(AppError::msg(format!("The built-in profile \"{}\" must stay a {} agent.", v.id, v.id)));
    }
    v.description = v.description.trim().chars().take(200).collect();
    if v.instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(AppError::msg(format!("The instructions can be at most {MAX_INSTRUCTIONS_CHARS} characters.")));
    }
    v.instructions = v.instructions.trim().to_string();
    v.model = v.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    v.fallback_models = clean_models(&v.fallback_models)?;
    let mut tools: Vec<String> = Vec::new();
    for t in &v.tools {
        let t = t.trim();
        if t.is_empty() || tools.iter().any(|x| x == t) {
            continue;
        }
        if !allowed.iter().any(|a| a == t) {
            return Err(AppError::msg(format!("\"{t}\" isn't a tool this kind of agent can use.")));
        }
        tools.push(t.to_string());
    }
    v.tools = tools;
    if let Some(n) = v.max_steps {
        if !(1..=MAX_STEPS_LIMIT).contains(&n) {
            return Err(AppError::msg(format!("Steps must be between 1 and {MAX_STEPS_LIMIT}.")));
        }
    }
    v.review = if v.kind == "reviewer" { Some(v.review.unwrap_or_default().normalized()) } else { None };
    v.source = ProfileSource::Builtin;
    v.overrides_builtin = false;
    Ok(v)
}

// --------------------------------------------------------------- edits --

/// Saves (creates or replaces) a profile in the global or project file. A
/// new profile (empty id) gets a unique id made from its name.
pub fn save(config_dir: &Path, project: Option<&Path>, scope: Scope, profile: &Profile) -> AppResult<ProfilesView> {
    let creating = profile.id.trim().is_empty();
    let mut v = validate(profile)?;
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    if creating {
        let taken: Vec<String> = load(config_dir, project).profiles.into_iter().map(|p| p.id).collect();
        let base = v.id.clone();
        let mut n = 2;
        while taken.contains(&v.id) {
            v.id = format!("{base}-{n}");
            n += 1;
        }
    }
    let path = scope_path(scope, config_dir, project)?;
    let mut file = read_file(&path).unwrap_or_default();
    match file.profiles.iter_mut().find(|p| p.id == v.id) {
        Some(slot) => *slot = v,
        None => file.profiles.push(v),
    }
    write_file(&path, &file)?;
    Ok(load(config_dir, project))
}

/// Deletes a profile from one file. A built-in can't be deleted; deleting
/// its override from that file resets it there.
pub fn delete(config_dir: &Path, project: Option<&Path>, scope: Scope, id: &str) -> AppResult<ProfilesView> {
    let id = id.trim();
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = scope_path(scope, config_dir, project)?;
    let mut file = read_file(&path).map_err(AppError::msg)?;
    let before = file.profiles.len();
    file.profiles.retain(|p| p.id != id);
    if file.profiles.len() == before {
        return Err(AppError::msg(if is_builtin(id) {
            "Built-in profiles can't be deleted. Use Reset to undo your changes."
        } else {
            "That profile doesn't exist any more."
        }));
    }
    write_file(&path, &file)?;
    Ok(load(config_dir, project))
}

/// Removes the user's changes to a built-in profile (global and project).
pub fn reset(config_dir: &Path, project: Option<&Path>, id: &str) -> AppResult<ProfilesView> {
    let id = id.trim();
    if !is_builtin(id) {
        return Err(AppError::msg("Only built-in profiles can be reset. Delete your own profiles instead."));
    }
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut paths = vec![global_path(config_dir)];
    if let Some(dir) = project {
        paths.push(project_path(dir));
    }
    for path in paths {
        let Ok(mut file) = read_file(&path) else { continue };
        let before = file.profiles.len();
        file.profiles.retain(|p| p.id != id);
        if file.profiles.len() != before {
            write_file(&path, &file)?;
        }
    }
    Ok(load(config_dir, project))
}

/// Saves the defaults (model per role, max parallel runs) globally.
pub fn save_defaults(config_dir: &Path, project: Option<&Path>, defaults: &AgentDefaults) -> AppResult<ProfilesView> {
    let clean = defaults.validated()?;
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let path = global_path(config_dir);
    let mut file = read_file(&path).unwrap_or_default();
    file.defaults = Some(clean);
    write_file(&path, &file)?;
    Ok(load(config_dir, project))
}

// ----------------------------------------------------------- run start --

/// Fills a run request from a profile: the kind (when the request has none)
/// and every option the request didn't set itself.
pub fn apply(profile: &Profile, req: &mut StartRequest) -> AppResult<()> {
    if req.kind.trim().is_empty() {
        req.kind = profile.kind.clone();
    } else if req.kind.trim() != profile.kind {
        return Err(AppError::msg(format!("The profile \"{}\" is for a different kind of agent.", profile.name)));
    }
    req.profile_id = Some(profile.id.clone());
    let o = &mut req.options;
    if !profile.instructions.is_empty() {
        o.instructions = Some(match o.instructions.take().filter(|i| !i.trim().is_empty()) {
            Some(own) => format!("{}\n\n{}", profile.instructions, own.trim()),
            None => profile.instructions.clone(),
        });
    }
    if o.model.as_deref().is_none_or(|m| m.trim().is_empty()) {
        o.model = profile.model.clone();
    }
    if o.fallback_models.is_none() && !profile.fallback_models.is_empty() {
        o.fallback_models = Some(profile.fallback_models.clone());
    }
    if o.tools.is_none() && !profile.tools.is_empty() {
        o.tools = Some(profile.tools.clone());
    }
    o.max_steps = o.max_steps.or(profile.max_steps);
    o.thinking = o.thinking.or(profile.thinking);
    o.vision = o.vision.or(profile.vision);
    if o.profile_name.as_deref().is_none_or(|n| n.trim().is_empty()) {
        o.profile_name = Some(profile.name.clone());
    }
    o.auto_apply = o.auto_apply || profile.auto_apply;
    if let Some(setup) = &profile.review {
        let setup = serde_json::to_value(setup).map_err(|e| AppError::msg(e.to_string()))?;
        match &mut o.extra {
            None => o.extra = Some(serde_json::json!({ "review": setup })),
            Some(Value::Object(m)) if !m.contains_key("review") && !m.contains_key("venue") => {
                m.insert("review".into(), setup);
            }
            Some(_) => {}
        }
    }
    Ok(())
}

// --------------------------------------------------------- live models --

static LIVE: Mutex<Vec<(ProviderId, Instant, Vec<String>)>> = Mutex::new(Vec::new());
const LIVE_TTL: Duration = Duration::from_secs(10 * 60);

/// The provider's live model ids (cached 10 minutes). Empty when the list
/// can't be fetched (then the role models are used as they are).
pub async fn live_models(ai: &crate::ai::AiState, provider: ProviderId) -> Vec<String> {
    {
        let cache = LIVE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, ids)) = cache.iter().find(|(p, at, _)| *p == provider && at.elapsed() < LIVE_TTL) {
            return ids.clone();
        }
    }
    let ids: Vec<String> = match tokio::time::timeout(Duration::from_secs(20), ai.list_models(provider)).await {
        Ok(Ok(models)) => models.into_iter().map(|m| m.id).collect(),
        _ => return Vec::new(),
    };
    let mut cache = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|(p, _, _)| *p != provider);
    cache.push((provider, Instant::now(), ids.clone()));
    ids
}

/// The models a run of `role` uses: the defaults resolved against the live
/// list.
pub fn role_models(defaults: &AgentDefaults, provider: ProviderId, role: ModelRole, live: &[String]) -> Option<RoleModels> {
    defaults.role(provider, role)?.resolved(live)
}

/// The vision fallback for a provider (the Vision role), if any.
pub fn vision_fallback(defaults: &AgentDefaults, provider: ProviderId, live: &[String]) -> Option<VisionFallback> {
    role_models(defaults, provider, ModelRole::Vision, live).map(|r| VisionFallback { model: r.model, fallbacks: r.fallbacks })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(name: &str, kind: &str) -> Profile {
        Profile { name: name.into(), kind: kind.into(), ..Default::default() }
    }

    #[test]
    fn builtins_are_valid_and_one_per_kind() {
        let b = builtins();
        assert_eq!(b.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), BUILTIN_IDS);
        for p in &b {
            let v = validate(p).unwrap();
            assert_eq!(v.id, p.kind);
        }
        assert!(b.iter().find(|p| p.id == "reviewer").unwrap().review.is_some());
        assert!(b.iter().find(|p| p.id == "reviewer").unwrap().auto_apply);
        assert!(!b.iter().find(|p| p.id == "fixer").unwrap().auto_apply);
        assert!(!b.iter().find(|p| p.id == "task").unwrap().auto_apply);
    }

    #[test]
    fn validation_cleans_and_refuses() {
        let mut p = custom("  Strict statistician! ", "reviewer");
        p.fallback_models = vec![" a ".into(), "a".into(), "".into(), "b".into()];
        p.tools = vec!["read_file".into(), "read_file".into(), " search ".into()];
        p.model = Some("  ".into());
        let v = validate(&p).unwrap();
        assert_eq!(v.id, "strict-statistician");
        assert_eq!(v.name, "Strict statistician!");
        assert_eq!(v.fallback_models, ["a", "b"]);
        assert_eq!(v.tools, ["read_file", "search"]);
        assert_eq!(v.model, None);
        assert_eq!(v.review.as_ref().unwrap().reviewers, 3, "normalized setup");

        assert!(validate(&custom(" ", "task")).is_err());
        assert!(validate(&custom("X", "wizard")).unwrap_err().to_string().contains("doesn't know"));
        let mut bad = custom("X", "reviewer");
        bad.tools = vec!["edit_file".into()];
        assert!(validate(&bad).unwrap_err().to_string().contains("edit_file"), "reviewers can't edit");
        let mut bad = custom("X", "task");
        bad.max_steps = Some(0);
        assert!(validate(&bad).is_err());
        let mut bad = custom("X", "task");
        bad.id = "Bad Id".into();
        assert!(validate(&bad).is_err());
        let mut bad = custom("X", "task");
        bad.id = "fixer".into();
        assert!(validate(&bad).unwrap_err().to_string().contains("must stay"));
        let mut bad = custom("X", "task");
        bad.instructions = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);
        assert!(validate(&bad).is_err());
        // A review setup on a non-reviewer is dropped.
        let mut t = custom("X", "task");
        t.review = Some(ReviewSetup::default());
        assert!(validate(&t).unwrap().review.is_none());
        // The fixer's compile_check (its own wrapper) is allowed.
        let mut f = custom("Quick fixer", "fixer");
        f.tools = vec!["compile_check".into(), "edit_file".into()];
        assert!(validate(&f).is_ok());
    }

    #[test]
    fn layers_merge_by_id_and_edits_round_trip() {
        let cfg = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let (c, p) = (cfg.path(), Some(proj.path()));
        let view = load(c, p);
        assert_eq!(view.profiles.len(), 5);
        assert!(view.warnings.is_empty());
        assert!(view.profiles.iter().all(|x| x.source == ProfileSource::Builtin));

        // A global profile, a project one with the same name gets its own id.
        let view = save(c, p, Scope::Global, &custom("IEEE TPAMI reviewer", "reviewer")).unwrap();
        let g = view.profiles.iter().find(|x| x.id == "ieee-tpami-reviewer").unwrap();
        assert_eq!(g.source, ProfileSource::Global);
        let view = save(c, p, Scope::Project, &custom("IEEE TPAMI reviewer", "reviewer")).unwrap();
        assert!(view.profiles.iter().any(|x| x.id == "ieee-tpami-reviewer-2" && x.source == ProfileSource::Project));

        // Override a built-in globally, then in the project: the project wins.
        let mut fixer = view.profiles.iter().find(|x| x.id == "fixer").unwrap().clone();
        fixer.instructions = "Use British spelling.".into();
        save(c, p, Scope::Global, &fixer).unwrap();
        fixer.instructions = "Project rule.".into();
        let view = save(c, p, Scope::Project, &fixer).unwrap();
        let f = view.profiles.iter().find(|x| x.id == "fixer").unwrap();
        assert_eq!((f.instructions.as_str(), f.source, f.overrides_builtin), ("Project rule.", ProfileSource::Project, true));
        assert_eq!(view.profiles.iter().filter(|x| x.id == "fixer").count(), 1);
        assert_eq!(view.profiles[0].id, "fixer", "built-ins keep their place");
        // Without the project, the global override shows.
        assert_eq!(find(c, None, "fixer").unwrap().instructions, "Use British spelling.");

        // Built-ins can't be deleted, only reset; custom ones can be deleted.
        assert!(delete(c, p, Scope::Global, "reviewer").unwrap_err().to_string().contains("Reset"));
        let view = reset(c, p, "fixer").unwrap();
        assert_eq!(view.profiles.iter().find(|x| x.id == "fixer").unwrap().source, ProfileSource::Builtin);
        assert!(reset(c, p, "ieee-tpami-reviewer").is_err());
        let view = delete(c, p, Scope::Global, "ieee-tpami-reviewer").unwrap();
        assert!(!view.profiles.iter().any(|x| x.id == "ieee-tpami-reviewer"));
        assert!(delete(c, p, Scope::Global, "ieee-tpami-reviewer").is_err());
        assert!(save(c, None, Scope::Project, &custom("X", "task")).is_err(), "no project open");
        // Output-only fields aren't stored.
        let stored = fs::read_to_string(project_path(proj.path())).unwrap();
        assert!(!stored.contains("\"source\": \"project\""), "{stored}");
    }

    #[test]
    fn damaged_files_warn_and_are_backed_up_on_save() {
        let cfg = tempfile::tempdir().unwrap();
        fs::write(global_path(cfg.path()), "{ not json").unwrap();
        let view = load(cfg.path(), None);
        assert_eq!(view.profiles.len(), 5);
        assert!(view.warnings[0].contains("couldn't be loaded"));
        // An invalid profile inside a valid file is skipped with a warning.
        save(cfg.path(), None, Scope::Global, &custom("Mine", "task")).unwrap();
        let backups = fs::read_dir(cfg.path()).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains("broken")).count();
        assert_eq!(backups, 1);
        let mut file: Value = serde_json::from_str(&fs::read_to_string(global_path(cfg.path())).unwrap()).unwrap();
        file["profiles"].as_array_mut().unwrap().push(serde_json::json!({"id": "x", "name": "Bad", "kind": "wizard"}));
        fs::write(global_path(cfg.path()), file.to_string()).unwrap();
        let view = load(cfg.path(), None);
        assert!(view.profiles.iter().any(|p| p.id == "mine"));
        assert!(view.warnings.iter().any(|w| w.contains("\"Bad\" was skipped")));
    }

    #[test]
    fn apply_fills_only_what_the_request_left_open() {
        let mut p = custom("Strict statistician", "reviewer");
        p.instructions = "Check every p-value.".into();
        p.model = Some("m1".into());
        p.fallback_models = vec!["m2".into()];
        p.tools = vec!["read_file".into()];
        p.max_steps = Some(12);
        p.auto_apply = true;
        let p = validate(&p).unwrap();
        let mut req = StartRequest { prompt: "Review".into(), ..Default::default() };
        req.options.model = Some("mine".into());
        req.options.instructions = Some("Be brief.".into());
        apply(&p, &mut req).unwrap();
        assert_eq!(req.kind, "reviewer");
        assert_eq!(req.profile_id.as_deref(), Some("strict-statistician"));
        let o = &req.options;
        assert_eq!(o.model.as_deref(), Some("mine"));
        assert_eq!(o.fallback_models.as_deref(), Some(&["m2".to_string()][..]));
        assert_eq!(o.instructions.as_deref(), Some("Check every p-value.\n\nBe brief."));
        assert_eq!(o.tools.as_deref(), Some(&["read_file".to_string()][..]));
        assert_eq!(o.max_steps, Some(12));
        assert!(o.auto_apply);
        assert_eq!(o.profile_name.as_deref(), Some("Strict statistician"));
        let setup = ReviewSetup::from_extra(o.extra.as_ref()).unwrap();
        assert_eq!(setup.venue, "generic");

        let mut wrong = StartRequest { kind: "task".into(), ..Default::default() };
        assert!(apply(&p, &mut wrong).is_err());
    }

    #[test]
    fn role_defaults_resolve_against_the_live_list() {
        let d = AgentDefaults::default();
        let agent = d.role(ProviderId::Nvidia, ModelRole::Agent).unwrap();
        assert_eq!(agent.model, "nvidia/nemotron-3-ultra-550b-a55b");
        assert_eq!(d.role(ProviderId::Anthropic, ModelRole::Review).unwrap().model, CLAUDE_MODEL);
        assert!(d.role(ProviderId::Groq, ModelRole::Agent).is_none());

        // Offline / unknown list: kept as is.
        assert_eq!(agent.resolved(&[]).unwrap(), agent);
        // Only what the provider serves, in order.
        let live = vec!["mistralai/mistral-large-4-1t-a52b".to_string(), "MoonshotAI/Kimi-K3.1-Pro".to_string(), "x".to_string()];
        let r = agent.resolved(&live).unwrap();
        assert_eq!(r.model, "MoonshotAI/Kimi-K3.1-Pro");
        assert_eq!(r.fallbacks, ["mistralai/mistral-large-4-1t-a52b"]);
        assert!(agent.resolved(&["other".to_string()]).is_none());
        let v = vision_fallback(&d, ProviderId::Nvidia, &[]).unwrap();
        assert_eq!(v.model, "nvidia/nemotron-3.5-super-vl-120b-a12b");

        // User overrides per provider and role; the rest stay built-in.
        let mut user = AgentDefaults::default();
        user.roles.insert(
            "nvidia".into(),
            RoleSet { chat: Some(RoleModels { model: " my/chat ".into(), fallbacks: vec!["b".into(), "b".into()], thinking: None }), ..Default::default() },
        );
        let user = user.validated().unwrap();
        assert_eq!(user.role(ProviderId::Nvidia, ModelRole::Chat).unwrap().model, "my/chat");
        assert_eq!(user.role(ProviderId::Nvidia, ModelRole::Chat).unwrap().fallbacks, ["b"]);
        assert_eq!(user.role(ProviderId::Nvidia, ModelRole::Agent).unwrap(), agent);
        let eff = user.effective();
        assert_eq!(eff.roles["nvidia"].chat.as_ref().unwrap().model, "my/chat");
        assert!(eff.roles["nvidia"].vision.is_some() && eff.roles["anthropic"].agent.is_some());

        let mut bad = AgentDefaults { max_parallel: 9, ..Default::default() };
        assert!(bad.validated().is_err());
        bad.max_parallel = 2;
        bad.roles.insert("nope".into(), RoleSet::default());
        assert!(bad.validated().is_err());

        let cfg = tempfile::tempdir().unwrap();
        let view = save_defaults(cfg.path(), None, &user).unwrap();
        assert_eq!(view.defaults.roles["nvidia"].chat.as_ref().unwrap().model, "my/chat");
        assert_eq!(load_defaults(cfg.path()), user);
    }
}
