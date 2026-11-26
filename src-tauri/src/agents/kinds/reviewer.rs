//! The "Review the paper" kind: a reviewer ensemble.
//!
//! 1. The deterministic checklist (`agents/review`), without the AI, when
//!    the setup asks for it.
//! 2. N persona sub-runs in parallel, each with the venue rubric, its point
//!    of view and the checklist. Each ends with `submit_report` and must
//!    cite `file:line` for every weakness; reviews with missing or wrong
//!    locations get one more turn to fix them.
//! 3. Optional novelty grounding: with `groundNovelty` the reviewers get
//!    the literature tools (`search_papers` …) and list what they found.
//! 4. An area-chair meta-review merges them (consensus, disagreements,
//!    decision, must-fix); the score spread is computed by Texo.
//!
//! The result is a review [`Report`] (`ReviewReport`, kind `review`). It
//! writes `review.md` / `review.tex` only when the run asks for it
//! (`options.extra.export`: `"md"`, `"tex"` or both), through the changeset
//! like any other file.
//!
//! Reviewers don't get `compile_check` (parallel sub-runs would share one
//! shadow folder); the checklist carries the compile facts.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{json, Value};

use super::{json_in_text, AgentKind, Limits, ModelRole, Outcome};
use crate::agents::review::{checklist, venues, CheckStatus, MetaReview, Review, ReviewReport, ReviewSetup, WeaknessSeverity};
use crate::agents::run_loop::{LoopEnd, LoopOutcome, LoopSpec, RunCx};
use crate::agents::tools::registry::*;
use crate::ai::error::{AiError, AiResult, Kind};
use crate::ai::llm::{Msg, Part};

pub struct Reviewer;

const PROMPT: &str = include_str!("prompts/reviewer.md");
const META_PROMPT: &str = include_str!("prompts/reviewer_meta.md");
const META_STEPS: u32 = 3;
const FIX_STEPS: u32 = 6;
pub const AREA_CHAIR: &str = "Area chair";
pub const MD_FILE: &str = "review.md";
pub const TEX_FILE: &str = "review.tex";

impl AgentKind for Reviewer {
    fn id(&self) -> &'static str {
        "reviewer"
    }

    fn label(&self) -> &'static str {
        "Review the paper"
    }

    fn system_prompt(&self) -> String {
        PROMPT.to_string()
    }

    fn tool_names(&self) -> Vec<&'static str> {
        [FS_READ, &[COMPILE_CHECK], LITERATURE, &[FETCH_URL, READ_MEMORY], REPORT].concat()
    }

    fn limits(&self) -> Limits {
        Limits { max_steps: 40, ..Limits::default() }
    }

    fn role(&self) -> ModelRole {
        ModelRole::Review
    }

    fn drive<'a>(&'a self, cx: &'a RunCx) -> BoxFut<'a, AiResult<Outcome>> {
        Box::pin(drive(self, cx))
    }
}

/// Which files to write: `options.extra.export` as `"md"`, `"tex"`,
/// `"both"` or a list of them.
pub fn export_formats(extra: Option<&Value>) -> Vec<&'static str> {
    let Some(v) = extra.and_then(|e| e.get("export")) else { return Vec::new() };
    let items: Vec<String> = match v {
        Value::String(s) => vec![s.to_lowercase()],
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_lowercase)).collect(),
        Value::Bool(true) => vec!["md".into()],
        _ => Vec::new(),
    };
    let has = |words: &[&str]| items.iter().any(|i| words.contains(&i.trim()));
    let mut out = Vec::new();
    if has(&["md", "markdown", "both"]) {
        out.push("md");
    }
    if has(&["tex", "latex", "both"]) {
        out.push("tex");
    }
    out
}

