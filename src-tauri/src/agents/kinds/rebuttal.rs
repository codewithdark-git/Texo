//! The "Response to reviewers" kind.
//!
//! 1. Plan: split the reviews (pasted text, attached files, or an earlier
//!    Texo review report via `options.extra.reviewReport` /
//!    `options.extra.reviewRunId`) into atomic concerns, each with an
//!    action (answer / change the manuscript / new experiment) and a plan.
//!    The model hands it in with `submit_plan`.
//! 2. Pause in `awaiting_input` with the plan ([`PlanPayload`]) until the
//!    user approves or edits it with `agent_respond` ([`PlanAnswer`]).
//! 3. Draft `response-to-reviewers.tex` plus the manuscript edits, as the
//!    changeset. New experiments get `[TBD: …]` placeholders, never
//!    invented results (checked: a draft without them for experiment
//!    concerns gets one more turn, then a warning).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{json_in_text, AgentKind, Outcome};
use crate::agents::review::ReviewReport;
use crate::agents::run_loop::{LoopEnd, LoopSpec, RunCx};
use crate::agents::tools::registry::*;
use crate::agents::types::{one_line, Phase, PhaseStatus, PlanItem, PlanStatus, Report, RunProgress};
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::llm::{Msg, Part, ToolSpec};

pub struct Rebuttal;

const PLAN_PROMPT: &str = include_str!("prompts/rebuttal_plan.md");
const DRAFT_PROMPT: &str = include_str!("prompts/rebuttal_draft.md");
pub const LETTER: &str = "response-to-reviewers.tex";
pub const SUBMIT_PLAN: &str = "submit_plan";
pub const PLAN_KIND: &str = "rebuttalPlan";
pub const REPORT_KIND: &str = "rebuttal";
const MAX_CONCERNS: usize = 80;
const PLAN_STEPS: u32 = 24;

/// What to do about one concern.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Answer from what the paper already has, or clarify.
    #[default]
    Answer,
    /// Change the manuscript.
    Change,
    /// Needs a new experiment or analysis: `[TBD: …]`.
    Experiment,
}

/// One atomic reviewer concern and the plan for it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Concern {
    /// "R1.2": reviewer 1, point 2.
    pub id: String,
    #[serde(default)]
    pub reviewer: String,
    /// The reviewer's words.
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub action: Action,
    /// What the answer or change will be.
    #[serde(default)]
    pub plan: String,
    /// The manuscript file the change goes to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// After drafting: answered / changed / tbd / skipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// After drafting: where the manuscript changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<String>,
}

/// The `awaiting` payload while the plan waits for approval.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPayload {
    /// Always "rebuttalPlan".
    #[serde(rename = "type")]
    pub kind: String,
    pub concerns: Vec<Concern>,
    pub message: String,
}

/// The user's answer through `agent_respond`: `{approved, concerns?, note?}`
/// (also `true`, `"approve"`, or just the edited concerns list).
#[derive(Debug, Clone, PartialEq)]
pub enum PlanAnswer {
    Approved { concerns: Vec<Concern>, note: Option<String> },
    Declined,
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| text(Some(x))).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("; "),
        _ => String::new(),
    }
}

/// The action from the model's (or user's) loose words. Whole words only,
/// and a word after "no" / "not" / "without" (within four words) doesn't
/// count: "answer; no new analysis needed" is an answer, and "clarify the
/// running example" isn't an experiment.
fn action_of(s: &str) -> Action {
    let s = s.trim().to_lowercase();
    match s.as_str() {
        "answer" => return Action::Answer,
        "change" => return Action::Change,
        "experiment" => return Action::Experiment,
        _ => {}
    }
    let words: Vec<&str> = s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let negated = |i: usize| {
        words[i.saturating_sub(4)..i].iter().any(|w| matches!(*w, "no" | "not" | "without" | "never" | "don" | "doesn" | "needn" | "nor"))
    };
    let any = |is: &dyn Fn(&str) -> bool| words.iter().enumerate().any(|(i, w)| is(w) && !negated(i));
    let experiment = |w: &str| {
        w.starts_with("experiment")
            || w.starts_with("ablat")
            || w.starts_with("analys")
            || w.starts_with("analyz")
            || w.starts_with("benchmark")
            || w.starts_with("rerun")
            || matches!(w, "exp" | "tbd" | "run" | "runs" | "baseline" | "baselines" | "measure" | "measurements")
    };
    let change = |w: &str| {
        ["chang", "edit", "revis", "add", "manuscript", "rewrit", "rephras"].iter().any(|p| w.starts_with(p)) || matches!(w, "fix" | "update")
    };
    if any(&experiment) {
        Action::Experiment
    } else if any(&change) {
        Action::Change
    } else {
        Action::Answer
    }
}

