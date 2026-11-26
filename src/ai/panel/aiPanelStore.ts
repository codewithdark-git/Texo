// The right-dock AI panel: open or closed, its width, which tab shows, and a
// badge for background agent runs that finished while the Agents tab wasn't
// in view. Open/width/tab are remembered across sessions (localStorage).

import { create } from "zustand";
import type { RunStatus, RunSummary } from "../../lib/agentsApi";
import { useAgentDialog } from "../agents/dialogStore";

export type AiTab = "chat" | "agents";

export const PANEL_KEY = "texo.aiPanel";
export const DEFAULT_WIDTH = 400;
export const MIN_WIDTH = 300;
export const MAX_WIDTH = 760;

export interface PanelPrefs {
  open: boolean;
  width: number;
  tab: AiTab;
}

const DEFAULT_PREFS: PanelPrefs = { open: false, width: DEFAULT_WIDTH, tab: "chat" };

/** A width that fits: within the panel's limits and leaving at least `room` pixels of a `windowWidth`-wide window for the rest. */
export function clampWidth(width: number, windowWidth = Infinity, room = 480): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, windowWidth - room));
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

/** Saved prefs, with anything unexpected replaced by defaults. */
export function parsePrefs(raw: string | null): PanelPrefs {
  try {
    const o = JSON.parse(raw ?? "{}") as Partial<PanelPrefs>;
    return {
      open: typeof o.open === "boolean" ? o.open : DEFAULT_PREFS.open,
      width: typeof o.width === "number" ? clampWidth(o.width) : DEFAULT_PREFS.width,
      tab: o.tab === "agents" || o.tab === "chat" ? o.tab : DEFAULT_PREFS.tab,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadPrefs(): PanelPrefs {
  try {
    return parsePrefs(localStorage.getItem(PANEL_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(p: PanelPrefs) {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(p));
  } catch {
    // Remembered for this session only.
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

interface AiPanelStore extends PanelPrefs {
  /** Background runs that finished since the Agents tab was last in view. */
  badge: number;
  /** Last status seen per run id, to notice transitions. */
  seen: Record<string, RunStatus>;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number, persist?: boolean) => void;
  setTab: (tab: AiTab) => void;
  /** Opens the panel on a tab. */
  show: (tab: AiTab) => void;
  /** Feeds a run update; returns true when it counts as a background finish (badge raised). */
  noteRun: (run: Pick<RunSummary, "id" | "status">) => boolean;
  clearBadge: () => void;
}

export const useAiPanel = create<AiPanelStore>((set, get) => {
  const persist = () => {
    const { open, width, tab } = get();
    savePrefs({ open, width, tab });
  };
  const agentsVisible = () => get().open && get().tab === "agents";
  return {
    ...loadPrefs(),
    badge: 0,
    seen: {},
    setOpen: (open) => {
      // The agent dialogs live in the panel: closing it (Ctrl+Shift+A) would
      // throw away picks, reasons and typed prompts. Show the dialog instead (FE-4).
      if (!open && get().open && useAgentDialog.getState().dialog) {
        get().show("agents");
        return;
      }
      set(open && get().tab === "agents" ? { open, badge: 0 } : { open });
      persist();
    },
    toggle: () => get().setOpen(!get().open),
    setWidth: (width, save = true) => {
      set({ width: clampWidth(width, typeof window === "undefined" ? Infinity : window.innerWidth) });
      if (save) persist();
    },
    setTab: (tab) => {
      set(tab === "agents" && get().open ? { tab, badge: 0 } : { tab });
      persist();
    },
    show: (tab) => {
      set({ open: true, tab, ...(tab === "agents" ? { badge: 0 } : {}) });
      persist();
    },
    noteRun: (run) => {
      const before = get().seen[run.id];
      const finished = justFinished(before, run.status);
      const raise = finished && !agentsVisible();
      set((s) => ({ seen: { ...s.seen, [run.id]: run.status }, ...(raise ? { badge: s.badge + 1 } : {}) }));
      return raise;
    },
    clearBadge: () => set({ badge: 0 }),
  };
});
