//! Tests for venue presets, setups, report parsing and the checklist on
//! fixture projects in a temp dir.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::json;

use super::checklist::{self, *};
use super::scan;
use super::venues::preset;
use super::*;

fn write(root: &Path, rel: &str, text: impl AsRef<[u8]>) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn set_mtime(root: &Path, rel: &str, t: SystemTime) {
    fs::File::options()
        .write(true)
        .open(root.join(rel))
        .unwrap()
        .set_modified(t)
        .unwrap();
}

fn find<'a>(checks: &'a [Check], id: &str) -> &'a Check {
    checks
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("no check {id}: {checks:#?}"))
}

fn ids(checks: &[Check]) -> Vec<&str> {
    checks.iter().map(|c| c.id.as_str()).collect()
}

fn log_for(body: &str, pages: Option<u32>) -> String {
    let out = match pages {
        Some(n) => format!("Output written on main.pdf ({n} pages, 123456 bytes)."),
        None => "No pages of output.".into(),
    };
    format!("This is pdfTeX, Version 3.141592653-2.6-1.40.26\nentering extended mode\n(./main.tex\nLaTeX2e <2023-11-01>\n{body}\n) )\n{out}\nTranscript written on main.log.\n")
}

// ---------------------------------------------------------------------------
// Presets and setups
// ---------------------------------------------------------------------------

#[test]
fn presets_are_complete_and_scales_are_consistent() {
    let all = presets();
    let ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "generic",
            "neurips",
            "iclr",
            "icml",
            "acl",
            "cvpr",
            "ieee-transactions",
            "elsevier",
            "springer",
            "thesis"
        ]
    );
    for p in &all {
        assert!(
            !p.name.is_empty() && !p.source.is_empty() && !p.page_limit_note.is_empty(),
            "{}",
            p.id
        );
        assert!(p.rubric.sections.len() >= 4, "{}", p.id);
        assert!(!p.rubric.scores.is_empty(), "{}", p.id);
        assert!(p.rubric.decisions.len() >= 3, "{}", p.id);
        let conf = p.rubric.confidence.as_ref().expect("confidence");
        for sc in p.rubric.scores.iter().chain(std::iter::once(conf)) {
            assert!(sc.min < sc.max, "{} {}", p.id, sc.id);
            assert!(!sc.labels.is_empty(), "{} {}", p.id, sc.id);
            for l in &sc.labels {
                assert!(l.value >= sc.min && l.value <= sc.max, "{} {}", p.id, sc.id);
                assert_eq!(sc.snap(l.value), Some(l.value), "{} {}", p.id, sc.id);
            }
            assert!(sc.prompt_line().contains(&sc.id));
        }
        let mut score_ids: Vec<&str> = p.rubric.scores.iter().map(|s| s.id.as_str()).collect();
        score_ids.sort();
        score_ids.dedup();
        assert_eq!(
            score_ids.len(),
            p.rubric.scores.len(),
            "duplicate score ids in {}",
            p.id
        );
    }
    let neurips = preset("neurips").unwrap();
    assert_eq!((neurips.page_limit, neurips.anonymous), (Some(9), true));
    assert_eq!(
        neurips
            .rubric
            .scores
            .iter()
            .find(|s| s.id == "overall")
            .unwrap()
            .max,
        6.0
    );
    assert_eq!(preset("iclr").unwrap().page_limit, Some(10));
    assert_eq!(preset("icml").unwrap().page_limit, Some(8));
    assert_eq!(
        preset("acl")
            .unwrap()
            .rubric
            .scores
            .iter()
            .find(|s| s.id == "overall")
            .unwrap()
            .step,
        Some(0.5)
    );
    for j in ["ieee-transactions", "elsevier", "springer", "thesis"] {
        let p = preset(j).unwrap();
        assert!(!p.anonymous && p.page_limit.is_none(), "{j}");
    }
    assert_eq!(preset("ARR").unwrap().id, "acl");
    assert_eq!(preset(" ICCV ").unwrap().id, "cvpr");
    assert_eq!(preset("tpami").unwrap().id, "ieee-transactions");
    assert!(preset("nope").is_none());
    assert_eq!(review_presets().len(), 10);
}

#[test]
fn scores_snap_to_their_scales() {
    let iclr = preset("iclr").unwrap();
    let rating = iclr
        .rubric
        .scores
        .iter()
        .find(|s| s.id == "rating")
        .unwrap();
    assert_eq!(rating.snap(7.4), Some(8.0));
    assert_eq!(rating.snap(5.4), Some(5.0));
    assert_eq!(rating.snap(1.4), Some(1.0));
    assert_eq!(rating.snap(42.0), Some(10.0));
    assert_eq!(rating.snap(f64::NAN), None);
    let arr = preset("acl").unwrap();
    let overall = arr
        .rubric
        .scores
        .iter()
        .find(|s| s.id == "overall")
        .unwrap();
    assert_eq!(overall.snap(3.3), Some(3.5));
    assert_eq!(overall.snap(0.0), Some(1.0));
    assert_eq!(overall.label_of(3.5), Some("Borderline Conference"));
    let quality = preset("neurips").unwrap().rubric.scores[0].clone();
    assert_eq!(quality.snap(2.6), Some(3.0));
}

