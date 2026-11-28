//! The "Fix compile errors" kind.
//!
//! - Starts from a real shadow compile (recorded as the first
//!   `compile_check` step) so the model begins from the facts.
//! - Its `compile_check` counts rounds: at most [`MAX_COMPILE_ROUNDS`].
//! - The run ends only when the last `compile_check` succeeded (after the
//!   last edit), or after 3 compile rounds with a "couldn't fully fix"
//!   report listing the remaining issues and the explanation. When the
//!   model stops early, it is nudged to check its fix ([`next_step`]).
//! - A missing package is reported for the one-click install instead of
//!   being edited around (prompt, and the cheat guard flags removed
//!   `\usepackage`s).
//! - Cheat fixes are flagged by [`super::cheat`].

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};

use super::{AgentKind, Limits, Outcome};
use crate::agents::run_loop::{LoopEnd, RunCx};
use crate::agents::tools::build;
use crate::agents::tools::registry::*;
use crate::agents::types::{cap, one_line, ChangeEntry, Phase, PhaseStatus, ProgressUpdate, Report, RunProgress, Step, StepKind};
use crate::ai::error::AiResult;
use crate::ai::llm::{Msg, Part, ToolSpec};
use crate::compile::{CompileResult, Status};
use crate::texlog::Severity;

pub struct Fixer;

const PROMPT: &str = include_str!("prompts/fixer.md");
pub const MAX_COMPILE_ROUNDS: u32 = 3;
pub const REPORT_KIND: &str = "fix";
/// Times the model is sent back to check or continue its fix.
const MAX_NUDGES: u32 = 2;
const DEFAULT_PROMPT: &str = "Fix the compile errors in this project.";

/// `compile_check` with the fixer's round limit.
struct RoundedCompile;

impl Tool for RoundedCompile {
    fn spec(&self) -> ToolSpec {
        let mut s = Builtin::CompileCheck.spec();
        s.description = format!(
            "Compile the project with your changes in a private copy. Returns the status and the first issues. You have {MAX_COMPILE_ROUNDS} rounds in total."
        );
        s
    }

    fn call<'a>(&'a self, cx: &'a ToolCx, args: &'a Value) -> BoxFut<'a, ToolOutput> {
        Box::pin(async move {
            if cx.build.rounds() >= MAX_COMPILE_ROUNDS {
                return ToolOutput::err(format!(
                    "All {MAX_COMPILE_ROUNDS} compile rounds are used. Don't edit any more: finish with your message about what is fixed and what still fails."
                ));
            }
            cx.progress(phase_update(CHECK, PhaseStatus::Active, None));
            let mut out = Builtin::CompileCheck.call(cx, args).await;
            let used = cx.build.rounds();
            match cx.build.last().filter(|_| out.ok) {
                Some(r) => {
                    for u in after_compile(used, r.status == Status::Success, errors(&r).len()) {
                        cx.progress(u);
                    }
                }
                None => cx.progress(phase_update(CHECK, PhaseStatus::Pending, None)),
            }
            if out.ok {
                out.content.push_str(&format!("\n(Compile round {used} of {MAX_COMPILE_ROUNDS}.)"));
                let ok = cx.build.last().is_some_and(|r| r.status == Status::Success);
                if used >= MAX_COMPILE_ROUNDS && !ok {
                    out.content.push_str(" That was the last round: finish now and say what is still wrong.");
                }
            }
            out
        })
    }
}

const READ: &str = "read";
const CHECK: &str = "check";
const DONE: &str = "done";

fn round_id(k: u32) -> String {
    format!("round{k}")
}

/// The fixer's phases: read the errors, up to three fix rounds, the
/// compile check, done.
pub fn phases() -> Vec<Phase> {
    let mut v = vec![Phase::new(READ, "Read the errors")];
    for k in 1..=MAX_COMPILE_ROUNDS {
        v.push(Phase::new(&round_id(k), &format!("Fix round {k} of {MAX_COMPILE_ROUNDS}")));
    }
    v.push(Phase::new(CHECK, "Compile check"));
    v.push(Phase::new(DONE, "Done"));
    v
}

