// What a run card shows about progress, worked out from a run summary and
// its steps: how far along it is, a one-word health, step groups ("Ran 6
// searches · 14 results"), per-persona lanes, the tail of the streamed text
// and the phase changes to announce. Pure, so it is unit-tested without a DOM.

import { isActive, runProgress, type Phase, type PlanStatus, type RunSummary, type Step } from "../../../lib/agentsApi";
import type { StatusTone } from "../../../components/ui/StatusDot";

// ---------------------------------------------------------------------------
// How far along
// ---------------------------------------------------------------------------

/** Plan items that need no more work. */
const PLAN_SETTLED: PlanStatus[] = ["done", "partly", "notDone", "skipped"];

/** The part of a phase that is done: whole when it ended, its done/total while it runs. */
function phaseShare(p: Phase): number {
  if (p.status === "done" || p.status === "skipped" || p.status === "failed") return 1;
  if (p.status === "active" && p.total && p.total > 0) return Math.min(1, Math.max(0, (p.done ?? 0) / p.total)) * 0.99;
  return 0;
}

export type FractionRun = Pick<RunSummary, "status" | "stepCount"> & Partial<Pick<RunSummary, "maxSteps" | "progress">>;

/**
 * How far along a run is, from 0 to 1, or null when that can't be told
 * (the ring spins). In order: the plan (items settled of all), the phases
 * (an active phase counts its done/total), then steps used of the step limit
 * (capped at 0.95, and only while the run works).
 */