#[test]
fn setup_parses_camel_case_with_defaults_and_normalizes() {
    let s: ReviewSetup =
        serde_json::from_value(json!({"venue": "neurips", "reviewers": 9, "groundNovelty": false}))
            .unwrap();
    assert_eq!(s.venue, "neurips");
    assert!(!s.ground_novelty && s.checklist);
    assert_eq!(s.strictness, Strictness::Balanced);
    let n = s.normalized();
    assert_eq!(n.reviewers, 5);
    assert_eq!(n.personas.len(), 5);
    assert_eq!(n.personas[0].id, "methods");
    assert_eq!(n.rubric, preset("neurips").unwrap().rubric);
    assert_eq!(n.page_limit(), Some(9));
    assert!(n.anonymous());

    // Empty object: generic, three reviewers.
    let d: ReviewSetup = serde_json::from_value(json!({})).unwrap();
    assert_eq!(d.normalized(), ReviewSetup::default().normalized());
    assert_eq!(d.normalized().personas.len(), 3);

    // Custom persona and overrides are kept; unknown venue → generic.
    let c: ReviewSetup = serde_json::from_value(json!({
        "venue": "my-workshop", "reviewers": 0, "strictness": "harsh",
        "personas": [{"id": "", "name": "Strict statistician", "focus": "p-values"}],
        "pageLimit": 4, "anonymous": false, "focus": "x".repeat(5000)
    }))
    .unwrap();
    let n = c.normalized();
    assert_eq!(n.venue, "generic");
    assert_eq!(n.reviewers, 1);
    assert_eq!(
        n.personas,
        vec![Persona {
            id: "reviewer-1".into(),
            name: "Strict statistician".into(),
            focus: "p-values".into()
        }]
    );
    assert_eq!(n.page_limit(), Some(4));
    assert!(!n.anonymous());
    assert_eq!(n.focus.chars().count(), 2000);
    let v = serde_json::to_value(&n).unwrap();
    assert!(
        v.get("groundNovelty").is_some()
            && v.get("pageLimit").is_some()
            && v.get("ground_novelty").is_none()
    );
    let prompt = n.rubric_prompt();
    assert!(
        prompt.contains("Page limit: 4")
            && prompt.contains("demanding")
            && !prompt.contains("anonymous")
    );

    // From a run's options.extra, either shape.
    assert_eq!(
        ReviewSetup::from_extra(Some(&json!({"review": {"venue": "icml"}})))
            .unwrap()
            .venue,
        "icml"
    );
    assert_eq!(
        ReviewSetup::from_extra(Some(&json!({"venue": "iclr"})))
            .unwrap()
            .venue,
        "iclr"
    );
    assert!(ReviewSetup::from_extra(Some(&json!("neurips"))).is_none());
    assert!(ReviewSetup::from_extra(None).is_none());
}

