//! The task agent: plans first, then works through the plan.
//!
//! 1. A planning call (no tools) writes a short numbered plan, shown as a
//!    message step and parsed by [`parse_plan`].
//! 2. The standard loop works through it, with every tool.
//! 3. The final message has one line per task (done / partly / not done and
//!    why), parsed by [`parse_summary`] into the report (kind `task`).
//!
//! Attachments: images go as image parts when the model can see them, else
//! through the vision fallback's description (runtime + `attach.rs`); text
//! and PDF excerpts as text; "Also save into project" files go into the
//! changeset.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{AgentKind, Outcome};
use crate::agents::run_loop::{LoopEnd, LoopSpec, RunCx};
use crate::agents::tools::registry::*;
use crate::agents::types::{one_line, Phase, PhaseStatus, PlanItem, PlanStatus, Report, RunProgress};
use crate::ai::error::AiResult;
use crate::ai::llm::{Msg, Part};

pub struct Task;

const PROMPT: &str = include_str!("prompts/task.md");
const PLAN_PROMPT: &str = include_str!("prompts/task_plan.md");
pub const REPORT_KIND: &str = "task";
pub const MAX_TASKS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Done,
    Partly,
    NotDone,
    /// The final message didn't say.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    /// 1-based, as in the plan.
    pub n: usize,
    pub task: String,
    pub status: TaskStatus,
    /// What was done, or why not.
    pub note: String,
}

impl AgentKind for Task {
    fn id(&self) -> &'static str {
        "task"
    }

    fn label(&self) -> &'static str {
        "Task agent"
    }

    fn system_prompt(&self) -> String {
        PROMPT.to_string()
    }

    fn tool_names(&self) -> Vec<&'static str> {
        [FS_READ, FS_WRITE, BUILD, LITERATURE, BIB_WRITE, WEB, MEMORY, PLAN].concat()
    }

    fn drive<'a>(&'a self, cx: &'a RunCx) -> BoxFut<'a, AiResult<Outcome>> {
        Box::pin(drive(self, cx))
    }
}

fn numbered() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)^\s*(?:\*\*)?(?:task\s*)?(\d{1,2})\s*[.):]\s*(?:\*\*)?\s*(.+?)\s*$").expect("regex"))
}

fn bullet() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\s*[-*\u{2022}]\s+(.+?)\s*$").expect("regex"))
}

/// The tasks of a numbered (or bulleted) plan; at most [`MAX_TASKS`].
pub fn parse_plan(text: &str) -> Vec<String> {
    let mut tasks: Vec<String> = text
        .lines()
        .filter_map(|l| numbered().captures(l).map(|c| c[2].trim().trim_end_matches("**").trim().to_string()))
        .filter(|t| !t.is_empty())
        .collect();
    if tasks.is_empty() {
        tasks = text.lines().filter_map(|l| bullet().captures(l).map(|c| c[1].to_string())).collect();
    }
    tasks.truncate(MAX_TASKS);
    tasks
}

fn status_of(word: &str) -> Option<TaskStatus> {
    let w = word.trim().trim_matches(|c: char| c == '*' || c == '[' || c == ']' || c == '_').to_lowercase();
    if w.starts_with("not done") || w.starts_with("not") || w.starts_with("skipped") || w.starts_with("failed") || w.starts_with("couldn") {
        Some(TaskStatus::NotDone)
    } else if w.starts_with("partly") || w.starts_with("partial") {
        Some(TaskStatus::Partly)
    } else if w.starts_with("done") || w.starts_with("complete") || w.starts_with("finished") {
        Some(TaskStatus::Done)
    } else {
        None
    }
}

