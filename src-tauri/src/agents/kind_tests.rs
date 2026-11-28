//! The agent kinds driven end to end against the local mock LLM server: the
//! reviewer ensemble, the rebuttal pause and resume, the task plan, the
//! fixer's cheat guard and the vision fallback. No network, no TeX.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::attach::VisionFallback;
use super::kinds::{AgentKind, Registry};
use super::run_loop::RunEnv;
use super::runtime::{AgentRuntime, EnvSource};
use super::tests::{call, finished, project, request, runtime, text, wait, Rec};
use super::tools::registry::BoxFut;
use super::types::*;
use crate::ai::error::AiResult;
use crate::ai::http::{ApiKey, Cancel, Endpoint};
use crate::ai::llm::{ProviderId, RetryPolicy};
use crate::ai::mock::{Canned, MockServer};

fn report(args: Value) -> Canned {
    call("r", "submit_report", json!({ "report": args }))
}

fn all_text(req: &Value) -> String {
    req["messages"].to_string()
}

#[test]
fn reviewer_ensemble_runs_personas_in_parallel_and_merges_them() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        // The two personas (in whichever order their requests arrive).
        report(json!({"summary": "Solid.", "strengths": ["Clear"], "weaknesses": [{"text": "Intro is unclosed", "file": "main.tex", "line": 3, "severity": "major"}],
            "questions": ["Why?"], "scores": {"overall": "4", "soundness": 3, "made-up": 9}, "confidence": 4,
            "references": [{"title": "Prior Work", "doi": "10.1/x", "year": 2020}]})),
        report(json!({"summary": "Thin.", "weaknesses": ["Too short"], "scores": {"overall": 2.4}, "confidence": 3,
            "references": [{"title": "prior   work", "doi": "10.1/X"}]})),
        // The reviewer whose weakness had no file:line fixes it.
        report(json!({"summary": "Thin.", "weaknesses": [{"text": "Too short", "file": "./main.tex", "line": 4}], "scores": {"overall": 2}, "confidence": 3})),
        // The area chair.
        report(json!({"summary": "Mixed reviews.", "decision": "Borderline", "mustFix": ["Close the section brace (main.tex:3)"],
            "consensus": ["Short paper"], "disagreements": ["Methods likes it, Clarity doesn't"]})),
    ]);
    let rec = Arc::new(Rec::default());
    let rt = runtime(&server, rec.clone(), Registry::default());
    let mut req = request("reviewer", "Review my paper for a workshop.");
    req.options.extra = Some(json!({"review": {"venue": "generic", "reviewers": 2, "checklist": false, "groundNovelty": false}, "export": "md"}));
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);

    let reqs = server.recorded();
    assert_eq!(reqs.len(), 4);
    let first_two: Vec<Value> = reqs[..2].iter().map(|r| r.json()).collect();
    let views: Vec<bool> = ["Methods", "Clarity"]
        .iter()
        .map(|p| first_two.iter().any(|r| r["messages"][0]["content"].as_str().unwrap().contains(&format!("Your point of view: {p}."))))
        .collect();
    assert_eq!(views, [true, true], "both personas asked at once");
    assert!(first_two.iter().all(|r| {
        let names: Vec<&str> = r["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
        names.contains(&"submit_report") && names.contains(&"read_file") && !names.contains(&"edit_file") && !names.contains(&"compile_check")
    }));
    assert!(all_text(&reqs[2].json()).contains("no valid file and line"));
    let meta_req = reqs[3].json();
    assert!(meta_req["messages"][0]["content"].as_str().unwrap().contains("area chair"));
    assert!(all_text(&meta_req).contains("The reviews (JSON)") && all_text(&meta_req).contains("Too short"));

    // The report: both reviews (conformed to the rubric), the meta, the
    // merged references.
    let r = run.report.as_ref().unwrap();
    assert_eq!(r.kind, "review");
    let rr = crate::agents::review::ReviewReport::from_report(r);
    assert_eq!(rr.reviews.len(), 2);
    assert_eq!(rr.reviews.iter().map(|x| x.persona.as_str()).collect::<Vec<_>>(), ["Methods", "Clarity"]);
    for rev in &rr.reviews {
        assert!(rev.weaknesses.iter().all(|w| w.file.as_deref() == Some("main.tex") && w.line.is_some()), "{:?}", rev.weaknesses);
        assert!(!rev.scores.contains_key("made-up"));
    }
    assert_eq!(rr.meta.decision, "Borderline");
    assert_eq!(rr.meta.must_fix.len(), 1);
    let spread = &rr.meta.score_spread["overall"];
    assert_eq!((spread.min, spread.max, spread.mean), (2.0, 4.0, 3.0));
    assert_eq!(rr.references.len(), 1, "deduplicated by DOI");
    assert!(run.final_message.as_deref().unwrap().starts_with("Recommendation: Borderline."));

    // Steps of each sub-run carry its label.
    let subs: std::collections::BTreeSet<&str> = run.steps.iter().filter_map(|s| s.sub.as_deref()).collect();
    assert_eq!(subs.into_iter().collect::<Vec<_>>(), ["Area chair", "Clarity", "Methods"]);

    // review.md was asked for: it is in the changeset, not on disk.
    assert_eq!(run.changeset.len(), 1);
    assert_eq!(run.changeset[0].file, "review.md");
    assert!(run.changeset[0].new_text.as_deref().unwrap().contains("## Reviewer 2: Clarity"));
    assert!(!root.join("review.md").exists());

    // Progress: reviewers done goes 0 → 1 → 2 out of 2.
    let done: Vec<u32> = rec
        .updates
        .lock()
        .unwrap()
        .iter()
        .filter_map(|u| u.progress.phase("reviewers").filter(|p| p.status != PhaseStatus::Pending).and_then(|p| p.done))
        .collect();
    let mut steps = done.clone();
    steps.dedup();
    assert_eq!(steps, [0, 1, 2], "{done:?}");
    let phases: Vec<(&str, PhaseStatus)> = run.progress.phases.iter().map(|p| (p.id.as_str(), p.status)).collect();
    assert_eq!(
        phases,
        [
            ("checks", PhaseStatus::Skipped),
            ("reviewers", PhaseStatus::Done),
            ("fixpass", PhaseStatus::Done),
            ("chair", PhaseStatus::Done),
            ("report", PhaseStatus::Done)
        ]
    );
    let reviewers = run.progress.phase("reviewers").unwrap();
    assert_eq!((reviewers.done, reviewers.total), (Some(2), Some(2)));
    assert_eq!(run.summary().max_steps, 40);
}

