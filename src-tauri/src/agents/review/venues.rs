//! Venue presets: each venue's review sections, score names and scales,
//! main-text page limit (where well known) and whether review is anonymous.
//!
//! Sources (checked 2026-11-25; venues change their forms yearly, so these
//! are starting points the user can edit in the reviewer setup):
//! - NeurIPS: reviewer guidelines, <https://neurips.cc/Conferences/2025/ReviewerGuidelines>
//!   (Quality/Clarity/Significance/Originality 1–4, Overall 1–6,
//!   Confidence 1–5, nine content pages, double-blind).
//! - ICLR: author guide <https://iclr.cc/Conferences/2025/AuthorGuide> (10
//!   pages, "Submissions and reviews are both anonymous"); the review form
//!   itself is only on OpenReview, so the scales (Soundness, Presentation,
//!   Contribution 1–4; Rating 1/3/5/6/8/10; Confidence 1–5) follow the
//!   ICLR 2024–2025 OpenReview form as published with the public reviews.
//! - ICML: reviewer instructions <https://icml.cc/Conferences/2025/ReviewerInstructions>
//!   (main-track sections, Overall recommendation 1–5) and call for papers
//!   <https://icml.cc/Conferences/2025/CallForPapers> (8 pages, double-blind).
//!   The main-track form lists no confidence scale; the generic 1–5 is used.
//! - ACL Rolling Review: review form <https://aclrollingreview.org/reviewform>
//!   (Soundness, Excitement, Overall assessment 1–5 in half points,
//!   Reproducibility, Datasets, Software 1–5, Confidence 1–5). Page limits
//!   (8 long, 4 short) are from the ACL call for papers.
//! - CVPR/ICCV: reviewer guidelines <https://cvpr.thecvf.com/Conferences/2025/ReviewerGuidelines>
//!   (anonymity). That page doesn't publish the form's scales, so the
//!   five-point rating here is an approximation of the CVPR form; 8 pages
//!   excluding references is from the CVPR author kit.
//! - IEEE Transactions, Elsevier, Springer journals and thesis committees
//!   have no single form; these rubrics follow the questions their reviewer
//!   guides commonly ask, with the usual accept / minor / major / reject
//!   decisions. These journals are usually single-anonymous (reviewers know
//!   the authors), so anonymity is off by default.

use serde::{Deserialize, Serialize};

use super::{Persona, Rubric, RubricSection, ScaleLabel, ScoreScale};

pub const GENERIC: &str = "generic";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VenueKind {
    #[default]
    Conference,
    Journal,
    Thesis,
}

/// A venue's review setup defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenuePreset {
    pub id: String,
    pub name: String,
    pub kind: VenueKind,
    pub rubric: Rubric,
    /// Pages of main text (references and appendices usually don't count).
    pub page_limit: Option<u32>,
    /// What counts toward the limit, in plain words.
    pub page_limit_note: String,
    /// Double-blind: the paper must not reveal its authors.
    pub anonymous: bool,
    /// Where the rubric comes from.
    pub source: String,
}

fn sec(id: &str, title: &str, guidance: &str) -> RubricSection {
    RubricSection {
        id: id.into(),
        title: title.into(),
        guidance: guidance.into(),
    }
}

/// A whole-number scale; `labels` highest first.
fn scale(
    id: &str,
    name: &str,
    min: f64,
    max: f64,
    labels: &[(f64, &str)],
    description: &str,
) -> ScoreScale {
    ScoreScale {
        id: id.into(),
        name: name.into(),
        min,
        max,
        step: Some(1.0),
        labels: labels
            .iter()
            .map(|(v, l)| ScaleLabel {
                value: *v,
                label: (*l).into(),
            })
            .collect(),
        description: description.into(),
    }
}

const FOUR: [(f64, &str); 4] = [
    (4.0, "excellent"),
    (3.0, "good"),
    (2.0, "fair"),
    (1.0, "poor"),
];

fn four(id: &str, name: &str, description: &str) -> ScoreScale {
    scale(id, name, 1.0, 4.0, &FOUR, description)
}

