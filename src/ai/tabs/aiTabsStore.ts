// The AI tabs in the editor's tab strip: Chat, Agents, Papers (the paper
// library), and one tab per agent run. They sit after the file tabs; when one of them is active it takes the
// editor area, and showing a file (a click on its tab, the file tree, Quick
// Open, a compile error) puts the file back in front. Open tabs and the
// active one are remembered per project (localStorage), like file tabs.

import { create } from "zustand";
import { useLayout } from "../../workspace/layoutStore";

/** "chat", "agents", "papers", or "run:<run id>". */
export type AiTabId = "chat" | "agents" | "papers" | `run:${string}`;

export interface AiTabsState {
  tabs: AiTabId[];
  /** The AI tab in front of the editor, or null when a file shows. */
  active: AiTabId | null;
}

export const AI_TABS_PREFIX = "texo.aiTabs.";
export const aiTabsKey = (projectKey: string) => `${AI_TABS_PREFIX}${projectKey}`;
/** More than this many saved tabs are dropped (oldest run tabs first). */
export const MAX_SAVED_TABS = 24;

export const runTabId = (runId: string): AiTabId => `run:${runId}`;

/** The run a tab shows, or null for Chat, Agents and Papers. */
export function runIdOf(tab: AiTabId): string | null {
  return tab.startsWith("run:") ? tab.slice(4) : null;
}

export function isAiTabId(v: unknown): v is AiTabId {
  return v === "chat" || v === "agents" || v === "papers" || (typeof v === "string" && /^run:\S{1,200}$/.test(v));
}

export const EMPTY_TABS: AiTabsState = { tabs: [], active: null };

/** Saved tabs, with anything unexpected left out. */
export function parseAiTabs(raw: string | null): AiTabsState {
  try {
    const o = JSON.parse(raw ?? "null") as Partial<AiTabsState> | null;
    if (!o || typeof o !== "object" || !Array.isArray(o.tabs)) return EMPTY_TABS;
    const tabs = [...new Set(o.tabs.filter(isAiTabId))];
    while (tabs.length > MAX_SAVED_TABS) {
      const oldestRun = tabs.findIndex((t) => runIdOf(t));
      tabs.splice(oldestRun >= 0 ? oldestRun : 0, 1);
    }
    const active = isAiTabId(o.active) && tabs.includes(o.active) ? o.active : null;
    return { tabs, active };
  } catch {
    return EMPTY_TABS;
  }
}

/** Opens (or brings forward) a tab. */
export function withTab(s: AiTabsState, id: AiTabId): AiTabsState {
  return { tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id };
}

/** What shows after a tab closes: another AI tab, a file, or nothing new. */
export type AfterClose = { kind: "ai"; id: AiTabId } | { kind: "file"; path: string } | { kind: "none" };

/**
 * Closes `id`. When it was in front, its right-hand neighbour in the whole
 * strip (file tabs, then AI tabs) comes forward, else its left-hand one.
 */
export function withoutTab(s: AiTabsState, id: AiTabId, files: string[] = []): { state: AiTabsState; next: AfterClose } {
  const i = s.tabs.indexOf(id);
  if (i < 0) return { state: s, next: { kind: "none" } };
  const tabs = s.tabs.filter((t) => t !== id);
  if (s.active !== id) return { state: { tabs, active: s.active }, next: { kind: "none" } };
  const right = s.tabs[i + 1];
  if (right) return { state: { tabs, active: right }, next: { kind: "ai", id: right } };
  const left = s.tabs[i - 1];
  if (left) return { state: { tabs, active: left }, next: { kind: "ai", id: left } };
  const file = files[files.length - 1];
  return { state: { tabs, active: null }, next: file ? { kind: "file", path: file } : { kind: "none" } };
}

/** Closes the run tabs whose run is gone. */
export function withoutRuns(s: AiTabsState, keep: (runId: string) => boolean): AiTabsState {
  const tabs = s.tabs.filter((t) => {
    const run = runIdOf(t);
    return !run || keep(run);
  });
  if (tabs.length === s.tabs.length) return s;
  // A closed run tab in front gives way to the tab before it, or to the file.
  let active = s.active;
  if (active && !tabs.includes(active)) {
    const before = s.tabs.slice(0, s.tabs.indexOf(active)).reverse().find((t) => tabs.includes(t));
    active = before ?? tabs[0] ?? null;
  }
  return { tabs, active };
}

/** What the run tabs need to know of the runs store. */
export interface RunsView {
  project: string | null;
  runs: Record<string, unknown>;
  loading: boolean;
  error?: string | null;
}

/**
 * After the runs change from `prev` to `next`, which run tabs may stay, or
 * null when nothing says a run is gone. A run that was there and isn't was
 * deleted; once a fresh list is in, a run not in it is gone too (a tab
 * restored for a run deleted meanwhile).
 */
