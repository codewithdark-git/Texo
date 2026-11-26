//! The reviewer's deterministic parts: venue presets, the reviewer setup
//! (`ReviewSetup`), the review report (`ReviewReport`) and the checklist that
//! runs without the AI (page count, anonymity, undefined references, missing
//! figures, overfull boxes, `.bib` fields, leftovers, captions, labels).
//!
//! Commands: `review_presets() -> VenuePreset[]` and
//! `review_checklist(project, setup?) -> Check[]`. The reviewer kind calls
//! [`checklist::run`] directly and puts [`checklist::prompt_text`] into the
//! reviewers' prompt; its `submit_report` output is read back with
//! [`ReviewReport::from_report`], which tolerates the loose JSON open models
//! write.

// The reviewer kind (kinds/reviewer.rs) doesn't drive the ensemble with
// these yet; until it does, only the commands use part of this module.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

pub mod checklist;
mod pages;
mod scan;
pub mod venues;

#[cfg(test)]
mod tests;

pub use venues::{presets, VenuePreset};

/// The `kind` of a review [`crate::agents::types::Report`].
pub const REPORT_KIND: &str = "review";
pub const MIN_REVIEWERS: u8 = 1;
pub const MAX_REVIEWERS: u8 = 5;
const MAX_FOCUS_CHARS: usize = 2000;

// ---------------------------------------------------------------------------
// Rubric
// ---------------------------------------------------------------------------

/// A section the written review has (e.g. "Strengths and weaknesses").
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RubricSection {
    pub id: String,
    pub title: String,
    /// What the reviewer writes there.
    #[serde(default)]
    pub guidance: String,
}

/// One point of a score scale.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleLabel {
    pub value: f64,
    pub label: String,
}

/// A score the reviewer gives (e.g. Soundness 1–4).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreScale {
    /// The key in `Review.scores` (e.g. `soundness`).
    pub id: String,
    pub name: String,
    pub min: f64,
    pub max: f64,
    /// Allowed steps between `min` and `max` (e.g. 0.5). `None`: only the
    /// values in `labels` are allowed (ICLR's 1, 3, 5, 6, 8, 10).
    #[serde(default)]
    pub step: Option<f64>,
    /// Labelled points, highest first.
    #[serde(default)]
    pub labels: Vec<ScaleLabel>,
    #[serde(default)]
    pub description: String,
}

impl ScoreScale {
    /// The nearest allowed value, or `None` for a value that isn't a number.
    pub fn snap(&self, v: f64) -> Option<f64> {
        if !v.is_finite() {
            return None;
        }
        let (lo, hi) = if self.min <= self.max {
            (self.min, self.max)
        } else {
            (self.max, self.min)
        };
        let v = v.clamp(lo, hi);
        match self.step {
            Some(step) if step > 0.0 => Some((lo + ((v - lo) / step).round() * step).clamp(lo, hi)),
            _ if !self.labels.is_empty() => self
                .labels
                .iter()
                .map(|l| l.value)
                .min_by(|a, b| (a - v).abs().total_cmp(&(b - v).abs())),
            _ => Some(v.round()),
        }
    }

    /// The label of a value ("Accept"), when it has one.
    #[allow(dead_code)] // kept for a future score display in Rust exports
    pub fn label_of(&self, v: f64) -> Option<&str> {
        self.labels
            .iter()
            .find(|l| (l.value - v).abs() < 1e-9)
            .map(|l| l.label.as_str())
    }

    /// One line for a prompt: `Soundness (soundness): 1–4; 4 = excellent, …`.
    pub fn prompt_line(&self) -> String {
        let mut s = format!(
            "{} (`{}`): {}–{}",
            self.name,
            self.id,
            fmt_num(self.min),
            fmt_num(self.max)
        );
        match self.step {
            Some(step) if (step - 1.0).abs() > 1e-9 => {
                s.push_str(&format!(" in steps of {}", fmt_num(step)))
            }
            None if !self.labels.is_empty() => s.push_str(" (only the listed values)"),
            _ => {}
        }
        if !self.labels.is_empty() {
            let labels: Vec<String> = self
                .labels
                .iter()
                .map(|l| format!("{} = {}", fmt_num(l.value), l.label))
                .collect();
            s.push_str("; ");
            s.push_str(&labels.join(", "));
        }
        s
    }
}

