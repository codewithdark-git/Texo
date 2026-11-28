import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MARK_END, MARK_START, type LibraryPaper } from "../lib/libraryApi";
import { hasMatch, Highlight, highlightSegments, plainSnippet } from "./highlight";
import { formatCount, PaperCard, paperBadges, sourceTitle } from "./PaperCard";
import { PaperStrip, stripPapers } from "./PaperStrip";
import highlightSource from "./highlight.ts?raw";
import cardSource from "./PaperCard.tsx?raw";
import detailsSource from "./PaperDetails.tsx?raw";
import panelSource from "./LibraryPanel.tsx?raw";
import stripSource from "./PaperStrip.tsx?raw";

const S = MARK_START;
const E = MARK_END;

const paper: LibraryPaper = {
  uid: "6f1c2b9e-0000-4000-8000-000000000001",
  title: "Attention is all you need",
  authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"],
  year: 2017,
  venue: "NeurIPS",
  abstract: "The dominant sequence transduction models are based on complex recurrent networks.",
  tldr: null,
  citations: 120_000,
  influential: 15_000,
  oa: { status: "green", pdfUrl: "https://arxiv.org/pdf/1706.03762" },
  ids: { doi: "10.5555/3295222.3295349", arxiv: "1706.03762" },
  sources: [
    { source: "s2", fetchedAt: Date.UTC(2026, 2, 3), citations: 120_000 },
    { source: "crossref", fetchedAt: Date.UTC(2026, 2, 4), citations: 98_000 },
  ],
  saved: true,
  inProject: { citeKey: "vaswani2017", bibFile: "refs.bib", verify: "verified", verifyNote: null, inBib: true, addedBy: "bib-scan" },
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

const card = (p: LibraryPaper) => renderToStaticMarkup(createElement(PaperCard, { paper: p, bibFiles: ["refs.bib"], onOpen: () => {} }));

describe("highlight", () => {
  it("splits the sentinel markers into marked segments", () => {
    expect(highlightSegments(`a ${S}trans${E}former ${S}model${E}`)).toEqual([
      { text: "a ", mark: false },
      { text: "trans", mark: true },
      { text: "former ", mark: false },
      { text: "model", mark: true },
    ]);
    expect(highlightSegments(null)).toEqual([]);
    expect(plainSnippet(`${S}x${E}y`)).toBe("xy");
    expect(hasMatch("plain")).toBe(false);
    expect(hasMatch(`${S}x${E}`)).toBe(true);
  });

  it("renders matches as <mark> and never as markup", () => {
    const html = renderToStaticMarkup(createElement(Highlight, { text: `<b>bold</b> ${S}deep${E} learning` }));
    expect(html).toContain("<mark");
    expect(html).toMatch(/<mark[^>]*>deep<\/mark>/);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("shows a <script> title as text", () => {
    const html = card({ ...paper, title: '<script>alert("x")</script>', snippet: `${S}<img src=x onerror=alert(1)>${E}` });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
  });

  it("never uses dangerouslySetInnerHTML in the library UI", () => {
    for (const src of [highlightSource, cardSource, detailsSource, panelSource, stripSource]) {
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toContain("innerHTML");
    }
  });
});

describe("PaperCard", () => {
  it("shows citations, open access, In project and the source chips", () => {
    const html = card(paper);
    expect(html).toContain('data-badge="citations"');
    expect(html).toContain("120K citations");
    expect(html).toContain('data-badge="oa"');
    expect(html).toContain("OA · Green");
    expect(html).toContain('data-badge="project"');
    expect(html).toContain("In project · vaswani2017");
    expect(html).toContain('data-badge="verify"');
    expect(html).toContain("Verified");
    expect(html).toContain('data-badge="saved"');
    expect(html).toContain('data-source="s2"');
    expect(html).toContain('data-source="crossref"');
    // Authors: the first three, then "et al.".
    expect(html).toContain("Ashish Vaswani, Noam Shazeer, Niki Parmar et al.");
    expect(html).toContain("NeurIPS · 2017");
    // Already cited: the add button says so and is off.
    expect(html).toContain("In bibliography");
  });

  it("marks preprints, possible duplicates and papers without a project link", () => {
    const pre: LibraryPaper = { ...paper, ids: { arxiv: "2401.01234" }, workType: null, inProject: undefined, dupOf: "other", saved: false, oa: null, citations: null };
    const ids = paperBadges(pre).map((b) => b.id);
    expect(ids).toEqual(["preprint", "duplicate"]);
    const html = card(pre);
    expect(html).toContain("Preprint");
    expect(html).toContain("Possible duplicate");
    expect(html).toContain("Add to bibliography");
    expect(html).not.toContain("In project");
  });

  it("formats counts and source tooltips", () => {
    expect(formatCount(940)).toBe("940");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(12_400)).toBe("12.4K");
    expect(sourceTitle(paper.sources[0])).toBe("Semantic Scholar · 120,000 citations · fetched 3 Mar 2026");
  });
});

describe("PaperStrip", () => {
  it("keeps only papers, at most ten, and shows three before 'more'", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...paper, uid: `u${i}`, title: `Paper ${i}` }));
    expect(stripPapers([...many, { not: "a paper" }, null]).length).toBe(10);
    const html = renderToStaticMarkup(createElement(PaperStrip, { papers: many }));
    expect(html.split("<li").length - 1).toBe(3);
    expect(html).toContain("Show 7 more");
    expect(renderToStaticMarkup(createElement(PaperStrip, { papers: [{ title: "x" }] }))).toBe("");
  });
});
