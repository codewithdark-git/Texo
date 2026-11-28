// The paper library at narrow widths (180-480px): the width rules, the panel's
// markup, compact cards, and opening a paper from an agent step in the
// Papers editor tab.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The workspace store pulls in Monaco; the panel only needs the file list.
vi.mock("../workspace/store", () => {
  const state = { files: [] };
  return { useWorkspace: Object.assign((sel: (s: typeof state) => unknown) => sel(state), { getState: () => state, subscribe: () => () => {} }) };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAiTabs } from "../ai/tabs/aiTabsStore";
import type { LibraryPaper } from "../lib/libraryApi";
import { DEFAULT_LAYOUT, useLayout } from "../workspace/layoutStore";
import { LibraryPanel, SCOPE_LABELS_MIN, SCOPES, scopeLabel, SORT_SEGMENTS_MIN, sortControl, sortLabel, WIDE_MIN } from "./LibraryPanel";
import { useLibrary } from "./libraryStore";
import { PaperCard } from "./PaperCard";
import { openInLibrary } from "./PaperStrip";
import cardSource from "./PaperCard.tsx?raw";
import panelSource from "./LibraryPanel.tsx?raw";
import detailsSource from "./PaperDetails.tsx?raw";

const paper: LibraryPaper = {
  uid: "u1",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  venue: "NeurIPS",
  abstract: "The dominant sequence transduction models…",
  tldr: null,
  citations: 120,
  influential: null,
  oa: null,
  ids: { doi: "10.5555/3295222.3295349" },
  sources: [{ source: "s2", fetchedAt: 0, citations: 120 }],
  saved: true,
  inProject: undefined,
  tags: [],
  note: null,
  url: null,
  workType: "article",
  volume: null,
  issue: null,
  pages: null,
  publisher: null,
  foundBy: [],
  lastSeenAt: 0,
};

beforeEach(() => useLayout.setState({ ...DEFAULT_LAYOUT }));

describe("width rules", () => {
  it("shortens the scopes in a narrow sidebar", () => {
    const project = SCOPES.find((s) => s.value === "project")!;
    const agents = SCOPES.find((s) => s.value === "agents")!;
    expect(scopeLabel(project, 480)).toBe("In this project");
    expect(scopeLabel(project, SCOPE_LABELS_MIN - 1)).toBe("Project");
    expect(scopeLabel(agents, 180)).toBe("Agents");
    expect(scopeLabel(agents, SCOPE_LABELS_MIN)).toBe("Found by agents (30d)");
  });

  it("shortens the sort labels, then makes the sort a drop-down", () => {
    expect(sortLabel("relevance", WIDE_MIN)).toBe("Relevance");
    expect(sortLabel("relevance", WIDE_MIN - 1)).toBe("Best");
    expect(sortLabel("cited", 300)).toBe("Cited");
    expect(sortLabel("newest", 180)).toBe("Newest");
    expect(sortControl(480)).toBe("segments");
    expect(sortControl(SORT_SEGMENTS_MIN)).toBe("segments");
    expect(sortControl(SORT_SEGMENTS_MIN - 1)).toBe("select");
    expect(sortControl(180)).toBe("select");
  });
});

describe("LibraryPanel", () => {
  it("renders with search, scopes, sort, filters and actions", () => {
    const html = renderToStaticMarkup(createElement(LibraryPanel, { project: "C:/p" }));
    expect(html).toContain('aria-label="Search your library"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Sort by"');
    expect(html).toContain('aria-label="Filters"');
    expect(html).toContain('aria-label="Library actions"');
    // Menus and popovers stay inside the panel's width.
    expect(html).toContain("[&amp;_.texo-menu]:max-w-full");
    // The filters come last, so their popover opens along the row.
    expect(html.indexOf('aria-label="Library actions"')).toBeLessThan(html.indexOf('aria-label="Filters"'));
  });

  it("lays the details drawer over the list, inside the panel", () => {
    expect(detailsSource).toMatch(/absolute inset-0 z-20/);
    expect(panelSource).toContain("@container/papers relative");
  });
});

describe("PaperCard in a narrow sidebar", () => {
  const html = renderToStaticMarkup(createElement(PaperCard, { paper, bibFiles: ["refs.bib"], onOpen: () => {} }));

  it("tightens its padding and hides the source chips", () => {
    expect(html).toContain("@max-[260px]/papers:px-2.5");
    expect(html).toMatch(/contents @max-\[300px\]\/papers:hidden[^"]*"><span[^>]*aria-label="Sources"/);
  });

  it("keeps the bibliography button readable at every width", () => {
    expect(html).toContain("Add to bibliography");
    expect(html).toMatch(/@max-\[360px\]\/papers:inline[^"]*">Add</);
  });

  it("opens its menus across the card", () => {
    expect(cardSource).toContain("[&>div]:static");
  });
});

describe("openInLibrary", () => {
  it("opens the Papers editor tab and leaves the sidebar and the preview tab alone", () => {
    useAiTabs.getState().reset();
    useLayout.setState({ ...DEFAULT_LAYOUT, collapsed: true, sidebarTab: "files", rightTab: "log", layout: "code" });
    openInLibrary({ ...paper, uid: "pending:1" } as LibraryPaper);
    expect(useAiTabs.getState()).toMatchObject({ tabs: ["papers"], active: "papers" });
    expect(useLayout.getState()).toMatchObject({ sidebarTab: "files", collapsed: true, rightTab: "log", layout: "code" });
    // A second paper brings the same tab forward.
    useAiTabs.getState().activate(null);
    openInLibrary({ ...paper, uid: "pending:2" } as LibraryPaper);
    expect(useAiTabs.getState()).toMatchObject({ tabs: ["papers"], active: "papers" });
    useLibrary.getState().closeDetail();
    useAiTabs.getState().reset();
  });
});
