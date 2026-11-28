//! The run manager: starts runs as background tasks (at most
//! [`MAX_PARALLEL`] at once, the rest queued in order), cancels them, hands
//! input to paused runs, and serves the journals, changesets and apply.
//!
//! A run lives in a `tauri::async_runtime` task, so it survives the UI
//! switching projects or closing panels; it ends on finish, cancel or app
//! exit (then the journal says `interrupted` next time it is listed).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Semaphore;

use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::Cancel;
use crate::ai::llm;
use crate::error::{AppError, AppResult};
use crate::project;

use super::attach;
use super::changeset;
use super::journal;
use super::kinds::{AgentKind, Outcome, Registry};
use super::run_loop::{Events, RunCx, RunEnv, RunShared};
use super::tools::build::BuildState;
use super::tools::memory;
use super::tools::registry::{BoxFut, ToolCx};
use super::types::{
    now, one_line, AgentRun, ApplyResult, Changeset, Decision, FileState, RunStatus, RunSummary, StartRequest,
};

/// Runs working at the same time; more wait in the queue.
pub const MAX_PARALLEL: usize = 3;

/// Resolves what a run needs from the app (provider, key, model, web
/// settings, compiler). The app's version reads Settings; tests give a
/// mock server.
pub trait EnvSource: Send + Sync {
    fn resolve<'a>(
        &'a self,
        root: &'a Path,
        kind: &'a dyn AgentKind,
        request: &'a StartRequest,
        cancel: Cancel,
    ) -> BoxFut<'a, AiResult<RunEnv>>;
}

struct Inner {
    live: Mutex<HashMap<String, Arc<RunShared>>>,
    sem: Arc<Semaphore>,
    /// The current number of slots (Settings > AI > Agents, 1-5).
    limit: Mutex<usize>,
    events: Arc<dyn Events>,
    env: Arc<dyn EnvSource>,
    kinds: Registry,
    /// One apply / discard / delete at a time.
    edit: Mutex<()>,
}

/// Managed by Tauri; cheap to clone.
#[derive(Clone)]
pub struct AgentRuntime {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn new_run_id() -> String {
    let u = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), &u[..8])
}

impl AgentRuntime {
    pub fn new(events: Arc<dyn Events>, env: Arc<dyn EnvSource>) -> Self {
        // Shadow copies left behind by a crash or a quit during a run.
        std::thread::spawn(|| super::tools::build::sweep_old_shadows(Duration::from_secs(24 * 3600)));
        AgentRuntime::with_kinds(events, env, Registry::default())
    }

    pub fn with_kinds(events: Arc<dyn Events>, env: Arc<dyn EnvSource>, kinds: Registry) -> Self {
        AgentRuntime {
            inner: Arc::new(Inner {
                live: Mutex::new(HashMap::new()),
                sem: Arc::new(Semaphore::new(MAX_PARALLEL)),
                limit: Mutex::new(MAX_PARALLEL),
                events,
                env,
                kinds,
                edit: Mutex::new(()),
            }),
        }
    }

