import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import workspace from "./Workspace.tsx?raw";
import {
  autoTabAfterCompile,
  clampSidebar,
  clampSplit,
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  parseLayout,
  RAIL_WIDTH,
  RIGHT_TABS,
  SIDEBAR_ICON_LABELS_MIN,
  SIDEBAR_LABELS_MIN,
  SIDEBAR_TABS,
  sidebarColumn,
  sidebarTabStyle,
  useLayout,
  type RightTab,
} from "./layoutStore";

const reset = () => useLayout.setState({ ...DEFAULT_LAYOUT });

describe("layout tabs", () => {
  it("the sidebar has Files, Outline and Search; the right panel has PDF, Issues, Log and History", () => {
    expect(SIDEBAR_TABS).toEqual(["files", "outline", "search"]);
    expect(RIGHT_TABS).toEqual(["pdf", "issues", "log", "history"]);
  });

  it("the sidebar tabs drop their icons, then their labels, as the sidebar narrows", () => {
    expect(sidebarTabStyle(480)).toBe("full");
    expect(sidebarTabStyle(SIDEBAR_ICON_LABELS_MIN)).toBe("full");
    expect(sidebarTabStyle(SIDEBAR_ICON_LABELS_MIN - 1)).toBe("labels");
    expect(sidebarTabStyle(240)).toBe("labels");
    expect(sidebarTabStyle(SIDEBAR_LABELS_MIN)).toBe("labels");
    expect(sidebarTabStyle(SIDEBAR_LABELS_MIN - 1)).toBe("icons");
    expect(sidebarTabStyle(180)).toBe("icons");
  });
});

describe("parseLayout", () => {
  it("migrates the 1.2 layout JSON", () => {
    const old = JSON.stringify({ layout: "pdf", sidebar: 300, split: 0.4 });
    expect(parseLayout(old)).toEqual({ ...DEFAULT_LAYOUT, layout: "pdf", sidebar: 300, split: 0.4 });
  });

  it("keeps the new fields and replaces anything unexpected with defaults", () => {
    const saved = { layout: "code", sidebar: 200, collapsed: true, sidebarTab: "outline", rightTab: "log", split: 0.3 };
    expect(parseLayout(JSON.stringify(saved))).toEqual(saved);
    expect(parseLayout("not json")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("[1,2]")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ layout: "wide", sidebar: "x", collapsed: 1, sidebarTab: "nope", rightTab: 3, split: null }))).toEqual(
      DEFAULT_LAYOUT,
    );
  });

  it("sends a History sidebar tab to the right panel", () => {
    const p = parseLayout(JSON.stringify({ sidebarTab: "history" }));
    expect(p.sidebarTab).toBe("files");
    expect(p.rightTab).toBe("history");
  });

  it("drops a saved Papers tab, sidebar or right panel, for Files and the PDF", () => {
    const p = parseLayout(JSON.stringify({ layout: "split", collapsed: true, sidebarTab: "outline", rightTab: "papers" }));
    expect(p).toMatchObject({ sidebarTab: "outline", rightTab: "pdf", collapsed: true, layout: "split" });
    expect(parseLayout(JSON.stringify({ sidebarTab: "papers", rightTab: "history" }))).toMatchObject({ sidebarTab: "files", rightTab: "history" });
    expect(parseLayout(JSON.stringify({ sidebarTab: "papers", rightTab: "papers" }))).toMatchObject({ sidebarTab: "files", rightTab: "pdf" });
  });

  it("clamps saved sizes", () => {
    expect(parseLayout(JSON.stringify({ sidebar: 20, split: 0.99 }))).toMatchObject({ sidebar: 180, split: 0.8 });
  });
});

describe("sizes", () => {
  it("clamps the sidebar to 180–480 and folds it to the 44px rail", () => {
    expect(clampSidebar(100)).toBe(180);
    expect(clampSidebar(900)).toBe(480);
    expect(clampSidebar(250.4)).toBe(250);
    expect(clampSidebar(Number.NaN)).toBe(240);
    expect(RAIL_WIDTH).toBe(44);
    expect(sidebarColumn({ sidebar: 300, collapsed: true })).toBe(44);
    expect(sidebarColumn({ sidebar: 300, collapsed: false })).toBe(300);
    expect(sidebarColumn({ sidebar: 9999, collapsed: false })).toBe(480);
  });

  it("clamps the editor/preview split", () => {
    expect(clampSplit(0)).toBe(0.2);
    expect(clampSplit(1)).toBe(0.8);
    expect(clampSplit(0.5)).toBe(0.5);
  });
});

