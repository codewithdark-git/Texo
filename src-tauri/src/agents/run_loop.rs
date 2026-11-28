//! The agent loop: ask the model, run the tools it calls, feed the results
//! back, until it answers without tools, submits a report, or a limit
//! stops it.
//!
//! - Step limit per loop (kind default, profile override), a whole-run time
//!   limit (waiting for the user doesn't count) and a loop guard (the same
//!   tool with the same arguments `loop_guard` times stops the run).
//! - Cancellation is checked between steps and inside every HTTP call and
//!   tool.
//! - Tool results are capped (12k chars); once the conversation passes the
//!   budget (about 60% of the model's context, or 120k chars when unknown)
//!   older tool results are replaced by their one-line summary.
//! - Fallback-model switches and other notices from the LLM layer become
//!   steps in the run log. Tools go through the prompt (ReAct) when the
//!   model rejects native tools; `llm.rs` handles that per session.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::http::{Cancel, Endpoint};
use crate::ai::llm::{self, LlmRequest, LlmSession, Msg, Part, RetryPolicy, StopReason, StreamEvent, ToolChoice};

use super::journal;
use super::kinds::{AgentKind, ModelRole};
use super::overlay::Overlay;
use super::tools::build::BuildEnv;
use super::tools::fs::MAX_RESULT_CHARS;
use super::tools::net::NetCtx;
use super::tools::registry::{brings_outside_text, tools_by_name, Control, ProgressFn, Tool, ToolCx, REMEMBER};
use super::types::{
    cap, cap_args, cap_data, now, one_line, Activity, AgentRun, MessageEvent, Phase, PhaseStatus, PlanItem, ProgressUpdate,
    Report, RunStatus, RunSummary, Step, StepEvent, StepKind,
};

/// Activity-only updates (a tool's sub-progress) reach the window at most
/// this often; one that comes sooner goes out when the time is up. Starting
/// and ending a tool always go out.
pub const ACTIVITY_THROTTLE: Duration = Duration::from_millis(150);

/// Where run updates go (the window in the app; a recorder in tests).
pub trait Events: Send + Sync {
    fn run_updated(&self, run: &RunSummary);
    fn step(&self, event: &StepEvent);
    fn message(&self, event: &MessageEvent);
}

/// What a run needs from the app, resolved when it starts.
#[derive(Clone)]
pub struct RunEnv {
    pub client: reqwest::Client,
    /// Provider, key and model.
    pub endpoint: Endpoint,
    pub fallback_models: Vec<String>,
    pub thinking: bool,
    pub policy: RetryPolicy,
    /// `None`: no web or literature tools.
    pub net: Option<NetCtx>,
    /// `None`: `compile_check` says compiling isn't available.
    pub build: Option<BuildEnv>,
    /// Describes attached images for a model that can't see them (the
    /// vision fallback). `None`: such images are skipped with a note.
    pub vision: Option<super::attach::VisionFallback>,
}

/// State of one run shared by the runtime, the loop and the commands.
pub struct RunShared {
    pub id: String,
    pub root: PathBuf,
    pub request: super::types::StartRequest,
    pub run: Mutex<AgentRun>,
    pub overlay: Arc<Mutex<Overlay>>,
    pub cancel: Cancel,
    pub events: Arc<dyn Events>,
    next_step: AtomicU32,
    input: Mutex<Option<oneshot::Sender<Value>>>,
    pub(crate) permit: Mutex<Option<OwnedSemaphorePermit>>,
    #[allow(dead_code)] // read by `await_input`
    pub(crate) sem: Arc<Semaphore>,
    deadline: Mutex<Option<Instant>>,
    /// `agent_delete` removed the journal: don't write it again.
    pub deleted: AtomicBool,
    /// A web or literature tool ran in this run: its text could carry
    /// planted instructions, so `remember` is refused from then on.
    pub outside_text: AtomicBool,
    /// Numbers activities (see [`Activity::token`]).
    next_activity: AtomicU64,
    /// The throttle of activity-only updates.
    activity_emit: Mutex<ActivityEmit>,
}