pub(crate) fn fmt_num(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v}")
    }
}

/// What a review covers and how it is scored.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rubric {
    #[serde(default)]
    pub sections: Vec<RubricSection>,
    #[serde(default)]
    pub scores: Vec<ScoreScale>,
    /// How sure the reviewer is (`Review.confidence`).
    #[serde(default)]
    pub confidence: Option<ScoreScale>,
    /// The recommendations the meta-review picks from, best first.
    #[serde(default)]
    pub decisions: Vec<String>,
}

impl Rubric {
    pub fn is_empty(&self) -> bool {
        self.sections.is_empty() && self.scores.is_empty()
    }
}

// ---------------------------------------------------------------------------
// ReviewSetup
// ---------------------------------------------------------------------------

/// A reviewer's point of view (methods, clarity, …). Editable.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Persona {
    pub id: String,
    pub name: String,
    /// What this reviewer looks at, in plain words (goes into its prompt).
    #[serde(default)]
    pub focus: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strictness {
    Lenient,
    #[default]
    Balanced,
    Harsh,
}

impl Strictness {
    /// The line the reviewer prompt gets.
    pub fn prompt_line(self) -> &'static str {
        match self {
            Strictness::Lenient => "Be encouraging: point out problems, but give the benefit of the doubt on borderline points.",
            Strictness::Balanced => "Be fair and balanced, like a careful reviewer at the venue.",
            Strictness::Harsh => "Be demanding, like the toughest reviewer at the venue: question every claim that isn't backed by evidence.",
        }
    }
}

fn default_venue() -> String {
    venues::GENERIC.to_string()
}
fn default_reviewers() -> u8 {
    3
}
fn yes() -> bool {
    true
}

/// A reviewer setup: which venue, rubric, how many reviewers and who they
/// are. Stored in a profile's `review` field and sent as the reviewer run's
/// `options.extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSetup {
    /// A preset id from [`presets`] (`neurips`, `iclr`, …).
    #[serde(default = "default_venue")]
    pub venue: String,
    /// Empty: the venue's rubric.
    #[serde(default)]
    pub rubric: Rubric,
    /// 1–5.
    #[serde(default = "default_reviewers")]
    pub reviewers: u8,
    /// One per reviewer; missing ones are filled from the defaults.
    #[serde(default)]
    pub personas: Vec<Persona>,
    #[serde(default)]
    pub strictness: Strictness,
    /// Search the literature to judge novelty.
    #[serde(default = "yes")]
    pub ground_novelty: bool,
    /// Run the deterministic checklist first.
    #[serde(default = "yes")]
    pub checklist: bool,
    /// Free text: what the user wants the reviewers to look at.
    #[serde(default)]
    pub focus: String,
    /// Overrides the venue's page limit (main text pages). Extra to the spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_limit: Option<u32>,
    /// Overrides whether the venue reviews anonymously. Extra to the spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anonymous: Option<bool>,
}

impl Default for ReviewSetup {
    fn default() -> Self {
        ReviewSetup::for_venue(venues::GENERIC)
    }
}

impl ReviewSetup {
    /// The preset's setup: its rubric, three reviewers with the first three
    /// default personas, balanced, literature and checklist on.
    pub fn for_venue(id: &str) -> ReviewSetup {
        let p = venues::preset_or_generic(id);
        ReviewSetup {
            venue: p.id.clone(),
            rubric: p.rubric.clone(),
            reviewers: default_reviewers(),
            personas: venues::default_personas()
                .into_iter()
                .take(default_reviewers() as usize)
                .collect(),
            strictness: Strictness::Balanced,
            ground_novelty: true,
            checklist: true,
            focus: String::new(),
            page_limit: None,
            anonymous: None,
        }
    }

    /// The venue preset (generic when the id is unknown).
    pub fn preset(&self) -> VenuePreset {
        venues::preset_or_generic(&self.venue)
    }

    /// Main-text page limit: the override, else the venue's.
    pub fn page_limit(&self) -> Option<u32> {
        self.page_limit
            .filter(|n| *n > 0)
            .or(self.preset().page_limit)
    }

