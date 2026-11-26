// The Agents tab's runs: summaries of the open project's runs, kept live
// from `agent-run-updated` and `agent-step`, and the step lists of the runs
// whose cards are expanded (fetched with `agent_get`, then followed live).
// The reducers are pure and unit-tested; the store wires them to events.

import { create } from "zustand";
import { agentsApi, type AgentRun, type RunSummary, type Step } from "../../lib/agentsApi";

/** Steps kept per run in the live list (the journal keeps them all). */
export const MAX_STEPS_SHOWN = 400;

export const samePath = (a: string, b: string) => norm(a) === norm(b);
function norm(p: string) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Adds or replaces a run summary. */
export function upsertRun(runs: Record<string, RunSummary>, run: RunSummary): Record<string, RunSummary> {
  return { ...runs, [run.id]: run };
}

/** A run's steps with one more (or a newer copy of one with the same number), in order. */
export function mergeStep(steps: Step[], step: Step): Step[] {
  const at = steps.findIndex((s) => s.n === step.n);
  let next: Step[];
  if (at >= 0) {
    next = steps.slice();
    next[at] = step;
  } else if (steps.length === 0 || steps[steps.length - 1].n < step.n) {
    next = [...steps, step];
  } else {
    next = [...steps, step].sort((a, b) => a.n - b.n);
  }
  return next.length > MAX_STEPS_SHOWN ? next.slice(next.length - MAX_STEPS_SHOWN) : next;
}

/** Steps fetched with the full run, keeping any live step that arrived meanwhile. */
export function mergeSteps(live: Step[] | undefined, fetched: Step[]): Step[] {
  let out = fetched.slice(-MAX_STEPS_SHOWN);
  for (const s of live ?? []) out = mergeStep(out, s);
  return out;
}

/** The project's runs, newest first. */
export function runsForProject(runs: Record<string, RunSummary>, project: string): RunSummary[] {
  return Object.values(runs)
    .filter((r) => samePath(r.project, project))
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
}

/** "3 s", "2 min 05 s", "1 h 04 min". */
export function formatElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** Seconds a run has taken (so far, when `nowSecs` is given for a live run). */
export function elapsedSecs(run: Pick<RunSummary, "startedAt" | "finishedAt">, nowSecs: number): number {
  return (run.finishedAt ?? nowSecs) - run.startedAt;
}

/** "12.3k tokens". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

/** Plain words for a kind. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "fixer":
      return "Fixer";
    case "reviewer":
      return "Reviewer";
    case "rebuttal":
      return "Response to reviewers";
    case "task":
      return "Task";
    case "chat":
      return "Chat";
    default:
      return kind || "Agent";
  }
}

/** A run that can be started again with the same request. */
/** A one-line, plain-text version of a model message for the step list
 * (drops markdown emphasis, code ticks, heading marks and `$` math fences). */
export function plainSummary(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|[.,;:!?)]|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function canRetry(run: Pick<RunSummary, "status">): boolean {
  return run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
}

interface RunsStore {
  project: string | null;
  runs: Record<string, RunSummary>;
  /** Steps of runs whose cards are open. */
  steps: Record<string, Step[]>;
  loading: boolean;
  error: string | null;
  /** Lists the project's runs (and forgets other projects'). */
  load: (project: string) => Promise<void>;
  /** Fetches a run's full journal and starts keeping its steps. */
  follow: (project: string, runId: string) => Promise<AgentRun | null>;
  unfollow: (runId: string) => void;
  noteRun: (run: RunSummary) => void;
  noteStep: (runId: string, step: Step) => void;
  forget: (runId: string) => void;
}

const errorText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong. Try again.");

export const useRuns = create<RunsStore>((set, get) => ({
  project: null,
  runs: {},
  steps: {},
  loading: false,
  error: null,
  load: async (project) => {
    if (get().project !== project) set({ project, runs: {}, steps: {}, error: null });
    set({ loading: true });
    try {
      const list = await agentsApi.list(project);
      if (get().project !== project) return;
      // Keep summaries that arrived by event while listing if they are newer.
      set((s) => {
        let runs: Record<string, RunSummary> = {};
        for (const r of list) runs = upsertRun(runs, r);
        for (const r of Object.values(s.runs)) if (!runs[r.id] && samePath(r.project, project)) runs = upsertRun(runs, r);
        return { runs, loading: false, error: null };
      });
    } catch (e) {
      if (get().project === project) set({ loading: false, error: errorText(e) });
    }
  },
  follow: async (project, runId) => {
    if (!get().steps[runId]) set((s) => ({ steps: { ...s.steps, [runId]: [] } }));
    try {
      const run = await agentsApi.get(project, runId);
      set((s) => (s.steps[runId] ? { steps: { ...s.steps, [runId]: mergeSteps(s.steps[runId], run.steps) } } : {}));
      return run;
    } catch {
      return null;
    }
  },
  unfollow: (runId) =>
    set((s) => {
      const steps = { ...s.steps };
      delete steps[runId];
      return { steps };
    }),
  noteRun: (run) => {
    const p = get().project;
    if (!p || !samePath(run.project, p)) return;
    set((s) => ({ runs: upsertRun(s.runs, run) }));
  },
  noteStep: (runId, step) => {
    if (!get().steps[runId]) return;
    set((s) => ({ steps: { ...s.steps, [runId]: mergeStep(s.steps[runId] ?? [], step) } }));
  },
  forget: (runId) =>
    set((s) => {
      const runs = { ...s.runs };
      const steps = { ...s.steps };
      delete runs[runId];
      delete steps[runId];
      return { runs, steps };
    }),
}));

let listeners = 0;
let stop: (() => void) | null = null;

/** Follows the agent events while at least one caller needs them; returns the cleanup. */
export function listenRunEvents(): () => void {
  listeners++;
  if (listeners === 1) {
    const offs = [
      agentsApi.onRunUpdated((r) => useRuns.getState().noteRun(r)),
      agentsApi.onStep((e) => useRuns.getState().noteStep(e.runId, e.step)),
    ];
    stop = () => offs.forEach((p) => void p.then((f) => f()).catch(() => {}));
  }
  return () => {
    listeners--;
    if (listeners === 0) {
      stop?.();
      stop = null;
    }
  };
}