#[derive(Default)]
struct ActivityEmit {
    /// When the last activity-only update went to the window.
    last: Option<Instant>,
    /// A throttled change hasn't reached the window yet (a later send is
    /// scheduled).
    pending: bool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl RunShared {
    pub fn new(
        root: PathBuf,
        request: super::types::StartRequest,
        run: AgentRun,
        events: Arc<dyn Events>,
        sem: Arc<Semaphore>,
    ) -> Self {
        let overlay = Overlay::new(&root, request.dirty_buffers.iter().map(|b| (b.file.clone(), b.text.clone())));
        RunShared {
            id: run.id.clone(),
            root,
            request,
            run: Mutex::new(run),
            overlay: Arc::new(Mutex::new(overlay)),
            cancel: Cancel::default(),
            events,
            next_step: AtomicU32::new(1),
            input: Mutex::new(None),
            permit: Mutex::new(None),
            sem,
            deadline: Mutex::new(None),
            deleted: AtomicBool::new(false),
            outside_text: AtomicBool::new(false),
            next_activity: AtomicU64::new(1),
            activity_emit: Mutex::new(ActivityEmit::default()),
        }
    }

    pub fn snapshot(&self) -> AgentRun {
        lock(&self.run).clone()
    }

    /// Changes the run, saves the journal and tells the window.
    pub fn update(&self, f: impl FnOnce(&mut AgentRun)) {
        let summary = {
            let mut run = lock(&self.run);
            f(&mut run);
            if self.deleted.load(Ordering::SeqCst) {
                return;
            }
            // This update carries any throttled activity change too.
            lock(&self.activity_emit).pending = false;
            // The running tool is only for the window, never the journal.
            let activity = run.progress.activity.take();
            if let Err(e) = journal::save(&self.root, &run) {
                eprintln!("texo: couldn't save the AI run journal: {e}");
            }
            run.progress.activity = activity;
            run.summary()
        };
        self.events.run_updated(&summary);
    }

    /// Changes only the activity: tells the window, never saves the
    /// journal. Unless `always`, a change that comes within
    /// [`ACTIVITY_THROTTLE`] of the last one is sent when that time is up
    /// (with whatever changed meanwhile).
    fn update_activity(self: &Arc<Self>, always: bool, f: impl FnOnce(&mut AgentRun) -> bool) {
        let summary = {
            let mut run = lock(&self.run);
            if !f(&mut run) || self.deleted.load(Ordering::SeqCst) {
                return;
            }
            let mut emit = lock(&self.activity_emit);
            let wait = emit.last.map(|t| ACTIVITY_THROTTLE.saturating_sub(t.elapsed())).filter(|w| !w.is_zero());
            if let (false, Some(wait)) = (always, wait) {
                if !emit.pending {
                    emit.pending = true;
                    let sh = Arc::downgrade(self);
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(wait).await;
                        if let Some(sh) = sh.upgrade() {
                            sh.flush_activity();
                        }
                    });
                }
                return;
            }
            emit.last = Some(Instant::now());
            emit.pending = false;
            run.summary()
        };
        self.events.run_updated(&summary);
    }

    /// Sends a throttled activity change, unless another update sent it.
    fn flush_activity(&self) {
        let summary = {
            let run = lock(&self.run);
            let mut emit = lock(&self.activity_emit);
            if !emit.pending || self.deleted.load(Ordering::SeqCst) {
                return;
            }
            emit.pending = false;
            emit.last = Some(Instant::now());
            run.summary()
        };
        self.events.run_updated(&summary);
    }

    /// Shows a tool as running; returns its token for [`Self::end_activity`].
    pub fn begin_activity(self: &Arc<Self>, tool: &str, args: &Value, sub: Option<&str>) -> u64 {
        let token = self.next_activity.fetch_add(1, Ordering::SeqCst);
        let activity = Activity {
            tool: tool.to_string(),
            label: activity_label(tool, args),
            sub: sub.map(str::to_string),
            started_at: now(),
            token,
            ..Default::default()
        };
        self.update_activity(true, |run| {
            run.progress.activity = Some(activity);
            true
        });
        token
    }

    /// Clears the activity, unless another call (a parallel sub-run) has
    /// replaced it since.
    pub fn end_activity(self: &Arc<Self>, token: u64) {
        self.update_activity(true, |run| match &run.progress.activity {
            Some(a) if a.token == token => {
                run.progress.activity = None;
                true
            }
            _ => false,
        });
    }

    /// Applies progress a tool sent while running.
    pub fn progress(self: &Arc<Self>, update: ProgressUpdate) {
        match update {
            ProgressUpdate::Detail(text) => self.update_activity(false, |run| match run.progress.activity.as_mut() {
                Some(a) => {
                    a.detail = Some(one_line(&text, 160));
                    true
                }
                None => false,
            }),
            ProgressUpdate::Source(chip) => self.update_activity(false, |run| match run.progress.activity.as_mut() {
                Some(a) => {
                    match a.sources.iter_mut().find(|c| c.source == chip.source) {
                        Some(c) => *c = chip,
                        None => a.sources.push(chip),
                    }
                    true
                }
                None => false,
            }),
            ProgressUpdate::Count { key, by } => self.count(&key, by),
            ProgressUpdate::Phase { id, status, detail, done, total } => self.set_phase(&id, status, detail, done, total),
            ProgressUpdate::Plan { n, status, note, task } => {
                self.update(|run| run.progress.update_plan(n, status, note, task));
            }
        }
    }

    /// The kind's phases, all pending.
    pub fn set_phases(&self, phases: Vec<Phase>) {
        self.update(|run| run.progress.phases = phases);
    }

    /// Changes one phase (see [`super::types::RunProgress::set_phase`]).
    pub fn set_phase(&self, id: &str, status: PhaseStatus, detail: Option<String>, done: Option<u32>, total: Option<u32>) {
        self.update(|run| run.progress.set_phase(id, status, detail, done, total));
    }

    /// Adds `by` to a counter.
    pub fn count(&self, key: &str, by: u64) {
        self.update(|run| run.progress.count(key, by));
    }

    /// A new plan (shown as a checklist).
    pub fn set_plan(&self, items: Vec<PlanItem>) {
        self.update(|run| run.progress.set_plan(items));
    }

    /// Where the tools of this run send their progress.
    pub fn progress_sink(self: &Arc<Self>) -> ProgressFn {
        let sh = self.clone();
        Arc::new(move |u| sh.progress(u))
    }

    /// The overlay's changes as the run's changeset (decisions not made yet).
    pub fn sync_changes(&self, run: &mut AgentRun) {
        run.changeset = lock(&self.overlay).changes();
    }

    /// Records a step (numbered here), saves and emits it.
    pub fn record(&self, mut step: Step, changed_files: bool) -> Step {
        step.n = self.next_step.fetch_add(1, Ordering::SeqCst);
        step.at = now();
        let event = StepEvent { run_id: self.id.clone(), step: step.clone() };
        self.update(|run| {
            run.steps.push(step.clone());
            if changed_files {
                self.sync_changes(run);
            }
        });
        self.events.step(&event);
        step
    }

    /// Records a notice from Texo (not the model's words) in the run log.
    pub fn notice(&self, text: &str) {
        self.record(message_step(text, StepKind::Message, true, None), false);
    }

    pub fn set_deadline(&self, timeout: Duration) {
        *lock(&self.deadline) = Some(Instant::now() + timeout);
        lock(&self.run).deadline_at = Some(now() + timeout.as_secs() as i64);
    }

    /// `deadline_at` from the time left (after a pause for the user).
    fn sync_deadline_at(&self, run: &mut AgentRun) {
        run.deadline_at = lock(&self.deadline).map(|d| now() + d.saturating_duration_since(Instant::now()).as_secs() as i64);
    }

    /// Time left for the run; `None` once it is used up.
    fn remaining(&self) -> Option<Duration> {
        match *lock(&self.deadline) {
            None => Some(Duration::from_secs(24 * 3600)),
            Some(d) => d.checked_duration_since(Instant::now()).filter(|r| !r.is_zero()),
        }
    }

    /// Hands the user's answer to a run waiting in `awaiting_input`.
    pub fn respond(&self, input: Value) -> Result<(), Value> {
        match lock(&self.input).take() {
            Some(tx) => tx.send(input),
            None => Err(input),
        }
    }
}