#[test]
fn reviewer_without_export_writes_nothing_and_survives_a_failed_area_chair() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        report(json!({"summary": "Fine.", "weaknesses": [{"text": "Weak intro", "file": "main.tex", "line": 2, "severity": "major"}], "scores": {"overall": 4}})),
        text("I don't want to be the area chair."),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let mut req = request("reviewer", "Review");
    req.options.extra = Some(json!({"reviewers": 1, "checklist": true}));
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done, "{:?}", run.error);
    assert!(run.changeset.is_empty());
    let rr = crate::agents::review::ReviewReport::from_report(run.report.as_ref().unwrap());
    assert_eq!(rr.meta.must_fix, ["Weak intro (main.tex:2)"], "Texo's fallback meta-review");
    assert!(!rr.checklist.is_empty(), "the checklist ran");
    assert!(run.steps.iter().any(|s| s.text.as_deref().is_some_and(|t| t.starts_with("Automatic checks:"))));
    assert!(run.report.as_ref().unwrap().data["notes"].to_string().contains("area chair"));
}

#[test]
fn rebuttal_pauses_with_the_plan_and_drafts_after_approval() {
    let (_d, root) = project();
    let plan = json!({"concerns": [
        {"id": "R1.1", "reviewer": "Reviewer 1", "quote": "There is no ablation.", "action": "experiment", "plan": "Promise an ablation"},
        {"id": "R2.1", "reviewer": "Reviewer 2", "quote": "Typo in the intro.", "action": "change", "plan": "Fix it", "file": "main.tex"},
    ]});
    let letter = "\\documentclass{article}\n\\begin{document}\nR1.1: [TBD: ablation over the loss weight]\nR2.1: fixed.\n\\end{document}\n";
    let server = MockServer::start(vec![
        call("p1", "submit_plan", plan),
        call("d1", "write_file", json!({"path": "response-to-reviewers.tex", "text": letter, "reason": "Response letter"})),
        call("d2", "edit_file", json!({"path": "main.tex", "old": "Hello.", "new": "Hello, world.", "reason": "R2.1 typo"})),
        report(json!({"summary": "Answered both.", "concerns": [{"id": "R1.1", "status": "tbd"}, {"id": "R2.1", "status": "changed", "changes": "main.tex line 4"}]})),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("rebuttal", "Reviewer 1: There is no ablation.\nReviewer 2: Typo in the intro.")).unwrap().id;

    let run = wait(&rt, &root, &id, |r| r.status == RunStatus::AwaitingInput);
    let plan = run.progress.phase("plan").unwrap();
    assert_eq!((plan.label.as_str(), plan.status), ("Plan (needs your approval)", PhaseStatus::Active));
    assert_eq!(run.deadline_at, None, "waiting doesn't count against the time limit");
    let awaiting = run.awaiting.clone().unwrap();
    assert_eq!(awaiting["type"], "rebuttalPlan");
    assert_eq!(awaiting["concerns"].as_array().unwrap().len(), 2);
    assert_eq!(awaiting["concerns"][0]["action"], "experiment");
    assert!(run.steps.iter().any(|s| s.text.as_deref().is_some_and(|t| t.starts_with("Plan for 2 reviewer concern(s)"))));
    // The planning tools can't write.
    let names = server.recorded()[0].json()["tools"].to_string();
    assert!(names.contains("submit_plan") && !names.contains("write_file"));

    // The user edits one plan entry and approves.
    let mut edited = awaiting["concerns"].clone();
    edited[1]["plan"] = json!("Fix the typo and say thanks");
    rt.respond(&id, json!({"approved": true, "concerns": edited, "note": "Keep it short."})).unwrap();
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);

    let draft = all_text(&server.recorded()[1].json());
    assert!(draft.contains("Fix the typo and say thanks") && draft.contains("Keep it short."));
    let files: Vec<&str> = run.changeset.iter().map(|c| c.file.as_str()).collect();
    assert_eq!(files, ["main.tex", "response-to-reviewers.tex"]);
    let r = run.report.as_ref().unwrap();
    assert_eq!(r.kind, "rebuttal");
    assert_eq!(r.data["letter"], "response-to-reviewers.tex");
    assert_eq!(r.data["tbd"], json!(["[TBD: ablation over the loss weight]"]));
    assert_eq!(r.data["concerns"][1]["status"], "changed");
    assert_eq!(r.data["concerns"][1]["plan"], "Fix the typo and say thanks");
    assert_eq!(r.data["warnings"], json!([]));
    assert!(fs::read_to_string(root.join("main.tex")).unwrap().contains("Hello.\n"), "nothing written before review");
    // The concerns became the checklist: tbd is partly, changed is done.
    let plan: Vec<PlanStatus> = run.progress.plan.iter().map(|i| i.status).collect();
    assert_eq!(plan, [PlanStatus::Partly, PlanStatus::Done]);
    let draft = run.progress.phase("draft").unwrap();
    assert_eq!((draft.status, draft.done, draft.total), (PhaseStatus::Done, Some(2), Some(2)));
    assert!(all_text(&server.recorded()[1].json()).contains("call update_plan"));
}