#[test]
fn rubric_prompt_lists_sections_and_scales() {
    let p = ReviewSetup::for_venue("iclr").rubric_prompt();
    assert!(p.contains("Venue: ICLR"));
    assert!(p.contains("Page limit: 10"));
    assert!(p.contains("anonymous"));
    assert!(
        p.contains("`rating`")
            && p.contains("only the listed values")
            && p.contains("8 = accept, good paper")
    );
    let a = ReviewSetup::for_venue("acl").rubric_prompt();
    assert!(a.contains("in steps of 0.5"));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[test]
fn report_reads_loose_model_json() {
    let v = json!({
        "venue": "iclr",
        "reviews": [
            {
                "persona": "Methods",
                "summary": "Solid.",
                "strengths": ["clear", {"text": "good ablations"}],
                "weaknesses": [
                    "No error bars.",
                    {"text": "Baseline missing", "file": "sections/exp.tex:42", "severity": "Major"},
                    {"weakness": "Typo", "file": "main.tex", "line": "7-9", "severity": "low"},
                    {"file": "x.tex"}
                ],
                "questions": "- Why?\n- How?",
                "scores": {"soundness": "3/4", "Rating": 7, "made_up": 2},
                "confidence": "4"
            },
            {"persona": "Clarity", "scores": {"soundness": 2, "rating": 3}, "confidence": 9},
            "garbage"
        ],
        "meta": {"summary": "Mixed.", "recommendation": "Reject", "mustFix": ["baselines"], "nice_to_fix": "typos"},
        "references": [{"title": "Prior paper", "authors": ["A", "B"], "year": "2021", "doi": "10.1/x"}, "Another one", {"no": "title"}],
        "unknown": 1
    });
    let mut r = ReviewReport::from_value(&v);
    assert_eq!(r.kind, "review");
    assert_eq!(r.venue, "iclr");
    assert_eq!(r.reviews.len(), 2);
    let a = &r.reviews[0];
    assert_eq!(a.strengths, ["clear", "good ablations"]);
    assert_eq!(a.weaknesses.len(), 3);
    assert_eq!(a.weaknesses[1].file.as_deref(), Some("sections/exp.tex"));
    assert_eq!(a.weaknesses[1].line, Some(42));
    assert_eq!(a.weaknesses[1].severity, WeaknessSeverity::Major);
    assert_eq!(
        (a.weaknesses[2].file.as_deref(), a.weaknesses[2].line),
        (Some("main.tex"), Some(7))
    );
    assert_eq!(a.weaknesses[2].severity, WeaknessSeverity::Minor);
    assert_eq!(a.questions, ["Why?", "How?"]);
    assert_eq!(a.scores["soundness"], 3.0);
    assert_eq!(a.confidence, Some(4.0));
    assert_eq!(r.meta.decision, "Reject");
    assert_eq!(r.meta.nice_to_fix, ["typos"]);
    assert_eq!(r.references.len(), 2);
    assert_eq!(r.references[0].authors.as_deref(), Some("A, B"));
    assert_eq!(r.references[0].year, Some(2021));

    r.conform(&preset("iclr").unwrap().rubric);
    let a = &r.reviews[0];
    assert_eq!(a.scores.get("rating"), Some(&8.0));
    assert!(!a.scores.contains_key("made_up") && !a.scores.contains_key("Rating"));
    assert_eq!(r.reviews[1].confidence, Some(5.0));
    let spread = &r.meta.score_spread["soundness"];
    assert_eq!((spread.min, spread.max, spread.mean), (2.0, 3.0, 2.5));
    assert_eq!(r.meta.score_spread["rating"].mean, 5.5);

    // Round trip through the runtime's generic report.
    let generic = r.to_report();
    assert_eq!(generic.kind, "review");
    assert!(
        generic.data.contains_key("reviews")
            && generic.data.contains_key("checklist")
            && !generic.data.contains_key("kind")
    );
    let json = serde_json::to_value(&generic).unwrap();
    assert_eq!(json["meta"]["mustFix"], json!(["baselines"]));
    assert_eq!(ReviewReport::from_report(&generic), r);

    // A single review without the `reviews` wrapper, and junk.
    let single = ReviewReport::from_value(
        &json!({"summary": "s", "weaknesses": ["w"], "scores": {"overall": 3}}),
    );
    assert_eq!(single.reviews.len(), 1);
    assert_eq!(single.reviews[0].persona, "Reviewer");
    let empty = ReviewReport::from_value(&json!("nonsense"));
    assert!(empty.reviews.is_empty() && empty.venue == "generic");
}

#[test]
fn checks_serialize_with_lowercase_status() {
    let c = Check {
        id: "x".into(),
        title: "X".into(),
        status: CheckStatus::Warn,
        details: vec!["d".into()],
        file: Some("a.tex".into()),
        line: Some(3),
    };
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(
        v,
        json!({"id": "x", "title": "X", "status": "warn", "details": ["d"], "file": "a.tex", "line": 3})
    );
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

#[test]
fn comments_are_blanked_without_moving_lines() {
    let raw = "a % TODO hidden\nb \\% kept TODO\n\\\\% after a line break\n\\begin{comment}\nTODO\n\\end{comment}\nc";
    let code = scan::strip_comments(raw);
    assert_eq!(code.len(), raw.len());
    assert_eq!(code.lines().count(), raw.lines().count());
    assert!(code.starts_with("a  "));
    assert!(code.contains("\\% kept TODO"));
    assert!(!code.contains("after a line break"));
    assert_eq!(code.matches("TODO").count(), 1);
    let f = scan::TexFile::new("x.tex".into(), raw);
    assert_eq!(f.line_at(0), 1);
    assert_eq!(f.line_at(raw.len() - 1), 7);
    assert_eq!(f.at(raw.find("b ").unwrap()), "x.tex:2");
}

#[test]
fn groups_and_paths() {
    let t = r"\includegraphics[width=\linewidth]{figs/a{b}.png} rest";
    let (a, b) = scan::group_after(t, "\\includegraphics".len(), 2).unwrap();
    assert_eq!(&t[a..b], "figs/a{b}.png");
    assert!(scan::group_after("\\x text", 2, 0).is_none());
    assert!(scan::group_after("\\x{unclosed", 2, 0).is_none());
    assert_eq!(
        scan::normalize_rel("a/./b/../c.tex").as_deref(),
        Some("a/c.tex")
    );
    assert_eq!(scan::normalize_rel("../outside.tex"), None);
    assert_eq!(scan::normalize_rel("/abs.tex"), None);
    assert_eq!(
        scan::join_rel("paper", "sec\\intro").as_deref(),
        Some("paper/sec/intro")
    );
    assert_eq!(scan::parent_rel("a/b/c.tex"), "a/b");
    assert_eq!(scan::parent_rel("c.tex"), "");
}

// ---------------------------------------------------------------------------
// The checklist on fixture projects
// ---------------------------------------------------------------------------

const CLEAN_MAIN: &str = r"\documentclass{article}
\usepackage{neurips_2025}
\usepackage{graphicx}
\graphicspath{{figures/}}
\title{A Paper}
\author{Jane Doe \\ University of Somewhere \\ \texttt{jane@uni.edu}}
\begin{document}
\maketitle
\section{Introduction}\label{sec:intro}
As shown in Figure~\ref{fig:a} and Section~\ref{sec:intro}, prior work~\cite{smith2020} helps.
\begin{figure}
  \includegraphics[width=\linewidth]{plot}
  \caption{A plot.}\label{fig:a}
\end{figure}
\begin{ack}
We thank our funders.
\end{ack}
\bibliography{refs}
\end{document}
";

const CLEAN_BIB: &str = "@inproceedings{smith2020,\n  title={A},\n  author={Smith, A.},\n  booktitle={NeurIPS},\n  year={2020}\n}\n@article{unused,\n  title={No year, not cited}\n}\n";

#[test]
fn a_clean_neurips_paper_passes_everything() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "main.tex", CLEAN_MAIN);
    write(root, "refs.bib", CLEAN_BIB);
    write(root, "figures/plot.pdf", b"%PDF-1.4");
    write(root, ".texo/build/main.log", log_for("", Some(9)));
    let checks = checklist::run(root, &ReviewSetup::for_venue("neurips"));
    assert_eq!(
        ids(&checks),
        [
            PAGE_COUNT,
            ANON_AUTHORS,
            ANON_ACK,
            ANON_SELF_CITE,
            ANON_LINKS,
            UNDEFINED_REFS,
            UNDEFINED_CITES,
            MISSING_FIGURES,
            OVERFULL,
            BIB_FIELDS,
            LEFTOVERS,
            CAPTIONS,
            UNUSED_LABELS
        ]
    );
    for c in &checks {
        assert_eq!(c.status, CheckStatus::Pass, "{c:#?}");
        assert!(!c.details.is_empty(), "{c:#?}");
    }
    assert!(find(&checks, ANON_AUTHORS).details[0].contains("review mode"));
    assert!(find(&checks, ANON_ACK).details[0].contains("hides"));
    assert!(find(&checks, PAGE_COUNT).details[0].contains("9 pages"));
    assert!(find(&checks, BIB_FIELDS).details[0].contains("All 1 cited"));
    let text = checklist::prompt_text(&checks);
    assert!(text.contains("[pass] Page count"));
}

