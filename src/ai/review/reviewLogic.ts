// Pure helpers for the Review paper setup dialog and the Review report view.
// No React, no Tauri: tested in reviewLogic.test.ts.

import type { AgentProfile, ReviewerExtra, StartRequest } from "../../lib/agentsApi";
import type {
  MetaReview,
  Persona,
  Review,
  ReviewReport,
  ReviewSetup,
  Rubric,
  ScoreScale,
  ScoreSpread,
  VenuePreset,
  Weakness,
} from "../../lib/reviewApi";

export const MIN_REVIEWERS = 1;
export const MAX_REVIEWERS = 5;
export const MAX_FOCUS_CHARS = 2000;

/** The same points of view Rust fills in (agents/review/venues.rs `default_personas`). */
export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: "methods",
    name: "Methods",
    focus:
      "Soundness of the method, proofs and experiments: baselines, ablations, statistics, whether the evidence supports each claim.",
  },
  { id: "clarity", name: "Clarity", focus: "Writing, structure, notation, figures and tables: could a newcomer to the area follow the paper?" },
  { id: "novelty", name: "Novelty", focus: "What is new compared with prior work; missing related work; whether the contribution is significant." },
  {
    id: "reproducibility",
    name: "Reproducibility",
    focus: "Whether the paper gives enough detail (data, hyperparameters, code, compute) for others to reproduce the results.",
  },
  {
    id: "domain",
    name: "Domain expert",
    focus: "An expert in the paper's specific field: correctness of domain claims, use of standard benchmarks and terminology.",
  },
];

export const STRICTNESS_HELP: Record<ReviewSetup["strictness"], string> = {
  lenient: "Friendly: points out what to improve, gives the benefit of the doubt.",
  balanced: "Like a typical careful reviewer.",
  harsh: "Like a demanding reviewer at a top venue: every unsupported claim counts against the paper.",
};

export function clampReviewers(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.min(MAX_REVIEWERS, Math.max(MIN_REVIEWERS, Math.round(n)));
}

/** Exactly `n` personas: the given ones first, then unused defaults, then "Reviewer k". */
export function fitPersonas(personas: Persona[], n: number): Persona[] {
  const count = clampReviewers(n);
  const out = personas.slice(0, count).map((p) => ({ ...p }));
  const taken = new Set(out.map((p) => p.id));
  for (const d of DEFAULT_PERSONAS) {
    if (out.length >= count) break;
    if (!taken.has(d.id)) {
      out.push({ ...d });
      taken.add(d.id);
    }
  }
  while (out.length < count) {
    let k = out.length + 1;
    while (taken.has(`reviewer-${k}`)) k++;
    out.push({ id: `reviewer-${k}`, name: `Reviewer ${k}`, focus: "" });
    taken.add(`reviewer-${k}`);
  }
  return out;
}

function emptyRubric(r: Rubric | null | undefined): boolean {
  return !r || (r.sections.length === 0 && r.scores.length === 0);
}

/** A complete setup for the dialog: a preset's rubric when the setup has none, one persona per reviewer. */
export function completeSetup(setup: Partial<ReviewSetup> | null | undefined, presets: VenuePreset[]): ReviewSetup {
  const preset = findPreset(presets, setup?.venue) ?? presets[0];
  const reviewers = clampReviewers(setup?.reviewers ?? 3);
  const rubric = emptyRubric(setup?.rubric) ? (preset?.rubric ?? { sections: [], scores: [], confidence: null, decisions: [] }) : setup!.rubric!;
  return {
    venue: preset?.id ?? setup?.venue ?? "generic",
    rubric,
    reviewers,
    personas: fitPersonas(setup?.personas ?? [], reviewers),
    strictness: setup?.strictness ?? "balanced",
    groundNovelty: setup?.groundNovelty ?? true,
    checklist: setup?.checklist ?? true,
    focus: setup?.focus ?? "",
    ...(setup?.pageLimit != null ? { pageLimit: setup.pageLimit } : {}),
    ...(setup?.anonymous != null ? { anonymous: setup.anonymous } : {}),
  };
}

export function findPreset(presets: VenuePreset[], id: string | null | undefined): VenuePreset | undefined {
  if (!id) return undefined;
  const want = id.trim().toLowerCase();
  return presets.find((p) => p.id.toLowerCase() === want);
}

/** Switches the venue: its rubric replaces the old one and the page-limit / anonymity overrides are dropped. */
export function withVenue(setup: ReviewSetup, preset: VenuePreset): ReviewSetup {
  const next: ReviewSetup = { ...setup, venue: preset.id, rubric: preset.rubric };
  delete next.pageLimit;
  delete next.anonymous;
  return next;
}