    /// Whether author identity must be hidden.
    pub fn anonymous(&self) -> bool {
        self.anonymous.unwrap_or(self.preset().anonymous)
    }

    /// A usable copy: a known venue, 1–5 reviewers, one persona each (from
    /// the defaults when missing), the venue's rubric when empty, focus
    /// capped.
    pub fn normalized(&self) -> ReviewSetup {
        let mut s = self.clone();
        let p = s.preset();
        s.venue = p.id.clone();
        s.reviewers = s.reviewers.clamp(MIN_REVIEWERS, MAX_REVIEWERS);
        if s.rubric.is_empty() {
            let decisions = std::mem::take(&mut s.rubric.decisions);
            s.rubric = p.rubric.clone();
            if !decisions.is_empty() {
                s.rubric.decisions = decisions;
            }
        }
        if s.rubric.confidence.is_none() {
            s.rubric.confidence = p.rubric.confidence.clone();
        }
        if s.rubric.decisions.is_empty() {
            s.rubric.decisions = p.rubric.decisions.clone();
        }
        s.personas
            .retain(|x| !x.name.trim().is_empty() || !x.focus.trim().is_empty());
        for (i, x) in s.personas.iter_mut().enumerate() {
            if x.id.trim().is_empty() {
                x.id = format!("reviewer-{}", i + 1);
            }
            if x.name.trim().is_empty() {
                x.name = format!("Reviewer {}", i + 1);
            }
        }
        let defaults = venues::default_personas();
        let taken: Vec<String> = s.personas.iter().map(|x| x.id.clone()).collect();
        let mut extra = defaults.into_iter().filter(|d| !taken.contains(&d.id));
        while s.personas.len() < s.reviewers as usize {
            match extra.next() {
                Some(d) => s.personas.push(d),
                None => {
                    let n = s.personas.len() + 1;
                    s.personas.push(Persona {
                        id: format!("reviewer-{n}"),
                        name: format!("Reviewer {n}"),
                        focus: String::new(),
                    });
                }
            }
        }
        s.personas.truncate(s.reviewers as usize);
        if s.focus.chars().count() > MAX_FOCUS_CHARS {
            s.focus = s.focus.chars().take(MAX_FOCUS_CHARS).collect();
        }
        s
    }

    /// Reads a setup from a run's `options.extra` (either the setup itself or
    /// `{review: setup}`); `None` when there is none or it doesn't parse.
    pub fn from_extra(extra: Option<&Value>) -> Option<ReviewSetup> {
        let v = extra?;
        let v = v.get("review").filter(|r| r.is_object()).unwrap_or(v);
        if !v.is_object() {
            return None;
        }
        serde_json::from_value(v.clone()).ok()
    }

    /// The rubric part of a reviewer's prompt.
    pub fn rubric_prompt(&self) -> String {
        let s = self.normalized();
        let p = s.preset();
        let mut out = format!("Venue: {}.\n", p.name);
        if let Some(n) = s.page_limit() {
            out.push_str(&format!(
                "Page limit: {n} pages of main text. {}\n",
                p.page_limit_note
            ));
        }
        if s.anonymous() {
            out.push_str("Review is anonymous: the paper must not reveal who wrote it.\n");
        }
        out.push_str(s.strictness.prompt_line());
        out.push('\n');
        if !s.rubric.sections.is_empty() {
            out.push_str("Sections of your review:\n");
            for (i, sec) in s.rubric.sections.iter().enumerate() {
                out.push_str(&format!("{}. {}", i + 1, sec.title));
                if !sec.guidance.is_empty() {
                    out.push_str(&format!(": {}", sec.guidance));
                }
                out.push('\n');
            }
        }
        if !s.rubric.scores.is_empty() {
            out.push_str("Scores (put them in \"scores\" by their key):\n");
            for sc in &s.rubric.scores {
                out.push_str(&format!("- {}\n", sc.prompt_line()));
            }
        }
        if let Some(c) = &s.rubric.confidence {
            out.push_str(&format!(
                "Confidence (\"confidence\"): {}\n",
                c.prompt_line()
            ));
        }
        if !s.focus.trim().is_empty() {
            out.push_str(&format!(
                "The author asks you to focus on: {}\n",
                s.focus.trim()
            ));
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Checklist results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    #[default]
    Pass,
    Warn,
    Fail,
}

/// One checklist item. `details` are plain sentences, usually starting with
/// `file:line:`; `file`/`line` point at the first finding.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: String,
    pub title: String,
    pub status: CheckStatus,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
}

// ---------------------------------------------------------------------------
// ReviewReport
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WeaknessSeverity {
    Major,
    #[default]
    Minor,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weakness {
    pub text: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub severity: WeaknessSeverity,
}

/// One reviewer's review.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// The persona's name.
    pub persona: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub strengths: Vec<String>,
    #[serde(default)]
    pub weaknesses: Vec<Weakness>,
    #[serde(default)]
    pub questions: Vec<String>,
    /// By score id (see the rubric).
    #[serde(default)]
    pub scores: BTreeMap<String, f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

/// Lowest, highest and mean of one score over the reviews.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreSpread {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
}

/// The area chair's meta-review.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaReview {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    pub must_fix: Vec<String>,
    #[serde(default)]
    pub nice_to_fix: Vec<String>,
    /// Points the reviewers agree on. Extra to the spec's minimum.
    #[serde(default)]
    pub consensus: Vec<String>,
    /// Points they disagree on. Extra to the spec's minimum.
    #[serde(default)]
    pub disagreements: Vec<String>,
    /// Computed from the reviews by [`score_spread`], not by the model.
    #[serde(default)]
    pub score_spread: BTreeMap<String, ScoreSpread>,
}

