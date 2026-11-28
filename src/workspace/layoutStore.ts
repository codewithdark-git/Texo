// The editor window's layout: which panes show (code / split / pdf), the left
// sidebar's width and whether it is folded to an icon rail, its tab (Files,
// Outline or Search), the right panel's tab (PDF, Issues, Log or
// History), and the editor/preview split. Remembered across sessions in
// localStorage under the same key 1.2 used, so old saved layouts carry over.

import { create } from "zustand";

export type Layout = "split" | "code" | "pdf";

export const SIDEBAR_TABS = ["files", "outline", "search"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];

export const RIGHT_TABS = ["pdf", "issues", "log", "history"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

/** Tabs that show compile output; the compile may switch between these on its own. */
export const COMPILE_TABS: readonly RightTab[] = ["pdf", "issues", "log"];

export const LAYOUT_KEY = "texo.layout";
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 240;
/** The folded sidebar: tab icons at the top, footer icons at the bottom. */
export const RAIL_WIDTH = 44;
/** Below this width the sidebar tabs show icons only, with the label in a tooltip. */
export const SIDEBAR_LABELS_MIN = 230;
/** From this width the sidebar tabs show their icons next to the labels. */
export const SIDEBAR_ICON_LABELS_MIN = 330;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

export interface LayoutPrefs {
  layout: Layout;
  sidebar: number;
  collapsed: boolean;
  sidebarTab: SidebarTab;
  rightTab: RightTab;
  split: number;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  layout: "split",
  sidebar: SIDEBAR_DEFAULT,
  collapsed: false,
  sidebarTab: "files",
  rightTab: "pdf",
  split: 0.55,
};

export function clampSidebar(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

export function clampSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_LAYOUT.split;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
}

/** The width the sidebar takes on screen: the rail when folded, otherwise its width. */
export function sidebarColumn(p: Pick<LayoutPrefs, "sidebar" | "collapsed">): number {
  return p.collapsed ? RAIL_WIDTH : clampSidebar(p.sidebar);
}

/**
 * How the sidebar's four tabs fit at `width`: icon and label when there is
 * room, the label alone in the middle, and only the icon (label in a tooltip)
 * when narrow.
 */
export function sidebarTabStyle(width: number): "full" | "labels" | "icons" {
  if (width >= SIDEBAR_ICON_LABELS_MIN) return "full";
  return width >= SIDEBAR_LABELS_MIN ? "labels" : "icons";
}

const isLayout = (v: unknown): v is Layout => v === "split" || v === "code" || v === "pdf";
const isSidebarTab = (v: unknown): v is SidebarTab => (SIDEBAR_TABS as readonly unknown[]).includes(v);
const isRightTab = (v: unknown): v is RightTab => (RIGHT_TABS as readonly unknown[]).includes(v);

/**
 * Saved prefs, with anything unexpected replaced by defaults. Reads both the
 * 1.2 shape (`{layout, sidebar, split}`) and the current one. Papers used to
 * be a right-panel tab (1.2), then a sidebar tab; it is now an editor tab, so
 * a saved Papers tab falls back to the PDF on the right and Files in the
 * sidebar.
 */
export function parseLayout(raw: string | null): LayoutPrefs {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    o = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    o = {};
  }
  return {
    layout: isLayout(o.layout) ? o.layout : DEFAULT_LAYOUT.layout,
    sidebar: typeof o.sidebar === "number" ? clampSidebar(o.sidebar) : DEFAULT_LAYOUT.sidebar,
    collapsed: typeof o.collapsed === "boolean" ? o.collapsed : DEFAULT_LAYOUT.collapsed,
    sidebarTab: isSidebarTab(o.sidebarTab) ? o.sidebarTab : DEFAULT_LAYOUT.sidebarTab,
    // History used to be a sidebar tab; it now lives in the right panel.
    rightTab: isRightTab(o.rightTab) ? o.rightTab : o.sidebarTab === "history" ? "history" : DEFAULT_LAYOUT.rightTab,
    split: typeof o.split === "number" ? clampSplit(o.split) : DEFAULT_LAYOUT.split,
  };
}

/** What a finished compile asks the right panel to show. */
export type CompileOutcome = "failed" | "success" | "other";

/**
 * The right panel's tab after a compile: a failed one shows the issues and a
 * successful one brings the PDF back from the issues. Only the compile tabs
 * change; someone reading History is never pulled away, and a
 * success leaves the Log alone so saving (which auto-compiles) doesn't keep
 * yanking it away.
 */
export function autoTabAfterCompile(current: RightTab, outcome: CompileOutcome): RightTab {
  if (!COMPILE_TABS.includes(current)) return current;
  if (outcome === "failed") return "issues";
  if (outcome === "success" && current === "issues") return "pdf";
  return current;
}

/** The prefs after `openRightTab(tab)`: that tab, with the right panel shown. */
export function withRightTab(p: LayoutPrefs, tab: RightTab): LayoutPrefs {
  return { ...p, rightTab: tab, layout: p.layout === "code" ? "split" : p.layout };
}

interface LayoutStore extends LayoutPrefs {
  setLayout: (layout: Layout) => void;
  /** Live while dragging (`persist` false), then saved on release. */
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Shows a sidebar tab, unfolding the rail if needed. */
  showSidebarTab: (tab: SidebarTab) => void;
  setRightTab: (tab: RightTab) => void;
  /** Shows a right-panel tab, switching the code-only layout to split so it is visible. */
  openRightTab: (tab: RightTab) => void;
  setSplit: (ratio: number, persist?: boolean) => void;
  /** Applies the compile's tab rule (see `autoTabAfterCompile`). */
  afterCompile: (outcome: CompileOutcome) => void;
}

function load(): LayoutPrefs {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function save(p: LayoutPrefs) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(p));
  } catch {
    // Remembered for this session only.
  }
}

export const useLayout = create<LayoutStore>((set, get) => {
  const prefs = (): LayoutPrefs => {
    const { layout, sidebar, collapsed, sidebarTab, rightTab, split } = get();
    return { layout, sidebar, collapsed, sidebarTab, rightTab, split };
  };
  const update = (patch: Partial<LayoutPrefs>, persist = true) => {
    set(patch);
    if (persist) save(prefs());
  };
  return {
    ...load(),
    setLayout: (layout) => update({ layout }),
    setSidebarWidth: (width, persist = true) => update({ sidebar: clampSidebar(width), collapsed: false }, persist),
    setCollapsed: (collapsed) => update({ collapsed }),
    toggleSidebar: () => update({ collapsed: !get().collapsed }),
    setSidebarTab: (sidebarTab) => update({ sidebarTab }),
    showSidebarTab: (sidebarTab) => update({ sidebarTab, collapsed: false }),
    setRightTab: (rightTab) => update({ rightTab }),
    openRightTab: (tab) => {
      const next = withRightTab(prefs(), tab);
      update({ rightTab: next.rightTab, layout: next.layout });
    },
    setSplit: (ratio, persist = true) => update({ split: clampSplit(ratio) }, persist),
    afterCompile: (outcome) => {
      const next = autoTabAfterCompile(get().rightTab, outcome);
      if (next !== get().rightTab) update({ rightTab: next });
    },
  };
});