#[test]
fn rebuttal_declined_plan_ends_without_drafting() {
    let (_d, root) = project();
    let server = MockServer::start(vec![call("p1", "submit_plan", json!({"concerns": [{"id": "R1", "summary": "No ablation", "action": "experiment"}]}))]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("rebuttal", "R1: no ablation")).unwrap().id;
    wait(&rt, &root, &id, |r| r.status == RunStatus::AwaitingInput);
    rt.respond(&id, json!({"approved": false})).unwrap();
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done);
    assert!(run.changeset.is_empty());
    assert_eq!(run.report.unwrap().data["letter"], Value::Null);
    assert_eq!(server.recorded().len(), 1);
}

/// F8: a review handed in as JSON text (no submit_report) also gets the
/// extra turn to add file:line to its weaknesses.
#[test]
fn reviewer_json_text_review_gets_the_location_fix_turn() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        text("{\"summary\": \"Fine.\", \"weaknesses\": [{\"text\": \"Weak intro\", \"severity\": \"major\"}], \"scores\": {\"overall\": 3}}"),
        report(json!({"summary": "Fine.", "weaknesses": [{"text": "Weak intro", "file": "main.tex", "line": 2, "severity": "major"}], "scores": {"overall": 3}})),
        text("No area chair."),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let mut req = request("reviewer", "Review");
    req.options.extra = Some(json!({"reviewers": 1, "checklist": false}));
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done, "{:?}", run.error);
    let reqs = server.recorded();
    assert_eq!(reqs.len(), 3);
    assert!(all_text(&reqs[1].json()).contains("no valid file and line"));
    let rr = crate::agents::review::ReviewReport::from_report(run.report.as_ref().unwrap());
    let w = &rr.reviews[0].weaknesses[0];
    assert_eq!((w.file.as_deref(), w.line), (Some("main.tex"), Some(2)));
}