const MESSY_MAIN: &str = r"\documentclass{article}
\usepackage[final]{neurips_2025}
\usepackage{graphicx}
\usepackage{hyperref}
\hypersetup{pdfauthor={Jane Doe}}
\newcommand{\fig}[1]{Figure~\ref{#1}}
\author{Jane Doe\thanks{Funded by grant 42.}}
\begin{document}
\section{Introduction}
In our previous work [3] we built this. We previously showed it works.
Code: \url{https://github.com/janedoe/coolproject} and \url{https://github.com/anonymous/x}.
See \fig{fig:wrapped}. TODO: write more. % TODO in a comment is fine
\input{sections/method}
\begin{figure}
  \includegraphics{missing-plot}
\end{figure}
\begin{table}
  \caption{Results.}
\end{table}
\begin{figure}
  \includegraphics{figs/ok.png}
  \caption{Fine.}\label{fig:wrapped}
\end{figure}
\section*{Acknowledgments}
Thanks to my advisor.
\bibliography{refs}
\end{document}
";

const MESSY_METHOD: &str = r"\section{Method}\label{sec:method}
\todo{check this}
\begin{equation}x=1\label{eq:unused}\end{equation}
\input{sections/does-not-exist}
";

const MESSY_BIB: &str = "@article{a1, title={T}, author={A}, journal={J}}\n@inproceedings{b2, title={T}, author={B}, year={2020}}\n@misc{c3, title={T}, year=2021, howpublished={\\url{x}}}\n@book{notcited, title={T}}\n";

fn messy_log() -> String {
    log_for(
        "\nLaTeX Warning: Reference `fig:nothere' on page 1 undefined on input line 12.\n\nLaTeX Warning: Reference `fig:nothere' on page 2 undefined on input line 13.\n\nLaTeX Warning: Citation `ghost' on page 1 undefined on input line 10.\n\nOverfull \\hbox (12.5pt too wide) in paragraph at lines 10--11\n[]\\OT1/cmr/m/n/10 text\n\nOverfull \\hbox (0.4pt too wide) in paragraph at lines 11--11\n[]\\OT1/cmr/m/n/10 text\n\nOverfull \\hbox (30.0pt too wide) in paragraph at lines 20--21\n[]\\OT1/cmr/m/n/10 text\n",
        Some(12),
    )
}

#[test]
fn a_messy_paper_gets_each_problem_with_file_and_line() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let main = MESSY_MAIN.replace(
        "In our previous work [3]",
        "In our previous work~\\cite{a1,b2,c3,ghost}",
    );
    write(root, "main.tex", &main);
    write(root, "sections/method.tex", MESSY_METHOD);
    write(root, "refs.bib", MESSY_BIB);
    write(root, "figs/ok.png", b"png");
    write(
        root,
        "unused-old-draft.tex",
        "TODO everywhere \\author{Someone Else}",
    );
    write(root, ".texo/build/main.log", messy_log());
    let checks = checklist::run(root, &ReviewSetup::for_venue("neurips"));

    let pages = find(&checks, PAGE_COUNT);
    assert_eq!(
        pages.status,
        CheckStatus::Warn,
        "has a bibliography, so it may still fit: {pages:#?}"
    );
    assert!(pages.details[0].contains("12 pages") && pages.details[0].contains("page 9"));

    let authors = find(&checks, ANON_AUTHORS);
    assert_eq!(authors.status, CheckStatus::Fail);
    assert_eq!(
        (authors.file.as_deref(), authors.line),
        (Some("main.tex"), Some(5))
    );
    let all = authors.details.join("\n");
    assert!(
        all.contains("pdfauthor")
            && all.contains("Jane Doe")
            && all.contains("main.tex:7")
            && all.contains("camera-ready"),
        "{all}"
    );
    assert!(
        !all.contains("Someone Else"),
        "files the paper doesn't include are skipped"
    );

    let ack = find(&checks, ANON_ACK);
    assert_eq!(ack.status, CheckStatus::Fail);
    assert_eq!(ack.line, Some(24));

    let selfcite = find(&checks, ANON_SELF_CITE);
    assert_eq!(selfcite.status, CheckStatus::Warn);
    assert_eq!(
        selfcite.details.len(),
        1,
        "two phrases on one line count once: {selfcite:#?}"
    );
    assert_eq!(selfcite.line, Some(10));

    let links = find(&checks, ANON_LINKS);
    assert_eq!(links.status, CheckStatus::Fail);
    assert_eq!(
        links.details.len(),
        1,
        "anonymous links are fine: {links:#?}"
    );
    assert!(links.details[0].contains("github.com/janedoe"));

    let refs = find(&checks, UNDEFINED_REFS);
    assert_eq!(refs.status, CheckStatus::Fail);
    assert_eq!(refs.details.len(), 1);
    assert!(
        refs.details[0].starts_with("main.tex:12:")
            && refs.details[0].contains("fig:nothere")
            && refs.details[0].contains("2 times")
    );

    let cites = find(&checks, UNDEFINED_CITES);
    assert_eq!(cites.status, CheckStatus::Fail);
    assert!(cites.details[0].contains("'ghost'"));

    let figs = find(&checks, MISSING_FIGURES);
    assert_eq!(figs.status, CheckStatus::Fail);
    let all = figs.details.join("\n");
    assert!(all.contains("main.tex:15: 'missing-plot'"), "{all}");
    assert!(
        all.contains("sections/method.tex:4") && all.contains("does-not-exist"),
        "{all}"
    );
    assert!(!all.contains("ok.png"));

    let boxes = find(&checks, OVERFULL);
    assert_eq!(boxes.status, CheckStatus::Warn);
    assert!(
        boxes.details[0].contains("30pt"),
        "widest first: {boxes:#?}"
    );
    assert!(boxes.details.iter().any(|d| d.contains("1pt or less")));
    assert_eq!(boxes.line, Some(20));

    let bib = find(&checks, BIB_FIELDS);
    assert_eq!(bib.status, CheckStatus::Warn);
    let all = bib.details.join("\n");
    assert!(all.contains("refs.bib:1: a1 has no year"), "{all}");
    assert!(all.contains("b2 has no booktitle"), "{all}");
    assert!(!all.contains("c3") && !all.contains("notcited"), "{all}");

    let left = find(&checks, LEFTOVERS);
    assert_eq!(left.status, CheckStatus::Warn);
    let all = left.details.join("\n");
    assert!(
        all.contains("main.tex:12") && all.contains("sections/method.tex:2"),
        "{all}"
    );
    assert_eq!(left.details.len(), 2, "comments are ignored: {all}");

    let caps = find(&checks, CAPTIONS);
    assert_eq!(caps.status, CheckStatus::Warn);
    let all = caps.details.join("\n");
    assert!(
        all.contains("main.tex:14: This figure has no \\caption"),
        "{all}"
    );
    assert!(
        all.contains("main.tex:17: This table has no \\label"),
        "{all}"
    );
    assert_eq!(caps.details.len(), 2);

    let labels = find(&checks, UNUSED_LABELS);
    assert_eq!(labels.status, CheckStatus::Warn);
    let all = labels.details.join("\n");
    assert!(
        all.contains("'sec:method'") && all.contains("'eq:unused'"),
        "{all}"
    );
    assert!(!all.contains("fig:wrapped"), "\\fig wraps \\ref: {all}");

    let text = checklist::prompt_text(&checks);
    assert!(text.contains("[FAIL] Undefined citations"));
}

#[test]
fn page_limit_fails_without_references_or_appendix() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "main.tex",
        "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
    );
    write(root, ".texo/build/main.log", log_for("", Some(11)));
    let c = checklist::run(root, &ReviewSetup::for_venue("icml"));
    assert_eq!(find(&c, PAGE_COUNT).status, CheckStatus::Fail);
    // A user override.
    let mut s = ReviewSetup::for_venue("icml");
    s.page_limit = Some(12);
    assert_eq!(
        find(&checklist::run(root, &s), PAGE_COUNT).status,
        CheckStatus::Pass
    );
    // No pages at all.
    write(root, ".texo/build/main.log", log_for("", None));
    let c = checklist::run(root, &ReviewSetup::for_venue("icml"));
    assert_eq!(find(&c, PAGE_COUNT).status, CheckStatus::Fail);
    assert!(find(&c, PAGE_COUNT).details[0].contains("no pages"));
}