/// The tools a persona gets.
fn persona_tools(cx: &RunCx, setup: &ReviewSetup) -> Vec<Arc<dyn Tool>> {
    let mut names: Vec<&str> = [FS_READ, &[READ_MEMORY]].concat();
    if setup.ground_novelty {
        names.extend_from_slice(LITERATURE);
        names.push(FETCH_URL);
    }
    let mut names = super::narrowed(cx, names);
    names.push(SUBMIT_REPORT);
    tools_by_name(&names, cx.env.net.as_ref())
}

fn persona_system(setup: &ReviewSetup, persona: &crate::agents::review::Persona, checks: &str, extra: &str) -> String {
    let mut s = PROMPT.to_string();
    s.push_str(&format!("\n\nYour point of view: {}.", persona.name));
    if !persona.focus.trim().is_empty() {
        s.push_str(&format!(" {}", persona.focus.trim()));
    }
    s.push_str("\n\n");
    s.push_str(&setup.rubric_prompt());
    if setup.ground_novelty {
        s.push_str("Check whether the main idea is new with search_papers, and list the closest papers in \"references\".\n");
    } else {
        s.push_str("Don't search the literature; judge novelty from the paper and what you know.\n");
    }
    if !checks.is_empty() {
        s.push('\n');
        s.push_str(checks);
    }
    s.push_str(extra);
    s
}

/// Weaknesses whose `file:line` is missing or doesn't exist in the project.
fn bad_locations(cx: &RunCx, review: &mut Review) -> Vec<String> {
    let mut bad = Vec::new();
    let overlay = cx.tool_cx.overlay();
    for w in &mut review.weaknesses {
        if let Some(f) = &w.file {
            let clean = f.trim().trim_start_matches("./").replace('\\', "/");
            w.file = Some(clean);
        }
        let ok = match (&w.file, w.line) {
            (Some(f), Some(l)) => match overlay.peek(f) {
                Ok(Some(text)) => (l as usize) <= text.lines().count().max(1),
                _ => false,
            },
            _ => false,
        };
        if !ok {
            let at = match (&w.file, w.line) {
                (Some(f), Some(l)) => format!(" (given as {f}:{l}, which doesn't exist)"),
                (Some(f), None) => format!(" (given as {f}, without a line)"),
                _ => " (no file and line)".into(),
            };
            bad.push(format!("- {}{at}", crate::agents::types::one_line(&w.text, 120)));
        }
    }
    bad
}

/// The review a persona's loop produced, from `submit_report` or JSON in
/// its last text.
fn review_of(out: &LoopOutcome) -> Option<ReviewReport> {
    let rr = match &out.report {
        Some(r) => ReviewReport::from_report(r),
        None => ReviewReport::from_value(&json_in_text(&out.text)?),
    };
    (!rr.reviews.is_empty()).then_some(rr)
}

fn meta_of(out: &LoopOutcome) -> Option<MetaReview> {
    let data = match &out.report {
        Some(r) => Value::Object(r.data.clone()),
        None => json_in_text(&out.text)?,
    };
    let meta = data.get("meta").filter(|m| m.is_object()).cloned().unwrap_or(data);
    let m = ReviewReport::from_value(&json!({ "meta": meta })).meta;
    (!m.summary.is_empty() || !m.decision.is_empty() || !m.must_fix.is_empty()).then_some(m)
}

fn located(w: &crate::agents::review::Weakness) -> String {
    match (&w.file, w.line) {
        (Some(f), Some(l)) => format!("{} ({f}:{l})", w.text),
        (Some(f), None) => format!("{} ({f})", w.text),
        _ => w.text.clone(),
    }
}

/// A meta-review Texo puts together when the area chair step fails.
pub fn fallback_meta(reviews: &[Review]) -> MetaReview {
    let mut must = Vec::new();
    let mut nice = Vec::new();
    for r in reviews {
        for w in &r.weaknesses {
            let t = located(w);
            let list = if w.severity == WeaknessSeverity::Major { &mut must } else { &mut nice };
            if !list.contains(&t) && list.len() < 12 {
                list.push(t);
            }
        }
    }
    MetaReview {
        summary: "The area chair step didn't finish, so Texo listed the reviewers' points instead.".into(),
        must_fix: must,
        nice_to_fix: nice,
        ..Default::default()
    }
}

