import { describe, expect, it } from "vitest";
import {
  authorLine,
  isLibraryPaper,
  isLibraryProgress,
  isLibraryStatus,
  isOnlineSearchResult,
  isUnsavedPaper,
  MARK_END,
  MARK_START,
  snippetParts,
  type LibraryPaper,
} from "./libraryApi";

// The shape `library_get` returns (serde camelCase, empty ids left out).
const paper: LibraryPaper = {
  uid: "6f1c2b9e-0000-4000-8000-000000000001",
  title: "Deep learning",
  authors: ["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"],
  year: 2015,
  venue: "Nature",
  abstract: null,
  tldr: null,
  citations: 40000,
  influential: null,
  oa: null,
  ids: { doi: "10.1038/nature14539" },
  sources: [{ source: "crossref", fetchedAt: 1_700_000_000_000, citations: 40000 }],
  saved: true,
  tags: [],
  note: null,
  url: null,
  workType: "article",
  volume: "521",
  issue: null,
  pages: "436–444",
  publisher: null,
  foundBy: [],
  lastSeenAt: 1_700_000_000_000,
};

describe("libraryApi type guards", () => {
  it("accepts a paper and its optional parts", () => {
    expect(isLibraryPaper(paper)).toBe(true);
    expect(isLibraryPaper({ ...paper, snippet: `a ${MARK_START}b${MARK_END}`, dupOf: "x" })).toBe(true);
    expect(
      isLibraryPaper({
        ...paper,
        oa: { status: "gold", pdfUrl: null },
        inProject: { citeKey: "lecun2015", bibFile: "refs.bib", verify: null, verifyNote: null, inBib: true, addedBy: "bib-scan" },
      }),
    ).toBe(true);
  });

  it("rejects things that are not papers", () => {
    expect(isLibraryPaper(null)).toBe(false);
    expect(isLibraryPaper([])).toBe(false);
    expect(isLibraryPaper({ ...paper, uid: "" })).toBe(false);
    expect(isLibraryPaper({ ...paper, authors: "LeCun" })).toBe(false);
    expect(isLibraryPaper({ ...paper, year: "2015" })).toBe(false);
    expect(isLibraryPaper({ ...paper, sources: [{ source: "s2" }] })).toBe(false);
    const { tags: _tags, ...noTags } = paper;
    expect(isLibraryPaper(noTags)).toBe(false);
  });

  it("checks status and progress payloads", () => {
    const status = { available: true, warning: null, papers: 3, saved: 1, cacheEntries: 0, cacheBytes: 0, fileBytes: 4096 };
    expect(isLibraryStatus(status)).toBe(true);
    expect(isLibraryStatus({ ...status, available: false, warning: "The paper library file is damaged." })).toBe(true);
    expect(isLibraryStatus({ ...status, papers: undefined })).toBe(false);
    expect(isLibraryStatus("ok")).toBe(false);

    expect(isLibraryProgress({ requestId: "r1", source: "arxiv", state: "waiting", detail: "waiting 3s" })).toBe(true);
    expect(isLibraryProgress({ requestId: "r1", source: "s2", state: "ok", detail: null })).toBe(true);
    expect(isLibraryProgress({ requestId: "r1", source: "s2", state: "done", detail: null })).toBe(false);
    expect(isLibraryProgress({ source: "s2", state: "ok" })).toBe(false);
  });
});

describe("libraryApi helpers", () => {
  it("shortens long author lists", () => {
    expect(authorLine([])).toBe("Unknown authors");
    expect(authorLine(["A", "B", "C"])).toBe("A, B, C");
    expect(authorLine(["A", "B", "C", "D"])).toBe("A, B, C et al.");
  });

  it("splits snippets into plain and highlighted runs", () => {
    expect(snippetParts(`deep ${MARK_START}learn${MARK_END}ing <b>`)).toEqual([
      { text: "deep ", match: false },
      { text: "learn", match: true },
      { text: "ing <b>", match: false },
    ]);
    expect(snippetParts("")).toEqual([]);
  });
});

describe("online results", () => {
  it("recognises a search result and papers that weren't saved", () => {
    const result = { items: [paper, { ...paper, uid: "online:abc" }], notes: ["arXiv was busy"], stored: false, warning: null };
    expect(isOnlineSearchResult(result)).toBe(true);
    expect(isOnlineSearchResult({ ...result, stored: "no" })).toBe(false);
    expect(isOnlineSearchResult({ ...result, items: [{ uid: "" }] })).toBe(false);
    expect(isUnsavedPaper(result.items[1])).toBe(true);
    expect(isUnsavedPaper(paper)).toBe(false);
  });

  it("accepts citation-check progress", () => {
    expect(isLibraryProgress({ requestId: "r", source: "verify", state: "pending", detail: "smith2020", done: 2, total: 9 })).toBe(true);
  });
});
