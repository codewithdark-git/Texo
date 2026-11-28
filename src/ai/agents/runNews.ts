// What a run's own tab tells a screen reader between two updates of the run:
// its phase changes and how it came out. The Agents tab's live region covers
// the list, but it isn't mounted while a run's tab is in front.

import type { RunStatus, RunSummary } from "../../lib/agentsApi";
import { finishText, justFinished } from "../panel/aiPanelStore";
import { phaseAnnouncements, type PhaseMemory } from "./progress/progressModel";

/** What a run's tab remembers between updates, to tell what changed. */
export interface RunNewsMemory {
  phases: PhaseMemory;
  status?: RunStatus;
}

/**
 * Lines for a screen reader about one run between two updates: phases that
 * started or finished, then how the run came out ("Review paper: done. 2
 * file(s) to review.") or that it was stopped. The first update only sets
 * the memory.
 */
export function runNews(before: RunNewsMemory, run: Pick<RunSummary, "id" | "title" | "kind" | "progress" | "status" | "pendingFiles">): { lines: string[]; memory: RunNewsMemory } {
  const { lines, memory: phases } = phaseAnnouncements(before.phases, [run]);
  if (justFinished(before.status, run.status)) lines.push(finishText(run));
  else if (before.status && before.status !== "cancelled" && run.status === "cancelled") lines.push(`${run.title.trim() || "The agent"} was stopped.`);
  return { lines, memory: { phases, status: run.status } };
}