export function runTabKeeper(prev: RunsView, next: RunsView, project: string): ((runId: string) => boolean) | null {
  if (!next.project || next.project !== project || prev.project !== next.project) return null;
  const listed = prev.loading && !next.loading && !next.error;
  const removed = Object.keys(prev.runs).some((id) => !(id in next.runs));
  if (!listed && !removed) return null;
  return (id) => id in next.runs || (!listed && !(id in prev.runs));
}

/** True once the runs of `project` are listed (so a run missing from them is gone). */
export const runsListed = (r: RunsView, project: string) => r.project === project && !r.loading && !r.error;

/** One entry of the whole tab strip. */
export type StripTab = { kind: "file"; path: string } | { kind: "ai"; id: AiTabId };

/** The whole strip in order: file tabs, then AI tabs. */
export function stripTabs(files: string[], ai: AiTabId[]): StripTab[] {
  return [...files.map((path): StripTab => ({ kind: "file", path })), ...ai.map((id): StripTab => ({ kind: "ai", id }))];
}

/** Where Ctrl+Tab (or Ctrl+Shift+Tab) goes from the tab in front. */
export function cycleTab(files: string[], fileActive: string | null, ai: AiTabsState, back: boolean): StripTab | null {
  const all = stripTabs(files, ai.tabs);
  if (all.length < 2) return null;
  const at = ai.active ? all.findIndex((t) => t.kind === "ai" && t.id === ai.active) : all.findIndex((t) => t.kind === "file" && t.path === fileActive);
  return all[(at + (back ? -1 : 1) + all.length) % all.length];
}

function save(key: string | null, s: AiTabsState) {
  if (!key) return;
  try {
    localStorage.setItem(aiTabsKey(key), JSON.stringify({ tabs: s.tabs, active: s.active }));
  } catch {
    // Remembered for this session only.
  }
}

/** An AI tab coming forward needs the editor side of the window. */
function revealEditorSide() {
  const layout = useLayout.getState();
  if (layout.layout === "pdf") layout.setLayout("split");
}

interface AiTabsStore extends AiTabsState {
  /** Whose tabs these are (the project's id); null with no project open. */
  projectKey: string | null;
  /** Restores a project's saved tabs. */
  load: (projectKey: string) => void;
  /** Forgets the tabs (the project closed). */
  reset: () => void;
  /** Opens a tab, or brings it forward. */
  open: (id: AiTabId) => void;
  /** Opens the Agents tab (`show("agents")`); a run tab opened right after takes its place. */
  openAgents: () => void;
  /** Opens a run's tab. */
  openRun: (runId: string) => void;
  /** Brings an open AI tab forward, or (null) gives the editor area back to the file. */
  activate: (id: AiTabId | null) => void;
  /** Closes a tab; returns what should show next (a file to open, say). */
  close: (id: AiTabId, files?: string[]) => AfterClose;
  /** Closes the run tabs whose run is gone. */
  pruneRuns: (keep: (runId: string) => boolean) => void;
}

/**
 * Set by openAgents for the rest of this task: whether it added the tab. Many
 * places ask for the Agents tab and then, in the same breath, for a run; the
 * run's own tab is then what they mean.
 */
let agentsJustOpened: { created: boolean } | null = null;

export const useAiTabs = create<AiTabsStore>((set, get) => {
  const apply = (next: AiTabsState) => {
    set({ tabs: next.tabs, active: next.active });
    save(get().projectKey, next);
  };
  return {
    ...EMPTY_TABS,
    projectKey: null,
    load: (projectKey) => {
      let saved = EMPTY_TABS;
      try {
        saved = parseAiTabs(localStorage.getItem(aiTabsKey(projectKey)));
      } catch {
        // No storage: start with no AI tabs.
      }
      set({ projectKey, ...saved });
    },
    reset: () => set({ projectKey: null, ...EMPTY_TABS }),
    open: (id) => {
      apply(withTab(get(), id));
      revealEditorSide();
    },
    openAgents: () => {
      const created = !get().tabs.includes("agents");
      get().open("agents");
      agentsJustOpened = { created };
      queueMicrotask(() => {
        agentsJustOpened = null;
      });
    },
    openRun: (runId) => {
      let s: AiTabsState = get();
      if (agentsJustOpened?.created) s = { tabs: s.tabs.filter((t) => t !== "agents"), active: s.active };
      agentsJustOpened = null;
      apply(withTab(s, runTabId(runId)));
      revealEditorSide();
    },
    activate: (id) => {
      if (id && !get().tabs.includes(id)) return;
      if (id === get().active) return;
      apply({ tabs: get().tabs, active: id });
    },
    close: (id, files = []) => {
      const { state, next } = withoutTab(get(), id, files);
      if (state !== get()) apply(state);
      return next;
    },
    pruneRuns: (keep) => {
      const next = withoutRuns(get(), keep);
      if (next !== get()) apply(next);
    },
  };
});

/** Opens the paper library in its editor tab, or brings that tab forward. */
export function openPapersTab() {
  useAiTabs.getState().open("papers");
}

/** A file asked to show (the file tree, Quick Open, search, a compile error, its tab) comes in front of any AI tab. */
export function showFileInFront() {
  useAiTabs.getState().activate(null);
}