fn message_step(text: &str, kind: StepKind, notice: bool, sub: Option<&str>) -> Step {
    Step {
        n: 0,
        kind,
        tool: None,
        args: None,
        result_summary: one_line(text, 160),
        result: None,
        text: Some(cap(text, 8000)),
        ok: true,
        ms: 0,
        at: 0,
        sub: sub.map(str::to_string),
        notice,
        data: None,
    }
}

/// One tool loop's settings.
#[derive(Clone)]
pub struct LoopSpec {
    pub system: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<Arc<dyn Tool>>,
    pub max_steps: u32,
    pub loop_guard: u32,
    /// Label of a sub-run (e.g. a reviewer persona); its steps carry it.
    pub sub: Option<String>,
    /// Overrides the run's model / fallbacks / thinking for this loop.
    pub model: Option<String>,
    pub fallback_models: Option<Vec<String>>,
    pub thinking: Option<bool>,
    /// Stream the answer text as `agent-message` events.
    pub stream: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopEnd {
    /// The model answered without calling a tool.
    Finished,
    /// `submit_report` was called.
    Report,
    StepLimit(u32),
    /// The same call was repeated; holds the tool name.
    LoopGuard(String),
    TimeLimit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoopOutcome {
    /// The model's last text.
    pub text: String,
    pub report: Option<Report>,
    pub end: LoopEnd,
    pub steps: u32,
    /// The conversation at the end (to continue it, e.g. with a nudge).
    pub messages: Vec<Msg>,
}

impl LoopOutcome {
    /// Plain words for a run that stopped early.
    pub fn end_message(&self) -> String {
        match &self.end {
            LoopEnd::Finished | LoopEnd::Report => String::new(),
            LoopEnd::StepLimit(n) => format!("The agent used all {n} of its steps before it finished."),
            LoopEnd::LoopGuard(tool) => {
                format!("The agent kept repeating the same step ({tool}), so Texo stopped it.")
            }
            LoopEnd::TimeLimit => "The agent ran out of time, so Texo stopped it.".into(),
        }
    }
}

/// What a kind drives a run with. Cheap to clone (sub-runs get clones).
#[derive(Clone)]
pub struct RunCx {
    pub shared: Arc<RunShared>,
    pub env: RunEnv,
    pub tool_cx: ToolCx,
    /// The user's message: prompt plus attachments.
    pub user_parts: Vec<Part>,
    /// Project facts, profile instructions and memory, added after the
    /// kind's system prompt.
    pub system_extra: String,
    pub limits: super::kinds::Limits,
}

// `message`, `await_input` and `sub_runs` are for the kinds that plan,
// pause (rebuttal) and fan out (reviewer ensemble).
#[allow(dead_code)]
impl RunCx {
    pub fn request(&self) -> &super::types::StartRequest {
        &self.shared.request
    }

    pub fn options(&self) -> &super::types::RunOptions {
        &self.shared.request.options
    }

    pub fn cancel(&self) -> &Cancel {
        &self.shared.cancel
    }

    /// The kind's standard loop: its prompt, its tools (narrowed by the
    /// profile), the user's message, its limits.
    pub fn default_spec<K: AgentKind + ?Sized>(&self, kind: &K) -> LoopSpec {
        let mut names = kind.tool_names();
        if let Some(allowed) = &self.options().tools {
            names.retain(|n| allowed.iter().any(|a| a == n));
        }
        let mut tools = tools_by_name(&names, self.env.net.as_ref());
        for t in kind.extra_tools() {
            let name = t.spec().name;
            if self.options().tools.as_ref().is_none_or(|a| a.contains(&name)) {
                tools.push(t);
            }
        }
        LoopSpec {
            system: format!("{}{}", kind.system_prompt(), self.system_extra),
            messages: vec![Msg::User { content: self.user_parts.clone() }],
            tools,
            max_steps: self.options().max_steps.unwrap_or(self.limits.max_steps).clamp(1, 200),
            loop_guard: self.limits.loop_guard.max(2),
            sub: None,
            model: None,
            fallback_models: None,
            thinking: None,
            stream: kind.role() == ModelRole::Chat,
        }
    }

    /// Adds a message step (e.g. a plan) to the run log.
    pub fn message(&self, text: &str) {
        self.shared.record(message_step(text, StepKind::Message, false, None), false);
    }

    /// Pauses the run in `awaiting_input` with `payload` until
    /// `agent_respond` hands over the user's input. The run gives up its
    /// slot while it waits, and the wait doesn't count against its time.
    pub async fn await_input(&self, payload: Value) -> AiResult<Value> {
        let sh = &self.shared;
        let (tx, rx) = oneshot::channel();
        *lock(&sh.input) = Some(tx);
        let paused = Instant::now();
        sh.update(|run| {
            run.status = RunStatus::AwaitingInput;
            run.awaiting = Some(payload);
            // Waiting doesn't count against the time limit.
            run.deadline_at = None;
        });
        lock(&sh.permit).take();
        let got = sh.cancel.run(async { rx.await.map_err(|_| AiError::cancelled()) }).await;
        lock(&sh.input).take();
        let input = got?;
        sh.update(|run| {
            run.status = RunStatus::Queued;
            run.awaiting = None;
        });
        let sem = sh.sem.clone();
        let permit = sh.cancel.run(async { sem.acquire_owned().await.map_err(|_| AiError::cancelled()) }).await?;
        *lock(&sh.permit) = Some(permit);
        if let Some(d) = lock(&sh.deadline).as_mut() {
            *d += paused.elapsed();
        }
        sh.update(|run| {
            run.status = RunStatus::Running;
            sh.sync_deadline_at(run);
        });
        Ok(input)
    }

    /// Runs several loops at once (e.g. a reviewer ensemble); results in
    /// the order of `specs`. They share the run's overlay, steps and cancel.
    pub async fn sub_runs(&self, specs: Vec<LoopSpec>) -> Vec<AiResult<LoopOutcome>> {
        self.sub_runs_with(specs, |_| {}).await
    }

    /// [`Self::sub_runs`], calling `done(i)` as each loop ends (in the
    /// order they end).
    pub async fn sub_runs_with(&self, specs: Vec<LoopSpec>, mut done: impl FnMut(usize)) -> Vec<AiResult<LoopOutcome>> {
        let mut set = tokio::task::JoinSet::new();
        let count = specs.len();
        for (i, spec) in specs.into_iter().enumerate() {
            let cx = self.clone();
            set.spawn(async move { (i, cx.run_loop(spec).await) });
        }
        let mut out: Vec<Option<AiResult<LoopOutcome>>> = (0..count).map(|_| None).collect();
        while let Some(joined) = set.join_next().await {
            if let Ok((i, r)) = joined {
                out[i] = Some(r);
                done(i);
            }
        }
        out.into_iter()
            .map(|r| r.unwrap_or_else(|| Err(AiError::new(Kind::Other, "Something went wrong inside Texo."))))
            .collect()
    }

    fn budget_chars(&self, model: &str) -> usize {
        match llm::model_caps(self.env.endpoint.provider, model).context_length {
            // About 3.5 characters per token, 60% of the window.
            Some(tokens) => ((tokens as f64) * 0.6 * 3.5) as usize,
            None => 120_000,
        }
    }

    /// The standard tool loop.
    pub async fn run_loop(&self, spec: LoopSpec) -> AiResult<LoopOutcome> {
        let sh = self.shared.clone();
        let sub = spec.sub.clone();
        let mut ep = self.env.endpoint.clone();
        if let Some(m) = spec.model.clone().filter(|m| !m.trim().is_empty()) {
            ep.model = m;
        }
        let mut session = LlmSession::new(ep);
        let tool_specs: Vec<_> = spec.tools.iter().map(|t| t.spec()).collect();
        let mut messages = spec.messages.clone();
        let mut seen: HashMap<String, u32> = HashMap::new();
        let mut summaries: HashMap<String, String> = HashMap::new();
        let mut nudged = false;
        let mut last_text = String::new();
        let mut steps = 0u32;
        while steps < spec.max_steps {
            sh.cancel.check()?;
            let Some(remaining) = sh.remaining() else {
                return Ok(LoopOutcome { text: last_text, report: None, end: LoopEnd::TimeLimit, steps, messages });
            };
            steps += 1;
            compact(&mut messages, self.budget_chars(session.model()), &summaries);
            let req = LlmRequest {
                system: spec.system.clone(),
                messages: messages.clone(),
                tools: tool_specs.clone(),
                tool_choice: ToolChoice::Auto,
                thinking: spec.thinking.unwrap_or(self.env.thinking),
                fallback_models: spec.fallback_models.clone().unwrap_or_else(|| self.env.fallback_models.clone()),
                policy: self.env.policy.clone(),
                ..Default::default()
            };
            let events = sh.events.clone();
            let (run_id, sub_label) = (sh.id.clone(), sub.clone());
            let mut sink = move |ev: StreamEvent| {
                let (text, reset) = match ev {
                    StreamEvent::Text(t) => (t, false),
                    StreamEvent::Reset => (String::new(), true),
                    StreamEvent::Notice(_) => return,
                };
                events.message(&MessageEvent { run_id: run_id.clone(), sub: sub_label.clone(), text, reset });
            };
            let client = self.env.client.clone();
            let call = session.complete(&client, &req, &sh.cancel, if spec.stream { Some(&mut sink) } else { None });
            let reply = match tokio::time::timeout(remaining, call).await {
                Err(_) => return Ok(LoopOutcome { text: last_text, report: None, end: LoopEnd::TimeLimit, steps, messages }),
                Ok(r) => r?,
            };
            sh.update(|run| {
                run.usage.input_tokens += reply.usage.input_tokens;
                run.usage.output_tokens += reply.usage.output_tokens;
                run.usage.llm_calls += 1;
                run.model = reply.model.clone();
            });
            for n in &reply.notices {
                sh.record(message_step(&n.message(), StepKind::Message, true, sub.as_deref()), false);
            }
            let text = reply.text.trim().to_string();
            messages.push(reply.to_msg());
            if reply.tool_calls.is_empty() {
                if text.is_empty() && !nudged {
                    nudged = true;
                    messages.push(Msg::user("Please continue: call a tool, or give your final answer."));
                    continue;
                }
                let mut final_text = text;
                if reply.stop == StopReason::MaxTokens {
                    final_text.push_str("\n\n(The answer was cut off at the model's length limit.)");
                }
                if !final_text.trim().is_empty() {
                    sh.record(message_step(&final_text, StepKind::Message, false, sub.as_deref()), false);
                }
                return Ok(LoopOutcome { text: final_text, report: None, end: LoopEnd::Finished, steps, messages });
            }
            if !text.is_empty() {
                sh.record(message_step(&text, StepKind::Think, false, sub.as_deref()), false);
                last_text = text.clone();
            }
            let mut report: Option<Report> = None;
            for call in &reply.tool_calls {
                let started = Instant::now();
                let tool = spec.tools.iter().find(|t| t.spec().name == call.name);
                let key = format!("{}|{}", call.name, call.arguments);
                let count = seen.entry(key).or_insert(0);
                *count += 1;
                if *count >= spec.loop_guard && call.invalid_arguments.is_none() {
                    let mut step = tool_step(&call.name, &call.arguments, sub.as_deref());
                    step.ok = false;
                    step.result_summary = "Stopped: the same call was repeated".into();
                    sh.record(step, false);
                    return Ok(LoopOutcome { text: last_text, report: None, end: LoopEnd::LoopGuard(call.name.clone()), steps, messages });
                }
                let mut saved_note: Option<String> = None;
                let mut data: Option<Value> = None;
                let mut activity: Option<ActivityGuard> = None;
                let (content, ok, summary, write) = if call.invalid_arguments.is_some() {
                    // Cut off at the output limit or unreadable: the model is
                    // told why and tries again (smaller edits for a cut-off).
                    let summary = if call.cut_off() { "The call was cut off at the length limit" } else { "The model sent unreadable arguments" };
                    (call.invalid_message(), false, summary.to_string(), false)
                } else if tool.is_some() && call.name == REMEMBER && sh.outside_text.load(Ordering::SeqCst) {
                    let m = super::tools::memory::REFUSED_AFTER_WEB.to_string();
                    (m, false, "Didn't save a note (the run read outside text)".to_string(), false)
                } else if let Some(tool) = tool {
                    activity = Some(ActivityGuard { sh: &sh, token: sh.begin_activity(&call.name, &call.arguments, sub.as_deref()) });
                    let out = sh.cancel.run(async { Ok(tool.call(&self.tool_cx, &call.arguments).await) }).await?;
                    data = out.data.as_deref().map(cap_data);
                    if let Some(Control::Finish(r)) = out.control {
                        report = Some(r);
                    }
                    if brings_outside_text(&call.name) {
                        sh.outside_text.store(true, Ordering::SeqCst);
                    }
                    if call.name == REMEMBER && out.ok {
                        saved_note = call.arguments.get("note").and_then(Value::as_str).map(str::to_string);
                    }
                    (cap(&out.content, MAX_RESULT_CHARS), out.ok, out.summary, !tool.read_only() && out.ok)
                } else {
                    let names: Vec<String> = spec.tools.iter().map(|t| t.spec().name).collect();
                    let m = format!("There is no tool named {}. The tools are: {}.", call.name, names.join(", "));
                    (m, false, format!("Unknown tool {}", call.name), false)
                };
                let mut step = tool_step(&call.name, &call.arguments, sub.as_deref());
                step.ok = ok;
                step.result_summary = summary.clone();
                step.result = Some(cap(&content, 2000));
                step.ms = started.elapsed().as_millis() as u64;
                step.data = data;
                sh.record(step, write);
                drop(activity);
                if write {
                    // The files changed: the same check or read again is
                    // not a repeat any more.
                    seen.clear();
                }
                if let Some(note) = saved_note {
                    // Memory reaches every later run: make the write visible.
                    sh.notice(&super::tools::memory::saved_notice(&note));
                }
                sh.update(|run| run.usage.tool_calls += 1);
                summaries.insert(call.id.clone(), format!("{}: {summary}", call.name));
                messages.push(Msg::tool_result(call, content, !ok));
            }
            if let Some(report) = report {
                return Ok(LoopOutcome { text: last_text, report: Some(report), end: LoopEnd::Report, steps, messages });
            }
        }
        Ok(LoopOutcome { text: last_text, report: None, end: LoopEnd::StepLimit(spec.max_steps), steps, messages })
    }
}

fn tool_step(name: &str, args: &Value, sub: Option<&str>) -> Step {
    Step {
        n: 0,
        kind: StepKind::ToolCall,
        tool: Some(name.to_string()),
        args: Some(cap_args(args)),
        result_summary: String::new(),
        result: None,
        text: None,
        ok: true,
        ms: 0,
        at: 0,
        sub: sub.map(str::to_string),
        notice: false,
        data: None,
    }
}

/// Ends the activity of a tool call however the call ends (also on cancel).
struct ActivityGuard<'a> {
    sh: &'a Arc<RunShared>,
    token: u64,
}

impl Drop for ActivityGuard<'_> {
    fn drop(&mut self) {
        self.sh.end_activity(self.token);
    }
}

