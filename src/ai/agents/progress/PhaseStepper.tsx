// A run's phases as a row of dots joined by a line (done ones filled, the
// active one ringed and breathing, skipped ones dashed), with a caption for
// the phase working now: "Fix round 1 of 3 · 3 errors left".

import type { Phase } from "../../../lib/agentsApi";
import { currentPhase, phaseCaption } from "./progressModel";

const STATUS_WORDS: Record<Phase["status"], string> = {
  pending: "not started",
  active: "working",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

function Dot({ phase }: { phase: Phase }) {
  const base = "relative z-10 block size-2.5 shrink-0 rounded-full transition-colors duration-[var(--dur-3)]";
  switch (phase.status) {
    case "done":
      return <span className={`${base} bg-success`} />;
    case "active":
      return <span className={`${base} texo-pulse-dot bg-accent text-accent ring-2 ring-accent/25`} />;
    case "failed":
      return <span className={`${base} bg-danger`} />;
    case "skipped":
      return <span className={`${base} border border-dashed border-muted/60 bg-surface`} />;
    case "pending":
      return <span className={`${base} border border-border bg-surface`} />;
  }
}

export function PhaseStepper({ phases, active = true }: { phases: Phase[]; active?: boolean }) {
  if (phases.length === 0) return null;
  const now = currentPhase(phases);
  const at = now ? phases.indexOf(now) : -1;
  return (
    <div className="min-w-0">
      <ol aria-label="Phases" className="flex items-center">
        {phases.map((p, i) => {
          // The line into a phase fills once the work reached it.
          const reached = p.status !== "pending";
          return (
            <li key={p.id} title={`${p.label}: ${STATUS_WORDS[p.status]}`} className={`flex items-center ${i === 0 ? "" : "flex-1"}`}>
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={`mx-0.5 h-px flex-1 transition-colors duration-[var(--dur-4)] ${reached ? "bg-success/60" : "bg-border"}`}
                />
              )}
              <Dot phase={p} />
              <span className="sr-only">
                {p.label}: {STATUS_WORDS[p.status]}
              </span>
            </li>
          );
        })}
      </ol>
      {now && (
        <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-[11px]">
          <span className="shrink-0 tabular-nums text-muted">
            {at + 1}/{phases.length}
          </span>
          <span key={now.id} className={`texo-fade-in truncate ${now.status === "failed" ? "text-danger" : active ? "text-text/85" : "text-muted"}`}>
            {phaseCaption(now)}
          </span>
        </p>
      )}
    </div>
  );
}