#[test]
fn journals_skip_anonymity_and_have_no_page_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "main.tex", "\\documentclass{article}\\author{Jane Doe}\\begin{document}our previous work\\end{document}\n");
    write(root, ".texo/build/main.log", log_for("", Some(30)));
    let c = checklist::run(root, &ReviewSetup::for_venue("elsevier"));
    assert!(
        !c.iter().any(|x| x.id.starts_with("anonymity")),
        "{:?}",
        ids(&c)
    );
    let p = find(&c, PAGE_COUNT);
    assert_eq!(p.status, CheckStatus::Pass);
    assert!(p.details[0].contains("30 pages") && p.details[0].contains("no fixed page limit"));
    // Turned on by the setup.
    let mut s = ReviewSetup::for_venue("elsevier");
    s.anonymous = Some(true);
    let c = checklist::run(root, &s);
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Fail);
    assert_eq!(find(&c, ANON_SELF_CITE).status, CheckStatus::Warn);
}

#[test]
fn without_a_compile_the_log_checks_ask_for_one_and_pdf_pages_still_count() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "main.tex",
        "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
    );
    let c = checklist::run(root, &ReviewSetup::default());
    for id in [PAGE_COUNT, UNDEFINED_REFS, UNDEFINED_CITES, OVERFULL] {
        let x = find(&c, id);
        assert_eq!(x.status, CheckStatus::Warn, "{x:#?}");
        assert!(x.details[0].contains("Compile"), "{x:#?}");
    }
    // A PDF compiled elsewhere (next to the main document), page tree in an
    // object stream.
    write(root, "main.pdf", super::pages::tests::objstm_pdf(6));
    let c = checklist::run(root, &ReviewSetup::default());
    let p = find(&c, PAGE_COUNT);
    assert_eq!(p.status, CheckStatus::Pass);
    assert!(
        p.details[0].contains("6 pages") && p.details[0].contains("compiled PDF"),
        "{p:#?}"
    );
}