export function withReviewers(setup: ReviewSetup, n: number): ReviewSetup {
  const reviewers = clampReviewers(n);
  return { ...setup, reviewers, personas: fitPersonas(setup.personas, reviewers) };
}

export function withPersona(setup: ReviewSetup, index: number, patch: Partial<Persona>): ReviewSetup {
  return { ...setup, personas: setup.personas.map((p, i) => (i === index ? { ...p, ...patch } : p)) };
}

/** The page limit and anonymity the checks will use (overrides first). */
export function effectiveRules(setup: ReviewSetup, preset: VenuePreset | undefined): { pageLimit: number | null; anonymous: boolean } {
  return {
    pageLimit: setup.pageLimit != null ? setup.pageLimit : (preset?.pageLimit ?? null),
    anonymous: setup.anonymous != null ? setup.anonymous : (preset?.anonymous ?? false),
  };
}

/** Problems that stop the review from starting, in plain words (empty: fine). */
export function setupProblems(setup: ReviewSetup): string[] {
  const out: string[] = [];
  setup.personas.forEach((p, i) => {
    if (!p.name.trim()) out.push(`Give reviewer ${i + 1} a name.`);
  });
  const names = setup.personas.map((p) => p.name.trim().toLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) out.push("Two reviewers have the same name. Give each one its own name.");
  if (setup.focus.length > MAX_FOCUS_CHARS) out.push(`The focus note can be at most ${MAX_FOCUS_CHARS} characters.`);
  if (setup.pageLimit != null && (!Number.isInteger(setup.pageLimit) || setup.pageLimit < 1 || setup.pageLimit > 999))
    out.push("The page limit must be a whole number of pages.");
  return out;
}