/// Reads concerns from model or user JSON, leniently: `{concerns: [...]}`
/// or a list; ids filled in, actions read from loose words.
pub fn parse_concerns(v: &Value) -> Vec<Concern> {
    let items = match v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => match o.get("concerns").or(o.get("plan")).or(o.get("items")) {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    let mut out: Vec<Concern> = Vec::new();
    for (n, it) in items.iter().enumerate().take(MAX_CONCERNS) {
        let c = match it {
            Value::String(s) if !s.trim().is_empty() => Concern { summary: s.trim().into(), ..Default::default() },
            Value::Object(o) => Concern {
                id: text(o.get("id")),
                reviewer: text(o.get("reviewer")),
                quote: text(o.get("quote").or(o.get("comment"))),
                summary: text(o.get("summary").or(o.get("concern"))),
                action: action_of(&text(o.get("action").or(o.get("type")))),
                plan: text(o.get("plan").or(o.get("response")).or(o.get("answer"))),
                file: Some(text(o.get("file"))).filter(|f| !f.is_empty()),
                status: Some(text(o.get("status"))).filter(|f| !f.is_empty()),
                changes: Some(text(o.get("changes"))).filter(|f| !f.is_empty()),
            },
            _ => continue,
        };
        if c.summary.is_empty() && c.quote.is_empty() && c.plan.is_empty() && c.status.is_none() {
            continue;
        }
        let mut c = c;
        if c.id.is_empty() || out.iter().any(|x| x.id == c.id) {
            c.id = format!("C{}", n + 1);
        }
        if c.summary.is_empty() {
            c.summary = one_line(if c.quote.is_empty() { &c.plan } else { &c.quote }, 160);
        }
        if c.summary.is_empty() && c.status.is_none() {
            continue;
        }
        out.push(c);
    }
    out
}

/// Reads the user's answer to the plan.
pub fn parse_answer(v: &Value, proposed: &[Concern]) -> PlanAnswer {
    let approved_word = |s: &str| matches!(s.trim().to_lowercase().as_str(), "approve" | "approved" | "yes" | "ok" | "go" | "draft");
    match v {
        Value::Bool(true) => PlanAnswer::Approved { concerns: proposed.to_vec(), note: None },
        Value::String(s) if approved_word(s) => PlanAnswer::Approved { concerns: proposed.to_vec(), note: None },
        Value::Array(_) => match parse_concerns(v) {
            c if c.is_empty() => PlanAnswer::Declined,
            c => PlanAnswer::Approved { concerns: c, note: None },
        },
        Value::Object(o) => {
            if o.get("approved").and_then(Value::as_bool) == Some(false) {
                return PlanAnswer::Declined;
            }
            let concerns = match o.get("concerns") {
                Some(c @ Value::Array(_)) => parse_concerns(c),
                _ => proposed.to_vec(),
            };
            if concerns.is_empty() {
                return PlanAnswer::Declined;
            }
            let note = Some(text(o.get("note"))).filter(|n| !n.is_empty());
            PlanAnswer::Approved { concerns, note }
        }
        _ => PlanAnswer::Declined,
    }
}

/// The plan as a numbered list for the run log.
pub fn plan_text(concerns: &[Concern]) -> String {
    let mut s = format!("Plan for {} reviewer concern(s):\n", concerns.len());
    for c in concerns {
        let what = match c.action {
            Action::Answer => "answer",
            Action::Change => "change the paper",
            Action::Experiment => "new experiment [TBD]",
        };
        s.push_str(&format!("{}. {} ({what}): {}\n", c.id, one_line(&c.summary, 140), one_line(&c.plan, 200)));
    }
    s.trim_end().to_string()
}

/// The `[TBD: …]` placeholders in a text.
pub fn tbd_items(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("[TBD") {
        let after = &rest[i..];
        let end = after.find(']').map(|e| e + 1).unwrap_or(after.len().min(200));
        out.push(after[..end].to_string());
        rest = &after[end.max(1)..];
    }
    out
}

/// Whether a `[TBD …]` placeholder names concern `id` (whole token, any case).
fn names_concern(item: &str, id: &str) -> bool {
    let (item, id) = (item.to_lowercase(), id.trim().to_lowercase());
    if id.is_empty() {
        return false;
    }
    item.match_indices(id.as_str()).any(|(at, m)| {
        let before = item[..at].chars().next_back();
        let after = item[at + m.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// The experiment concerns the letter has no `[TBD: …]` placeholder for.
/// A placeholder that names a concern id covers that concern; each one that
/// names none covers one of the others. Empty when every concern is covered.
pub fn missing_tbd<'a>(letter: &str, experiments: &[&'a Concern]) -> Vec<&'a str> {
    let items = tbd_items(letter);
    let unnamed: Vec<&str> =
        experiments.iter().filter(|c| !items.iter().any(|t| names_concern(t, &c.id))).map(|c| c.id.as_str()).collect();
    let free = items.iter().filter(|t| !experiments.iter().any(|c| names_concern(t, &c.id))).count();
    if unnamed.len() > free {
        unnamed
    } else {
        Vec::new()
    }
}

/// `submit_plan`: ends the planning loop with the concerns.
struct SubmitPlan;

impl Tool for SubmitPlan {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: SUBMIT_PLAN.into(),
            description: "Hand in the plan: the reviewers' concerns, each with an action (answer, change or experiment) and a plan.".into(),
            parameters: json!({"type": "object", "properties": {"concerns": {"type": "array", "items": {"type": "object"}}}, "required": ["concerns"]}),
        }
    }

    fn call<'a>(&'a self, _cx: &'a ToolCx, args: &'a Value) -> BoxFut<'a, ToolOutput> {
        Box::pin(async move {
            let v = match args.get("concerns") {
                Some(Value::String(s)) => json_in_text(s).unwrap_or(Value::Null),
                _ => args.clone(),
            };
            let concerns = parse_concerns(&v);
            if concerns.is_empty() {
                return ToolOutput::err("The plan has no concerns. Call submit_plan with {\"concerns\": [{\"id\", \"reviewer\", \"quote\", \"summary\", \"action\", \"plan\"}]}.");
            }
            let mut data = serde_json::Map::new();
            data.insert("concerns".into(), json!(concerns));
            ToolOutput {
                content: "Plan received. The user will check it.".into(),
                ok: true,
                summary: format!("Handed in a plan with {} concern(s)", concerns.len()),
                control: Some(Control::Finish(Report { kind: PLAN_KIND.into(), data })),
                data: None,
            }
        })
    }
}