#[test]
fn a_newer_pdf_wins_over_the_log_and_stale_results_say_so() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "main.tex",
        "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
    );
    write(root, ".texo/build/main.log", log_for("", Some(3)));
    write(
        root,
        ".texo/build/main.pdf",
        super::pages::tests::plain_pdf(4),
    );
    let now = SystemTime::now();
    set_mtime(root, ".texo/build/main.log", now - Duration::from_secs(600));
    set_mtime(root, ".texo/build/main.pdf", now - Duration::from_secs(60));
    set_mtime(root, "main.tex", now - Duration::from_secs(30));
    let c = checklist::run(root, &ReviewSetup::default());
    let p = find(&c, PAGE_COUNT);
    assert!(p.details[0].contains("4 pages"), "{p:#?}");
    assert!(
        p.details
            .iter()
            .any(|d| d.contains("older than your latest changes")),
        "{p:#?}"
    );
    assert!(find(&c, OVERFULL)
        .details
        .iter()
        .any(|d| d.contains("older than")));
    // Fresh compile: no stale note.
    set_mtime(root, "main.tex", now - Duration::from_secs(3000));
    let c = checklist::run(root, &ReviewSetup::default());
    assert!(!find(&c, PAGE_COUNT)
        .details
        .iter()
        .any(|d| d.contains("older than")));
}