    /// How many runs may work at once (clamped to 1-5). Raising it lets
    /// queued runs start now; lowering it takes effect as working runs end.
    pub fn set_max_parallel(&self, n: usize) {
        let n = n.clamp(1, 5);
        let mut limit = lock(&self.inner.limit);
        let current = *limit;
        if n > current {
            self.inner.sem.add_permits(n - current);
        } else if n < current {
            let surplus = current - n;
            let taken = self.inner.sem.forget_permits(surplus);
            let owed = surplus - taken;
            if owed > 0 {
                // Busy slots: take them away as the runs holding them finish.
                let sem = self.inner.sem.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(p) = sem.acquire_many_owned(owed as u32).await {
                        p.forget();
                    }
                });
            }
        }
        *limit = n;
    }

    #[cfg(test)]
    pub fn max_parallel(&self) -> usize {
        *lock(&self.inner.limit)
    }

    fn live(&self, id: &str) -> Option<Arc<RunShared>> {
        lock(&self.inner.live).get(id).cloned()
    }

    /// Starts a run in the background; it is `queued` until a slot frees.
    pub fn start(&self, root: PathBuf, project: String, request: StartRequest) -> AppResult<RunSummary> {
        let kind = self
            .inner
            .kinds
            .get(&request.kind)
            .ok_or_else(|| AppError::msg(format!("Texo doesn't know an agent called \"{}\".", request.kind.trim())))?;
        if request.prompt.trim().is_empty() && request.attachments.is_empty() && kind.id() != "fixer" {
            return Err(AppError::msg("Write what the agent should do first."));
        }
        // Refuse unusable attachments now, before anything is queued.
        attach::prepare(&super::overlay::Overlay::new(&root, Vec::new()), &request.prompt, &request.attachments, true)?;
        let title = request
            .options
            .title
            .clone()
            .map(|t| one_line(&t, 80))
            .filter(|t| !t.is_empty())
            .or_else(|| Some(one_line(&request.prompt, 80)).filter(|t| !t.is_empty()))
            .unwrap_or_else(|| kind.label().to_string());
        let run = AgentRun {
            version: journal::VERSION,
            id: new_run_id(),
            project,
            kind: kind.id().to_string(),
            profile_id: request.profile_id.clone(),
            profile_name: request.options.profile_name.clone(),
            title,
            prompt: request.prompt.clone(),
            status: RunStatus::Queued,
            started_at: now(),
            options: request.options.clone(),
            max_steps: request.options.max_steps.unwrap_or(kind.limits().max_steps).clamp(1, 200),
            ..Default::default()
        };
        journal::save(&root, &run)?;
        let summary = run.summary();
        let shared = Arc::new(RunShared::new(root, request, run, self.inner.events.clone(), self.inner.sem.clone()));
        lock(&self.inner.live).insert(shared.id.clone(), shared.clone());
        self.inner.events.run_updated(&summary);
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            let result = drive(&inner, &shared, kind.as_ref()).await;
            finish(&shared, kind.as_ref(), result).await;
            lock(&shared.permit).take();
            lock(&inner.live).remove(&shared.id);
        });
        Ok(summary)
    }

    /// The project's runs, newest first (live runs as they are now).
    pub fn list(&self, root: &Path) -> Vec<RunSummary> {
        journal::list(root, &|id| self.live(id).is_some())
            .into_iter()
            .map(|r| match self.live(&r.id) {
                Some(sh) => sh.snapshot().summary(),
                None => r.summary(),
            })
            .collect()
    }

    pub fn get(&self, root: &Path, id: &str) -> AppResult<AgentRun> {
        if let Some(sh) = self.live(id) {
            return Ok(sh.snapshot());
        }
        let mut run = journal::load(root, id)?;
        if run.status.is_active() {
            journal::mark_interrupted(&mut run);
            journal::save(root, &run)?;
        }
        Ok(run)
    }

    /// Stops a run (queued, working or waiting for input). False when it
    /// isn't running.
    pub fn cancel(&self, id: &str) -> bool {
        match self.live(id) {
            Some(sh) => {
                sh.cancel.cancel();
                true
            }
            None => false,
        }
    }

    /// Gives a paused run (`awaiting_input`) the user's answer.
    pub fn respond(&self, id: &str, input: Value) -> AppResult<()> {
        let sh = self.live(id).ok_or_else(|| AppError::msg("That run isn't running any more."))?;
        sh.respond(input).map_err(|_| AppError::msg("That run isn't waiting for an answer."))
    }

    pub fn changeset(&self, root: &Path, id: &str) -> AppResult<Changeset> {
        Ok(changeset::view(root, &self.get(root, id)?))
    }

    fn kind_label(&self, kind: &str) -> String {
        self.inner.kinds.get(kind).map(|k| k.label().to_string()).unwrap_or_else(|| "AI agent".into())
    }

    /// Applies the user's decisions (blocking: file writes and a history
    /// commit). Refused while the run still works.
    pub fn apply(&self, root: &Path, id: &str, decisions: &[Decision]) -> AppResult<ApplyResult> {
        let _guard = lock(&self.inner.edit);
        if self.live(id).is_some() {
            return Err(AppError::msg("This run is still working. Wait until it finishes, or stop it first."));
        }
        let mut run = self.get(root, id)?;
        let plan = changeset::plan(root, &run, decisions, &self.kind_label(&run.kind))?;
        let outcome = match &plan.request {
            Some(req) => Some(crate::history::apply_changeset(root, req)?),
            None => None,
        };
        changeset::record(&mut run, &plan, outcome.as_ref());
        journal::save(root, &run)?;
        let summary = run.summary();
        self.inner.events.run_updated(&summary);
        let o = outcome.unwrap_or_default();
        Ok(ApplyResult {
            commit: o.commit,
            written: o.written,
            deleted: o.deleted,
            rejected: plan.rejected,
            conflicts: o.conflicts,
            history_error: o.history_error,
            run: summary,
        })
    }

    /// "Discard": rejects every file still waiting for a decision.
    pub fn discard(&self, root: &Path, id: &str) -> AppResult<RunSummary> {
        let _guard = lock(&self.inner.edit);
        if self.live(id).is_some() {
            return Err(AppError::msg("This run is still working. Stop it first."));
        }
        let mut run = self.get(root, id)?;
        changeset::discard(&mut run);
        journal::save(root, &run)?;
        let summary = run.summary();
        self.inner.events.run_updated(&summary);
        Ok(summary)
    }

    /// Deletes the run's journal (stopping it first if it still works).
    /// History commits it made stay in the history.
    pub fn delete(&self, root: &Path, id: &str) -> AppResult<()> {
        let _guard = lock(&self.inner.edit);
        if let Some(sh) = self.live(id) {
            // Under the run's lock: `RunShared::update` checks `deleted` and
            // saves while holding it, so no save can land after the removal.
            let removed = {
                let _run = lock(&sh.run);
                sh.deleted.store(true, Ordering::SeqCst);
                journal::remove(root, id)
            };
            sh.cancel.cancel();
            return removed;
        }
        journal::remove(root, id)
    }
}

