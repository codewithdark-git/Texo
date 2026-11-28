// Which dialog the Agents tab shows (at most one), so run cards and other
// places (e.g. a "Review changes" link) can open one.

import { create } from "zustand";
import type { AgentProfile, RunSummary } from "../../lib/agentsApi";
import type { ReadyAttachment } from "../chat/readAttachment";

/** The kinds the New task dialog starts. */
export type NewTaskKind = "task" | "rebuttal";

/** What a start dialog can be opened with (e.g. from the AI Chat bar). */
export interface StartSeed {
  /** Words to start from: the New task prompt, or the review's Focus. */
  prompt?: string;
  /** Called with the new run's id once the dialog started it. */
  onStarted?: (runId: string) => void;
}

export type AgentDialog =
  | ({ type: "new"; kind: NewTaskKind; profile?: AgentProfile | null; attachments?: ReadyAttachment[] } & StartSeed)
  | ({ type: "review"; profile?: AgentProfile | null } & StartSeed)
  | { type: "changes"; runId: string }
  | { type: "plan"; runId: string }
  | { type: "report"; runId: string }
  | { type: "delete"; run: RunSummary };

export const useAgentDialog = create<{ dialog: AgentDialog | null; open: (d: AgentDialog | null) => void }>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
}));

export const openAgentDialog = (d: AgentDialog | null) => useAgentDialog.getState().open(d);
