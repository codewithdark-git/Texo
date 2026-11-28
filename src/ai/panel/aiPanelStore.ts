// What is left of the old right-hand AI panel now that Chat, Agents and runs
// open as editor tabs (src/ai/tabs): `show("chat" | "agents")` opens that
// tab, how much each run card shows (Summary or Detailed, remembered), and a
// badge for background agent runs that finished while neither the Agents tab
// nor the run's own tab was in view. The badge clears when the Agents tab
// comes forward; a run's own tab coming forward takes that run off it.

import { create } from "zustand";
import type { RunStatus, RunSummary } from "../../lib/agentsApi";
import { useLayout } from "../../workspace/layoutStore";
import { runIdOf, runTabId, useAiTabs, type AiTabId } from "../tabs/aiTabsStore";
import { useRunFocus } from "../agents/focusStore";

export type AiTab = "chat" | "agents";
/** How much a run card shows: phases and the live line, or also the plan, steps and lanes. */
export type Density = "summary" | "detailed";

/** Kept from the old right-hand panel, so a saved density still reads. */
export const DENSITY_KEY = "texo.aiPanel.density";

/** A saved density, or Summary. */
export function parseDensity(raw: string | null): Density {
  return raw === "detailed" ? "detailed" : "summary";
}

function loadDensity(): Density {
  try {
    return parseDensity(localStorage.getItem(DENSITY_KEY));
  } catch {
    return "summary";
  }
}

/** Statuses after which a run needs nothing more from the agent (it finished, failed or wants the user). */
const SETTLED: RunStatus[] = ["awaiting_review", "awaiting_input", "done", "failed", "interrupted"];
const WORKING: RunStatus[] = ["queued", "running"];

/** True when a run just went from working to a state the user should look at (not when the user stopped it). */
export function justFinished(before: RunStatus | undefined, after: RunStatus): boolean {
  // A run first seen already settled (e.g. listed on start) isn't news.
  return before !== undefined && WORKING.includes(before) && SETTLED.includes(after);
}

/** Plain words for the finish toast. */
export function finishText(run: Pick<RunSummary, "title" | "status" | "pendingFiles">): string {
  const title = run.title.trim() || "The agent";
  switch (run.status) {
    case "awaiting_review":
      return `${title}: done. ${run.pendingFiles} file(s) to review.`;
    case "awaiting_input":
      return `${title} is waiting for you.`;
    case "failed":
    case "interrupted":
      return `${title} didn't finish.`;
    default:
      return `${title}: done.`;
  }
}

/** True while the user can see this tab in the editor area. */
export function tabInView(tab: AiTabId): boolean {
  return useAiTabs.getState().active === tab && useLayout.getState().layout !== "pdf";
}

interface AiPanelStore {
  density: Density;
  setDensity: (density: Density) => void;
  /** Background runs that finished since the Agents tab was last in view. */
  badge: number;
  /** The runs counted in the badge, oldest first; opening one's tab takes it off. */
  unseen: string[];
  /** Last status seen per run id, to notice transitions. */
  seen: Record<string, RunStatus>;
  /** Opens the Chat or Agents editor tab, or brings it forward. */
  show: (tab: AiTab) => void;
  /** Set when something asks for the Chat tab with its list of chats open; the Chat tab opens the list and clears it. */
  chatListWanted: boolean;
  /** Opens the Chat tab with its list of chats open. */
  showChatList: () => void;
  /** Feeds a run update; returns true when it counts as a background finish (badge raised). */
  noteRun: (run: Pick<RunSummary, "id" | "status">) => boolean;
  clearBadge: () => void;
}

/** True while show("agents") opens the tab: the badge then waits to see whether a run tab takes its place. */
let openingAgents = false;

export const useAiPanel = create<AiPanelStore>((set, get) => ({
  density: loadDensity(),
  setDensity: (density) => {
    set({ density });
    try {
      localStorage.setItem(DENSITY_KEY, density);
    } catch {
      // Remembered for this session only.
    }
  },
  badge: 0,
  unseen: [],
  seen: {},
  show: (tab) => {
    if (tab === "agents") {
      // Many callers ask for a run's tab right after; that tab then takes the
      // Agents tab's place, and the finishes counted are still unseen. So the
      // badge clears once this task is over, if the Agents tab is in view.
      openingAgents = true;
      try {
        useAiTabs.getState().openAgents();
      } finally {
        openingAgents = false;
      }
      queueMicrotask(() => {
        if (tabInView("agents") && get().badge) get().clearBadge();
      });
    } else useAiTabs.getState().open("chat");
  },
  chatListWanted: false,
  showChatList: () => {
    set({ chatListWanted: true });
    useAiTabs.getState().open("chat");
  },
  noteRun: (run) => {
    const before = get().seen[run.id];
    const finished = justFinished(before, run.status);
    // A finish isn't news while the Agents tab or the run's own tab is in front.
    const raise = finished && !tabInView("agents") && !tabInView(runTabId(run.id));
    set((s) => {
      const seen = { ...s.seen, [run.id]: run.status };
      // Finishing again (say, after a reply) counts the run once.
      if (!raise || s.unseen.includes(run.id)) return { seen };
      return { seen, badge: s.badge + 1, unseen: [...s.unseen, run.id] };
    });
    return raise;
  },
  clearBadge: () => set({ badge: 0, unseen: [] }),
}));

// Bringing the Agents tab forward counts as seeing the finishes.
useAiTabs.subscribe((s, prev) => {
  // A chat list asked for but not shown (the Chat tab couldn't list chats) isn't wanted later.
  if (s.active !== "chat" && useAiPanel.getState().chatListWanted) useAiPanel.setState({ chatListWanted: false });
  if (openingAgents) return;
  if (s.active === "agents" && prev.active !== "agents" && useAiPanel.getState().badge) useAiPanel.getState().clearBadge();
  // Bringing a finished run's own tab forward counts as seeing that run.
  const runId = s.active && s.active !== prev.active ? runIdOf(s.active) : null;
  if (runId) seeRun(runId);
});

/** Takes one run off the badge (its tab came forward). */
export function seeRun(runId: string) {
  const { unseen, badge } = useAiPanel.getState();
  if (!unseen.includes(runId)) return;
  useAiPanel.setState({ unseen: unseen.filter((id) => id !== runId), badge: Math.max(0, badge - 1) });
}

/** Opens a run's tab and counts the run as seen (its tab may already have been the active one, behind the PDF). */
export function openRunTab(runId: string) {
  useRunFocus.getState().focus(runId);
  seeRun(runId);
}

/** What the AI button opens while the badge shows: the one finished run's tab, or the Agents tab for several. */
export function showFinished() {
  const { unseen, badge } = useAiPanel.getState();
  if (badge === 1 && unseen.length === 1) openRunTab(unseen[0]);
  else useAiPanel.getState().show("agents");
}