#[test]
fn rebuttal_without_tbd_for_experiments_is_sent_back_once_then_warned() {
    let (_d, root) = project();
    let made_up = "\\documentclass{article}\n\\begin{document}\nR1: the ablation gives 93.1\\%.\n\\end{document}\n";
    let server = MockServer::start(vec![
        call("p1", "submit_plan", json!({"concerns": [{"id": "R1", "summary": "No ablation", "action": "experiment"}]})),
        call("d1", "write_file", json!({"path": "response-to-reviewers.tex", "text": made_up})),
        text("Done."),
        text("Still done."),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("rebuttal", "R1: no ablation")).unwrap().id;
    wait(&rt, &root, &id, |r| r.status == RunStatus::AwaitingInput);
    rt.respond(&id, json!(true)).unwrap();
    let run = wait(&rt, &root, &id, finished);
    let reqs = server.recorded();
    assert_eq!(reqs.len(), 4);
    assert!(all_text(&reqs[3].json()).contains("[TBD: ...] placeholder"));
    let warnings = run.report.unwrap().data["warnings"].to_string();
    assert!(warnings.contains("no results were made up"), "{warnings}");
}

#[test]
fn task_agent_plans_then_reports_per_task() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        text("1. Add a greeting\n2. Fix the typo in the conclusion"),
        call("c1", "edit_file", json!({"path": "main.tex", "old": "Hello.", "new": "Hello, reader.", "reason": "Greeting"})),
        text("1. done: added a greeting\n2. not done: there is no conclusion"),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("task", "Add a greeting and fix the typo in the conclusion.")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);

    let reqs = server.recorded();
    assert!(reqs[0].json().get("tools").is_none_or(|t| t.as_array().is_some_and(|a| a.is_empty())), "the plan call has no tools");
    let work = reqs[1].json();
    assert!(all_text(&work).contains("Plan:\\n1. Add a greeting\\n2. Fix the typo"));
    assert!(work["tools"].as_array().unwrap().len() > 5);
    assert_eq!(run.steps[0].kind, StepKind::Message);
    assert!(run.steps[0].text.as_deref().unwrap().starts_with("1. Add a greeting"));

    let r = run.report.as_ref().unwrap();
    assert_eq!(r.kind, "task");
    assert_eq!(r.data["tasks"][0]["status"], "done");
    assert_eq!(r.data["tasks"][1]["status"], "notDone");
    assert_eq!(r.data["tasks"][1]["note"], "there is no conclusion");
    assert_eq!(r.data["summary"], "1 of 2 task(s) done, 0 partly, 1 not done.");
}

