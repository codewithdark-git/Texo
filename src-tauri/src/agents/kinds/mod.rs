//! Agent kinds: what a run of each kind is told, which tools it gets, its
//! limits, and how it is driven.
//!
//! A kind implements [`AgentKind`]. The default [`AgentKind::drive`] runs
//! the standard tool loop once; a kind can override it to
//! - write a plan first ([`RunCx::message`]),
//! - run sub-runs in parallel ([`RunCx::sub_runs`], e.g. a reviewer
//!   ensemble, each with its own persona prompt and model),
//! - pause for the user ([`RunCx::await_input`]: the run shows
//!   `awaiting_input` with a payload until `agent_respond`),
//! - and finish with a [`Report`] (the `submit_report` tool, or by
//!   returning one in [`Outcome`]).
//!
//! Each kind's system prompt is a Markdown file in `prompts/` (short
//! numbered rules, one example tool call, an explicit finish line, written
//! for open models), included at build time so it is easy to tune.

use std::sync::Arc;
use std::time::Duration;

use crate::agents::run_loop::{LoopEnd, RunCx};
use crate::agents::tools::registry::{BoxFut, Tool};
use crate::agents::types::{ChangeEntry, Report};
use crate::ai::error::AiResult;

pub mod cheat;
mod chat;
pub mod fixer;
pub mod rebuttal;
pub mod reviewer;
pub mod task;

/// Step and time limits of one loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_steps: u32,
    /// The whole run (time spent waiting for the user doesn't count).
    pub timeout: Duration,
    /// The same tool with the same arguments this many times stops the run.
    pub loop_guard: u32,
}

pub const DEFAULT_MAX_STEPS: u32 = 24;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

impl Default for Limits {
    fn default() -> Self {
        Limits { max_steps: DEFAULT_MAX_STEPS, timeout: DEFAULT_TIMEOUT, loop_guard: 3 }
    }
}

/// Which default model a kind wants (NVIDIA defaults from the spec).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelRole {
    Agent,
    Chat,
    /// For kinds that read images (the vision fallback).
    Vision,
    Review,
}

/// How a run ended, as the kind reports it to the runtime.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outcome {
    /// The final message for the user.
    pub message: Option<String>,
    pub report: Option<Report>,
    /// Set when the run stopped early (step limit, loop guard, time limit);
    /// the plain-words reason becomes the run's `error`.
    pub stopped: Option<String>,
}

impl Outcome {
    /// From the standard loop's result.
    pub fn from_loop(out: crate::agents::run_loop::LoopOutcome) -> Outcome {
        let stopped = match out.end {
            LoopEnd::Finished | LoopEnd::Report => None,
            _ => Some(out.end_message()),
        };
        Outcome { message: (!out.text.trim().is_empty()).then_some(out.text), report: out.report, stopped }
    }
}

/// JSON a model wrote as text: the whole text, a fenced block, or the first
/// `{…}` / `[…]` in it.
pub fn json_in_text(text: &str) -> Option<serde_json::Value> {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).map(|r| r.trim_end().trim_end_matches("```")).unwrap_or(t);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t.trim()) {
        if v.is_object() || v.is_array() {
            return Some(v);
        }
    }
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(a), Some(b)) = (t.find(open), t.rfind(close)) {
            if a < b {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t[a..=b]) {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// `names` narrowed to the run's `options.tools` (when set).
pub fn narrowed<'a>(cx: &RunCx, names: Vec<&'a str>) -> Vec<&'a str> {
    match &cx.options().tools {
        Some(allowed) => names.into_iter().filter(|n| allowed.iter().any(|a| a == n)).collect(),
        None => names,
    }
}

pub trait AgentKind: Send + Sync {
    /// `fixer`, `reviewer`, `rebuttal`, `task`, `chat`, …
    fn id(&self) -> &'static str;
    /// Plain name, e.g. "Fix compile errors" (also the history author when
    /// the run has no profile).
    fn label(&self) -> &'static str;
    /// The system prompt (the runtime adds the project facts, profile
    /// instructions and memory after it).
    fn system_prompt(&self) -> String;
    /// Built-in tool names (see `tools::registry`); profiles can narrow them.
    fn tool_names(&self) -> Vec<&'static str>;
    /// Tools of this kind only (e.g. chat's `propose_task`).
    fn extra_tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }
    fn limits(&self) -> Limits {
        Limits::default()
    }
    fn role(&self) -> ModelRole {
        ModelRole::Agent
    }
    /// Looks over the changeset before review; sets `attention` on files
    /// that need the user's eye (the fixer's cheat-fix guard). A changeset
    /// with any attention flag is never applied automatically.
    fn check_changes(&self, _changes: &mut [ChangeEntry]) {}
    /// Drives the run. The default runs the standard loop once.
    fn drive<'a>(&'a self, cx: &'a RunCx) -> BoxFut<'a, AiResult<Outcome>> {
        Box::pin(async move {
            let spec = cx.default_spec(self);
            Ok(Outcome::from_loop(cx.run_loop(spec).await?))
        })
    }
}

/// The kinds Texo knows.
pub struct Registry {
    kinds: Vec<Arc<dyn AgentKind>>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            kinds: vec![
                Arc::new(fixer::Fixer),
                Arc::new(reviewer::Reviewer),
                Arc::new(rebuttal::Rebuttal),
                Arc::new(task::Task),
                Arc::new(chat::Chat),
            ],
        }
    }
}

impl Registry {
    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentKind>> {
        self.kinds.iter().find(|k| k.id() == id.trim()).cloned()
    }

    /// Adds (or replaces) a kind.
    #[allow(dead_code)] // user-made kinds come with profiles
    pub fn register(&mut self, kind: Arc<dyn AgentKind>) {
        self.kinds.retain(|k| k.id() != kind.id());
        self.kinds.push(kind);
    }

    #[allow(dead_code)]
    pub fn ids(&self) -> Vec<&'static str> {
        self.kinds.iter().map(|k| k.id()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::tools::registry::{all_names, Builtin};

    #[test]
    fn built_in_kinds_have_prompts_and_known_tools() {
        let r = Registry::default();
        assert_eq!(r.ids(), ["fixer", "reviewer", "rebuttal", "task", "chat"]);
        for id in r.ids() {
            let k = r.get(id).unwrap();
            assert!(k.system_prompt().len() > 100, "{id}");
            for t in k.tool_names() {
                assert!(all_names().contains(&t) && Builtin::from_name(t).is_some(), "{id}: {t}");
            }
        }
        assert_eq!(r.get("fixer").unwrap().limits().max_steps, 16);
        assert_eq!(r.get("reviewer").unwrap().limits().max_steps, 40);
        assert_eq!(r.get("task").unwrap().limits().max_steps, 24);
        assert!(r.get("nope").is_none());
    }
}