fn arg(args: &Value, k: &str, max: usize) -> String {
    match args.get(k) {
        Some(Value::String(s)) => one_line(s, max),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Plain words for a running tool, from its arguments.
pub fn activity_label(tool: &str, args: &Value) -> String {
    let quoted = |k: &str| {
        let v = arg(args, k, 60);
        if v.is_empty() { String::new() } else { format!(": \"{v}\"") }
    };
    let path = |verb: &str| {
        let p = arg(args, "path", 80);
        if p.is_empty() { format!("{verb} a file") } else { format!("{verb} {p}") }
    };
    match tool {
        "list_files" => "Listing the project's files".into(),
        "read_file" => path("Reading"),
        "search" => format!("Searching the project{}", quoted("pattern")),
        "edit_file" => path("Editing"),
        "write_file" => path("Writing"),
        "delete_file" => path("Deleting"),
        "compile_check" => "Compiling a private copy".into(),
        "explain_log" => "Explaining a compile issue".into(),
        "search_papers" => format!("Searching papers{}", quoted("query")),
        "get_bibtex" => format!("Getting BibTeX{}", quoted("id")),
        "verify_citation" => format!("Checking citation{}", quoted("key")),
        "fetch_url" => format!("Reading a web page{}", quoted("url")),
        "web_search" => format!("Searching the web{}", quoted("query")),
        "read_memory" => "Reading the project memory".into(),
        "remember" => "Saving a note".into(),
        "submit_report" => "Handing in the report".into(),
        "update_plan" => "Updating the plan".into(),
        "submit_plan" => "Handing in the plan".into(),
        other => {
            let mut words = other.replace('_', " ");
            if let Some(c) = words.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            words
        }
    }
}

fn msg_chars(m: &Msg) -> usize {
    match m {
        Msg::User { content } => content
            .iter()
            .map(|p| match p {
                Part::Text { text } => text.len(),
                Part::Image { .. } => 1000,
            })
            .sum(),
        Msg::Assistant { text, tool_calls, .. } => text.len() + tool_calls.iter().map(|c| c.arguments.to_string().len()).sum::<usize>(),
        Msg::Tool { content, .. } => content.len(),
    }
}

/// Tool results kept whole however long the conversation gets.
const KEEP_RECENT_RESULTS: usize = 4;

/// Shortens older tool results to one line until the conversation fits
/// `budget` characters (the latest few results stay whole).
pub fn compact(messages: &mut [Msg], budget: usize, summaries: &HashMap<String, String>) {
    let mut total: usize = messages.iter().map(msg_chars).sum();
    if total <= budget {
        return;
    }
    let tool_positions: Vec<usize> =
        messages.iter().enumerate().filter(|(_, m)| matches!(m, Msg::Tool { .. })).map(|(i, _)| i).collect();
    let old = tool_positions.len().saturating_sub(KEEP_RECENT_RESULTS);
    for &i in &tool_positions[..old] {
        if total <= budget {
            break;
        }
        if let Msg::Tool { tool_call_id, name, content, .. } = &mut messages[i] {
            if content.starts_with("[Shortened") {
                continue;
            }
            let line = summaries.get(tool_call_id.as_str()).cloned().unwrap_or_else(|| format!("{name}: {}", one_line(content, 120)));
            let short = format!("[Shortened to save space; call the tool again if you need it] {line}");
            total = total - content.len() + short.len();
            *content = short;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::llm::ToolCall;

    #[test]
    fn compaction_shortens_old_results_first() {
        let call = |id: &str| ToolCall { id: id.into(), name: "read_file".into(), arguments: serde_json::json!({}), invalid_arguments: None };
        let mut msgs = vec![Msg::user("go")];
        for i in 0..8 {
            let c = call(&format!("c{i}"));
            msgs.push(Msg::Assistant { text: String::new(), tool_calls: vec![c.clone()], replay: None });
            msgs.push(Msg::tool_result(&c, "x".repeat(10_000), false));
        }
        let mut summaries = HashMap::new();
        summaries.insert("c0".to_string(), "read_file: Read main.tex".to_string());
        compact(&mut msgs, 50_000, &summaries);
        let total: usize = msgs.iter().map(msg_chars).sum();
        assert!(total <= 50_000, "{total}");
        let Msg::Tool { content, .. } = &msgs[2] else { panic!() };
        assert!(content.starts_with("[Shortened") && content.ends_with("read_file: Read main.tex"));
        // The latest results stay whole.
        let Msg::Tool { content, .. } = &msgs[16] else { panic!() };
        assert_eq!(content.len(), 10_000);
        // Under budget: nothing changes.
        let before = msgs.clone();
        compact(&mut msgs, 10_000_000, &summaries);
        assert_eq!(before, msgs);
    }
}