/** The setup as it is sent and saved: personas trimmed, ids made unique. */
export function cleanSetup(setup: ReviewSetup): ReviewSetup {
  const seen = new Set<string>();
  const personas = setup.personas.slice(0, setup.reviewers).map((p, i) => {
    let id = (p.id || "").trim() || `reviewer-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { id, name: p.name.trim(), focus: p.focus.trim() };
  });
  return { ...setup, personas, focus: setup.focus.trim().slice(0, MAX_FOCUS_CHARS) };
}

export interface ExportChoice {
  md: boolean;
  tex: boolean;
}

/** `options.extra.export` for the reviewer run (writes go through the changeset). */
export function exportValue(e: ExportChoice): ReviewerExtra["export"] | undefined {
  if (e.md && e.tex) return "both";
  if (e.md) return "md";
  if (e.tex) return "tex";
  return undefined;
}

/** The agent_start request for a review. */
export function reviewRequest(
  setup: ReviewSetup,
  preset: VenuePreset | undefined,
  opts: {
    profile?: Pick<AgentProfile, "id"> | null;
    exports?: ExportChoice;
    dirtyBuffers?: StartRequest["dirtyBuffers"];
    /** A model picked for this run only; empty means the profile's or the default. */
    model?: string;
  } = {},
): StartRequest {
  const clean = cleanSetup(setup);
  const venue = preset?.name ?? clean.venue;
  const extra: ReviewerExtra = { review: clean };
  const ex = opts.exports ? exportValue(opts.exports) : undefined;
  if (ex) extra.export = ex;
  let prompt = `Review this paper as reviewers for ${venue}.`;
  if (clean.focus) prompt += `\n\nPay special attention to: ${clean.focus}`;
  return {
    kind: "reviewer",
    profileId: opts.profile?.id ?? null,
    prompt,
    ...(opts.dirtyBuffers?.length ? { dirtyBuffers: opts.dirtyBuffers } : {}),
    options: { title: `Review for ${venue}`, ...(opts.model ? { model: opts.model } : {}), extra },
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** "main.tex:12", "main.tex", or "" */
export function locationText(file: string | null | undefined, line: number | null | undefined): string {
  if (!file) return "";
  return line != null && line > 0 ? `${file}:${line}` : file;
}

export function scaleById(rubric: Rubric | null | undefined, id: string): ScoreScale | undefined {
  return rubric?.scores.find((s) => s.id === id);
}

export interface ScoreRow {
  id: string;
  name: string;
  scale: ScoreScale | undefined;
  /** One per review, in review order (null: that reviewer gave none). */
  values: (number | null)[];
  spread: ScoreSpread | null;
  /** The reviewers disagree a lot on this score. */
  disagree: boolean;
}

function spreadOf(values: number[]): ScoreSpread | null {
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  return { min, max, mean };
}

/**
 * Two or more reviewers whose scores differ by at least 40% of the scale
 * (or by 2 points when the scale is unknown).
 */
export function isDisagreement(spread: ScoreSpread | null, scale: ScoreScale | undefined, count: number): boolean {
  if (!spread || count < 2) return false;
  const gap = spread.max - spread.min;
  if (scale && scale.max > scale.min) return gap / (scale.max - scale.min) >= 0.4;
  return gap >= 2;
}

/** The score table: rubric scales first (in rubric order), then any other score ids the reviews used. */
export function scoreRows(report: Pick<ReviewReport, "reviews" | "meta">, rubric: Rubric | null | undefined): ScoreRow[] {
  const ids: string[] = (rubric?.scores ?? []).map((s) => s.id);
  for (const r of report.reviews) for (const id of Object.keys(r.scores ?? {})) if (!ids.includes(id)) ids.push(id);
  const rows: ScoreRow[] = [];
  for (const id of ids) {
    const values = report.reviews.map((r) => (typeof r.scores?.[id] === "number" ? r.scores[id] : null));
    const given = values.filter((v): v is number => v != null);
    if (!given.length) continue;
    const scale = scaleById(rubric, id);
    const spread = report.meta?.scoreSpread?.[id] ?? spreadOf(given);
    rows.push({ id, name: scale?.name ?? id, scale, values, spread, disagree: isDisagreement(spread, scale, given.length) });
  }
  return rows;
}

/** "2–4 (mean 3)" */
export function spreadText(s: ScoreSpread | null): string {
  if (!s) return "–";
  if (s.min === s.max) return `${s.min}`;
  return `${s.min}–${s.max} (mean ${s.mean})`;
}

export interface ReportCounts {
  reviewers: number;
  major: number;
  minor: number;
  questions: number;
}

export function reportCounts(report: Pick<ReviewReport, "reviews">): ReportCounts {
  let major = 0;
  let minor = 0;
  let questions = 0;
  for (const r of report.reviews) {
    for (const w of r.weaknesses) {
      if (w.severity === "major") major++;
      else minor++;
    }
    questions += r.questions.length;
  }
  return { reviewers: report.reviews.length, major, minor, questions };
}

/** Notes Texo added to the report (a reviewer that didn't finish …). */
export function reportNotes(report: unknown): string[] {
  const notes = (report as { notes?: unknown } | null)?.notes;
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string" && n.trim() !== "") : [];
}

/** Rough tone for the decision badge. */
export function decisionTone(decision: string): "good" | "bad" | "mixed" | "none" {
  const d = decision.trim().toLowerCase();
  if (!d) return "none";
  if (/borderline|weak|minor|major|revis/.test(d)) return "mixed";
  if (/reject|fail|not ready/.test(d)) return "bad";
  if (/accept|pass|approve|ready/.test(d)) return "good";
  return "mixed";
}

/** The task agent's prompt for "Fix this with the task agent". */
export function fixPrompt(point: { text: string; file?: string | null; line?: number | null }, from: string, venue?: string): string {
  const where = locationText(point.file ?? null, point.line ?? null);
  const lines = [
    `A reviewer${from ? ` (${from})` : ""}${venue ? ` for ${venue}` : ""} raised this point about my paper:`,
    "",
    `"${point.text.trim()}"`,
    "",
  ];
  if (where) lines.push(`It refers to ${where}.`);
  lines.push(
    "Change the manuscript to address it. Keep the rest of the paper as it is.",
    "If it needs new experiments, data or results, don't invent them: add a short [TBD: …] note where they would go and tell me what is needed.",
  );
  return lines.join("\n");
}

export function fixTitle(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `Fix: ${one.length > 60 ? `${one.slice(0, 57)}…` : one}`;
}

/** Points worth a "Fix this" button in the meta-review (must-fix and nice-to-fix). */
export function metaPoints(meta: MetaReview | null | undefined): { text: string; mustFix: boolean }[] {
  if (!meta) return [];
  return [...meta.mustFix.map((text) => ({ text, mustFix: true })), ...meta.niceToFix.map((text) => ({ text, mustFix: false }))].filter(
    (p) => p.text.trim(),
  );
}

/** Weaknesses major first, keeping each group's order. */
export function sortedWeaknesses(ws: Weakness[]): Weakness[] {
  return [...ws.filter((w) => w.severity === "major"), ...ws.filter((w) => w.severity !== "major")];
}

/** A file name for "Save as…", e.g. "My Paper – review.md". */
export function exportFileName(projectName: string | null | undefined, format: "md" | "tex"): string {
  const base = (projectName ?? "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${base ? `${base} - review` : "review"}.${format}`;
}

/** The review's confidence with its label (e.g. "4 (confident)"). */
export function confidenceText(review: Pick<Review, "confidence">, rubric: Rubric | null | undefined): string {
  if (review.confidence == null) return "";
  const label = rubric?.confidence?.labels.find((l) => Math.abs(l.value - review.confidence!) < 1e-9)?.label;
  return label ? `${review.confidence} (${label})` : `${review.confidence}`;
}