fn errors_left(n: usize) -> String {
    match n {
        0 => "No errors left".into(),
        1 => "1 error left".into(),
        n => format!("{n} errors left"),
    }
}

fn phase_update(id: &str, status: PhaseStatus, detail: Option<String>) -> ProgressUpdate {
    ProgressUpdate::Phase { id: id.into(), status, detail, done: None, total: None }
}

/// Round k fixes what compile k found (compile 1 is Texo's own, before the
/// model starts). After compile `c` (1-based), round c-1 is over; when it
/// still fails, round c starts.
pub fn after_compile(c: u32, success: bool, errors: usize) -> Vec<ProgressUpdate> {
    let mut out = Vec::new();
    if c >= 2 {
        out.push(phase_update(&round_id((c - 1).min(MAX_COMPILE_ROUNDS)), PhaseStatus::Done, Some(errors_left(errors))));
    }
    if success {
        out.push(phase_update(CHECK, PhaseStatus::Done, Some("The document compiles".into())));
    } else {
        out.push(phase_update(CHECK, PhaseStatus::Pending, None));
        if (1..=MAX_COMPILE_ROUNDS).contains(&c) {
            out.push(phase_update(&round_id(c), PhaseStatus::Active, Some(errors_left(errors))));
        }
    }
    out
}

/// The phases when the run ends: a round still going is finished, rounds
/// not reached are skipped, the check says whether the fix compiles.
pub fn finish_phases(p: &mut RunProgress, fixed: bool, compiled: bool) {
    for k in 1..=MAX_COMPILE_ROUNDS {
        let id = round_id(k);
        match p.phase(&id).map(|ph| ph.status) {
            Some(PhaseStatus::Active) => p.set_phase(&id, PhaseStatus::Done, None, None, None),
            Some(PhaseStatus::Pending) => p.set_phase(&id, PhaseStatus::Skipped, None, None, None),
            _ => {}
        }
    }
    if p.phase(READ).is_some_and(|ph| !ph.status.is_settled()) {
        p.set_phase(READ, PhaseStatus::Skipped, None, None, None);
    }
    let check = if !compiled {
        (PhaseStatus::Skipped, "Texo couldn't compile here".to_string())
    } else if fixed {
        (PhaseStatus::Done, "The document compiles".to_string())
    } else {
        (PhaseStatus::Failed, "Still doesn't compile".to_string())
    };
    p.set_phase(CHECK, check.0, Some(check.1), None, None);
    p.set_phase(DONE, PhaseStatus::Done, None, None, None);
}

/// The document compiled cleanly at the start: nothing was done.
pub fn nothing_to_fix(p: &mut RunProgress) {
    p.skip_all();
}

impl AgentKind for Fixer {
    fn id(&self) -> &'static str {
        "fixer"
    }

    fn label(&self) -> &'static str {
        "Fix compile errors"
    }

    fn system_prompt(&self) -> String {
        PROMPT.to_string()
    }

    fn tool_names(&self) -> Vec<&'static str> {
        // compile_check is the round-limited one from `extra_tools`.
        [FS_READ, FS_WRITE, &[EXPLAIN_LOG, GET_BIBTEX], MEMORY].concat()
    }

    fn extra_tools(&self) -> Vec<Arc<dyn Tool>> {
        vec![Arc::new(RoundedCompile)]
    }

    fn limits(&self) -> Limits {
        Limits { max_steps: 16, ..Limits::default() }
    }

    fn check_changes(&self, changes: &mut [ChangeEntry]) {
        super::cheat::check(changes);
    }

    fn drive<'a>(&'a self, cx: &'a RunCx) -> BoxFut<'a, AiResult<Outcome>> {
        Box::pin(drive(self, cx))
    }
}

