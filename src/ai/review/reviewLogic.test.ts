import { describe, expect, it } from "vitest";
import type { Review, ReviewReport, Rubric, ScoreScale, VenuePreset } from "../../lib/reviewApi";
import {
  cleanSetup,
  clampReviewers,
  completeSetup,
  decisionTone,
  effectiveRules,
  exportFileName,
  exportValue,
  fitPersonas,
  fixPrompt,
  fixTitle,
  isDisagreement,
  locationText,
  metaPoints,
  reportCounts,
  reportNotes,
  reviewRequest,
  scoreRows,
  setupProblems,
  sortedWeaknesses,
  spreadText,
  withPersona,
  withReviewers,
  withVenue,
} from "./reviewLogic";

const overall: ScoreScale = { id: "overall", name: "Overall", min: 1, max: 6, step: 1, labels: [{ value: 6, label: "strong accept" }], description: "" };
const quality: ScoreScale = { id: "quality", name: "Quality", min: 1, max: 4, step: 1, labels: [], description: "" };
const rubric: Rubric = { sections: [{ id: "s", title: "Summary", guidance: "" }], scores: [quality, overall], confidence: null, decisions: ["Accept", "Reject"] };

const preset = (id: string, extra: Partial<VenuePreset> = {}): VenuePreset => ({
  id,
  name: id.toUpperCase(),
  kind: "conference",
  rubric,
  pageLimit: 9,
  pageLimitNote: "",
  anonymous: true,
  source: "",
  ...extra,
});
const presets = [preset("generic", { pageLimit: null, anonymous: false }), preset("neurips")];

const review = (persona: string, scores: Record<string, number>, ws: Review["weaknesses"] = []): Review => ({
  persona,
  summary: "",
  strengths: [],
  weaknesses: ws,
  questions: ["q"],
  scores,
  confidence: 3,
});

describe("review setup", () => {
  it("clamps reviewers to 1-5", () => {
    expect(clampReviewers(0)).toBe(1);
    expect(clampReviewers(9)).toBe(5);
    expect(clampReviewers(2.6)).toBe(3);
    expect(clampReviewers(Number.NaN)).toBe(3);
  });

  it("fills personas from the defaults, then numbered ones, and trims extra", () => {
    const own = [{ id: "stats", name: "Statistician", focus: "p-values" }];
    const five = fitPersonas(own, 5);
    expect(five.map((p) => p.id)).toEqual(["stats", "methods", "clarity", "novelty", "reproducibility"]);
    expect(fitPersonas(five, 2).map((p) => p.id)).toEqual(["stats", "methods"]);
    const taken = fitPersonas(
      [
        { id: "methods", name: "M", focus: "" },
        { id: "clarity", name: "C", focus: "" },
        { id: "novelty", name: "N", focus: "" },
        { id: "reproducibility", name: "R", focus: "" },
      ],
      5,
    );
    expect(taken[4].id).toBe("domain");
  });

  it("completes a profile's setup with the venue rubric and keeps overrides", () => {
    const s = completeSetup({ venue: "NeurIPS", reviewers: 2, pageLimit: 8 }, presets);
    expect(s.venue).toBe("neurips");
    expect(s.rubric).toBe(rubric);
    expect(s.personas).toHaveLength(2);
    expect(s.pageLimit).toBe(8);
    expect(completeSetup(null, presets).venue).toBe("generic");
  });

  it("switching venue drops the overrides; effective rules use the preset", () => {
    const s = completeSetup({ venue: "generic", pageLimit: 4, anonymous: true }, presets);
    expect(effectiveRules(s, presets[0])).toEqual({ pageLimit: 4, anonymous: true });
    const n = withVenue(s, presets[1]);
    expect(n.pageLimit).toBeUndefined();
    expect(effectiveRules(n, presets[1])).toEqual({ pageLimit: 9, anonymous: true });
  });

  it("changes reviewers and personas", () => {
    const s = withReviewers(completeSetup(null, presets), 4);
    expect(s.reviewers).toBe(4);
    expect(s.personas).toHaveLength(4);
    expect(withPersona(s, 1, { name: "Stats" }).personas[1].name).toBe("Stats");
  });

  it("reports problems in plain words", () => {
    const s = completeSetup({ reviewers: 2 }, presets);
    expect(setupProblems(s)).toEqual([]);
    expect(setupProblems(withPersona(s, 0, { name: " " }))[0]).toMatch(/name/);
    expect(setupProblems(withPersona(s, 1, { name: s.personas[0].name.toUpperCase() }))[0]).toMatch(/same name/);
    expect(setupProblems({ ...s, pageLimit: 0 })[0]).toMatch(/page limit/);
    expect(setupProblems({ ...s, focus: "x".repeat(2001) })[0]).toMatch(/2000/);
  });

  it("cleans the setup: trimmed, unique ids, one persona per reviewer", () => {
    const s = completeSetup({ reviewers: 2, personas: [{ id: "a", name: " A ", focus: " f " }, { id: "a", name: "B", focus: "" }], focus: "  x " }, presets);
    const c = cleanSetup(s);
    expect(c.personas.map((p) => p.id)).toEqual(["a", "a-2"]);
    expect(c.personas[0]).toEqual({ id: "a", name: "A", focus: "f" });
    expect(c.focus).toBe("x");
  });

  it("builds the reviewer run request", () => {
    const s = completeSetup({ venue: "neurips", focus: "Theorem 2" }, presets);
    expect(exportValue({ md: true, tex: true })).toBe("both");
    expect(exportValue({ md: false, tex: true })).toBe("tex");
    expect(exportValue({ md: false, tex: false })).toBeUndefined();
    const req = reviewRequest(s, presets[1], { profile: { id: "my-rev" }, exports: { md: true, tex: false }, dirtyBuffers: [{ file: "a.tex", text: "x" }] });
    expect(req.kind).toBe("reviewer");
    expect(req.profileId).toBe("my-rev");
    expect(req.prompt).toMatch(/NEURIPS/);
    expect(req.prompt).toMatch(/Theorem 2/);
    expect(req.options?.title).toBe("Review for NEURIPS");
    expect(req.options?.extra).toMatchObject({ export: "md", review: { venue: "neurips" } });
    expect(req.dirtyBuffers).toHaveLength(1);
    expect(reviewRequest(s, undefined).profileId).toBeNull();
    expect(reviewRequest(s, undefined).dirtyBuffers).toBeUndefined();
  });
});