impl AgentKind for Rebuttal {
    fn id(&self) -> &'static str {
        "rebuttal"
    }

    fn label(&self) -> &'static str {
        "Response to reviewers"
    }

    fn system_prompt(&self) -> String {
        DRAFT_PROMPT.to_string()
    }

    fn tool_names(&self) -> Vec<&'static str> {
        [FS_READ, FS_WRITE, LITERATURE, &[FETCH_URL], MEMORY, REPORT, PLAN].concat()
    }

    fn extra_tools(&self) -> Vec<Arc<dyn Tool>> {
        vec![Arc::new(SubmitPlan)]
    }

    fn drive<'a>(&'a self, cx: &'a RunCx) -> BoxFut<'a, AiResult<Outcome>> {
        Box::pin(drive(self, cx))
    }
}

/// An earlier Texo review given with the run, as text for the model.
fn previous_review(cx: &RunCx) -> Option<String> {
    let extra = cx.options().extra.as_ref()?;
    let report = match (extra.get("reviewReport"), extra.get("reviewRunId").and_then(Value::as_str)) {
        (Some(r @ Value::Object(_)), _) => ReviewReport::from_value(r),
        (_, Some(id)) => {
            let run = crate::agents::journal::load(&cx.tool_cx.root, id).ok()?;
            ReviewReport::from_report(run.report.as_ref()?)
        }
        _ => return None,
    };
    if report.reviews.is_empty() {
        return None;
    }
    Some(crate::agents::types::cap(&super::reviewer::render_markdown(&report), 30_000))
}

