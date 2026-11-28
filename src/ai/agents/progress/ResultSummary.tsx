// How a run came out: its counters ("23 found · 18 new · 5 duplicates"),
// the plain reason when it failed, a note when changes need a closer look,
// and the links that fit (Review the plan, Review changes, Open report,
// Retry). The card adds Stop and Delete around these.

import { CirclePause, FileDiff, FileText, RotateCcw, TriangleAlert } from "lucide-react";
import { isActive, isRebuttalPlan, runProgress, type RunSummary } from "../../../lib/agentsApi";
import { openAgentDialog } from "../dialogStore";
import { canRetry } from "../runsStore";
import { countsText } from "./progressModel";

export const linkBtn =
  "inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted transition-colors hover:border-accent/60 hover:text-text disabled:opacity-50";

/** What a run found or did, and why it stopped if it failed. */
export function ResultSummary({ run }: { run: RunSummary }) {
  const counts = countsText(runProgress(run).counts);
  const toReview = run.pendingFiles > 0 || run.conflictFiles > 0;
  const failed = run.status === "failed" || run.status === "interrupted";
  if (!counts && !run.error && !(run.needsAttention && toReview)) return null;
  return (
    <div className="space-y-1">
      {counts && <p className="text-[11px] tabular-nums text-muted">{counts}</p>}
      {run.error && (
        <p className={`text-[12px] leading-relaxed ${failed ? "rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-text/90" : "text-text/85"}`}>{run.error}</p>
      )}
      {run.needsAttention && toReview && (
        <p className="flex items-center gap-1 text-[12px] text-warning">
          <TriangleAlert size={12} aria-hidden="true" /> Some changes need your attention.
        </p>
      )}
    </div>
  );
}

/** The links for what to do next with a run. */
export function ResultActions({ run, onRetry }: { run: RunSummary; onRetry: () => void }) {
  const active = isActive(run.status);
  const toReview = run.pendingFiles > 0 || run.conflictFiles > 0;
  const plan = run.status === "awaiting_input" && isRebuttalPlan(run.awaiting);
  return (
    <>
      {plan && (
        <button type="button" className={`${linkBtn} border-warning/50 text-text`} onClick={() => openAgentDialog({ type: "plan", runId: run.id })}>
          <CirclePause size={12} /> Review the plan
        </button>
      )}
      {run.status === "awaiting_input" && !plan && <span className="text-[11px] text-muted">This run is waiting for an answer Texo can't show yet.</span>}
      {toReview && (
        <button type="button" className={`${linkBtn} border-accent/50 text-text`} onClick={() => openAgentDialog({ type: "changes", runId: run.id })}>
          <FileDiff size={12} /> Review changes
        </button>
      )}
      {!toReview && run.changedFiles > 0 && !active && (
        <button type="button" className={linkBtn} onClick={() => openAgentDialog({ type: "changes", runId: run.id })}>
          <FileDiff size={12} /> Changes
        </button>
      )}
      {run.hasReport && (
        <button type="button" className={linkBtn} onClick={() => openAgentDialog({ type: "report", runId: run.id })}>
          <FileText size={12} /> Open report
        </button>
      )}
      {canRetry(run) && (
        <button type="button" className={linkBtn} onClick={onRetry}>
          <RotateCcw size={12} /> Retry
        </button>
      )}
    </>
  );
}