describe("autoTabAfterCompile", () => {
  it("never leaves History", () => {
    for (const tab of ["history"] as RightTab[]) {
      expect(autoTabAfterCompile(tab, "failed")).toBe(tab);
      expect(autoTabAfterCompile(tab, "success")).toBe(tab);
      expect(autoTabAfterCompile(tab, "other")).toBe(tab);
    }
  });

  it("shows the issues after a failed compile and the PDF again after a good one", () => {
    expect(autoTabAfterCompile("pdf", "failed")).toBe("issues");
    expect(autoTabAfterCompile("log", "failed")).toBe("issues");
    expect(autoTabAfterCompile("issues", "success")).toBe("pdf");
    expect(autoTabAfterCompile("pdf", "success")).toBe("pdf");
    // Saving auto-compiles; someone reading the log stays on it.
    expect(autoTabAfterCompile("log", "success")).toBe("log");
    expect(autoTabAfterCompile("issues", "other")).toBe("issues");
  });
});

describe("useLayout", () => {
  beforeEach(reset);

  it("openRightTab shows the right panel when only the editor is showing", () => {
    useLayout.getState().setLayout("code");
    useLayout.getState().openRightTab("history");
    expect(useLayout.getState()).toMatchObject({ layout: "split", rightTab: "history" });
    useLayout.getState().setLayout("pdf");
    useLayout.getState().openRightTab("log");
    expect(useLayout.getState()).toMatchObject({ layout: "pdf", rightTab: "log" });
  });

  it("afterCompile follows the tab rule", () => {
    useLayout.getState().setRightTab("history");
    useLayout.getState().afterCompile("failed");
    expect(useLayout.getState().rightTab).toBe("history");
    useLayout.getState().setRightTab("pdf");
    useLayout.getState().afterCompile("failed");
    expect(useLayout.getState().rightTab).toBe("issues");
  });

  it("folds and unfolds the sidebar; resizing or picking a tab unfolds it", () => {
    const s = useLayout.getState();
    s.toggleSidebar();
    expect(useLayout.getState().collapsed).toBe(true);
    s.toggleSidebar();
    expect(useLayout.getState().collapsed).toBe(false);
    s.setCollapsed(true);
    s.showSidebarTab("search");
    expect(useLayout.getState()).toMatchObject({ collapsed: false, sidebarTab: "search" });
    s.setCollapsed(true);
    s.setSidebarWidth(1000, false);
    expect(useLayout.getState()).toMatchObject({ collapsed: false, sidebar: 480 });
  });
});

describe("saved layout", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores a layout saved with a Papers tab as Files and the PDF", async () => {
    store.set(LAYOUT_KEY, JSON.stringify({ layout: "split", sidebar: 300, collapsed: false, sidebarTab: "papers", rightTab: "papers", split: 0.5 }));
    const { useLayout: fresh } = await import("./layoutStore");
    expect(fresh.getState()).toMatchObject({ sidebarTab: "files", rightTab: "pdf", sidebar: 300 });
  });

  it("starts from the 1.2 texo.layout entry and saves back to it", async () => {
    store.set(LAYOUT_KEY, JSON.stringify({ layout: "code", sidebar: 320, split: 0.6 }));
    const { useLayout: fresh } = await import("./layoutStore");
    expect(fresh.getState()).toMatchObject({ layout: "code", sidebar: 320, split: 0.6, collapsed: false, sidebarTab: "files", rightTab: "pdf" });
    fresh.getState().openRightTab("history");
    expect(JSON.parse(store.get(LAYOUT_KEY)!)).toMatchObject({ layout: "split", rightTab: "history", sidebar: 320 });
    fresh.getState().showSidebarTab("outline");
    expect(JSON.parse(store.get(LAYOUT_KEY)!)).toMatchObject({ sidebarTab: "outline", rightTab: "history" });
    // A live drag isn't written until release.
    fresh.getState().setSidebarWidth(400, false);
    expect(JSON.parse(store.get(LAYOUT_KEY)!).sidebar).toBe(320);
  });
});

describe("Workspace shell", () => {
  /** Strips comments so commented-out JSX doesn't count. */
  const src = workspace.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  /** The JSX of the `<section>` that holds the editor. */
  function editorSection(): string {
    const at = src.indexOf("<EditorPane");
    const start = src.lastIndexOf("<section", at);
    const end = src.indexOf("</section>", at);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(at);
    return src.slice(start, end);
  }

  it("has the Command Center, the AI button and the composer bar", () => {
    expect(src).toMatch(/<CommandCenter\b/);
    expect(src).toMatch(/<AiPanelButton\b/);
    expect(editorSection()).toMatch(/<AiComposerBar\b/);
  });

  it("puts the status bar outside the editor section, below the panes", () => {
    expect(src).toMatch(/<StatusBar\b/);
    expect(editorSection()).not.toMatch(/<StatusBar\b/);
    expect(src.lastIndexOf("<StatusBar")).toBeGreaterThan(src.lastIndexOf("<AiPanel "));
  });

  it("no longer shows History in the left sidebar", () => {
    expect(src).not.toMatch(/<HistoryPanel\b/);
  });
});