fn plan_spec(kind: &Rebuttal, cx: &RunCx) -> LoopSpec {
    let mut spec = cx.default_spec(kind);
    spec.system = format!("{PLAN_PROMPT}{}", cx.system_extra);
    let read: Vec<&str> = [FS_READ, LITERATURE, &[FETCH_URL, READ_MEMORY]].concat();
    let names = super::narrowed(cx, read);
    spec.tools = tools_by_name(&names, cx.env.net.as_ref());
    spec.tools.push(Arc::new(SubmitPlan));
    spec.max_steps = spec.max_steps.min(PLAN_STEPS);
    if let Some(prev) = previous_review(cx) {
        if let Some(Msg::User { content }) = spec.messages.first_mut() {
            content.push(Part::Text { text: format!("An earlier review of this paper by Texo's reviewer agent:\n{prev}") });
        }
    }
    spec
}

/// The rebuttal's phases: read, plan (approved by the user), draft, report.
pub fn phases() -> Vec<Phase> {
    vec![
        Phase::new("read", "Read the reviews"),
        Phase::new("plan", "Plan (needs your approval)"),
        Phase::new("draft", "Draft responses"),
        Phase::new("report", "Report"),
    ]
}

/// The approved concerns as the plan checklist (numbered 1..n).
pub fn plan_items(concerns: &[Concern]) -> Vec<PlanItem> {
    concerns
        .iter()
        .enumerate()
        .map(|(i, c)| PlanItem { n: i as u32 + 1, task: format!("{}: {}", c.id, one_line(&c.summary, 140)), ..Default::default() })
        .collect()
}

/// The drafted statuses onto the plan: answered / changed are done, tbd is
/// partly (an experiment still to run), skipped is skipped.
pub fn apply_statuses(progress: &mut RunProgress, concerns: &[Concern]) {
    for (i, c) in concerns.iter().enumerate() {
        let status = match c.status.as_deref().map(|s| s.trim().to_lowercase()) {
            Some(s) if s == "answered" || s == "changed" || s == "done" => PlanStatus::Done,
            Some(s) if s == "tbd" || s == "partly" => PlanStatus::Partly,
            Some(s) if s == "skipped" => PlanStatus::Skipped,
            _ => continue,
        };
        progress.update_plan(i as u32 + 1, status, c.changes.clone(), None);
    }
}