describe("review report", () => {
  const report: ReviewReport = {
    kind: "review",
    venue: "neurips",
    checklist: [],
    reviews: [
      review("Methods", { quality: 1, overall: 2, extra: 5 }, [
        { text: "minor one", file: null, line: null, severity: "minor" },
        { text: "major one", file: "main.tex", line: 12, severity: "major" },
      ]),
      review("Clarity", { quality: 4, overall: 3 }),
    ],
    meta: { summary: "", decision: "Weak accept", mustFix: ["Add error bars", " "], niceToFix: ["Typos"], consensus: [], disagreements: [], scoreSpread: { overall: { min: 2, max: 3, mean: 2.5 } } },
    references: [],
  };

  it("builds score rows: rubric order first, spread from Rust or computed, disagreements flagged", () => {
    const rows = scoreRows(report, rubric);
    expect(rows.map((r) => r.id)).toEqual(["quality", "overall", "extra"]);
    expect(rows[0].values).toEqual([1, 4]);
    expect(rows[0].spread).toEqual({ min: 1, max: 4, mean: 2.5 });
    expect(rows[0].disagree).toBe(true);
    expect(rows[1].spread).toEqual({ min: 2, max: 3, mean: 2.5 });
    expect(rows[1].disagree).toBe(false);
    expect(rows[2].values).toEqual([5, null]);
    expect(rows[2].disagree).toBe(false);
  });

  it("flags disagreement by share of the scale, or 2 points without one", () => {
    expect(isDisagreement({ min: 1, max: 3, mean: 2 }, overall, 2)).toBe(true);
    expect(isDisagreement({ min: 2, max: 3, mean: 2.5 }, overall, 2)).toBe(false);
    expect(isDisagreement({ min: 1, max: 3, mean: 2 }, undefined, 2)).toBe(true);
    expect(isDisagreement({ min: 1, max: 9, mean: 5 }, overall, 1)).toBe(false);
    expect(isDisagreement(null, overall, 3)).toBe(false);
  });

  it("formats spreads, locations and counts", () => {
    expect(spreadText({ min: 2, max: 2, mean: 2 })).toBe("2");
    expect(spreadText({ min: 1, max: 4, mean: 2.5 })).toBe("1–4 (mean 2.5)");
    expect(spreadText(null)).toBe("–");
    expect(locationText("main.tex", 12)).toBe("main.tex:12");
    expect(locationText("main.tex", null)).toBe("main.tex");
    expect(locationText(null, 3)).toBe("");
    expect(reportCounts(report)).toEqual({ reviewers: 2, major: 1, minor: 1, questions: 2 });
  });

  it("sorts weaknesses major first and lists meta points", () => {
    expect(sortedWeaknesses(report.reviews[0].weaknesses).map((w) => w.severity)).toEqual(["major", "minor"]);
    expect(metaPoints(report.meta)).toEqual([
      { text: "Add error bars", mustFix: true },
      { text: "Typos", mustFix: false },
    ]);
    expect(metaPoints(null)).toEqual([]);
  });

  it("reads Texo's notes leniently", () => {
    expect(reportNotes({ notes: ["a", 3, " ", "b"] })).toEqual(["a", "b"]);
    expect(reportNotes(report)).toEqual([]);
    expect(reportNotes(null)).toEqual([]);
  });

  it("picks a tone for the decision", () => {
    expect(decisionTone("Accept")).toBe("good");
    expect(decisionTone("Strong reject")).toBe("bad");
    expect(decisionTone("Weak accept")).toBe("mixed");
    expect(decisionTone("Major revision")).toBe("mixed");
    expect(decisionTone("")).toBe("none");
  });

  it("writes the task agent's prompt without inventing results", () => {
    const p = fixPrompt({ text: " No error bars ", file: "main.tex", line: 12 }, "Methods", "NeurIPS");
    expect(p).toMatch(/A reviewer \(Methods\) for NeurIPS/);
    expect(p).toMatch(/"No error bars"/);
    expect(p).toMatch(/main\.tex:12/);
    expect(p).toMatch(/\[TBD/);
    expect(fixPrompt({ text: "x" }, "")).not.toMatch(/refers to/);
    expect(fixTitle("a".repeat(100))).toHaveLength("Fix: ".length + 58);
    expect(fixTitle("short\n point")).toBe("Fix: short point");
  });

  it("suggests safe export file names", () => {
    expect(exportFileName("My: Paper?", "md")).toBe("My Paper - review.md");
    expect(exportFileName(null, "tex")).toBe("review.tex");
  });
});