fn merge_references(reports: &[ReviewReport]) -> Vec<crate::agents::review::ReportReference> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for r in reports {
        for x in &r.references {
            let key = x
                .doi
                .clone()
                .or(x.arxiv_id.clone())
                .unwrap_or_else(|| x.title.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" "));
            if seen.insert(key.to_lowercase()) {
                out.push(x.clone());
            }
        }
    }
    out
}

async fn drive(_kind: &Reviewer, cx: &RunCx) -> AiResult<Outcome> {
    let setup = ReviewSetup::from_extra(cx.options().extra.as_ref()).unwrap_or_default().normalized();

    // 1. The checklist (no AI).
    let checks = if setup.checklist {
        let (root, s) = (cx.tool_cx.root.clone(), setup.clone());
        let checks = tokio::task::spawn_blocking(move || checklist::run(&root, &s)).await.unwrap_or_default();
        let fails = checks.iter().filter(|c| c.status == CheckStatus::Fail).count();
        let warns = checks.iter().filter(|c| c.status == CheckStatus::Warn).count();
        cx.message(&format!("Automatic checks: {fails} problem(s), {warns} warning(s) in {} checks.", checks.len()));
        checks
    } else {
        Vec::new()
    };
    let checks_text = if checks.is_empty() { String::new() } else { checklist::prompt_text(&checks) };
    cx.cancel().check()?;

    // 2. The reviewers, in parallel.
    let tools = persona_tools(cx, &setup);
    let max_steps = cx.options().max_steps.unwrap_or(cx.limits.max_steps).clamp(1, 200);
    let specs: Vec<LoopSpec> = setup
        .personas
        .iter()
        .map(|p| {
            let mut content = cx.user_parts.clone();
            content.push(Part::Text { text: format!("Review the paper as the {} reviewer.", p.name) });
            LoopSpec {
                system: persona_system(&setup, p, &checks_text, &cx.system_extra),
                messages: vec![Msg::User { content }],
                tools: tools.clone(),
                max_steps,
                loop_guard: cx.limits.loop_guard.max(2),
                sub: Some(p.name.clone()),
                model: None,
                fallback_models: None,
                thinking: None,
                stream: false,
            }
        })
        .collect();
    let outs = cx.sub_runs(specs.clone()).await;
    cx.cancel().check()?;

    let mut notes: Vec<String> = Vec::new();
    let mut got: Vec<Option<(ReviewReport, LoopOutcome)>> = Vec::new();
    for (p, out) in setup.personas.iter().zip(outs) {
        match out {
            Err(e) if e.kind == Kind::Cancelled => return Err(e),
            Err(e) => {
                notes.push(format!("The {} reviewer didn't finish: {}", p.name, e.message));
                got.push(None);
            }
            Ok(o) => match review_of(&o) {
                Some(r) => got.push(Some((r, o))),
                None => {
                    let why = if o.end == LoopEnd::Finished || o.end == LoopEnd::Report { "it didn't hand in a review".to_string() } else { o.end_message() };
                    notes.push(format!("The {} reviewer didn't finish: {why}", p.name));
                    got.push(None);
                }
            },
        }
    }

    // Every weakness needs a real file:line: one more turn for those without.
    let mut fixes: Vec<(usize, LoopSpec)> = Vec::new();
    for (i, slot) in got.iter_mut().enumerate() {
        let Some((rr, out)) = slot else { continue };
        let bad = bad_locations(cx, &mut rr.reviews[0]);
        // A review handed in as JSON text (`Finished`) gets the turn too:
        // the conversation goes on and the model is asked for submit_report.
        if bad.is_empty() || !matches!(out.end, LoopEnd::Report | LoopEnd::Finished) {
            continue;
        }
        let mut spec = specs[i].clone();
        spec.messages = out.messages.clone();
        spec.messages.push(Msg::user(format!(
            "These weaknesses have no valid file and line:\n{}\nRead the files if needed, then call submit_report with your complete review. Every weakness needs \"file\" (a project path) and \"line\" (a line number from read_file).",
            bad.join("\n")
        )));
        spec.max_steps = FIX_STEPS;
        fixes.push((i, spec));
    }
    if !fixes.is_empty() {
        let (idx, fix_specs): (Vec<usize>, Vec<LoopSpec>) = fixes.into_iter().unzip();
        for (i, out) in idx.into_iter().zip(cx.sub_runs(fix_specs).await) {
            match out {
                Err(e) if e.kind == Kind::Cancelled => return Err(e),
                Ok(o) => {
                    if let Some(mut better) = review_of(&o) {
                        let left = bad_locations(cx, &mut better.reviews[0]).len();
                        let before = got[i].as_mut().map(|(r, _)| bad_locations(cx, &mut r.reviews[0]).len()).unwrap_or(usize::MAX);
                        if left <= before {
                            got[i] = Some((better, o));
                        }
                    }
                }
                Err(_) => {}
            }
        }
    }

    let mut reports: Vec<ReviewReport> = Vec::new();
    let mut reviews: Vec<Review> = Vec::new();
    for (p, slot) in setup.personas.iter().zip(got) {
        if let Some((mut rr, _)) = slot {
            let mut r = rr.reviews.remove(0);
            r.persona = p.name.clone();
            if !bad_locations(cx, &mut r).is_empty() {
                notes.push(format!("Some of the {} reviewer's points have no file and line.", p.name));
            }
            reviews.push(r);
            reports.push(rr);
        }
    }
    if reviews.is_empty() {
        return Err(AiError::new(
            Kind::Other,
            format!("None of the reviewers finished. {}", notes.first().cloned().unwrap_or_default()).trim().to_string(),
        ));
    }

    // 3. The area chair.
    let preset = setup.preset();
    let mut ask = format!("Venue: {}.\n", preset.name);
    if !setup.rubric.decisions.is_empty() {
        ask.push_str(&format!("Decisions to choose from: {}.\n", setup.rubric.decisions.join(", ")));
    }
    if !checks_text.is_empty() {
        ask.push_str(&format!("\n{checks_text}"));
    }
    let reviews_json = serde_json::to_string_pretty(&reviews).unwrap_or_default();
    ask.push_str(&format!("\nThe reviews (JSON):\n{}", crate::agents::types::cap(&reviews_json, 60_000)));
    let meta_spec = LoopSpec {
        system: format!("{META_PROMPT}{}", cx.system_extra),
        messages: vec![Msg::user(ask)],
        tools: tools_by_name(&[SUBMIT_REPORT], None),
        max_steps: META_STEPS,
        loop_guard: 2,
        sub: Some(AREA_CHAIR.into()),
        model: None,
        fallback_models: None,
        thinking: None,
        stream: false,
    };
    let meta = match cx.sub_runs(vec![meta_spec]).await.pop() {
        Some(Err(e)) if e.kind == Kind::Cancelled => return Err(e),
        Some(Ok(o)) => meta_of(&o),
        _ => None,
    };
    let meta = meta.unwrap_or_else(|| {
        notes.push("The area chair step didn't finish; the summary was put together by Texo.".into());
        fallback_meta(&reviews)
    });

    // 4. The report.
    let mut report = ReviewReport {
        venue: setup.venue.clone(),
        checklist: checks,
        reviews,
        meta,
        references: merge_references(&reports),
        ..Default::default()
    };
    report.conform(&setup.rubric);
    let mut out = report.to_report();
    if !notes.is_empty() {
        out.data.insert("notes".into(), json!(notes));
    }

    let exports = export_formats(cx.options().extra.as_ref());
    if !exports.is_empty() {
        let mut o = cx.tool_cx.overlay();
        for f in exports {
            let (path, text) =
                if f == "md" { (MD_FILE, render_markdown(&report)) } else { (TEX_FILE, render_tex(&report)) };
            if let Err(e) = o.write(path, &text, "The review report") {
                notes.push(format!("{path} couldn't be written: {e}"));
            }
        }
        drop(o);
        cx.shared.update(|run| cx.shared.sync_changes(run));
    }

    let mut message = String::new();
    if !report.meta.decision.is_empty() {
        message.push_str(&format!("Recommendation: {}.\n\n", report.meta.decision));
    }
    message.push_str(&report.meta.summary);
    for n in &notes {
        message.push_str(&format!("\n\n{n}"));
    }
    Ok(Outcome { message: Some(message.trim().to_string()), report: Some(out), stopped: None })
}

