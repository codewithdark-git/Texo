// Which dialog the Agents tab shows (at most one), so run cards and other
// places (e.g. a "Review changes" link) can open one.

import { create } from "zustand";
import type { AgentProfile, RunSummary } from "../../lib/agentsApi";

/** The kinds the New task dialog starts. */
export type NewTaskKind = "task" | "rebuttal";

export type AgentDialog =
  | { type: "new"; kind: NewTaskKind; profile?: AgentProfile | null }
  | { type: "review"; profile?: AgentProfile | null }
  | { type: "changes"; runId: string }
  | { type: "plan"; runId: string }
  | { type: "report"; runId: string }
  | { type: "delete"; run: RunSummary };

export const useAgentDialog = create<{ dialog: AgentDialog | null; open: (d: AgentDialog | null) => void }>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
}));

export const openAgentDialog = (d: AgentDialog | null) => useAgentDialog.getState().open(d);