/// Queue, before-run snapshot, environment, attachments, then the kind.
async fn drive(inner: &Inner, sh: &Arc<RunShared>, kind: &dyn AgentKind) -> AiResult<Outcome> {
    let sem = inner.sem.clone();
    let permit = sh.cancel.run(async { sem.acquire_owned().await.map_err(|_| AiError::cancelled()) }).await?;
    *lock(&sh.permit) = Some(permit);
    let limits = kind.limits();
    sh.set_deadline(sh.request.options.timeout_secs.map(Duration::from_secs).unwrap_or(limits.timeout));
    sh.update(|r| r.status = RunStatus::Running);

    // The "before run" snapshot of the user's files (never fails the run).
    let (root, id) = (sh.root.clone(), sh.id.clone());
    let start = tokio::task::spawn_blocking(move || crate::history::start_run(&root, &id)).await.ok().flatten();
    sh.update(|r| r.start_commit = start);

    let env = inner.env.resolve(&sh.root, kind, &sh.request, sh.cancel.clone()).await?;
    sh.cancel.check()?;
    sh.update(|r| {
        r.model = env.endpoint.model.clone();
        r.provider = env.endpoint.label.clone();
    });

    let vision = sh.request.options.vision.unwrap_or_else(|| llm::model_caps(env.endpoint.provider, &env.endpoint.model).vision);
    let mut prepared = {
        let mut o = lock(&sh.overlay);
        let p = attach::prepare(&o, &sh.request.prompt, &sh.request.attachments, vision)
            .map_err(|e| AiError::new(Kind::InvalidInput, e.to_string()))?;
        for (dest, text) in &p.saves {
            o.write(dest, text, "Attachment saved into the project").map_err(|e| AiError::new(Kind::InvalidInput, e.to_string()))?;
        }
        p
    };
    // The vision fallback: a vision model describes the images first.
    if let Some(v) = env.vision.as_ref().filter(|_| !prepared.unseen.is_empty()) {
        if let Some(note) = attach::describe(&env.client, &env.endpoint, v, env.policy.clone(), &mut prepared, &sh.cancel).await? {
            sh.notice(&note);
        }
    }
    // Say so in the run when an attachment couldn't be used (e.g. a picture
    // for a model that can't see images and no vision model to describe it).
    for info in prepared.infos.iter().filter(|i| i.used_as == "skipped") {
        let why = info.note.as_deref().unwrap_or("It couldn't be used.");
        sh.notice(&format!("{} wasn't sent to the AI. {why}", info.name));
    }
    sh.update(|r| {
        r.attachments = prepared.infos.clone();
        sh.sync_changes(r);
    });

    let build = Arc::new(BuildState::new(&sh.id, env.build.clone()));
    let _cleanup = Cleanup(build.clone());
    let tool_cx = ToolCx {
        root: sh.root.clone(),
        run_id: sh.id.clone(),
        kind: kind.id().to_string(),
        overlay: sh.overlay.clone(),
        build,
        net: env.net.clone(),
        cancel: sh.cancel.clone(),
        progress: Some(sh.progress_sink()),
    };
    let cx = RunCx {
        shared: sh.clone(),
        system_extra: system_extra(&sh.root, &sh.request),
        env,
        tool_cx,
        user_parts: prepared.parts,
        limits,
    };
    kind.drive(&cx).await
}

/// Removes the shadow compile folder however the run ends.
struct Cleanup(Arc<BuildState>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.cleanup();
    }
}

/// Project facts, profile instructions and memory for the system prompt.
fn system_extra(root: &Path, req: &StartRequest) -> String {
    let mut s = String::new();
    if let Some(meta) = project::read_meta(root) {
        s.push_str("\n\nThe project");
        if let Some(main) = &meta.main_document {
            s.push_str(&format!("'s main document is {main}"));
        }
        s.push_str(&format!(" and it is compiled with {:?}.", meta.engine).to_lowercase());
    }
    if !req.dirty_buffers.is_empty() {
        s.push_str(" Some files have unsaved edits in the editor; you see those versions.");
    }
    if req.options.auto_apply {
        s.push_str(" Your file changes are saved into the project when you finish, unless something needs the user's attention, so change only what the task needs.");
    } else {
        s.push_str(" Your file changes are shown to the user for review before anything is saved.");
    }
    if let Some(i) = req.options.instructions.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
        s.push_str(&format!("\n\nInstructions from the user's profile:\n{}", super::types::cap(i, 4000)));
    }
    let mem = memory::read(root);
    if !mem.trim().is_empty() {
        s.push_str(&format!("\n\n{}\n{}", memory::PROMPT_HEADING, super::types::cap(mem.trim(), 3000)));
    }
    s
}