// ------------------------------------------------------------- export --

fn status_word(s: CheckStatus) -> &'static str {
    match s {
        CheckStatus::Pass => "ok",
        CheckStatus::Warn => "warning",
        CheckStatus::Fail => "problem",
    }
}

fn scale_name(setup_venue: &str, id: &str) -> String {
    venues::preset_or_generic(setup_venue)
        .rubric
        .scores
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| id.to_string())
}

/// The review as Markdown (`review.md`).
pub fn render_markdown(r: &ReviewReport) -> String {
    let venue = venues::preset_or_generic(&r.venue).name;
    let mut s = format!("# Review: {venue}\n\n_Written by Texo's reviewer agent with {} reviewer(s)._\n\n", r.reviews.len());
    s.push_str("## Area chair\n\n");
    if !r.meta.decision.is_empty() {
        s.push_str(&format!("**Recommendation:** {}\n\n", r.meta.decision));
    }
    if !r.meta.summary.is_empty() {
        s.push_str(&format!("{}\n\n", r.meta.summary));
    }
    for (title, items) in [
        ("Must fix", &r.meta.must_fix),
        ("Nice to fix", &r.meta.nice_to_fix),
        ("Reviewers agree", &r.meta.consensus),
        ("Reviewers disagree", &r.meta.disagreements),
    ] {
        if !items.is_empty() {
            s.push_str(&format!("### {title}\n\n"));
            for i in items {
                s.push_str(&format!("- {i}\n"));
            }
            s.push('\n');
        }
    }
    if !r.meta.score_spread.is_empty() {
        s.push_str("### Scores\n\n| Score | Lowest | Mean | Highest |\n|---|---|---|---|\n");
        for (k, v) in &r.meta.score_spread {
            s.push_str(&format!("| {} | {} | {} | {} |\n", scale_name(&r.venue, k), v.min, v.mean, v.max));
        }
        s.push('\n');
    }
    if !r.checklist.is_empty() {
        s.push_str("## Automatic checks\n\n");
        for c in &r.checklist {
            s.push_str(&format!("- [{}] {}", status_word(c.status), c.title));
            if c.status != CheckStatus::Pass && !c.details.is_empty() {
                s.push_str(&format!(": {}", c.details.iter().take(5).cloned().collect::<Vec<_>>().join("; ")));
            }
            s.push('\n');
        }
        s.push('\n');
    }
    for (n, rev) in r.reviews.iter().enumerate() {
        s.push_str(&format!("## Reviewer {}: {}\n\n", n + 1, rev.persona));
        if !rev.summary.is_empty() {
            s.push_str(&format!("{}\n\n", rev.summary));
        }
        if !rev.strengths.is_empty() {
            s.push_str("**Strengths**\n\n");
            for x in &rev.strengths {
                s.push_str(&format!("- {x}\n"));
            }
            s.push('\n');
        }
        if !rev.weaknesses.is_empty() {
            s.push_str("**Weaknesses**\n\n");
            for w in &rev.weaknesses {
                let sev = if w.severity == WeaknessSeverity::Major { "major" } else { "minor" };
                let at = match (&w.file, w.line) {
                    (Some(f), Some(l)) => format!(" (`{f}:{l}`)"),
                    (Some(f), None) => format!(" (`{f}`)"),
                    _ => String::new(),
                };
                s.push_str(&format!("- [{sev}] {}{at}\n", w.text));
            }
            s.push('\n');
        }
        if !rev.questions.is_empty() {
            s.push_str("**Questions**\n\n");
            for q in &rev.questions {
                s.push_str(&format!("- {q}\n"));
            }
            s.push('\n');
        }
        if !rev.scores.is_empty() || rev.confidence.is_some() {
            let mut parts: Vec<String> = rev.scores.iter().map(|(k, v)| format!("{}: {v}", scale_name(&r.venue, k))).collect();
            if let Some(c) = rev.confidence {
                parts.push(format!("Confidence: {c}"));
            }
            s.push_str(&format!("**Scores:** {}\n\n", parts.join(", ")));
        }
    }
    if !r.references.is_empty() {
        s.push_str("## Related papers\n\n");
        for x in &r.references {
            let mut line = x.title.clone();
            if let Some(y) = x.year {
                line.push_str(&format!(" ({y})"));
            }
            if let Some(d) = &x.doi {
                line.push_str(&format!(", doi:{d}"));
            } else if let Some(a) = &x.arxiv_id {
                line.push_str(&format!(", arXiv:{a}"));
            }
            if let Some(n) = &x.note {
                line.push_str(&format!(": {n}"));
            }
            s.push_str(&format!("- {line}\n"));
        }
    }
    s.trim_end().to_string() + "\n"
}