/// Per task of the plan: the status and note from the final message's
/// numbered lines ("1. done: …", "2. partly: …", "3. not done: …").
pub fn parse_summary(text: &str, tasks: &[String]) -> Vec<TaskResult> {
    let mut out: Vec<TaskResult> = tasks
        .iter()
        .enumerate()
        .map(|(i, t)| TaskResult { n: i + 1, task: t.clone(), status: TaskStatus::Unknown, note: String::new() })
        .collect();
    for line in text.lines() {
        let Some(c) = numbered().captures(line) else { continue };
        let Ok(n) = c[1].parse::<usize>() else { continue };
        let rest = c[2].trim();
        let Some(slot) = out.iter_mut().find(|r| r.n == n) else { continue };
        // "done: note", "Done — note", "**partly** - note".
        let (head, note) = match rest.find([':', '\u{2014}', '\u{2013}']).or_else(|| rest.find(" - ")) {
            Some(i) => {
                let sep_len = rest[i..].chars().next().map(char::len_utf8).unwrap_or(1);
                let skip = if rest[i..].starts_with(" - ") { 3 } else { sep_len };
                (&rest[..i], rest[i + skip..].trim())
            }
            None => (rest, ""),
        };
        if let Some(s) = status_of(head) {
            slot.status = s;
            slot.note = note.to_string();
        } else if let Some(s) = status_of(rest) {
            slot.status = s;
            slot.note = rest.to_string();
        }
    }
    out
}

/// The task kind's phases: plan, work, summary.
pub fn phases() -> Vec<Phase> {
    vec![Phase::new("plan", "Plan"), Phase::new("work", "Work"), Phase::new("summary", "Summary")]
}

/// The plan checklist from the parsed tasks.
pub fn plan_items(tasks: &[String]) -> Vec<PlanItem> {
    tasks.iter().enumerate().map(|(i, t)| PlanItem { n: i as u32 + 1, task: t.clone(), ..Default::default() }).collect()
}

/// The final per-task statuses onto the plan (a task the summary doesn't
/// mention keeps what `update_plan` gave it).
pub fn apply_results(progress: &mut RunProgress, results: &[TaskResult]) {
    for r in results {
        let status = match r.status {
            TaskStatus::Done => PlanStatus::Done,
            TaskStatus::Partly => PlanStatus::Partly,
            TaskStatus::NotDone => PlanStatus::NotDone,
            TaskStatus::Unknown => continue,
        };
        let note = Some(r.note.clone()).filter(|n| !n.trim().is_empty());
        progress.update_plan(r.n as u32, status, note, None);
    }
}

fn plan_spec(kind: &Task, cx: &RunCx) -> LoopSpec {
    let mut spec = cx.default_spec(kind);
    spec.system = format!("{PLAN_PROMPT}{}", cx.system_extra);
    spec.tools = Vec::new();
    spec.max_steps = 1;
    spec.stream = false;
    spec
}

