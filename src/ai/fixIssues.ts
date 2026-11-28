// What the Issues panel's "Fix issues" button shows. Pure, so the whole truth
// table is tested: AI off hides it, a fixer run at work turns it into a
// progress chip, a compile in progress disables it, and errors (or a compile
// that failed without any) make it ready. Only errors count: with warnings or
// layout boxes alone it stays in place, dimmed, and says why.

import { isActive, runProgress, type RunSummary } from "../lib/agentsApi";
import type { CompileStatus } from "../lib/api";

export interface IssueCounts {
  error: number;
  warning: number;
  badbox: number;
}

/** The last compile's status, or "compiling" while one runs; undefined before the first. */
export type FixCompileStatus = CompileStatus | "compiling" | undefined;

/** The parts of a fixer run the button reads. */
export type FixerRun = Pick<RunSummary, "id" | "status" | "progress">;

export type FixIssuesState =
  | { kind: "hidden" }
  | { kind: "disabled"; count: number; reason: string }
  | { kind: "ready"; count: number }
  | { kind: "progress"; runId: string; label: string; value: number | undefined };

export const WAIT_FOR_COMPILE = "Wait for the compile to finish";
export const NOT_COMPILED = "Compile first to find errors to fix";
export const NO_ERRORS = "No errors to fix. Fix issues only handles errors, not warnings.";

/** "Fix issues (3)", or "Fix issues" when the compile failed without a listed error. */
export function fixIssuesLabel(count: number): string {
  return count > 0 ? `Fix issues (${count})` : "Fix issues";
}

/** The fixer's rounds are phases "round1" … "round3". */
const ROUND = /^round(\d+)$/;

/** "Fixing… round 2 of 3" and how far along, from the run's phases. */
export function fixerProgress(run: FixerRun): { label: string; value: number | undefined } {
  if (run.status === "queued") return { label: "Fixer waiting to start", value: undefined };
  const phases = runProgress(run).phases;
  const counted = phases.filter((p) => p.status !== "skipped");
  const done = counted.filter((p) => p.status === "done").length;
  const value = counted.length > 0 ? done / counted.length : undefined;
  const active = phases.find((p) => p.status === "active");
  const rounds = phases.filter((p) => ROUND.test(p.id)).length;
  const round = active && ROUND.exec(active.id);
  if (round) return { label: rounds > 0 ? `Fixing… round ${round[1]} of ${rounds}` : `Fixing… round ${round[1]}`, value };
  if (active?.id === "read") return { label: "Fixing… reading the errors", value };
  if (active?.id === "check") return { label: "Fixing… compile check", value };
  return { label: "Fixing…", value };
}

/**
 * The button's state.
 * - AI off: hidden (the per-row "Explain & fix" goes with it).
 * - A fixer run at work: a progress chip that leads to the run.
 * - Compiling: disabled until it finishes.
 * - No errors and the compile didn't fail: disabled, saying why (warnings alone don't count).
 * - Otherwise ready, with the number of errors.
 */
export function fixIssuesState(counts: IssueCounts, status: FixCompileStatus, aiEnabled: boolean, activeFixer: FixerRun | null): FixIssuesState {
  if (!aiEnabled) return { kind: "hidden" };
  if (activeFixer && isActive(activeFixer.status)) return { kind: "progress", runId: activeFixer.id, ...fixerProgress(activeFixer) };
  // The previous result's errors stay listed while a compile runs, so the button stays put, disabled.
  if (status === "compiling") return { kind: "disabled", count: counts.error, reason: WAIT_FOR_COMPILE };
  if (counts.error === 0 && status !== "failed") return { kind: "disabled", count: 0, reason: status === undefined ? NOT_COMPILED : NO_ERRORS };
  return { kind: "ready", count: counts.error };
}

/** The open project's newest fixer run that is still at work, or null. */
export function activeFixerRun<R extends Pick<RunSummary, "kind" | "status" | "startedAt">>(runs: R[]): R | null {
  let best: R | null = null;
  for (const r of runs) if (r.kind === "fixer" && isActive(r.status) && (!best || r.startedAt > best.startedAt)) best = r;
  return best;
}