/// Text made safe for LaTeX.
pub fn tex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '{' | '}' | '$' | '&' | '%' | '#' | '_' => {
                out.push('\\');
                out.push(c);
            }
            '^' => out.push_str("\\textasciicircum{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '<' => out.push_str("\\textless{}"),
            '>' => out.push_str("\\textgreater{}"),
            _ => out.push(c),
        }
    }
    out
}

fn tex_list(s: &mut String, items: &[String]) {
    if items.is_empty() {
        return;
    }
    s.push_str("\\begin{itemize}\n");
    for i in items {
        s.push_str(&format!("  \\item {}\n", tex_escape(i)));
    }
    s.push_str("\\end{itemize}\n");
}

/// The review as a LaTeX document (`review.tex`).
pub fn render_tex(r: &ReviewReport) -> String {
    let venue = venues::preset_or_generic(&r.venue).name;
    let mut s = String::from("\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\begin{document}\n");
    s.push_str(&format!("\\section*{{Review: {}}}\n", tex_escape(&venue)));
    s.push_str("\\subsection*{Area chair}\n");
    if !r.meta.decision.is_empty() {
        s.push_str(&format!("\\textbf{{Recommendation:}} {}\n\n", tex_escape(&r.meta.decision)));
    }
    if !r.meta.summary.is_empty() {
        s.push_str(&format!("{}\n\n", tex_escape(&r.meta.summary)));
    }
    for (title, items) in [("Must fix", &r.meta.must_fix), ("Nice to fix", &r.meta.nice_to_fix)] {
        if !items.is_empty() {
            s.push_str(&format!("\\paragraph{{{title}}}\n"));
            tex_list(&mut s, items);
        }
    }
    for (n, rev) in r.reviews.iter().enumerate() {
        s.push_str(&format!("\\subsection*{{Reviewer {}: {}}}\n", n + 1, tex_escape(&rev.persona)));
        if !rev.summary.is_empty() {
            s.push_str(&format!("{}\n\n", tex_escape(&rev.summary)));
        }
        if !rev.strengths.is_empty() {
            s.push_str("\\paragraph{Strengths}\n");
            tex_list(&mut s, &rev.strengths);
        }
        if !rev.weaknesses.is_empty() {
            s.push_str("\\paragraph{Weaknesses}\n");
            let items: Vec<String> = rev
                .weaknesses
                .iter()
                .map(|w| {
                    let sev = if w.severity == WeaknessSeverity::Major { "Major" } else { "Minor" };
                    format!("{sev}: {}", located(w))
                })
                .collect();
            tex_list(&mut s, &items);
        }
        if !rev.questions.is_empty() {
            s.push_str("\\paragraph{Questions}\n");
            tex_list(&mut s, &rev.questions);
        }
        if !rev.scores.is_empty() {
            let parts: Vec<String> = rev.scores.iter().map(|(k, v)| format!("{}: {v}", scale_name(&r.venue, k))).collect();
            s.push_str(&format!("\\paragraph{{Scores}} {}\n", tex_escape(&parts.join(", "))));
        }
    }
    s.push_str("\\end{document}\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::review::{Persona, Weakness};

    #[test]
    fn export_formats_are_read_leniently() {
        assert!(export_formats(None).is_empty());
        assert!(export_formats(Some(&json!({"review": {}}))).is_empty());
        assert_eq!(export_formats(Some(&json!({"export": "Markdown"}))), ["md"]);
        assert_eq!(export_formats(Some(&json!({"export": ["tex", "md", "tex"]}))), ["md", "tex"]);
        assert_eq!(export_formats(Some(&json!({"export": "both"}))), ["md", "tex"]);
    }

    fn sample() -> ReviewReport {
        let mut r = ReviewReport {
            reviews: vec![Review {
                persona: "Methods".into(),
                summary: "Sound but thin.".into(),
                strengths: vec!["Clear 50% gain".into()],
                weaknesses: vec![
                    Weakness { text: "No ablation of $\\alpha$".into(), file: Some("main.tex".into()), line: Some(3), severity: WeaknessSeverity::Major },
                    Weakness { text: "Typo".into(), ..Default::default() },
                ],
                scores: [("overall".to_string(), 4.0)].into_iter().collect(),
                confidence: Some(3.0),
                ..Default::default()
            }],
            ..Default::default()
        };
        r.meta = MetaReview { summary: "Borderline.".into(), decision: "Weak accept".into(), must_fix: vec!["Ablation".into()], ..Default::default() };
        r
    }

    #[test]
    fn markdown_and_tex_exports() {
        let r = sample();
        let md = render_markdown(&r);
        assert!(md.starts_with("# Review: "));
        assert!(md.contains("**Recommendation:** Weak accept"));
        assert!(md.contains("- [major] No ablation of $\\alpha$ (`main.tex:3`)"));
        assert!(md.contains("## Reviewer 1: Methods"));
        let tex = render_tex(&r);
        assert!(tex.starts_with("\\documentclass{article}") && tex.trim_end().ends_with("\\end{document}"));
        assert!(tex.contains("Clear 50\\% gain"));
        assert!(tex.contains("No ablation of \\$\\textbackslash{}alpha\\$ (main.tex:3)"));
        assert_eq!(tex.matches("\\begin{itemize}").count(), tex.matches("\\end{itemize}").count());
    }

    #[test]
    fn the_fallback_meta_lists_major_points_as_must_fix() {
        let m = fallback_meta(&sample().reviews);
        assert_eq!(m.must_fix, ["No ablation of $\\alpha$ (main.tex:3)"]);
        assert_eq!(m.nice_to_fix, ["Typo"]);
        assert!(m.summary.contains("didn't finish"));
    }

    #[test]
    fn persona_prompts_carry_rubric_checklist_and_view() {
        let setup = ReviewSetup::for_venue("neurips").normalized();
        let p = Persona { id: "stats".into(), name: "Strict statistician".into(), focus: "Check every test.".into() };
        let s = persona_system(&setup, &p, "Automatic checklist: x", "\n\nProject facts.");
        assert!(s.contains("Your point of view: Strict statistician. Check every test."));
        assert!(s.contains("NeurIPS") && s.contains("Automatic checklist: x") && s.ends_with("Project facts."));
        assert!(s.contains("search_papers"));
        assert!(s.contains("Always finish by calling submit_report"));
    }
}