/// A paper the reviewers looked up (e.g. for novelty).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportReference {
    pub title: String,
    #[serde(default)]
    pub authors: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub venue: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub arxiv_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// Why it matters to this paper.
    #[serde(default)]
    pub note: Option<String>,
}

/// `Report { kind: review, venue, checklist[], reviews[], meta, references[] }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReport {
    pub kind: String,
    /// The venue preset id.
    pub venue: String,
    #[serde(default)]
    pub checklist: Vec<Check>,
    #[serde(default)]
    pub reviews: Vec<Review>,
    #[serde(default)]
    pub meta: MetaReview,
    #[serde(default)]
    pub references: Vec<ReportReference>,
}

impl Default for ReviewReport {
    fn default() -> Self {
        ReviewReport {
            kind: REPORT_KIND.to_string(),
            venue: venues::GENERIC.to_string(),
            checklist: Vec::new(),
            reviews: Vec::new(),
            meta: MetaReview::default(),
            references: Vec::new(),
        }
    }
}

/// Per score id: min, max and mean over the reviews that gave it.
pub fn score_spread(reviews: &[Review]) -> BTreeMap<String, ScoreSpread> {
    let mut all: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for r in reviews {
        for (k, v) in &r.scores {
            if v.is_finite() {
                all.entry(k.clone()).or_default().push(*v);
            }
        }
    }
    all.into_iter()
        .map(|(k, vs)| {
            let min = vs.iter().copied().fold(f64::INFINITY, f64::min);
            let max = vs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let mean = vs.iter().sum::<f64>() / vs.len() as f64;
            (
                k,
                ScoreSpread {
                    min,
                    max,
                    mean: (mean * 100.0).round() / 100.0,
                },
            )
        })
        .collect()
}

impl ReviewReport {
    /// As the runtime's generic report.
    pub fn to_report(&self) -> crate::agents::types::Report {
        let mut data = match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        data.remove("kind");
        crate::agents::types::Report {
            kind: REPORT_KIND.to_string(),
            data,
        }
    }

    /// Reads a review from a generic report, leniently (see [`Self::from_value`]).
    pub fn from_report(report: &crate::agents::types::Report) -> ReviewReport {
        let mut v = Value::Object(report.data.clone());
        v["kind"] = Value::String(REPORT_KIND.into());
        ReviewReport::from_value(&v)
    }