#[test]
fn task_plan_becomes_a_checklist_that_update_plan_ticks_off() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        text("1. Add a greeting\n2. Fix the typo in the conclusion\n3. Check the title"),
        call("u1", "update_plan", json!({"n": 1, "status": "done", "note": "Greeting added"})),
        text("1. done: added a greeting\n2. not done: there is no conclusion"),
    ]);
    let rec = Arc::new(Rec::default());
    let rt = runtime(&server, rec.clone(), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("task", "Add a greeting and fix the typo.")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done, "{:?}", run.error);
    assert!(all_text(&server.recorded()[1].json()).contains("call update_plan"));

    // After planning: the plan has the parsed tasks, all pending.
    let updates = rec.updates.lock().unwrap().clone();
    let planned = updates.iter().find(|u| !u.progress.plan.is_empty()).expect("the plan reached the window");
    assert_eq!(planned.progress.plan.len(), 3);
    assert!(planned.progress.plan.iter().all(|i| i.status == PlanStatus::Pending));
    // update_plan changed task 1 and told the window (before the summary).
    let ticked = updates
        .iter()
        .find(|u| u.progress.plan.first().is_some_and(|i| i.status == PlanStatus::Done))
        .expect("an update after update_plan");
    assert_eq!(ticked.progress.plan[0].note.as_deref(), Some("Greeting added"));
    assert_eq!(ticked.progress.plan[1].status, PlanStatus::Pending);
    let work = ticked.progress.phase("work").unwrap();
    assert_eq!((work.status, work.done, work.total), (PhaseStatus::Active, Some(1), Some(3)));
    let step = run.steps.iter().find(|s| s.tool.as_deref() == Some("update_plan")).unwrap();
    assert!(step.ok && step.result.as_deref() == Some("ok"), "{step:?}");

    // The end: the summary's statuses; task 3 wasn't reported and stays pending.
    let plan: Vec<PlanStatus> = run.progress.plan.iter().map(|i| i.status).collect();
    assert_eq!(plan, [PlanStatus::Done, PlanStatus::NotDone, PlanStatus::Pending]);
    assert_eq!(run.progress.plan[0].note.as_deref(), Some("added a greeting"));
    let phases: Vec<PhaseStatus> = run.progress.phases.iter().map(|p| p.status).collect();
    assert_eq!(phases, [PhaseStatus::Done, PhaseStatus::Done, PhaseStatus::Done]);
    assert_eq!(run.progress.phase("plan").unwrap().detail.as_deref(), Some("3 task(s)"));
}

