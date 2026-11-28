// Which agent run the user asked to look at, from the Command Center, the
// sidebar's background tasks dock, a toast or a paper's "Found by". Asking
// opens that run's editor tab (or brings it forward); the request stays here
// too, so a run card in the Agents tab that shows it can flash once, then
// clears it.

import { create } from "zustand";
import { useAiTabs } from "../tabs/aiTabsStore";

interface RunFocusStore {
  /** The run to bring into view, or null when nothing is asked for. */
  runId: string | null;
  /** Goes up on every request, so asking for the same run twice still counts. */
  seq: number;
  /** Opens the run's tab and notes the request. */
  focus: (id: string) => void;
  clear: () => void;
}

export const useRunFocus = create<RunFocusStore>((set) => ({
  runId: null,
  seq: 0,
  focus: (id) => {
    useAiTabs.getState().openRun(id);
    set((s) => ({ runId: id, seq: s.seq + 1 }));
  },
  clear: () => set({ runId: null }),
}));