    /// Reads a review from model-written JSON. Tolerates numbers as strings
    /// ("4", "4/5"), lines as "12" or "12-14", file given as "a.tex:12",
    /// weaknesses or strengths as plain strings, a single review instead of
    /// `reviews`, and unknown fields. Never fails: missing parts are empty.
    pub fn from_value(v: &Value) -> ReviewReport {
        let mut r = ReviewReport {
            venue: str_of(v.get("venue")).unwrap_or_else(|| venues::GENERIC.to_string()),
            ..ReviewReport::default()
        };
        if let Some(Value::Array(items)) = v.get("checklist") {
            r.checklist = items
                .iter()
                .filter_map(|c| serde_json::from_value(c.clone()).ok())
                .collect();
        }
        match v.get("reviews") {
            Some(Value::Array(items)) => {
                r.reviews = items
                    .iter()
                    .filter(|x| x.is_object())
                    .map(review_of)
                    .collect()
            }
            Some(o @ Value::Object(_)) => r.reviews = vec![review_of(o)],
            _ if v.get("weaknesses").is_some()
                || v.get("strengths").is_some()
                || v.get("scores").is_some() =>
            {
                r.reviews = vec![review_of(v)];
            }
            _ => {}
        }
        if let Some(m) = v.get("meta").filter(|m| m.is_object()) {
            r.meta = MetaReview {
                summary: str_of(m.get("summary")).unwrap_or_default(),
                decision: str_of(m.get("decision").or(m.get("recommendation"))).unwrap_or_default(),
                must_fix: strings_of(m.get("mustFix").or(m.get("must_fix"))),
                nice_to_fix: strings_of(m.get("niceToFix").or(m.get("nice_to_fix"))),
                consensus: strings_of(m.get("consensus")),
                disagreements: strings_of(m.get("disagreements")),
                score_spread: BTreeMap::new(),
            };
        }
        r.meta.score_spread = score_spread(&r.reviews);
        if let Some(Value::Array(items)) = v.get("references") {
            r.references = items.iter().filter_map(reference_of).collect();
        }
        r
    }

    /// Snaps scores and confidence to the rubric's scales and drops scores
    /// the rubric doesn't have (when it has any), then recomputes the spread.
    pub fn conform(&mut self, rubric: &Rubric) {
        for rev in &mut self.reviews {
            if !rubric.scores.is_empty() {
                let mut kept = BTreeMap::new();
                for (k, v) in &rev.scores {
                    let id = norm_id(k);
                    if let Some(sc) = rubric
                        .scores
                        .iter()
                        .find(|s| norm_id(&s.id) == id || norm_id(&s.name) == id)
                    {
                        if let Some(x) = sc.snap(*v) {
                            kept.insert(sc.id.clone(), x);
                        }
                    }
                }
                rev.scores = kept;
            }
            if let (Some(c), Some(scale)) = (rev.confidence, &rubric.confidence) {
                rev.confidence = scale.snap(c);
            }
        }
        self.meta.score_spread = score_spread(&self.reviews);
    }
}

fn norm_id(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn str_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Object(o) => str_of(o.get("text").or(o.get("summary")).or(o.get("title"))),
        _ => None,
    }
}

fn strings_of(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items.iter().filter_map(|x| str_of(Some(x))).collect(),
        Some(Value::String(s)) => s
            .lines()
            .map(|l| {
                l.trim()
                    .trim_start_matches(['-', '*', '•'])
                    .trim()
                    .to_string()
            })
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// A number from `4`, `"4"`, `"4/5"`, `"4.5 (accept)"`.
pub(crate) fn num_of(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let s = s.trim();
            let digits = s.strip_prefix('-').unwrap_or(s);
            let end = digits
                .find(|c: char| !(c.is_ascii_digit() || c == '.'))
                .unwrap_or(digits.len());
            s[..s.len() - digits.len() + end].parse::<f64>().ok()
        }
        Value::Object(o) => num_of(o.get("value").or(o.get("score"))),
        _ => None,
    }
    .filter(|x| x.is_finite())
}

fn line_of(v: Option<&Value>) -> Option<u32> {
    num_of(v)
        .filter(|x| *x >= 1.0 && *x < 10_000_000.0)
        .map(|x| x as u32)
}

fn severity_of(v: Option<&Value>) -> WeaknessSeverity {
    let s = str_of(v).unwrap_or_default().to_lowercase();
    if ["major", "critical", "high", "severe", "serious", "fatal"]
        .iter()
        .any(|w| s.contains(w))
    {
        WeaknessSeverity::Major
    } else {
        WeaknessSeverity::Minor
    }
}