async fn drive(kind: &Rebuttal, cx: &RunCx) -> AiResult<Outcome> {
    let sh = &cx.shared;
    sh.set_phases(phases());
    sh.set_phase("read", PhaseStatus::Active, None, None, None);
    // 1. The plan.
    let out = cx.run_loop(plan_spec(kind, cx)).await?;
    let proposed = match &out.report {
        Some(r) => parse_concerns(&Value::Object(r.data.clone())),
        None => json_in_text(&out.text).map(|v| parse_concerns(&v)).unwrap_or_default(),
    };
    if proposed.is_empty() {
        let why = match out.end {
            LoopEnd::Finished | LoopEnd::Report => "The reviews couldn't be split into concerns. Paste the reviewers' comments into the request (or attach them) and try again.".to_string(),
            _ => out.end_message(),
        };
        return Err(AiError::new(Kind::Other, why));
    }
    cx.message(&plan_text(&proposed));
    sh.update(|run| {
        run.progress.set_phase("read", PhaseStatus::Done, Some(format!("{} concern(s)", proposed.len())), None, None);
        run.progress.set_phase("plan", PhaseStatus::Active, None, None, None);
    });

    // 2. Wait for the user.
    let payload = PlanPayload {
        kind: PLAN_KIND.into(),
        concerns: proposed.clone(),
        message: "Check the plan: edit, remove or add concerns, then approve it to start drafting.".into(),
    };
    let answer = cx.await_input(serde_json::to_value(&payload).unwrap_or(Value::Null)).await?;
    let (concerns, note) = match parse_answer(&answer, &proposed) {
        PlanAnswer::Declined => {
            sh.update(|run| {
                run.progress.set_phase("plan", PhaseStatus::Done, Some("You stopped before drafting".into()), None, None);
                run.progress.skip_unfinished();
            });
            let mut data = serde_json::Map::new();
            data.insert("concerns".into(), json!(proposed));
            data.insert("letter".into(), Value::Null);
            data.insert("summary".into(), json!("You stopped before the drafting started."));
            return Ok(Outcome {
                message: Some("You stopped before the drafting started. The plan is kept in the report.".into()),
                report: Some(Report { kind: REPORT_KIND.into(), data }),
                stopped: None,
            });
        }
        PlanAnswer::Approved { concerns, note } => (concerns, note),
    };
    cx.message(&format!("You approved the plan ({} concern(s)). Drafting the response.", concerns.len()));
    sh.update(|run| {
        run.progress.set_phase("plan", PhaseStatus::Done, Some("Approved".into()), None, None);
        run.progress.set_phase("draft", PhaseStatus::Active, None, None, None);
        run.progress.set_plan(plan_items(&concerns));
    });

    // 3. The draft.
    let mut spec = cx.default_spec(kind);
    spec.tools.retain(|t| t.spec().name != SUBMIT_PLAN);
    if let Some(Msg::User { content }) = spec.messages.first_mut() {
        if let Some(prev) = previous_review(cx) {
            content.push(Part::Text { text: format!("An earlier review of this paper by Texo's reviewer agent:\n{prev}") });
        }
        let mut t = format!(
            "The approved plan (JSON):\n{}",
            serde_json::to_string_pretty(&concerns).unwrap_or_default()
        );
        if let Some(n) = &note {
            t.push_str(&format!("\n\nThe user's note on the plan: {n}"));
        }
        if spec.tools.iter().any(|t| t.spec().name == UPDATE_PLAN) {
            t.push_str("\n\nThe concerns are numbered 1, 2, … in this order. When you have answered one, call update_plan with its number and status \"done\" (\"partly\" when it waits for a new experiment).");
        }
        content.push(Part::Text { text: t });
    }
    let budget = spec.max_steps;
    let mut out = cx.run_loop(spec.clone()).await?;
    let mut used = out.steps;
    let mut warnings: Vec<String> = Vec::new();
    let experiments: Vec<&Concern> = concerns.iter().filter(|c| c.action == Action::Experiment).collect();
    // At most one more turn per problem: no letter, or no [TBD] placeholders.
    let mut asked: Vec<&str> = Vec::new();
    loop {
        let letter = letter_text(cx);
        let (key, ask) = match &letter {
            None => ("letter", format!("{LETTER} hasn't been written yet. Write the complete letter now with write_file, then call submit_report.")),
            Some(l) if !missing_tbd(l, &experiments).is_empty() => ("tbd", format!(
                "Concern(s) {} need a new experiment, but the letter has no [TBD: ...] placeholder for them. Never report results that weren't run: put one [TBD: <concern id>: what must be run] per concern where its results go, then call submit_report.",
                missing_tbd(l, &experiments).join(", ")
            )),
            Some(_) => break,
        };
        let ended = matches!(out.end, LoopEnd::Finished | LoopEnd::Report);
        if !ended || used >= budget || asked.contains(&key) {
            break;
        }
        asked.push(key);
        let mut next = spec.clone();
        next.messages = out.messages.clone();
        next.messages.push(Msg::user(ask));
        next.max_steps = (budget - used).max(1);
        let prev_report = out.report.clone();
        out = cx.run_loop(next).await?;
        if out.report.is_none() {
            out.report = prev_report;
        }
        used += out.steps;
    }
    let letter = letter_text(cx);
    match &letter {
        None => warnings.push(format!("{LETTER} wasn't written.")),
        Some(l) if !missing_tbd(l, &experiments).is_empty() => warnings.push(format!(
            "Concern(s) {} need new experiments, but the letter has no [TBD: ...] placeholder for them. Check that no results were made up.",
            missing_tbd(l, &experiments).join(", ")
        )),
        _ => {}
    }

    // The report: the plan with the statuses the model reported.
    let mut merged = concerns.clone();
    let reported = out.report.as_ref().map(|r| parse_concerns(&Value::Object(r.data.clone()))).unwrap_or_default();
    for c in &mut merged {
        if let Some(r) = reported.iter().find(|r| r.id == c.id) {
            c.status = r.status.clone();
            c.changes = r.changes.clone();
        }
    }
    sh.update(|run| {
        let p = &mut run.progress;
        apply_statuses(p, &merged);
        let draft = if letter.is_some() { PhaseStatus::Done } else { PhaseStatus::Failed };
        p.set_phase("draft", draft, None, None, None);
        p.set_phase("report", PhaseStatus::Done, None, None, None);
    });
    let summary = out
        .report
        .as_ref()
        .and_then(|r| r.data.get("summary"))
        .map(|s| text(Some(s)))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| out.text.trim().to_string());
    let mut data = serde_json::Map::new();
    data.insert("summary".into(), json!(summary));
    data.insert("concerns".into(), json!(merged));
    data.insert("letter".into(), json!(letter.as_ref().map(|_| LETTER)));
    data.insert("tbd".into(), json!(letter.as_deref().map(tbd_items).unwrap_or_default()));
    data.insert("warnings".into(), json!(warnings));
    let mut message = summary.clone();
    for w in &warnings {
        message.push_str(&format!("\n\n{w}"));
    }
    let stopped = match out.end {
        LoopEnd::Finished | LoopEnd::Report => None,
        _ => Some(out.end_message()),
    };
    Ok(Outcome {
        message: (!message.trim().is_empty()).then_some(message.trim().to_string()),
        report: Some(Report { kind: REPORT_KIND.into(), data }),
        stopped,
    })
}