async fn drive(kind: &Task, cx: &RunCx) -> AiResult<Outcome> {
    let sh = &cx.shared;
    sh.set_phases(phases());
    sh.set_phase("plan", PhaseStatus::Active, None, None, None);
    // 1. The plan (recorded as a message step by the loop).
    let plan_out = cx.run_loop(plan_spec(kind, cx)).await?;
    let mut tasks = parse_plan(&plan_out.text);
    if tasks.is_empty() {
        let first = cx.request().prompt.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Do what the user asked");
        tasks = vec![one_line(first, 200)];
        cx.message(&format!("Plan:\n1. {}", tasks[0]));
    }
    let plan: String = tasks.iter().enumerate().map(|(i, t)| format!("{}. {t}\n", i + 1)).collect();
    sh.set_plan(plan_items(&tasks));
    sh.update(|run| {
        run.progress.set_phase("plan", PhaseStatus::Done, Some(format!("{} task(s)", tasks.len())), None, None);
        run.progress.set_phase("work", PhaseStatus::Active, None, None, None);
    });

    // 2. The work.
    let mut spec = cx.default_spec(kind);
    spec.max_steps = spec.max_steps.saturating_sub(plan_out.steps).max(1);
    spec.messages.push(Msg::Assistant { text: format!("Plan:\n{plan}"), tool_calls: Vec::new(), replay: None });
    let mut ask = "Now carry out the plan, task by task. Finish with one line per task, numbered as in the plan: \"1. done: ...\", \"2. partly: ...\" or \"3. not done: ...\"."
        .to_string();
    if spec.tools.iter().any(|t| t.spec().name == UPDATE_PLAN) {
        ask.push_str(" As you go, call update_plan with the task number: status \"active\" when you start a task, then \"done\", \"partly\" or \"notDone\".");
    }
    spec.messages.push(Msg::User { content: vec![Part::Text { text: ask }] });
    let out = cx.run_loop(spec).await?;

    // 3. The per-task summary.
    let results = parse_summary(&out.text, &tasks);
    let stopped = match out.end {
        LoopEnd::Finished | LoopEnd::Report => None,
        _ => Some(out.end_message()),
    };
    sh.update(|run| {
        let p = &mut run.progress;
        let work = if stopped.is_some() { PhaseStatus::Failed } else { PhaseStatus::Done };
        p.set_phase("work", work, None, None, None);
        apply_results(p, &results);
        p.set_phase("summary", PhaseStatus::Done, None, None, None);
    });
    let counts = |s: TaskStatus| results.iter().filter(|r| r.status == s).count();
    let summary = format!(
        "{} of {} task(s) done, {} partly, {} not done{}.",
        counts(TaskStatus::Done),
        results.len(),
        counts(TaskStatus::Partly),
        counts(TaskStatus::NotDone),
        match counts(TaskStatus::Unknown) {
            0 => String::new(),
            n => format!(", {n} not reported"),
        }
    );
    let mut data = serde_json::Map::new();
    data.insert("tasks".into(), json!(results));
    data.insert("summary".into(), json!(summary));
    let mut message = out.text.trim().to_string();
    if message.is_empty() {
        message = summary.clone();
    }
    Ok(Outcome { message: Some(message), report: Some(Report { kind: REPORT_KIND.into(), data }), stopped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_are_parsed_from_numbered_or_bulleted_lines() {
        let text = "Here is my plan:\n\n1. Shorten the abstract.\n2) Add the figure\n**3.** Fix the bibliography\nThat's all.";
        assert_eq!(parse_plan(text), ["Shorten the abstract.", "Add the figure", "Fix the bibliography"]);
        assert_eq!(parse_plan("- Do A\n* Do B"), ["Do A", "Do B"]);
        assert!(parse_plan("Just one paragraph with no list.").is_empty());
        let many: String = (1..=14).map(|i| format!("{i}. Task {i}\n")).collect();
        assert_eq!(parse_plan(&many).len(), MAX_TASKS);
        assert_eq!(parse_plan("Task 1: Add a title"), ["Add a title"]);
    }

    #[test]
    fn summaries_map_to_the_plan() {
        let tasks: Vec<String> = ["Shorten", "Add figure", "Fix bib", "Translate"].iter().map(|s| s.to_string()).collect();
        let text = "All finished.\n1. done: shortened to 148 words\n2. Partly \u{2014} added, caption missing\n3. not done: no .bib file found\n9. done: extra line";
        let r = parse_summary(text, &tasks);
        assert_eq!(r.iter().map(|x| x.status).collect::<Vec<_>>(), [TaskStatus::Done, TaskStatus::Partly, TaskStatus::NotDone, TaskStatus::Unknown]);
        assert_eq!(r[0].note, "shortened to 148 words");
        assert_eq!(r[1].note, "added, caption missing");
        assert_eq!(r[2].note, "no .bib file found");
        assert_eq!((r[3].n, r[3].task.as_str()), (4, "Translate"));
        let r = parse_summary("1. **Done** - all good\n2. Not done (needs data)", &tasks[..2]);
        assert_eq!(r[0].status, TaskStatus::Done);
        assert_eq!(r[0].note, "all good");
        assert_eq!(r[1].status, TaskStatus::NotDone);
    }
}