export function runFraction(run: FractionRun): number | null {
  const { plan, phases } = runProgress(run);
  if (plan.length > 0) return plan.filter((i) => PLAN_SETTLED.includes(i.status)).length / plan.length;
  if (phases.length > 0) return phases.reduce((sum, p) => sum + phaseShare(p), 0) / phases.length;
  if (isActive(run.status) && run.maxSteps && run.maxSteps > 0) return Math.min(0.95, run.stepCount / run.maxSteps);
  return null;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthId = "running" | "needsInput" | "review" | "failed" | "done" | "stopped";

export interface Health {
  id: HealthId;
  label: string;
  tone: StatusTone;
}

/** One word for where a run stands, with the colour of its dot. */
export function health(run: Pick<RunSummary, "status">): Health {
  switch (run.status) {
    case "queued":
    case "running":
      return { id: "running", label: "Running", tone: "accent" };
    case "awaiting_input":
      return { id: "needsInput", label: "Needs input", tone: "warning" };
    case "awaiting_review":
      return { id: "review", label: "Review", tone: "info" };
    case "failed":
    case "interrupted":
      return { id: "failed", label: "Failed", tone: "danger" };
    case "done":
      return { id: "done", label: "Done", tone: "success" };
    case "cancelled":
      return { id: "stopped", label: "Stopped", tone: "muted" };
  }
}

/** The run waits on the user (an answer, or changes to review). */
export function needsUser(run: Pick<RunSummary, "status">): boolean {
  return run.status === "awaiting_input" || run.status === "awaiting_review";
}

/** Runs that wait on the user first, otherwise in the order given (stable). */
export function attentionFirst<T extends Pick<RunSummary, "status">>(runs: T[]): T[] {
  return runs.map((r, i) => [r, i] as const).sort((a, b) => Number(needsUser(b[0])) - Number(needsUser(a[0])) || a[1] - b[1]).map(([r]) => r);
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** The phase working now, else the last one that ended. */
export function currentPhase(phases: Phase[]): Phase | null {
  const active = phases.find((p) => p.status === "active");
  if (active) return active;
  for (let i = phases.length - 1; i >= 0; i--) if (phases[i].status === "done" || phases[i].status === "failed") return phases[i];
  return null;
}

/** "Reviewers · 2 of 3", or the detail line, for the active phase. */
export function phaseCaption(p: Phase): string {
  const parts = [p.label];
  if (p.total && p.total > 0) parts.push(`${p.done ?? 0} of ${p.total}`);
  if (p.detail) parts.push(p.detail);
  return parts.join(" · ");
}

/** Phase statuses per run, to notice changes between two updates. */
export type PhaseMemory = Record<string, Record<string, Phase["status"]>>;

/**
 * Lines for a screen reader about phases that started or finished between
 * `before` and `runs`, and the memory for next time. A run seen for the first
 * time only sets the memory (nothing is announced for runs already going).
 */
export function phaseAnnouncements(before: PhaseMemory, runs: Pick<RunSummary, "id" | "title" | "kind" | "progress">[]): { lines: string[]; memory: PhaseMemory } {
  const lines: string[] = [];
  const memory: PhaseMemory = {};
  for (const run of runs) {
    const phases = runProgress(run).phases;
    const now: Record<string, Phase["status"]> = {};
    for (const p of phases) now[p.id] = p.status;
    memory[run.id] = now;
    const was = before[run.id];
    if (!was) continue;
    const title = run.title.trim() || "The agent";
    for (const p of phases) {
      if (was[p.id] === p.status) continue;
      if (p.status === "active") lines.push(`${title}: ${p.label} started`);
      else if (p.status === "done" && was[p.id] !== undefined) lines.push(`${title}: ${p.label} finished`);
      else if (p.status === "failed") lines.push(`${title}: ${p.label} failed`);
    }
  }
  return { lines, memory };
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

const COUNT_WORDS: [key: string, word: string][] = [
  ["papersFound", "found"],
  ["papersNew", "new"],
  ["duplicates", "duplicates"],
  ["keysChecked", "citations checked"],
];

/** "23 found · 18 new · 5 duplicates" from a run's counters (unknown keys are left out). */
export function countsText(counts: Record<string, number>): string {
  const c = { ...counts };
  if (c.duplicates === undefined && c.papersFound !== undefined && c.papersNew !== undefined && c.papersFound > c.papersNew) c.duplicates = c.papersFound - c.papersNew;
  return COUNT_WORDS.filter(([k]) => (c[k] ?? 0) > 0)
    .map(([k, w]) => `${c[k]} ${w}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Steps: groups and lanes
// ---------------------------------------------------------------------------

export interface StepGroup {
  /** Stable while steps are added: the first step's number. */
  key: number;
  tool?: string;
  sub?: string;
  steps: Step[];
  count: number;
  okCount: number;
  /** One line: the step's own summary, or "Ran 6 searches · 14 results" for a group. */
  summary: string;
}

/** What a group of calls of a tool is called ("Ran 6 paper searches"). */
const TOOL_WORDS: Record<string, string> = {
  search_papers: "paper searches",
  library_search: "library searches",
  library_search_online: "paper searches",
  web_search: "web searches",
  search: "project searches",
  read_file: "file reads",
  edit_file: "edits",
  write_file: "file writes",
  fetch_url: "page reads",
  verify_citation: "citation checks",
  get_bibtex: "BibTeX lookups",
  compile_check: "compiles",
  paper_details: "paper lookups",
};

/** The number of results a step's summary reports ("…: 14 found", "3 hit(s)"), if any. */
export function resultCount(summary: string): number | null {
  const m = /(\d+)\s+(?:found|results?|result\(s\)|hits?|hit\(s\)|papers?)\b/.exec(summary);
  return m ? Number(m[1]) : null;
}

function groupSummary(tool: string, steps: Step[]): string {
  if (steps.length === 1) return steps[0].resultSummary;
  const many = TOOL_WORDS[tool] ?? `${tool} calls`;
  const parts = [`Ran ${steps.length} ${many}`];
  const counts = steps.map((s) => resultCount(s.resultSummary)).filter((n): n is number => n !== null);
  if (counts.length) {
    const total = counts.reduce((a, b) => a + b, 0);
    parts.push(`${total} result${total === 1 ? "" : "s"}`);
  }
  const failed = steps.filter((s) => !s.ok).length;
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** Consecutive calls of the same tool (in the same sub-run) become one group; messages stay alone. */
export function groupSteps(steps: Step[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (s.kind === "toolCall" && s.tool && last && last.tool === s.tool && last.sub === s.sub) {
      last.steps.push(s);
      continue;
    }
    groups.push({ key: s.n, tool: s.kind === "toolCall" ? s.tool : undefined, sub: s.sub, steps: [s], count: 0, okCount: 0, summary: "" });
  }
  for (const g of groups) {
    g.count = g.steps.length;
    g.okCount = g.steps.filter((s) => s.ok).length;
    g.summary = g.tool ? groupSummary(g.tool, g.steps) : g.steps[0].resultSummary;
  }
  return groups;
}

export interface Lane {
  /** The sub-run label, or null for the run's own steps. */
  sub: string | null;
  steps: Step[];
}

/** Steps by sub-run (reviewer personas, the area chair), in the order each first appears. */
export function lanes(steps: Step[]): Lane[] {
  const out: Lane[] = [];
  const at = new Map<string | null, Lane>();
  for (const s of steps) {
    const sub = s.sub ?? null;
    let lane = at.get(sub);
    if (!lane) {
      lane = { sub, steps: [] };
      at.set(sub, lane);
      out.push(lane);
    }
    lane.steps.push(s);
  }
  return out;
}

/** The papers a step found (`data.papers`), or none. */
export function stepPapers(step: Pick<Step, "data">): unknown[] {
  const d = step.data;
  if (typeof d !== "object" || d === null) return [];
  const papers = (d as { papers?: unknown }).papers;
  return Array.isArray(papers) ? papers : [];
}

// ---------------------------------------------------------------------------
// Streamed text
// ---------------------------------------------------------------------------

/** The last one or two non-empty lines of streamed text, markdown marks left as they are. */
export function liveTail(stream: string | undefined, lines = 2): string[] {
  if (!stream) return [];
  return stream
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-lines);
}

// ---------------------------------------------------------------------------
// The sidebar dock
// ---------------------------------------------------------------------------

/** Runs the dock lists (working ones and ones that wait on the user), at most `max`, and how many more there are. */
export function dockRows<T extends Pick<RunSummary, "status">>(runs: T[], max = 3): { shown: T[]; more: number } {
  const live = attentionFirst(runs.filter((r) => isActive(r.status) || r.status === "awaiting_review"));
  return { shown: live.slice(0, max), more: Math.max(0, live.length - max) };
}