fn five(id: &str, name: &str, description: &str) -> ScoreScale {
    scale(
        id,
        name,
        1.0,
        5.0,
        &[
            (5.0, "excellent"),
            (4.0, "good"),
            (3.0, "fair"),
            (2.0, "weak"),
            (1.0, "poor"),
        ],
        description,
    )
}

fn confidence_generic() -> ScoreScale {
    scale(
        "confidence",
        "Confidence",
        1.0,
        5.0,
        &[
            (5.0, "absolutely certain; I know the related work in detail"),
            (4.0, "confident, but not absolutely certain"),
            (3.0, "fairly confident; I may have missed some parts"),
            (
                2.0,
                "willing to defend my assessment, but I may have missed central parts",
            ),
            (1.0, "an educated guess"),
        ],
        "How sure you are of your assessment.",
    )
}

const JOURNAL_DECISIONS: [&str; 4] = ["Accept", "Minor revision", "Major revision", "Reject"];

fn journal_recommendation() -> ScoreScale {
    scale(
        "recommendation",
        "Recommendation",
        1.0,
        4.0,
        &[
            (4.0, "Accept as is"),
            (3.0, "Minor revision"),
            (2.0, "Major revision"),
            (1.0, "Reject"),
        ],
        "Your recommendation to the editor.",
    )
}