#[test]
fn a_compile_that_stopped_early_downgrades_undefined_items_to_warnings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "main.tex",
        "\\documentclass{article}\\begin{document}\\cite{k}\\end{document}\n",
    );
    let log = "(./main.tex\nPackage natbib Warning: Citation `k' on page 1 undefined on input line 1.\n\n! Undefined control sequence.\nl.2 \\foo\n\n! Emergency stop.\n)\nNo pages of output.\n";
    write(root, ".texo/build/main.log", log);
    let c = checklist::run(root, &ReviewSetup::default());
    let cites = find(&c, UNDEFINED_CITES);
    assert_eq!(cites.status, CheckStatus::Warn, "{cites:#?}");
    assert!(cites.details.iter().any(|d| d.contains("stopped early")));
}

#[test]
fn main_in_a_subfolder_with_subimport_and_graphicspath() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "paper/main.tex",
        "\\documentclass{article}\n\\usepackage{graphicx}\n\\graphicspath{{img/}{../shared/}}\n\\begin{document}\n\\subimport{chapters/}{one}\n\\includegraphics{logo}\n\\includegraphics{common.jpg}\n\\end{document}\n",
    );
    write(
        root,
        "paper/chapters/one.tex",
        "\\subimport{deeper/}{two.tex}\nFIXME here\n",
    );
    write(
        root,
        "paper/chapters/deeper/two.tex",
        "\\includegraphics{nope}\n",
    );
    write(root, "paper/img/logo.PDF", "x");
    write(root, "shared/common.jpg", "x");
    write(root, ".texo/project.json", json!({"id": "1", "name": "p", "mainDocument": "paper/main.tex", "createdAt": "2026-01-01T00:00:00Z", "formatVersion": 1}).to_string());
    let c = checklist::run(root, &ReviewSetup::for_venue("thesis"));
    let left = find(&c, LEFTOVERS);
    assert_eq!(left.file.as_deref(), Some("paper/chapters/one.tex"));
    assert_eq!(left.line, Some(2));
    let figs = find(&c, MISSING_FIGURES);
    assert_eq!(figs.status, CheckStatus::Fail);
    assert_eq!(figs.details.len(), 1, "{figs:#?}");
    assert!(figs.details[0].starts_with("paper/chapters/deeper/two.tex:1: 'nope'"));
}

#[test]
fn review_mode_detection_for_other_styles() {
    let run_with = |pre: &str, body: &str| {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "main.tex",
            format!("{pre}\n\\begin{{document}}\n{body}\n\\end{{document}}\n"),
        );
        checklist::run(dir.path(), &ReviewSetup::for_venue("generic"))
    };
    // ICML hides names unless [accepted].
    let c = run_with(
        "\\documentclass{article}\\usepackage{icml2025}",
        "\\icmlauthor{Jane Doe}{uni}",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Pass);
    let c = run_with(
        "\\documentclass{article}\\usepackage[accepted]{icml2025}",
        "\\icmlauthor{Jane Doe}{uni}",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Fail);
    // ACL hides them only with [review].
    let c = run_with(
        "\\documentclass{article}\\usepackage[review]{acl}\\author{Jane Doe}",
        "",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Pass);
    let c = run_with(
        "\\documentclass{article}\\usepackage{acl}\\author{Jane Doe}",
        "",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Fail);
    // ICLR: \iclrfinalcopy shows them.
    let c = run_with(
        "\\documentclass{article}\\usepackage{iclr2025_conference}\\author{Jane}",
        "",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Pass);
    let c = run_with(
        "\\documentclass{article}\\usepackage{iclr2025_conference}\\iclrfinalcopy\\author{Jane}",
        "",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Fail);
    // acmart anonymous hides authors and the acks environment.
    let c = run_with(
        "\\documentclass[sigconf,anonymous,review]{acmart}\\author{Jane}",
        "\\begin{acks}Thanks\\end{acks}",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Pass);
    assert_eq!(find(&c, ANON_ACK).status, CheckStatus::Pass);
    // Plain article: placeholders are fine, names aren't.
    let c = run_with(
        "\\documentclass{article}\\author{Anonymous Author(s) \\\\ Paper ID 1234}",
        "",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Pass, "{c:#?}");
    let c = run_with(
        "\\documentclass{article}\\author{}",
        "\\begin{acknowledgements}x\\end{acknowledgements}",
    );
    assert_eq!(find(&c, ANON_AUTHORS).status, CheckStatus::Pass);
    assert_eq!(find(&c, ANON_ACK).status, CheckStatus::Fail);
}