/// Records how the run ended, then applies automatically when asked and
/// nothing needs attention.
async fn finish(sh: &Arc<RunShared>, kind: &dyn AgentKind, result: AiResult<Outcome>) {
    let mut changes = lock(&sh.overlay).changes();
    kind.check_changes(&mut changes);
    // For every kind: build configuration, scripts and shell escape.
    super::safety::check(&mut changes);
    sh.update(|run| {
        run.changeset = changes;
        run.finished_at = Some(now());
        run.awaiting = None;
        let has_changes = !run.changeset.is_empty();
        match result {
            Ok(o) => {
                run.final_message = o.message;
                run.report = o.report;
                run.status = if has_changes { RunStatus::AwaitingReview } else { RunStatus::Done };
                if let Some(stop) = o.stopped {
                    run.error = Some(stop);
                    if !has_changes && run.report.is_none() {
                        run.status = RunStatus::Failed;
                    }
                }
            }
            Err(e) if e.kind == Kind::Cancelled => {
                run.status = RunStatus::Cancelled;
                run.error = Some(if has_changes {
                    "You stopped this run. The changes it made so far can still be reviewed.".into()
                } else {
                    "You stopped this run.".into()
                });
            }
            Err(e) => {
                run.status = RunStatus::Failed;
                run.error = Some(e.message);
            }
        }
        run.progress.settle(run.status);
        run.deadline_at = None;
    });
    let run = sh.snapshot();
    let auto = run.options.auto_apply
        && run.status == RunStatus::AwaitingReview
        && run.changeset.iter().all(|c| c.attention.is_empty() && c.state == FileState::Pending)
        && !sh.deleted.load(Ordering::SeqCst);
    if !auto {
        return;
    }
    let root = sh.root.clone();
    let label = kind.label().to_string();
    let applied = tokio::task::spawn_blocking(move || {
        let decisions: Vec<Decision> =
            run.changeset.iter().map(|c| Decision { file: c.file.clone(), accept: true, ..Default::default() }).collect();
        let plan = changeset::plan(&root, &run, &decisions, &label)?;
        let outcome = match &plan.request {
            Some(req) => Some(crate::history::apply_changeset(&root, req)?),
            None => None,
        };
        let mut run = run;
        changeset::record(&mut run, &plan, outcome.as_ref());
        Ok::<AgentRun, AppError>(run)
    })
    .await;
    match applied {
        Ok(Ok(updated)) => sh.update(|run| {
            run.changeset = updated.changeset;
            run.apply_commits = updated.apply_commits;
            run.status = updated.status;
        }),
        Ok(Err(e)) => sh.update(|run| run.error = Some(format!("The changes couldn't be applied automatically: {e}"))),
        Err(_) => {}
    }
}

#[cfg(test)]
mod limit_tests {
    use super::*;

    #[test]
    fn parallel_limit_follows_the_setting() {
        let server = crate::ai::mock::MockServer::start(Vec::new());
        let rt = super::super::tests::runtime(&server, Arc::new(super::super::tests::Rec::default()), Registry::default());
        assert_eq!(rt.max_parallel(), MAX_PARALLEL);
        rt.set_max_parallel(5);
        assert_eq!(rt.inner.sem.available_permits(), 5);
        rt.set_max_parallel(1);
        assert_eq!((rt.max_parallel(), rt.inner.sem.available_permits()), (1, 1));
        rt.set_max_parallel(99);
        assert_eq!((rt.max_parallel(), rt.inner.sem.available_permits()), (5, 5));
        rt.set_max_parallel(0);
        assert_eq!(rt.max_parallel(), 1);
    }

    #[test]
    fn lowering_the_limit_waits_for_busy_slots() {
        tauri::async_runtime::block_on(async {
            let server = crate::ai::mock::MockServer::start(Vec::new());
            let rt = super::super::tests::runtime(&server, Arc::new(super::super::tests::Rec::default()), Registry::default());
            let busy = rt.inner.sem.clone().acquire_many_owned(3).await.unwrap();
            rt.set_max_parallel(1);
            assert_eq!(rt.inner.sem.available_permits(), 0);
            drop(busy);
            for _ in 0..50 {
                if rt.inner.sem.available_permits() == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert_eq!(rt.inner.sem.available_permits(), 1);
        });
    }
}
