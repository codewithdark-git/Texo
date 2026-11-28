// A reviewer run's sub-runs side by side: one lane per persona (and the area
// chair) with its step count and what it did last, a spinner on the one
// working now. A lane opens to its own grouped steps.

import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { Activity, Step } from "../../../lib/agentsApi";
import { StatusDot } from "../../../components/ui/StatusDot";
import { plainSummary } from "../runsStore";
import { lanes, type Lane } from "./progressModel";
import { StepGroups } from "./StepGroups";

function LaneRow({ lane, working, runActive }: { lane: Lane & { sub: string }; working: boolean; runActive: boolean }) {
  const [open, setOpen] = useState(false);
  const last = lane.steps[lane.steps.length - 1];
  const failed = lane.steps.some((s) => !s.ok);
  return (
    <li className="rounded-md border border-border/70 bg-surface-2/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors hover:bg-surface-2/60"
      >
        {working ? (
          <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin text-accent" />
        ) : (
          <StatusDot tone={failed ? "warning" : runActive ? "muted" : "success"} />
        )}
        <span className="shrink-0 font-medium">{lane.sub}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{last ? plainSummary(last.resultSummary) : ""}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted">
          {lane.steps.length} step{lane.steps.length === 1 ? "" : "s"}
        </span>
        <ChevronRight size={11} aria-hidden="true" className={`shrink-0 text-muted transition-transform duration-[var(--dur-2)] ${open ? "rotate-90" : ""}`} />
      </button>
      <div className="texo-collapse" data-open={open ? "" : "false"}>
        <div inert={!open}>
          <div className="border-t border-border/70 px-1 py-1">
            <StepGroups steps={lane.steps} active={false} />
          </div>
        </div>
      </div>
    </li>
  );
}

/** Lanes for the sub-runs only; null when the steps have none (nothing to split). */
export function PersonaLanes({ steps, activity, active }: { steps: Step[]; activity: Activity | null; active: boolean }) {
  const subs = lanes(steps).filter((l): l is Lane & { sub: string } => l.sub !== null);
  if (subs.length === 0) return null;
  return (
    <section aria-label="Reviewers">
      <p className="mb-1 text-[11px] font-medium text-muted">Reviewers</p>
      <ul className="space-y-1">
        {subs.map((l) => (
          <LaneRow key={l.sub} lane={l} working={active && activity?.sub === l.sub} runActive={active} />
        ))}
      </ul>
    </section>
  );
}