/// The letter as the run wrote it (not the file on disk).
fn letter_text(cx: &RunCx) -> Option<String> {
    let o = cx.tool_cx.overlay();
    o.changes().into_iter().find(|c| c.file == LETTER).and_then(|c| c.new_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concerns_are_read_leniently() {
        let v = json!({"concerns": [
            {"id": "R1.1", "reviewer": "Reviewer 1", "quote": "No ablation.", "action": "New experiment", "plan": "Run it"},
            {"id": "R1.1", "comment": "Typos in Sec. 2", "action": "edit the manuscript", "plan": "Fix them", "file": "sec2.tex"},
            {"concern": "Why not X?", "action": "answer", "response": "Because Y"},
            "A plain string concern",
            {"id": "empty"},
            42
        ]});
        let c = parse_concerns(&v);
        assert_eq!(c.len(), 4);
        assert_eq!((c[0].id.as_str(), c[0].action), ("R1.1", Action::Experiment));
        assert_eq!(c[0].summary, "No ablation.");
        assert_eq!((c[1].id.as_str(), c[1].action), ("C2", Action::Change), "duplicate id replaced");
        assert_eq!(c[1].file.as_deref(), Some("sec2.tex"));
        assert_eq!((c[2].action, c[2].plan.as_str()), (Action::Answer, "Because Y"));
        assert_eq!(c[3].summary, "A plain string concern");
        assert!(parse_concerns(&json!("nothing")).is_empty());
        assert_eq!(parse_concerns(&json!([{"summary": "x"}])).len(), 1);
    }

    #[test]
    fn plan_answers() {
        let proposed = parse_concerns(&json!([{"id": "R1", "summary": "a", "plan": "p"}, {"id": "R2", "summary": "b"}]));
        let all = PlanAnswer::Approved { concerns: proposed.clone(), note: None };
        assert_eq!(parse_answer(&json!(true), &proposed), all);
        assert_eq!(parse_answer(&json!("Approve"), &proposed), all);
        assert_eq!(parse_answer(&json!({"approved": true}), &proposed), all);
        assert_eq!(parse_answer(&json!({"approved": false}), &proposed), PlanAnswer::Declined);
        assert_eq!(parse_answer(&json!(false), &proposed), PlanAnswer::Declined);
        assert_eq!(parse_answer(&json!("cancel"), &proposed), PlanAnswer::Declined);
        assert_eq!(parse_answer(&json!({"approved": true, "concerns": []}), &proposed), PlanAnswer::Declined);
        let edited = parse_answer(&json!({"approved": true, "concerns": [{"id": "R2", "summary": "b", "action": "change"}], "note": " Be brief. "}), &proposed);
        match edited {
            PlanAnswer::Approved { concerns, note } => {
                assert_eq!(concerns.len(), 1);
                assert_eq!(concerns[0].action, Action::Change);
                assert_eq!(note.as_deref(), Some("Be brief."));
            }
            _ => panic!(),
        }
        assert!(matches!(parse_answer(&json!([{"id": "R9", "summary": "z"}]), &proposed), PlanAnswer::Approved { concerns, .. } if concerns[0].id == "R9"));
    }

    #[test]
    fn plan_text_and_tbd_placeholders() {
        let c = parse_concerns(&json!([{"id": "R1.1", "summary": "No ablation", "action": "experiment", "plan": "Add ablation"}]));
        let t = plan_text(&c);
        assert!(t.contains("R1.1. No ablation (new experiment [TBD]): Add ablation"), "{t}");
        assert_eq!(tbd_items("We ran [TBD: ablation on CIFAR] and [TBD: timing]. [TBD"), ["[TBD: ablation on CIFAR]", "[TBD: timing]", "[TBD"]);
        assert!(tbd_items("no placeholders").is_empty());
    }

    /// F7: loose action words are read as whole words, with negations.
    #[test]
    fn actions_from_loose_words() {
        for (words, want) in [
            ("New experiment", Action::Experiment),
            ("run an ablation", Action::Experiment),
            ("needs new analysis", Action::Experiment),
            ("TBD", Action::Experiment),
            ("answer; no new analysis needed", Action::Answer),
            ("clarify the running example", Action::Answer),
            ("explain; we don't need to run anything", Action::Answer),
            ("rebut", Action::Answer),
            ("edit the manuscript", Action::Change),
            ("add a paragraph, without new experiments", Action::Change),
            ("Revise Sec. 3", Action::Change),
        ] {
            assert_eq!(action_of(words), want, "{words}");
        }
    }

    /// F7: one [TBD] doesn't cover several experiment concerns.
    #[test]
    fn every_experiment_needs_its_own_placeholder() {
        let c = parse_concerns(&json!([
            {"id": "R1.1", "summary": "ablation", "action": "experiment"},
            {"id": "R2.1", "summary": "runtime", "action": "experiment"},
            {"id": "R3.1", "summary": "scaling", "action": "experiment"},
        ]));
        let ex: Vec<&Concern> = c.iter().collect();
        assert_eq!(missing_tbd("We get 93.1% [TBD: ablation]. Runtime is 2s.", &ex), ["R1.1", "R2.1", "R3.1"]);
        assert_eq!(missing_tbd("[TBD: R1.1 ablation] and 2s.", &ex), ["R2.1", "R3.1"]);
        assert!(missing_tbd("[TBD: R1.1 ablation] [TBD: r2.1: timing] [TBD: scaling]", &ex).is_empty());
        assert!(missing_tbd("[TBD: a] [TBD: b] [TBD: c]", &ex).is_empty(), "unnamed placeholders count one each");
        assert!(names_concern("[TBD: r1.1: x]", "R1.1") && !names_concern("[TBD: R1.10]", "R1.1"), "ids match whole tokens");
        assert_eq!(missing_tbd("[TBD: R2.1] [TBD: R3.1]", &ex), ["R1.1"]);
        assert!(missing_tbd("no experiments", &[]).is_empty());
    }
}
