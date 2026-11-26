// Bindings for the reviewer's deterministic parts (src-tauri/src/agents/review):
// venue presets, the reviewer setup (stored in a profile's `review` field and
// sent as a reviewer run's `options.extra`), the checklist that runs without
// the AI, and the review report a reviewer run ends with (`Report` with
// kind "review" in agentsApi).
import { invoke } from "@tauri-apps/api/core";
import type { Report } from "./agentsApi";

export interface RubricSection {
  id: string;
  title: string;
  /** What the reviewer writes there. */
  guidance: string;
}

export interface ScaleLabel {
  value: number;
  label: string;
}

export interface ScoreScale {
  /** Key in `Review.scores`. */
  id: string;
  name: string;
  min: number;
  max: number;
  /** Allowed steps (e.g. 0.5). null: only the values in `labels` (ICLR 1/3/5/6/8/10). */
  step: number | null;
  /** Highest first. */
  labels: ScaleLabel[];
  description: string;
}

export interface Rubric {
  sections: RubricSection[];
  scores: ScoreScale[];
  confidence: ScoreScale | null;
  /** Meta-review recommendations, best first. */
  decisions: string[];
}

export type VenueKind = "conference" | "journal" | "thesis";

export interface VenuePreset {
  id: VenueId;
  name: string;
  kind: VenueKind;
  rubric: Rubric;
  /** Pages of main text, when well known. */
  pageLimit: number | null;
  pageLimitNote: string;
  /** Double-blind: the paper must not reveal its authors. */
  anonymous: boolean;
  /** Where the rubric comes from (URL or note). */
  source: string;
}

export type VenueId =
  | "generic"
  | "neurips"
  | "iclr"
  | "icml"
  | "acl"
  | "cvpr"
  | "ieee-transactions"
  | "elsevier"
  | "springer"
  | "thesis"
  | (string & {});

export interface Persona {
  id: string;
  name: string;
  /** What this reviewer looks at, in plain words. */
  focus: string;
}

export type Strictness = "lenient" | "balanced" | "harsh";

export interface ReviewSetup {
  venue: VenueId;
  /** Empty sections and scores: the venue's rubric is used. */
  rubric: Rubric;
  /** 1–5. */
  reviewers: number;
  /** One per reviewer; missing ones are filled from the defaults in Rust. */
  personas: Persona[];
  strictness: Strictness;
  /** Search the literature to judge novelty. */
  groundNovelty: boolean;
  /** Run the deterministic checklist first. */
  checklist: boolean;
  focus: string;
  /** Overrides the venue's page limit. */
  pageLimit?: number | null;
  /** Overrides whether review is anonymous. */
  anonymous?: boolean | null;
}

export type CheckStatus = "pass" | "warn" | "fail";

/** Check ids, in the order Rust returns them (anonymity ones only for anonymous venues). */
export type CheckId =
  | "page-count"
  | "anonymity-authors"
  | "anonymity-acknowledgements"
  | "anonymity-self-citation"
  | "anonymity-links"
  | "undefined-references"
  | "undefined-citations"
  | "missing-figures"
  | "overfull-boxes"
  | "bib-fields"
  | "leftovers"
  | "captions-labels"
  | "unreferenced-labels"
  | (string & {});

export interface Check {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /** Plain sentences, usually "file:line: …". */
  details: string[];
  /** The first finding, for "jump to". */
  file: string | null;
  line: number | null;
}

export type WeaknessSeverity = "major" | "minor";

export interface Weakness {
  text: string;
  file: string | null;
  line: number | null;
  severity: WeaknessSeverity;
}

export interface Review {
  persona: string;
  summary: string;
  strengths: string[];
  weaknesses: Weakness[];
  questions: string[];
  /** By score id from the rubric. */
  scores: Record<string, number>;
  confidence: number | null;
}

export interface ScoreSpread {
  min: number;
  max: number;
  mean: number;
}

export interface MetaReview {
  summary: string;
  decision: string;
  mustFix: string[];
  niceToFix: string[];
  consensus: string[];
  disagreements: string[];
  /** Computed in Rust from the reviews. */
  scoreSpread: Record<string, ScoreSpread>;
}

export interface ReportReference {
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  note: string | null;
}

export interface ReviewReport {
  kind: "review";
  venue: VenueId;
  checklist: Check[];
  reviews: Review[];
  meta: MetaReview;
  references: ReportReference[];
}

export const reviewApi = {
  presets: () => invoke<VenuePreset[]>("review_presets"),
  /** Runs the checklist (no AI, no network). No setup: the generic conference preset. */
  checklist: (project: string, setup?: ReviewSetup | null) =>
    invoke<Check[]>("review_checklist", { project, setup: setup ?? null }),
};

/** A run report that is a review (Rust normalises it before it's stored). */
export function isReviewReport(report: Report | null | undefined): report is Report & ReviewReport {
  return !!report && report.kind === "review" && Array.isArray((report as Partial<ReviewReport>).reviews);
}

/** A setup with the preset's rubric and the given reviewers (Rust fills personas). */
export function setupForPreset(preset: VenuePreset, reviewers = 3): ReviewSetup {
  return {
    venue: preset.id,
    rubric: preset.rubric,
    reviewers: Math.min(5, Math.max(1, Math.round(reviewers))),
    personas: [],
    strictness: "balanced",
    groundNovelty: true,
    checklist: true,
    focus: "",
  };
}

/** Worst status first, then the checklist's own order. */
export function sortChecks(checks: Check[]): Check[] {
  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2 };
  return checks.map((c, i) => ({ c, i })).sort((a, b) => rank[a.c.status] - rank[b.c.status] || a.i - b.i).map((x) => x.c);
}

/** "2 problems, 3 warnings" / "All 9 checks passed". */
export function checklistSummary(checks: Check[]): string {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (!fails && !warns) return checks.length ? `All ${checks.length} checks passed` : "No checks run";
  const parts: string[] = [];
  if (fails) parts.push(`${fails} problem${fails === 1 ? "" : "s"}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** A score with its label, e.g. "8 (accept, good paper)". */
export function scoreText(scale: ScoreScale | null | undefined, value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "–";
  const label = scale?.labels.find((l) => Math.abs(l.value - value) < 1e-9)?.label;
  return label ? `${value} (${label})` : `${value}`;
}