#[test]
fn a_task_run_stopped_mid_work_leaves_nothing_running() {
    let (_d, root) = project();
    let server = MockServer::start(vec![
        text("1. Add a greeting
2. Fix the typo"),
        call("u1", "update_plan", json!({"n": 1, "status": "active"})),
        text("Still thinking.").delay(10_000),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let id = rt.start(root.clone(), "p".into(), request("task", "Add a greeting and fix the typo.")).unwrap().id;
    let busy = wait(&rt, &root, &id, |r| r.progress.plan.first().is_some_and(|i| i.status == PlanStatus::Active));
    assert_eq!(busy.progress.phase("work").unwrap().status, PhaseStatus::Active);
    assert!(busy.deadline_at.is_some());
    assert!(rt.cancel(&id));
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Cancelled);

    let phases: Vec<(&str, PhaseStatus)> = run.progress.phases.iter().map(|p| (p.id.as_str(), p.status)).collect();
    assert_eq!(phases, [("plan", PhaseStatus::Done), ("work", PhaseStatus::Skipped), ("summary", PhaseStatus::Skipped)]);
    let plan: Vec<PlanStatus> = run.progress.plan.iter().map(|i| i.status).collect();
    assert_eq!(plan, [PlanStatus::Skipped, PlanStatus::Pending]);
    assert!(run.progress.activity.is_none());
    assert_eq!(run.deadline_at, None);
    let s = serde_json::to_value(run.summary()).unwrap();
    assert!(s["deadlineAt"].is_null());
    assert!(!s["progress"].to_string().contains("\"active\""), "{}", s["progress"]);
}

#[test]
fn fixer_flags_a_cheat_fix_and_never_applies_it_automatically() {
    let (_d, root) = project();
    fs::write(root.join("main.tex"), "\\documentclass{article}\n\\begin{document}\nSee \\cite{smith}.\n\\end{document}\n").unwrap();
    let server = MockServer::start(vec![
        call("c1", "edit_file", json!({"path": "main.tex", "old": "See \\cite{smith}.", "new": "See Smith."})),
        text("Removed the broken citation."),
    ]);
    let rt = runtime(&server, Arc::new(Rec::default()), Registry::default());
    let mut req = request("fixer", "");
    req.options.auto_apply = true;
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);
    assert!(run.summary().needs_attention);
    assert!(run.changeset[0].attention.iter().any(|a| a.contains("citation(s) smith")), "{:?}", run.changeset[0].attention);
    assert_eq!(run.changeset[0].state, FileState::Pending, "not applied automatically");
    assert!(fs::read_to_string(root.join("main.tex")).unwrap().contains("\\cite{smith}"));
    assert_eq!(run.report.as_ref().unwrap().kind, "fix");
    // An empty prompt gets the default request.
    assert!(all_text(&server.recorded()[0].json()).contains("Fix the compile errors in this project."));

    // The phases: no compiler here, so one round and no check.
    let labels: Vec<&str> = run.progress.phases.iter().map(|p| p.label.as_str()).collect();
    assert_eq!(labels, ["Read the errors", "Fix round 1 of 3", "Fix round 2 of 3", "Fix round 3 of 3", "Compile check", "Done"]);
    let status: Vec<PhaseStatus> = run.progress.phases.iter().map(|p| p.status).collect();
    use PhaseStatus::*;
    assert_eq!(status, [Done, Done, Skipped, Skipped, Skipped, Done]);
    assert_eq!(run.summary().max_steps, 16);
}

#[test]
fn fixer_phases_follow_the_compile_rounds() {
    use super::kinds::fixer::{after_compile, finish_phases, nothing_to_fix, phases};
    let apply = |p: &mut RunProgress, ups: Vec<ProgressUpdate>| {
        for u in ups {
            if let ProgressUpdate::Phase { id, status, detail, done, total } = u {
                p.set_phase(&id, status, detail, done, total);
            }
        }
    };
    let mut p = RunProgress { phases: phases(), ..Default::default() };
    p.set_phase("read", PhaseStatus::Done, None, None, None);
    // Texo's own first compile failed with 3 errors: round 1.
    apply(&mut p, after_compile(1, false, 3));
    assert_eq!(p.phase("round1").unwrap().status, PhaseStatus::Active);
    assert_eq!(p.phase("round1").unwrap().detail.as_deref(), Some("3 errors left"));
    // The model's check still fails with 1: round 1 done, round 2 starts.
    apply(&mut p, after_compile(2, false, 1));
    assert_eq!(p.phase("round1").unwrap().status, PhaseStatus::Done);
    assert_eq!(p.phase("round2").unwrap().detail.as_deref(), Some("1 error left"));
    // Then it compiles.
    apply(&mut p, after_compile(3, true, 0));
    assert_eq!(p.phase("round2").unwrap().status, PhaseStatus::Done);
    assert_eq!(p.phase("check").unwrap().status, PhaseStatus::Done);
    finish_phases(&mut p, true, true);
    let status: Vec<PhaseStatus> = p.phases.iter().map(|x| x.status).collect();
    use PhaseStatus::*;
    assert_eq!(status, [Done, Done, Done, Skipped, Done, Done]);

    // Nothing to fix: every phase is skipped.
    let mut p = RunProgress { phases: phases(), ..Default::default() };
    p.set_phase("read", PhaseStatus::Active, None, None, None);
    nothing_to_fix(&mut p);
    assert!(p.phases.iter().all(|x| x.status == Skipped && x.started_at.is_none()), "{:?}", p.phases);
}

/// An environment with a vision fallback model.
struct VisionEnv {
    base: String,
}

impl EnvSource for VisionEnv {
    fn resolve<'a>(&'a self, _: &'a Path, _: &'a dyn AgentKind, _: &'a StartRequest, _: Cancel) -> BoxFut<'a, AiResult<RunEnv>> {
        Box::pin(async move {
            Ok(RunEnv {
                client: crate::ai::http::build_client(false)?,
                endpoint: Endpoint {
                    provider: ProviderId::Custom,
                    label: "Test AI".into(),
                    base_url: format!("{}/v1", self.base),
                    key: Some(ApiKey::new("sk-test-KEY-123456".into())),
                    model: "blind-model".into(),
                },
                fallback_models: Vec::new(),
                thinking: false,
                policy: RetryPolicy { tries: 1, backoff: Duration::from_millis(1), max_wait: Duration::from_secs(1), rate_limit: false },
                net: None,
                build: None,
                vision: Some(VisionFallback { model: "vision-model".into(), fallbacks: Vec::new() }),
            })
        })
    }
}

#[test]
fn images_for_a_blind_model_are_described_by_the_vision_fallback() {
    use base64::Engine as _;
    let (_d, root) = project();
    let server = MockServer::start(vec![text("A bar chart with two bars, A = 3 and B = 5."), text("B is larger.")]);
    let mut kinds = Registry::default();
    kinds.register(Arc::new(super::tests::Plain));
    let rt = AgentRuntime::with_kinds(Arc::new(Rec::default()), Arc::new(VisionEnv { base: server.base_url.clone() }), kinds);
    let mut req = request("plain", "Which bar is larger?");
    req.attachments.push(Attachment {
        name: "chart.png".into(),
        mime: "image/png".into(),
        data_base64: Some(base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake")),
        ..Default::default()
    });
    let id = rt.start(root.clone(), "p".into(), req).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::Done, "{:?}", run.error);
    let reqs = server.recorded();
    let v = reqs[0].json();
    assert_eq!(v["model"], "vision-model");
    assert!(v.to_string().contains("data:image/png;base64,"));
    let main = reqs[1].json();
    assert_eq!(main["model"], "blind-model");
    assert!(all_text(&main).contains("A bar chart with two bars") && !main.to_string().contains("data:image/png"));
    assert_eq!(run.attachments[0].used_as, "described");
    assert!(run.steps.iter().any(|s| s.notice && s.text.as_deref().is_some_and(|t| t.contains("described them first"))));
}

/// An environment that compiles for real (needs TeX on the machine).
struct TexEnv {
    base: String,
    tools_dir: std::path::PathBuf,
}

impl EnvSource for TexEnv {
    fn resolve<'a>(&'a self, _: &'a Path, _: &'a dyn AgentKind, _: &'a StartRequest, _: Cancel) -> BoxFut<'a, AiResult<RunEnv>> {
        Box::pin(async move {
            Ok(RunEnv {
                client: crate::ai::http::build_client(false)?,
                endpoint: Endpoint {
                    provider: ProviderId::Custom,
                    label: "Test AI".into(),
                    base_url: format!("{}/v1", self.base),
                    key: Some(ApiKey::new("sk-test-KEY-123456".into())),
                    model: "test-model".into(),
                },
                fallback_models: Vec::new(),
                thinking: false,
                policy: RetryPolicy { tries: 1, backoff: Duration::from_millis(1), max_wait: Duration::from_secs(1), rate_limit: false },
                net: None,
                build: Some(super::tools::build::BuildEnv {
                    tools_dir: self.tools_dir.clone(),
                    compiler: crate::compile::Compiler::Auto,
                    trusted: false,
                }),
                vision: None,
            })
        })
    }
}

/// A scripted model fixes a missing brace; the fixer compiles first, sends
/// the model back to check its edit, and ends with a compiling changeset.
#[test]
#[ignore = "needs a TeX installation"]
fn fixer_run_with_real_tex_ends_with_a_compiling_changeset() {
    let (_d, root) = project();
    let tools = tempfile::tempdir().unwrap();
    let server = MockServer::start(vec![
        call("c1", "edit_file", json!({"path": "main.tex", "old": "\\section{Intro\n", "new": "\\section{Intro}\n", "reason": "Close the brace"})),
        // It stops without checking: the fixer sends it back once.
        text("I closed the brace."),
        call("c2", "compile_check", json!({})),
        text("Fixed: the \\section title was missing its closing brace."),
    ]);
    let rt = AgentRuntime::with_kinds(
        Arc::new(Rec::default()),
        Arc::new(TexEnv { base: server.base_url.clone(), tools_dir: tools.path().to_path_buf() }),
        Registry::default(),
    );
    let id = rt.start(root.clone(), "p".into(), request("fixer", "")).unwrap().id;
    let run = wait(&rt, &root, &id, finished);
    assert_eq!(run.status, RunStatus::AwaitingReview, "{:?}", run.error);
    let first = &run.steps[0];
    assert_eq!(first.tool.as_deref(), Some("compile_check"));
    assert!(first.result.as_deref().unwrap().contains("The compile failed"), "{:?}", first.result);
    let reqs = server.recorded();
    assert_eq!(reqs.len(), 4);
    assert!(all_text(&reqs[0].json()).contains("Result of the first compile_check"));
    assert!(all_text(&reqs[2].json()).contains("compile_check now"));
    let r = run.report.as_ref().unwrap();
    assert_eq!(r.data["fixed"], true, "{:?}", r.data);
    assert_eq!(r.data["rounds"], 2);
    assert!(run.error.is_none());
    assert!(run.changeset[0].attention.is_empty());
    assert!(!super::tools::build::shadow_root().join(&id).exists(), "the shadow copy is removed");
}