/// What the fixer knows when the model stops talking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixState {
    /// Compiling works in this run.
    pub can_compile: bool,
    pub rounds: u32,
    /// The last compile succeeded (`None`: no compile yet).
    pub last_ok: Option<bool>,
    /// Files were changed after the last compile.
    pub edited_since_compile: bool,
    /// The last compile says packages are missing.
    pub missing_packages: bool,
    /// The model finished on its own (not a step, time or loop limit).
    pub ended: bool,
    pub steps_left: u32,
    pub nudges: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// Send the model back with this message.
    Continue(String),
    Finish,
}

/// Whether the fixer is done, or the model has to check or keep fixing.
pub fn next_step(s: &FixState) -> Next {
    if !s.ended || !s.can_compile || s.steps_left == 0 || s.nudges >= MAX_NUDGES {
        return Next::Finish;
    }
    if s.rounds >= MAX_COMPILE_ROUNDS {
        return Next::Finish;
    }
    if s.edited_since_compile {
        return Next::Continue("You changed files after the last compile_check. Call compile_check now to confirm that the document compiles.".into());
    }
    match s.last_ok {
        Some(true) => Next::Finish,
        None => Next::Continue("Call compile_check to see whether the document compiles.".into()),
        Some(false) if s.missing_packages => Next::Finish,
        Some(false) => Next::Continue(
            "The last compile_check still failed. Keep fixing the remaining errors, then call compile_check again. If an error can't be fixed by editing, finish and explain why."
                .into(),
        ),
    }
}

fn compile_step(text: &str, ok: bool, ms: u64) -> Step {
    Step {
        n: 0,
        kind: StepKind::ToolCall,
        tool: Some(COMPILE_CHECK.into()),
        args: Some(json!({})),
        result_summary: one_line(text, 160),
        result: Some(cap(text, 2000)),
        text: None,
        ok,
        ms,
        at: 0,
        sub: None,
        notice: false,
        data: None,
    }
}

/// Files were changed after the last successful `compile_check` step.
fn edited_since_compile(steps: &[Step]) -> bool {
    let is_write = |s: &Step| s.ok && s.tool.as_deref().is_some_and(|t| FS_WRITE.contains(&t));
    let last_write = steps.iter().rposition(is_write);
    let last_compile = steps.iter().rposition(|s| s.ok && s.tool.as_deref() == Some(COMPILE_CHECK));
    match (last_write, last_compile) {
        (Some(w), Some(c)) => w > c,
        (Some(_), None) => true,
        _ => false,
    }
}

fn errors(r: &CompileResult) -> Vec<&crate::texlog::Issue> {
    r.issues.iter().filter(|i| i.severity == Severity::Error).collect()
}

fn issue_text(i: &crate::texlog::Issue) -> String {
    let at = match (&i.file, i.line) {
        (Some(f), Some(l)) => format!("{}:{l} ", f.trim_start_matches("./")),
        (Some(f), None) => format!("{} ", f.trim_start_matches("./")),
        _ => String::new(),
    };
    format!("{at}{}", one_line(&i.message, 200))
}

