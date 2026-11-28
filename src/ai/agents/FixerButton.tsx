// The fixer agent's side of the Issues panel's "Fix issues" button: starting
// a fixer run (it compiles a private copy, fixes, checks again, and you review
// its changes), finding the run that is at work now, and the progress chip
// that stands in for the button while it runs and leads to its card.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { Tooltip } from "../../components/ui/Tooltip";
import { useAiPanel } from "../panel/aiPanelStore";
import { activeFixerRun } from "../fixIssues";
import { startFixerRun } from "./actions";
import { useRunFocus } from "./focusStore";
import { listenRunEvents, runsForProject, useRuns } from "./runsStore";

/** Starts a fixer run; `busy` is true until it has started (or failed to). */
export function useStartFixer(): { busy: boolean; start: () => void } {
  const [busy, setBusy] = useState(false);
  const start = useCallback(() => {
    setBusy(true);
    void startFixerRun().finally(() => setBusy(false));
  }, []);
  return { busy, start };
}

/** The project's fixer run that is at work now, kept live from the agent events. */
export function useActiveFixer(project: string | null) {
  const runs = useRuns((s) => s.runs);
  useEffect(() => listenRunEvents(), []);
  useEffect(() => {
    if (project && useRuns.getState().project !== project) void useRuns.getState().load(project);
  }, [project]);
  return useMemo(() => (project ? activeFixerRun(runsForProject(runs, project)) : null), [runs, project]);
}

/** Brings a run's card into view in the AI panel's Agents tab. */
export function focusRun(runId: string) {
  useAiPanel.getState().show("agents");
  useRunFocus.getState().focus(runId);
}

/** "Fixing… round 2 of 3" with a ring; a click shows the run. */
export function FixerProgressChip({ label, value, onClick }: { label: string; value: number | undefined; onClick: () => void }) {
  return (
    <Tooltip content="Show the fixer run">
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}. Show the fixer run`}
        className="texo-fade-in inline-flex h-6 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 pr-2.5 pl-1.5 text-xs text-text transition-colors duration-[var(--dur-2)] hover:bg-accent/20"
      >
        <ProgressRing value={value} size={14} label="Fixer progress" />
        <span className="texo-shimmer truncate">{label}</span>
      </button>
    </Tooltip>
  );
}
