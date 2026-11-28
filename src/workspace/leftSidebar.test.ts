// Static markup of the left sidebar: its three tabs at each width and the
// rail, with Papers gone from both (it opens as an editor tab). The panels
// are stand-ins. A server render reads the store's first state, so each
// render starts a fresh copy of the modules from a saved layout.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./FileTree", () => ({ FileTree: () => "files-panel" }));
vi.mock("./Outline", () => ({ Outline: () => "outline-panel" }));
vi.mock("./SearchPanel", () => ({ SearchPanel: () => "search-panel" }));
vi.mock("./SidebarFooter", () => ({ SidebarFooter: () => null }));

import compilePanel from "./CompilePanel.tsx?raw";
import leftSidebar from "./LeftSidebar.tsx?raw";
import { DEFAULT_LAYOUT, LAYOUT_KEY, SIDEBAR_ICON_LABELS_MIN, SIDEBAR_LABELS_MIN, type LayoutPrefs } from "./layoutStore";
import { sidebarTabItems } from "./LeftSidebar";

async function render(prefs: Partial<LayoutPrefs> = {}): Promise<string> {
  const saved = JSON.stringify({ ...DEFAULT_LAYOUT, ...prefs });
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === LAYOUT_KEY ? saved : null), setItem: () => {} });
  vi.resetModules();
  const [{ createElement }, { renderToStaticMarkup }, { LeftSidebar }] = await Promise.all([import("react"), import("react-dom/server"), import("./LeftSidebar")]);
  return renderToStaticMarkup(createElement(LeftSidebar, { project: "C:/p", dropTarget: null, searchFocus: 0 }));
}
const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>/g)].length;

afterEach(() => vi.unstubAllGlobals());

describe("LeftSidebar", () => {
  it("has Files, Outline and Search tabs, without Papers", async () => {
    const html = await render({ sidebar: 400 });
    expect(tabs(html)).toBe(3);
    for (const label of ["Files", "Outline", "Search"]) expect(html).toContain(`>${label}</span>`);
    expect(html).not.toContain('id="sidebar-tab-papers"');
    expect(html).not.toContain("library-panel");
    expect(leftSidebar).not.toContain("LibraryPanel");
  });

  it("shows icons and labels when wide, labels in the middle and icons alone when narrow", async () => {
    expect(sidebarTabItems(SIDEBAR_ICON_LABELS_MIN).every((t) => t.icon)).toBe(true);
    expect(sidebarTabItems(SIDEBAR_ICON_LABELS_MIN - 1).some((t) => t.icon)).toBe(false);
    expect(sidebarTabItems(SIDEBAR_ICON_LABELS_MIN - 1).map((t) => t.label)).toEqual(["Files", "Outline", "Search"]);

    const narrow = await render({ sidebar: SIDEBAR_LABELS_MIN - 1 });
    expect(tabs(narrow)).toBe(3);
    expect(narrow).toContain('aria-label="Search"');
    expect(narrow).not.toContain(">Search</span>");
    const middle = await render({ sidebar: SIDEBAR_LABELS_MIN });
    expect(middle).toContain(">Search</span>");
  });

  it("lists Files, Outline and Search in the folded rail", async () => {
    const html = await render({ collapsed: true });
    for (const label of ["Files", "Outline", "Search"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="Papers"');
  });

  it("falls back to Files for a layout saved with the old Papers tab", async () => {
    const html = await render({ sidebarTab: "papers" as never });
    expect(html).toContain('id="sidebar-tab-files"');
    expect(html).toMatch(/id="sidebar-tab-files"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="sidebar-tab-files"/);
  });
});

describe("preview tabs", () => {
  it("are PDF, Issues, Log and History, without Papers", async () => {
    expect(compilePanel).not.toContain("LibraryPanel");
    expect(compilePanel).not.toContain('"papers"');
    for (const id of ['id: "pdf"', 'id: "issues"', 'id: "log"', 'id: "history"']) expect(compilePanel).toContain(id);
  });
});