/// The fixer's report (kind `fix`) and, when not everything is fixed, the
/// plain-words summary for the run's message and error.
pub fn fix_report(last: Option<&CompileResult>, rounds: u32, can_compile: bool) -> (Report, Option<String>) {
    let fixed = last.is_some_and(|r| r.status == Status::Success);
    let missing = last.map(build::missing_packages).unwrap_or_default();
    let remaining: Vec<Value> = last
        .map(|r| {
            errors(r)
                .into_iter()
                .take(10)
                .map(|i| json!({"file": i.file.as_deref().map(|f| f.trim_start_matches("./")), "line": i.line, "message": one_line(&i.message, 300)}))
                .collect()
        })
        .unwrap_or_default();
    let explanation = match last {
        Some(r) if !fixed => build::explain_text(Some(r), None).ok(),
        _ => None,
    };
    let summary = if !can_compile {
        Some("Texo couldn't compile the project here, so the fix isn't checked. Compile it yourself after reviewing the changes.".to_string())
    } else if fixed {
        None
    } else {
        let mut s = if !missing.is_empty() {
            format!(
                "The document needs {} that {} not installed: {}. Install {} with one click, then compile again.",
                if missing.len() == 1 { "a package" } else { "packages" },
                if missing.len() == 1 { "is" } else { "are" },
                missing.join(", "),
                if missing.len() == 1 { "it" } else { "them" },
            )
        } else {
            format!("Texo couldn't fully fix the document after {rounds} compile round(s).")
        };
        let errs: Vec<String> = last.map(|r| errors(r).into_iter().take(5).map(issue_text).collect()).unwrap_or_default();
        if !errs.is_empty() {
            s.push_str("\nStill wrong:\n");
            for e in &errs {
                s.push_str(&format!("- {e}\n"));
            }
        }
        if let Some(e) = &explanation {
            s.push_str(&format!("\nWhat the first error means:\n{}", e.trim()));
        }
        Some(s.trim_end().to_string())
    };
    let mut data = serde_json::Map::new();
    data.insert("fixed".into(), json!(fixed));
    data.insert("compiled".into(), json!(can_compile && last.is_some()));
    data.insert("rounds".into(), json!(rounds));
    data.insert("remaining".into(), Value::Array(remaining));
    data.insert("missingPackages".into(), json!(missing));
    data.insert("explanation".into(), json!(explanation));
    data.insert("summary".into(), json!(summary.clone().unwrap_or_else(|| "The document compiles.".into())));
    (Report { kind: REPORT_KIND.into(), data }, summary)
}