fn strings(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

fn generic() -> VenuePreset {
    VenuePreset {
        id: GENERIC.into(),
        name: "Generic conference".into(),
        kind: VenueKind::Conference,
        rubric: Rubric {
            sections: vec![
                sec(
                    "summary",
                    "Summary",
                    "What the paper claims and does, in your own words.",
                ),
                sec(
                    "strengths",
                    "Strengths",
                    "What is convincing, new or useful.",
                ),
                sec(
                    "weaknesses",
                    "Weaknesses",
                    "What is missing, wrong or unclear; cite file:line for each.",
                ),
                sec(
                    "questions",
                    "Questions for the authors",
                    "What the authors should answer in their response.",
                ),
                sec(
                    "limitations",
                    "Limitations",
                    "Whether limitations and possible negative impact are discussed.",
                ),
            ],
            scores: vec![
                four(
                    "soundness",
                    "Soundness",
                    "Are the claims supported by the method, proofs and experiments?",
                ),
                four(
                    "presentation",
                    "Presentation",
                    "Is the paper clear and well organised?",
                ),
                four(
                    "contribution",
                    "Contribution",
                    "How new and significant are the results?",
                ),
                scale(
                    "overall",
                    "Overall",
                    1.0,
                    5.0,
                    &[
                        (5.0, "Strong accept"),
                        (4.0, "Weak accept"),
                        (3.0, "Borderline"),
                        (2.0, "Weak reject"),
                        (1.0, "Strong reject"),
                    ],
                    "Your overall recommendation.",
                ),
            ],
            confidence: Some(confidence_generic()),
            decisions: strings(&[
                "Accept",
                "Weak accept",
                "Borderline",
                "Weak reject",
                "Reject",
            ]),
        },
        page_limit: None,
        page_limit_note: "Check the call for papers for the page limit.".into(),
        anonymous: true,
        source: "Texo's generic rubric, modelled on common ML/CS conference forms.".into(),
    }
}

fn neurips() -> VenuePreset {
    VenuePreset {
        id: "neurips".into(),
        name: "NeurIPS".into(),
        kind: VenueKind::Conference,
        rubric: Rubric {
            sections: vec![
                sec("summary", "Summary", "Briefly restate the paper's contributions in your own words."),
                sec(
                    "strengths-weaknesses",
                    "Strengths and weaknesses",
                    "A thorough assessment of quality, clarity, significance and originality.",
                ),
                sec(
                    "questions",
                    "Questions",
                    "3–5 actionable questions or suggestions, and what would raise or lower your score.",
                ),
                sec(
                    "limitations",
                    "Limitations",
                    "Do the authors adequately address limitations and potential negative societal impact? If not, suggest how.",
                ),
                sec("ethics", "Ethical concerns", "Flag the paper for ethics review if there are issues."),
            ],
            scores: vec![
                four("quality", "Quality", "Technical soundness: are the claims well supported?"),
                four("clarity", "Clarity", "Is the paper clearly written and well organised?"),
                four("significance", "Significance", "Are the results important to the community?"),
                four("originality", "Originality", "Does the work provide new insights or methods?"),
                scale(
                    "overall",
                    "Overall",
                    1.0,
                    6.0,
                    &[
                        (6.0, "Strong Accept"),
                        (5.0, "Accept"),
                        (4.0, "Borderline accept"),
                        (3.0, "Borderline reject"),
                        (2.0, "Reject"),
                        (1.0, "Strong Reject"),
                    ],
                    "Your overall recommendation.",
                ),
            ],
            confidence: Some(scale(
                "confidence",
                "Confidence",
                1.0,
                5.0,
                &[
                    (5.0, "absolutely certain"),
                    (4.0, "confident but not absolutely certain"),
                    (3.0, "fairly confident"),
                    (2.0, "willing to defend, but likely missed central parts"),
                    (1.0, "educated guess"),
                ],
                "How sure you are of your assessment.",
            )),
            decisions: strings(&["Accept", "Borderline accept", "Borderline reject", "Reject"]),
        },
        page_limit: Some(9),
        page_limit_note: "Nine content pages including figures and tables; references, appendices and the paper checklist don't count."
            .into(),
        anonymous: true,
        source: "https://neurips.cc/Conferences/2025/ReviewerGuidelines".into(),
    }
}

fn iclr() -> VenuePreset {
    let rating = ScoreScale {
        id: "rating".into(),
        name: "Rating".into(),
        min: 1.0,
        max: 10.0,
        step: None,
        labels: [
            (
                10.0,
                "strong accept, should be highlighted at the conference",
            ),
            (8.0, "accept, good paper"),
            (6.0, "marginally above the acceptance threshold"),
            (5.0, "marginally below the acceptance threshold"),
            (3.0, "reject, not good enough"),
            (1.0, "strong reject"),
        ]
        .iter()
        .map(|(v, l)| ScaleLabel {
            value: *v,
            label: (*l).into(),
        })
        .collect(),
        description: "Your overall rating (only the listed values).".into(),
    };
    VenuePreset {
        id: "iclr".into(),
        name: "ICLR".into(),
        kind: VenueKind::Conference,
        rubric: Rubric {
            sections: vec![
                sec("summary", "Summary", "What the paper claims to contribute."),
                sec("strengths", "Strengths", "Strong points of the paper."),
                sec("weaknesses", "Weaknesses", "Weak points, with the key reasons for your recommendation."),
                sec("questions", "Questions", "Questions whose answers could change your opinion."),
                sec("feedback", "Additional feedback", "Suggestions to improve the paper, not part of the decision."),
            ],
            scores: vec![
                four("soundness", "Soundness", "Are the claims supported?"),
                four("presentation", "Presentation", "Is the paper clearly written?"),
                four("contribution", "Contribution", "How significant is the contribution?"),
                rating,
            ],
            confidence: Some(confidence_generic()),
            decisions: strings(&["Accept (oral)", "Accept (poster)", "Reject"]),
        },
        page_limit: Some(10),
        page_limit_note: "Ten pages of main text; references and appendices don't count.".into(),
        anonymous: true,
        source: "https://iclr.cc/Conferences/2025/AuthorGuide (page limit, anonymity); ICLR 2024–2025 OpenReview form (scales)"
            .into(),
    }
}

fn icml() -> VenuePreset {
    VenuePreset {
        id: "icml".into(),
        name: "ICML".into(),
        kind: VenueKind::Conference,
        rubric: Rubric {
            sections: vec![
                sec("summary", "Summary", "The main findings and contributions."),
                sec("claims-evidence", "Claims and evidence", "Are the claims supported by clear and convincing evidence?"),
                sec("prior-work", "Relation to prior works", "How the paper relates to the literature; missing related work."),
                sec("other", "Other aspects", "Other strengths and weaknesses: originality, significance, clarity."),
                sec("questions", "Questions for authors", "Questions whose answers could change your evaluation."),
                sec("ethics", "Ethical issues", "Any ethical concerns."),
            ],
            scores: vec![scale(
                "overall",
                "Overall recommendation",
                1.0,
                5.0,
                &[(5.0, "Strong accept"), (4.0, "Accept"), (3.0, "Weak accept"), (2.0, "Weak reject"), (1.0, "Reject")],
                "Your overall recommendation.",
            )],
            confidence: Some(confidence_generic()),
            decisions: strings(&["Accept", "Weak accept", "Weak reject", "Reject"]),
        },
        page_limit: Some(8),
        page_limit_note: "Eight pages for the main paper; references, impact statement and appendices don't count.".into(),
        anonymous: true,
        source: "https://icml.cc/Conferences/2025/ReviewerInstructions; https://icml.cc/Conferences/2025/CallForPapers".into(),
    }
}

fn arr() -> VenuePreset {
    let half = |id: &str, name: &str, labels: &[(f64, &str)], d: &str| {
        let mut s = scale(id, name, 1.0, 5.0, labels, d);
        s.step = Some(0.5);
        s
    };
    VenuePreset {
        id: "acl".into(),
        name: "ACL / ARR".into(),
        kind: VenueKind::Conference,
        rubric: Rubric {
            sections: vec![
                sec("summary", "Paper summary", "What the paper is about and what it contributes."),
                sec("strengths", "Summary of strengths", "The main reasons to accept."),
                sec("weaknesses", "Summary of weaknesses", "The main reasons not to accept; cite file:line for each."),
                sec("comments", "Comments, suggestions and typos", "Smaller points that would improve the paper."),
                sec("limitations", "Limitations and societal impact", "Are limitations and risks discussed?"),
                sec("ethics", "Ethical concerns", "Any ethical concerns."),
            ],
            scores: vec![
                half(
                    "soundness",
                    "Soundness",
                    &[(5.0, "Excellent"), (4.0, "Strong"), (3.0, "Acceptable"), (2.0, "Poor"), (1.0, "Major Issues")],
                    "How well the claims are supported.",
                ),
                half(
                    "excitement",
                    "Excitement",
                    &[
                        (5.0, "Highly Exciting"),
                        (4.0, "Exciting"),
                        (3.0, "Interesting"),
                        (2.0, "Potentially Interesting"),
                        (1.0, "Not Exciting"),
                    ],
                    "How exciting the paper is to the community.",
                ),
                half(
                    "overall",
                    "Overall assessment",
                    &[
                        (5.0, "Consider for Award"),
                        (4.5, "Borderline Award"),
                        (4.0, "Conference"),
                        (3.5, "Borderline Conference"),
                        (3.0, "Findings"),
                        (2.5, "Borderline Findings"),
                        (2.0, "Resubmit next cycle"),
                        (1.5, "Resubmit after next cycle"),
                        (1.0, "Do not resubmit"),
                    ],
                    "Where the paper belongs.",
                ),
                scale(
                    "reproducibility",
                    "Reproducibility",
                    1.0,
                    5.0,
                    &[
                        (5.0, "could easily reproduce the results"),
                        (4.0, "could mostly reproduce the results"),
                        (3.0, "could reproduce the results with some difficulty"),
                        (2.0, "would be hard pressed to reproduce the results"),
                        (1.0, "could not reproduce the results"),
                    ],
                    "Could others reproduce the results?",
                ),
                scale(
                    "datasets",
                    "Datasets",
                    1.0,
                    5.0,
                    &[(5.0, "Enabling"), (4.0, "Useful"), (3.0, "Potentially useful"), (2.0, "Documentary"), (1.0, "No usable datasets submitted")],
                    "Value of any released datasets.",
                ),
                scale(
                    "software",
                    "Software",
                    1.0,
                    5.0,
                    &[(5.0, "Enabling"), (4.0, "Useful"), (3.0, "Potentially useful"), (2.0, "Documentary"), (1.0, "No usable software released")],
                    "Value of any released software.",
                ),
            ],
            confidence: Some(scale(
                "confidence",
                "Reviewer confidence",
                1.0,
                5.0,
                &[
                    (5.0, "Positive that my evaluation is correct"),
                    (4.0, "Quite sure"),
                    (3.0, "Pretty sure"),
                    (2.0, "Willing to defend my evaluation"),
                    (1.0, "Not my area"),
                ],
                "How sure you are of your assessment.",
            )),
            decisions: strings(&["Main conference", "Findings", "Resubmit next cycle", "Do not resubmit"]),
        },
        page_limit: Some(8),
        page_limit_note: "Eight pages for long papers (four for short papers); references, limitations and appendices don't count."
            .into(),
        anonymous: true,
        source: "https://aclrollingreview.org/reviewform".into(),
    }
}

fn cvpr() -> VenuePreset {
    VenuePreset {
        id: "cvpr".into(),
        name: "CVPR / ICCV".into(),
        kind: VenueKind::Conference,
        rubric: Rubric {
            sections: vec![
                sec("summary", "Summary", "What the paper proposes and claims."),
                sec("strengths", "Strengths", "Novelty, technical quality and experimental evidence."),
                sec("weaknesses", "Weaknesses", "Missing comparisons, unclear parts, unsupported claims; cite file:line."),
                sec("justification", "Justification of rating", "The key reasons behind your rating."),
                sec("questions", "Questions for the rebuttal", "What the authors should address in their rebuttal."),
            ],
            scores: vec![scale(
                "rating",
                "Rating",
                1.0,
                5.0,
                &[(5.0, "Accept"), (4.0, "Weak accept"), (3.0, "Borderline"), (2.0, "Weak reject"), (1.0, "Reject")],
                "Your overall rating (approximation of the CVPR form).",
            )],
            confidence: Some(confidence_generic()),
            decisions: strings(&["Accept", "Weak accept", "Borderline", "Weak reject", "Reject"]),
        },
        page_limit: Some(8),
        page_limit_note: "Eight pages excluding references.".into(),
        anonymous: true,
        source: "https://cvpr.thecvf.com/Conferences/2025/ReviewerGuidelines (anonymity); rating scale approximated".into(),
    }
}

fn journal(id: &str, name: &str, source: &str) -> VenuePreset {
    VenuePreset {
        id: id.into(),
        name: name.into(),
        kind: VenueKind::Journal,
        rubric: Rubric {
            sections: vec![
                sec("summary", "Summary", "What the manuscript does and claims."),
                sec(
                    "relevance",
                    "Relevance and novelty",
                    "Does it fit the journal's scope, and what is new compared with prior work?",
                ),
                sec(
                    "soundness",
                    "Technical soundness",
                    "Are the methods, proofs and experiments correct and sufficient?",
                ),
                sec(
                    "presentation",
                    "Presentation",
                    "Structure, language, figures and tables.",
                ),
                sec(
                    "references",
                    "References",
                    "Is the related work complete and fairly discussed?",
                ),
                sec(
                    "comments",
                    "Detailed comments to the authors",
                    "Numbered points the authors must address in a revision.",
                ),
            ],
            scores: vec![
                five("relevance", "Relevance", "Fit to the journal's scope."),
                five("novelty", "Novelty", "Originality of the contribution."),
                five("technical", "Technical quality", "Correctness and rigour."),
                five(
                    "presentation",
                    "Presentation",
                    "Clarity of writing and figures.",
                ),
                journal_recommendation(),
            ],
            confidence: Some(confidence_generic()),
            decisions: strings(&JOURNAL_DECISIONS),
        },
        page_limit: None,
        page_limit_note: "Journals set their own length rules; check the guide for authors.".into(),
        anonymous: false,
        source: source.into(),
    }
}

fn thesis() -> VenuePreset {
    VenuePreset {
        id: "thesis".into(),
        name: "Thesis committee".into(),
        kind: VenueKind::Thesis,
        rubric: Rubric {
            sections: vec![
                sec(
                    "summary",
                    "Summary",
                    "The research questions and the main results.",
                ),
                sec(
                    "contribution",
                    "Contribution",
                    "What is original, and is it enough for the degree?",
                ),
                sec(
                    "literature",
                    "Literature review",
                    "Is the background complete and critically discussed?",
                ),
                sec(
                    "methods",
                    "Methods",
                    "Are the methods appropriate, justified and correctly applied?",
                ),
                sec(
                    "results",
                    "Results and analysis",
                    "Do the results answer the research questions?",
                ),
                sec(
                    "writing",
                    "Writing and structure",
                    "Clarity, structure, figures, references.",
                ),
                sec(
                    "defence",
                    "Questions for the defence",
                    "What the candidate should be ready to answer.",
                ),
            ],
            scores: vec![
                five(
                    "originality",
                    "Originality",
                    "Original contribution to knowledge.",
                ),
                five(
                    "literature",
                    "Command of the literature",
                    "Depth and critical use of prior work.",
                ),
                five(
                    "rigour",
                    "Methodological rigour",
                    "Soundness of methods and analysis.",
                ),
                five(
                    "results",
                    "Quality of results",
                    "Strength and significance of the findings.",
                ),
                five("writing", "Writing", "Clarity and structure."),
            ],
            confidence: Some(confidence_generic()),
            decisions: strings(&[
                "Pass",
                "Pass with minor corrections",
                "Major corrections",
                "Revise and resubmit",
                "Fail",
            ]),
        },
        page_limit: None,
        page_limit_note: "Check your university's regulations for length limits.".into(),
        anonymous: false,
        source: "Texo's rubric, modelled on common doctoral examination report forms.".into(),
    }
}

/// All presets, in menu order.
pub fn presets() -> Vec<VenuePreset> {
    vec![
        generic(),
        neurips(),
        iclr(),
        icml(),
        arr(),
        cvpr(),
        journal(
            "ieee-transactions",
            "IEEE Transactions journal",
            "Texo's rubric, modelled on IEEE Transactions reviewer forms (questions vary by journal).",
        ),
        journal("elsevier", "Elsevier journal", "Texo's rubric, modelled on Elsevier's reviewer guidance (questions vary by journal)."),
        journal("springer", "Springer journal", "Texo's rubric, modelled on Springer Nature's reviewer guidance (questions vary by journal)."),
        thesis(),
    ]
}

/// A preset by id (case-insensitive; `arr`, `iccv`, `ieee` and a few other
/// common names also work).
pub fn preset(id: &str) -> Option<VenuePreset> {
    let id = id.trim().to_lowercase();
    let id = match id.as_str() {
        "arr" | "acl/arr" | "acl-arr" | "emnlp" | "naacl" => "acl",
        "iccv" | "cvpr/iccv" | "eccv" => "cvpr",
        "ieee" | "ieee-tpami" | "tpami" => "ieee-transactions",
        "conference" | "" => GENERIC,
        other => other,
    };
    presets().into_iter().find(|p| p.id == id)
}

pub fn preset_or_generic(id: &str) -> VenuePreset {
    preset(id).unwrap_or_else(generic)
}

/// The five built-in reviewer personas.
pub fn default_personas() -> Vec<Persona> {
    let p = |id: &str, name: &str, focus: &str| Persona {
        id: id.into(),
        name: name.into(),
        focus: focus.into(),
    };
    vec![
        p(
            "methods",
            "Methods",
            "Soundness of the method, proofs and experiments: baselines, ablations, statistics, whether the evidence supports each claim.",
        ),
        p("clarity", "Clarity", "Writing, structure, notation, figures and tables: could a newcomer to the area follow the paper?"),
        p("novelty", "Novelty", "What is new compared with prior work; missing related work; whether the contribution is significant."),
        p(
            "reproducibility",
            "Reproducibility",
            "Whether the paper gives enough detail (data, hyperparameters, code, compute) for others to reproduce the results.",
        ),
        p(
            "domain",
            "Domain expert",
            "An expert in the paper's specific field: correctness of domain claims, use of standard benchmarks and terminology.",
        ),
    ]
}