/// `"sections/a.tex:12"` → (`sections/a.tex`, 12).
fn split_file_line(f: &str) -> (String, Option<u32>) {
    let f = f.trim();
    if let Some((a, b)) = f.rsplit_once(':') {
        let digits: String = b.trim().chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty()
            && !a.is_empty()
            && !(a.len() == 1 && a.chars().all(|c| c.is_ascii_alphabetic()))
        {
            return (a.to_string(), digits.parse().ok());
        }
    }
    (f.to_string(), None)
}

fn weakness_of(v: &Value) -> Option<Weakness> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(Weakness {
            text: s.trim().to_string(),
            ..Weakness::default()
        }),
        Value::Object(o) => {
            let text = str_of(
                o.get("text")
                    .or(o.get("weakness"))
                    .or(o.get("description"))
                    .or(o.get("comment")),
            )?;
            let mut line = line_of(o.get("line"));
            let file = str_of(o.get("file").or(o.get("location"))).map(|f| {
                let (f, l) = split_file_line(&f);
                line = line.or(l);
                f
            });
            Some(Weakness {
                text,
                file,
                line,
                severity: severity_of(o.get("severity")),
            })
        }
        _ => None,
    }
}

fn review_of(v: &Value) -> Review {
    let mut scores = BTreeMap::new();
    if let Some(Value::Object(m)) = v.get("scores") {
        for (k, x) in m {
            if let Some(n) = num_of(Some(x)) {
                scores.insert(k.clone(), n);
            }
        }
    }
    let weaknesses = match v.get("weaknesses") {
        Some(Value::Array(items)) => items.iter().filter_map(weakness_of).collect(),
        Some(s @ Value::String(_)) => strings_of(Some(s))
            .into_iter()
            .map(|t| Weakness {
                text: t,
                ..Weakness::default()
            })
            .collect(),
        _ => Vec::new(),
    };
    Review {
        persona: str_of(v.get("persona").or(v.get("reviewer")))
            .unwrap_or_else(|| "Reviewer".to_string()),
        summary: str_of(v.get("summary")).unwrap_or_default(),
        strengths: strings_of(v.get("strengths")),
        weaknesses,
        questions: strings_of(v.get("questions")),
        scores,
        confidence: num_of(v.get("confidence")),
    }
}

fn reference_of(v: &Value) -> Option<ReportReference> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(ReportReference {
            title: s.trim().to_string(),
            ..Default::default()
        }),
        Value::Object(o) => Some(ReportReference {
            title: str_of(o.get("title"))?,
            authors: match o.get("authors") {
                Some(Value::Array(a)) => Some(
                    a.iter()
                        .filter_map(|x| str_of(Some(x)))
                        .collect::<Vec<_>>()
                        .join(", "),
                )
                .filter(|s| !s.is_empty()),
                x => str_of(x),
            },
            year: num_of(o.get("year")).map(|y| y as i32),
            venue: str_of(o.get("venue")),
            doi: str_of(o.get("doi")),
            arxiv_id: str_of(o.get("arxivId").or(o.get("arxiv_id")).or(o.get("arxiv"))),
            // Model-written: keep web links only (no file:, javascript: or app schemes).
            url: str_of(o.get("url")).filter(|u| is_web_url(u)),
            note: str_of(o.get("note").or(o.get("why"))),
        }),
        _ => None,
    }
}

/// `http(s)://` links only.
fn is_web_url(u: &str) -> bool {
    let l = u.trim().to_ascii_lowercase();
    (l.starts_with("https://") || l.starts_with("http://")) && l.len() > 8
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The venue presets, for the reviewer setup editor.
#[tauri::command]
pub fn review_presets() -> Vec<VenuePreset> {
    presets()
}

/// Runs the deterministic checklist on a project (no AI, no network). With
/// no setup, the generic conference preset is used.
#[tauri::command]
pub async fn review_checklist(
    state: State<'_, Mutex<AppState>>,
    project: String,
    setup: Option<ReviewSetup>,
) -> AppResult<Vec<Check>> {
    let dir = {
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        crate::commands::known_project(&s, &project)?.0
    };
    let setup = setup.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || Ok(checklist::run(&dir, &setup)))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
}