async fn drive(kind: &Fixer, cx: &RunCx) -> AiResult<Outcome> {
    let mut spec = cx.default_spec(kind);
    let mut can_compile = cx.env.build.is_some() && spec.tools.iter().any(|t| t.spec().name == COMPILE_CHECK);
    if let Some(Msg::User { content }) = spec.messages.first_mut() {
        if let Some(Part::Text { text }) = content.first_mut() {
            if text.trim().is_empty() {
                *text = DEFAULT_PROMPT.into();
            }
        }
    }

    let sh = &cx.shared;
    sh.set_phases(phases());
    sh.set_phase(READ, PhaseStatus::Active, None, None, None);

    // The first compile, so the model starts from the facts.
    if can_compile {
        let started = Instant::now();
        let tcx = &cx.tool_cx;
        let first = build::compile_check(tcx.build.clone(), tcx.root.clone(), tcx.overlay.clone(), cx.cancel()).await;
        cx.cancel().check()?;
        let (text, ok) = match first {
            Ok(t) => (format!("{t}\n(Compile round 1 of {MAX_COMPILE_ROUNDS}.)"), true),
            Err(e) => (format!("Error: {e}"), false),
        };
        // Compiling doesn't work here (no main document …): don't insist on it.
        can_compile = ok;
        cx.shared.record(compile_step(&text, ok, started.elapsed().as_millis() as u64), false);
        cx.shared.update(|run| run.usage.tool_calls += 1);
        let last = tcx.build.last();
        if let Some(r) = &last {
            let clean = r.status == Status::Success && r.issues.iter().all(|i| i.severity == Severity::Badbox);
            if clean {
                let (report, _) = fix_report(Some(r), tcx.build.rounds(), true);
                let message = "The document already compiles without errors or warnings. There was nothing to fix.".to_string();
                sh.update(|run| nothing_to_fix(&mut run.progress));
                cx.message(&message);
                return Ok(Outcome { message: Some(message), report: Some(report), stopped: None });
            }
            let n = errors(r).len();
            sh.update(|run| {
                let p = &mut run.progress;
                let read = match n {
                    1 => "1 error".to_string(),
                    n => format!("{n} errors"),
                };
                p.set_phase(READ, PhaseStatus::Done, Some(read), None, None);
                p.set_phase(&round_id(1), PhaseStatus::Active, Some(errors_left(n)), None, None);
            });
        }
        if let Some(Msg::User { content }) = spec.messages.first_mut() {
            content.push(Part::Text { text: format!("Result of the first compile_check:\n{text}") });
        }
    }
    if !sh.snapshot().progress.phase(READ).is_some_and(|p| p.status.is_settled()) {
        // No compile to start from: the model reads the errors itself.
        sh.update(|run| {
            let p = &mut run.progress;
            p.set_phase(READ, PhaseStatus::Done, Some("Texo couldn't compile here".into()), None, None);
            p.set_phase(&round_id(1), PhaseStatus::Active, None, None, None);
        });
    }

    let budget = spec.max_steps;
    let mut used = 0u32;
    let mut nudges = 0u32;
    let mut texts: Vec<String> = Vec::new();
    let end = loop {
        let out = cx.run_loop(spec.clone()).await?;
        used += out.steps;
        if !out.text.trim().is_empty() {
            texts.push(out.text.trim().to_string());
        }
        let build = &cx.tool_cx.build;
        let last = build.last();
        let state = FixState {
            can_compile,
            rounds: build.rounds(),
            last_ok: last.as_ref().map(|r| r.status == Status::Success),
            edited_since_compile: edited_since_compile(&cx.shared.snapshot().steps),
            missing_packages: last.as_ref().is_some_and(|r| !build::missing_packages(r).is_empty()),
            ended: out.end == LoopEnd::Finished,
            steps_left: budget.saturating_sub(used),
            nudges,
        };
        match next_step(&state) {
            Next::Finish => break out,
            Next::Continue(msg) => {
                nudges += 1;
                spec.messages = out.messages;
                spec.messages.push(Msg::user(msg));
                spec.max_steps = budget.saturating_sub(used).max(1);
            }
        }
    };

    let build = &cx.tool_cx.build;
    let (report, summary) = fix_report(build.last().as_ref(), build.rounds(), can_compile);
    let fixed = build.last().is_some_and(|r| r.status == Status::Success);
    sh.update(|run| finish_phases(&mut run.progress, fixed, can_compile));
    let mut message = texts.last().cloned().unwrap_or_default();
    let mut stopped = match end.end {
        LoopEnd::Finished | LoopEnd::Report => None,
        _ => Some(end.end_message()),
    };
    if let Some(s) = summary {
        // Without a compiler in this run (tests), say nothing extra.
        if can_compile || cx.env.build.is_some() {
            if !message.is_empty() {
                message.push_str("\n\n");
            }
            message.push_str(&s);
            cx.message(&s);
        }
        if can_compile {
            stopped = Some(match stopped {
                Some(st) => format!("{st} {}", one_line(&s, 200)),
                None => one_line(&s, 200),
            });
        }
    }
    Ok(Outcome { message: (!message.trim().is_empty()).then_some(message), report: Some(report), stopped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> FixState {
        FixState {
            can_compile: true,
            rounds: 1,
            last_ok: Some(false),
            edited_since_compile: true,
            missing_packages: false,
            ended: true,
            steps_left: 10,
            nudges: 0,
        }
    }

    #[test]
    fn the_fixer_checks_its_fix_before_it_ends() {
        // Edited since the last compile: check first.
        assert!(matches!(next_step(&state()), Next::Continue(m) if m.contains("compile_check now")));
        // Compiled after the edit and it works: done.
        let ok = FixState { edited_since_compile: false, last_ok: Some(true), ..state() };
        assert_eq!(next_step(&ok), Next::Finish);
        // Still failing: keep fixing, until 3 rounds are used.
        let failing = FixState { edited_since_compile: false, ..state() };
        assert!(matches!(next_step(&failing), Next::Continue(m) if m.contains("still failed")));
        assert_eq!(next_step(&FixState { rounds: 3, ..failing }), Next::Finish);
        assert_eq!(next_step(&FixState { rounds: 3, ..state() }), Next::Finish, "no 4th round even after an edit");
        // A missing package: stop and offer the install.
        assert_eq!(next_step(&FixState { missing_packages: true, ..failing }), Next::Finish);
        // Never compiled: compile.
        let never = FixState { rounds: 0, last_ok: None, edited_since_compile: false, ..state() };
        assert!(matches!(next_step(&never), Next::Continue(_)));
        // Limits, cancel-like ends, no compiler, too many nudges: finish.
        assert_eq!(next_step(&FixState { ended: false, ..state() }), Next::Finish);
        assert_eq!(next_step(&FixState { steps_left: 0, ..state() }), Next::Finish);
        assert_eq!(next_step(&FixState { can_compile: false, ..state() }), Next::Finish);
        assert_eq!(next_step(&FixState { nudges: MAX_NUDGES, ..state() }), Next::Finish);
    }

    fn step(tool: &str, ok: bool) -> Step {
        let mut s = compile_step("x", ok, 0);
        s.tool = Some(tool.into());
        s
    }

    #[test]
    fn edits_after_the_last_compile_are_noticed() {
        assert!(!edited_since_compile(&[]));
        assert!(edited_since_compile(&[step("edit_file", true)]));
        assert!(!edited_since_compile(&[step("edit_file", true), step("compile_check", true)]));
        assert!(edited_since_compile(&[step("compile_check", true), step("write_file", true)]));
        assert!(!edited_since_compile(&[step("compile_check", true), step("edit_file", false), step("read_file", true)]));
    }

    fn result(status: Status, issues: Vec<crate::texlog::Issue>, hints: Vec<String>) -> CompileResult {
        CompileResult {
            status,
            compiler: None,
            engine: Default::default(),
            pdf_path: None,
            duration_ms: 0,
            issues,
            hints,
            log: String::new(),
            output: String::new(),
            rc_ignored: false,
            saved_pdf: None,
        }
    }

    fn error(file: &str, line: u32, message: &str) -> crate::texlog::Issue {
        crate::texlog::Issue {
            severity: Severity::Error,
            message: message.into(),
            file: Some(format!("./{file}")),
            line: Some(line),
            context: None,
            citation: None,
            explanation: Some("A brace is missing.".into()),
            fatal: true,
            consequence: false,
            missing_file: None,
        }
    }

    #[test]
    fn the_report_says_what_is_still_wrong() {
        let ok = result(Status::Success, vec![], vec![]);
        let (r, summary) = fix_report(Some(&ok), 2, true);
        assert_eq!(r.kind, "fix");
        assert_eq!(r.data["fixed"], true);
        assert_eq!(r.data["rounds"], 2);
        assert!(summary.is_none());

        let bad = result(Status::Failed, vec![error("main.tex", 12, "Missing } inserted.")], vec![]);
        let (r, summary) = fix_report(Some(&bad), 3, true);
        assert_eq!(r.data["fixed"], false);
        assert_eq!(r.data["remaining"][0]["file"], "main.tex");
        assert_eq!(r.data["remaining"][0]["line"], 12);
        let s = summary.unwrap();
        assert!(s.contains("couldn't fully fix") && s.contains("after 3 compile round(s)"), "{s}");
        assert!(s.contains("main.tex:12 Missing } inserted.") && s.contains("A brace is missing."), "{s}");

        let mut pkg = error("main.tex", 2, "File `foo.sty' not found.");
        pkg.missing_file = Some("foo.sty".into());
        let (r, summary) = fix_report(Some(&result(Status::Failed, vec![pkg], vec![])), 1, true);
        assert_eq!(r.data["missingPackages"], json!(["foo"]));
        assert!(summary.unwrap().contains("Install it with one click"));

        let (r, summary) = fix_report(None, 0, false);
        assert_eq!(r.data["compiled"], false);
        assert!(summary.unwrap().contains("isn't checked"));
    }
}