#[test]
fn bib_without_citations_checks_every_entry_and_nocite_star_too() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "main.tex", "\\documentclass{article}\\begin{document}\\nocite{*}\\bibliography{lib/refs}\\end{document}\n");
    write(root, "lib/refs.bib", "@string{j = {J}}\n@article{x, title={T}, journal=j, year={2020}}\n@phdthesis{t, title={T}, year={2019}}\n@online{w, title={T}, date={2021}, url={https://x}}\n");
    write(root, "other.bib", "@article{ignored, title={T}}\n");
    let c = checklist::run(root, &ReviewSetup::default());
    let b = find(&c, BIB_FIELDS);
    assert_eq!(b.status, CheckStatus::Warn, "{b:#?}");
    assert_eq!(b.file.as_deref(), Some("lib/refs.bib"));
    assert!(b.details[0].contains("t has no school"), "{b:#?}");
    assert!(!b.details.join("\n").contains("ignored"));
}

#[test]
fn a_project_without_a_main_document_reads_every_tex_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "notes/a.tex", "XXX fill in\n");
    write(root, "node_modules/b.tex", "TODO skipped\n");
    let c = checklist::run(root, &ReviewSetup::default());
    let left = find(&c, LEFTOVERS);
    assert_eq!(left.details.len(), 1, "{left:#?}");
    assert_eq!(left.file.as_deref(), Some("notes/a.tex"));
    let p = find(&c, PAGE_COUNT);
    assert_eq!(p.status, CheckStatus::Warn);
    assert!(p.details[0].contains("main document"));
    assert_eq!(find(&c, UNUSED_LABELS).status, CheckStatus::Pass);
    assert_eq!(find(&c, CAPTIONS).details, ["No figures or tables."]);
}

#[test]
fn many_findings_are_capped_with_a_count() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let body: String = (0..30).map(|i| format!("\\label{{l{i}}}\n")).collect();
    write(
        root,
        "main.tex",
        format!("\\documentclass{{article}}\\begin{{document}}\n{body}\\end{{document}}\n"),
    );
    let c = checklist::run(root, &ReviewSetup::default());
    let l = find(&c, UNUSED_LABELS);
    assert!(l.details.iter().any(|d| d == "…and 18 more."), "{l:#?}");
    assert_eq!(l.line, Some(2));
}

/// Needs TeX on the PATH: `cargo test --lib -- --ignored real_pdflatex`.
#[test]
#[ignore]
fn real_pdflatex_log_and_pdf_feed_the_checklist() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "main.tex",
        "\\documentclass{article}\n\\begin{document}\nSee \\ref{nope} and \\cite{ghost}.\n\\hbox to 2in{\\hbox to 3in{x}}\n\\newpage B \\newpage C\n\\end{document}\n",
    );
    fs::create_dir_all(root.join(".texo/build")).unwrap();
    let status = std::process::Command::new("pdflatex")
        .args([
            "-interaction=nonstopmode",
            "-output-directory=.texo/build",
            "main.tex",
        ])
        .current_dir(root)
        .output()
        .expect("pdflatex");
    assert!(
        root.join(".texo/build/main.pdf").is_file(),
        "{}",
        String::from_utf8_lossy(&status.stdout)
    );
    let pdf = fs::read(root.join(".texo/build/main.pdf")).unwrap();
    assert_eq!(super::pages::from_pdf(&pdf), Some(3));
    let c = checklist::run(root, &ReviewSetup::for_venue("icml"));
    assert!(find(&c, PAGE_COUNT).details[0].contains("3 pages"));
    assert!(find(&c, UNDEFINED_REFS).details[0].contains("'nope'"));
    assert!(find(&c, UNDEFINED_CITES).details[0].contains("'ghost'"));
    let o = find(&c, OVERFULL);
    assert_eq!(o.status, CheckStatus::Warn);
    assert!(
        o.details[0].contains("main.tex:4") && o.details[0].contains("72.27pt"),
        "{o:#?}"
    );
}

#[test]
fn reference_links_keep_web_urls_only() {
    let v = json!({"references": [
        {"title": "Web", "url": "https://arxiv.org/abs/2401.00001"},
        {"title": "File", "url": "file:///C:/Windows/System32/calc.exe"},
        {"title": "Script", "url": "javascript:alert(1)"},
        {"title": "App", "url": "ms-settings:privacy"},
        {"title": "Plain http", "url": "HTTP://example.org/paper"}
    ]});
    let r = ReviewReport::from_value(&v);
    let urls: Vec<Option<&str>> = r.references.iter().map(|x| x.url.as_deref()).collect();
    assert_eq!(urls, [Some("https://arxiv.org/abs/2401.00001"), None, None, None, Some("HTTP://example.org/paper")]);
}
