import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import type { LibraryPaper, LibraryProgress } from "../lib/libraryApi";
import type { BibIo } from "./bibInsert";
import {
  activeFilterCount,
  bibFilesOf,
  bibIoFor,
  chipText,
  citeCommand,
  filterOnline,
  mergeResults,
  moveRow,
  onlineAnnouncement,
  onlineOptions,
  paperId,
  reduceProgress,
  searchArgs,
  settleChips,
  showsOnline,
  useLibrary,
} from "./libraryStore";
import { useUi } from "../ui";

function paper(uid: string, over: Partial<LibraryPaper> = {}): LibraryPaper {
  return {
    uid,
    title: uid,
    authors: [],
    year: 2020,
    venue: null,
    abstract: null,
    tldr: null,
    citations: null,
    influential: null,
    oa: null,
    ids: {},
    sources: [],
    saved: false,
    tags: [],
    note: null,
    url: null,
    workType: null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    foundBy: [],
    lastSeenAt: 0,
    ...over,
  };
}

describe("searchArgs", () => {
  it("maps scope, project, filters and sort onto library_search", () => {
    expect(searchArgs("  diffusion  ", "saved", "C:/p", { yearFrom: 2019, yearTo: 2024, oaOnly: true, minCitations: 10, source: "arxiv" }, "cited")).toEqual({
      query: "diffusion",
      filters: { scope: "saved", project: "C:/p", yearFrom: 2019, yearTo: 2024, oaOnly: true, minCitations: 10, source: "arxiv" },
      sort: "cited",
      limit: 50,
      offset: 0,
    });
  });

  it("leaves out filters that aren't set or aren't usable, and pages by offset", () => {
    const a = searchArgs("", "all", null, { yearFrom: 20, oaOnly: false, minCitations: 0 }, "relevance", 2);
    expect(a.filters).toEqual({ scope: "all" });
    expect(a.offset).toBe(100);
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ yearFrom: 2020, yearTo: 2021, oaOnly: true, source: "s2" })).toBe(3);
  });

  it("maps the same filters onto the online search, one source when one is picked", () => {
    expect(onlineOptions({ yearFrom: 2020, oaOnly: true }, "newest")).toEqual({ limit: 20, sort: "newest", yearFrom: 2020, oaOnly: true });
    expect(onlineOptions({ source: "crossref" }, "relevance").sources).toEqual({ s2: false, arxiv: false, openalex: false, crossref: true });
  });
});

describe("mergeResults", () => {
  it("adds online results without repeating a uid", () => {
    const local = [paper("a", { snippet: "local snippet" }), paper("b")];
    const online = [paper("b", { citations: 5 }), paper("c"), paper("a", { citations: 9 }), paper("c")];
    const merged = mergeResults(local, online);
    expect(merged.map((p) => p.uid)).toEqual(["a", "b", "c"]);
    // The local row keeps its place and snippet, with the fresher online data.
    expect(merged[0]).toMatchObject({ uid: "a", citations: 9, snippet: "local snippet" });
    expect(merged[1].citations).toBe(5);
  });

  it("folds an unsaved result into the library paper with the same DOI or arXiv id", () => {
    const local = [paper("lib-1", { ids: { doi: "10.1000/ABC" }, saved: true }), paper("lib-2", { ids: { arxiv: "2401.01234" } })];
    const online = [paper("online:x", { ids: { doi: "10.1000/abc" } }), paper("online:y", { ids: { arxiv: "2401.01234v2" } }), paper("online:z")];
    const merged = mergeResults(local, online);
    expect(merged.map((p) => p.uid)).toEqual(["lib-1", "lib-2", "online:z"]);
    expect(merged[0].saved).toBe(true);
  });

  it("joins the list only in the All scope and for the query in the box", () => {
    const base = { online: true, scope: "all" as const, onlineQuery: "gan", query: " gan " };
    expect(showsOnline(base)).toBe(true);
    expect(showsOnline({ ...base, scope: "saved" })).toBe(false);
    expect(showsOnline({ ...base, query: "gans" })).toBe(false);
    expect(showsOnline({ ...base, online: false })).toBe(false);
  });
});

describe("small helpers", () => {
  it("source chips follow progress events", () => {
    const ev = (source: string, state: LibraryProgress["state"], detail: string | null): LibraryProgress => ({ requestId: "r", source, state, detail });
    let chips = reduceProgress({}, ev("s2", "pending", null));
    chips = reduceProgress(chips, ev("arxiv", "waiting", "waiting 3s"));
    chips = reduceProgress(chips, ev("s2", "ok", "12 results"));
    chips = reduceProgress(chips, ev("openalex", "skipped", "Key not set"));
    expect(chips.s2).toEqual({ state: "ok", detail: "12 results" });
    expect(chipText("s2", chips.s2)).toBe("Semantic Scholar");
    expect(chipText("arxiv", chips.arxiv)).toBe("arXiv: waiting 3s");
    expect(chipText("openalex", chips.openalex)).toBe("OpenAlex: Key not set");
  });

  it("settles chips left waiting, and announces only the start and end of a search", () => {
    const chips = { s2: { state: "ok" as const, detail: "12 results" }, arxiv: { state: "waiting" as const, detail: "waiting 3s" }, crossref: { state: "pending" as const, detail: null } };
    const stopped = settleChips(chips, "stopped");
    expect(stopped.s2).toEqual(chips.s2);
    expect(stopped.arxiv).toEqual({ state: "skipped", detail: "stopped" });
    expect(stopped.crossref).toEqual({ state: "skipped", detail: "stopped" });
    expect(settleChips({ s2: chips.s2 }, "stopped")).toEqual({ s2: chips.s2 });
    expect(onlineAnnouncement(true, chips)).toBe("Searching online…");
    expect(onlineAnnouncement(false, {})).toBe("");
    expect(onlineAnnouncement(false, stopped)).toBe("Online search stopped.");
    expect(onlineAnnouncement(false, settleChips(chips, "no answer"))).toBe("Online search finished: 1 of 3 sources answered.");
  });

  it("keeps online results that break the filters out of the list", () => {
    const items = [
      paper("old", { year: 2010, citations: 500 }),
      paper("few", { year: 2022, citations: 3 }),
      paper("closed", { year: 2022, citations: 50, oa: { status: "closed", pdfUrl: null } }),
      paper("ok", { year: 2022, citations: 50, oa: { status: "gold", pdfUrl: null } }),
    ];
    expect(filterOnline(items, {}).map((p) => p.uid)).toEqual(["old", "few", "closed", "ok"]);
    expect(filterOnline(items, { yearFrom: 2020, minCitations: 10, oaOnly: true }).map((p) => p.uid)).toEqual(["ok"]);
  });

  it("moves the row cursor within the list", () => {
    expect(moveRow(-1, 1, 3)).toBe(0);
    expect(moveRow(-1, -1, 3)).toBe(2);
    expect(moveRow(2, 1, 3)).toBe(2);
    expect(moveRow(0, -1, 3)).toBe(0);
    expect(moveRow(0, 1, 0)).toBe(-1);
  });

  it("knows cite commands, paper ids and .bib files", () => {
    expect(citeCommand("smith2020")).toBe("\\cite{smith2020}");
    expect(paperId(paper("u1"))).toBe("u1");
    expect(paperId(paper("online:1", { ids: { arxiv: "2401.1" } }))).toBe("2401.1");
    expect(paperId(paper("online:2"))).toBeNull();
    expect(
      bibFilesOf([
        { path: "refs/z.bib", isDir: false },
        { path: "main.tex", isDir: false },
        { path: "a.BIB", isDir: false },
        { path: "x.bib", isDir: true },
      ]),
    ).toEqual(["a.BIB", "refs/z.bib"]);
  });
});

describe("the store", () => {
  const calls = () => h.invoke.mock.calls.map((c) => c[0] as string);

  beforeEach(() => {
    h.invoke.mockReset();
    useLibrary.setState({ project: "C:/p", unavailable: null, query: "", online: false, scope: "all", sort: "relevance", filters: {}, local: [], onlineItems: [], items: [], onlineQuery: null, onlineRequest: null });
  });

  it("searches the library with the panel's scope, filters and sort", async () => {
    h.invoke.mockResolvedValue({ items: [paper("a")], total: 1 });
    useLibrary.setState({ query: "gan", scope: "project", sort: "newest", filters: { oaOnly: true } });
    await useLibrary.getState().search();
    expect(h.invoke).toHaveBeenCalledWith("library_search", {
      query: "gan",
      filters: { scope: "project", project: "C:/p", oaOnly: true },
      sort: "newest",
      limit: 50,
      offset: 0,
    });
    expect(useLibrary.getState().items.map((p) => p.uid)).toEqual(["a"]);
  });

  it("merges an online search into the local list", async () => {
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "library_search") return { items: [paper("a"), paper("b")], total: 2 };
      if (cmd === "library_search_online") return { items: [paper("b"), paper("c")], notes: [], stored: true, warning: null };
      if (cmd === "library_status") return { available: true, warning: null, papers: 3, saved: 0, cacheEntries: 0, cacheBytes: 0, fileBytes: 0 };
      return null;
    });
    useLibrary.setState({ query: "gan", online: true });
    await useLibrary.getState().search();
    await useLibrary.getState().searchOnline();
    expect(useLibrary.getState().items.map((p) => p.uid)).toEqual(["a", "b", "c"]);
    const online = h.invoke.mock.calls.find((c) => c[0] === "library_search_online")![1];
    expect(online).toMatchObject({ query: "gan", opts: { limit: 20, sort: "relevance" }, project: "C:/p" });
    // A different query in the box hides results that answer the old one.
    useLibrary.setState({ query: "vae" });
    await useLibrary.getState().search();
    expect(useLibrary.getState().items.map((p) => p.uid)).toEqual(["a", "b"]);
  });

  it("re-runs the online search when the filters change and hides stale results that break them", async () => {
    let onlineCalls = 0;
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "library_search") return { items: [paper("a", { citations: 100 })], total: 1 };
      if (cmd === "library_search_online") {
        onlineCalls++;
        // The second search never answers within the test: the stale results stay, filtered.
        if (onlineCalls > 1) return new Promise(() => {});
        return { items: [paper("b", { citations: 2 }), paper("c", { citations: 40 })], notes: [], stored: false, warning: null };
      }
      return null;
    });
    useLibrary.setState({ query: "gan", online: true });
    await useLibrary.getState().search();
    await useLibrary.getState().searchOnline();
    expect(useLibrary.getState().items.map((p) => p.uid)).toEqual(["a", "b", "c"]);
    useLibrary.getState().setFilters({ minCitations: 10, yearFrom: 2019 });
    expect(useLibrary.getState().items.map((p) => p.uid)).toEqual(["a", "c"]);
    const online = h.invoke.mock.calls.filter((c) => c[0] === "library_search_online");
    expect(online).toHaveLength(2);
    expect(online[1][1]).toMatchObject({ query: "gan", opts: { yearFrom: 2019 } });
    useLibrary.getState().stopOnline();
    expect(useLibrary.getState().onlineRequest).toBeNull();
  });

  it("copies a cite command only for a paper that has a key, and never writes a .bib file to get one", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await useLibrary.getState().cite(paper("u1"));
      expect(writeText).not.toHaveBeenCalled();
      expect(calls()).not.toContain("library_bibtex_for");
      expect(useUi.getState().toasts.at(-1)?.text).toMatch(/bibliography first/);
      await useLibrary.getState().cite(paper("u2", { inProject: { citeKey: "smith2020", bibFile: "refs.bib", verify: null, verifyNote: null, inBib: true, addedBy: "user" } }));
      expect(writeText).toHaveBeenCalledWith("\\cite{smith2020}");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips the local search when the library is unavailable", async () => {
    useLibrary.setState({ unavailable: "Library unavailable: the disk is full." });
    await useLibrary.getState().search();
    expect(calls()).not.toContain("library_search");
  });

  it("adds a paper to the only .bib file, marks it in the project, and offers Undo", async () => {
    const disk: Record<string, string> = { "refs.bib": "@misc{old,}\n" };
    const io: BibIo = {
      openText: async () => null,
      editOpen: async () => {},
      readDisk: async (f) => disk[f] ?? "",
      writeDisk: async (f, t) => void (disk[f] = t),
    };
    const make = bibIoFor.make;
    bibIoFor.make = () => io;
    try {
      h.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "library_bibtex_for") return { key: "smith2020a", bibtex: "@article{smith2020a,\n  title={T}\n}", renamedFrom: "smith2020", warnings: [], bibFile: "refs.bib" };
        if (cmd === "library_sync_bib") return { files: ["refs.bib"], entries: 2, matched: 2, added: 1, removed: 0 };
        return null;
      });
      const p = paper("u1");
      useLibrary.setState({ items: [p], local: [p] });
      const key = await useLibrary.getState().addToBibliography(p, ["refs.bib"]);
      expect(key).toBe("smith2020a");
      expect(h.invoke).toHaveBeenCalledWith("library_bibtex_for", { project: "C:/p", id: "u1", bibFile: "refs.bib" });
      expect(disk["refs.bib"]).toBe("@misc{old,}\n\n@article{smith2020a,\n  title={T}\n}\n");
      expect(useLibrary.getState().items[0].inProject?.citeKey).toBe("smith2020a");
      const t = useUi.getState().toasts.at(-1)!;
      expect(t.text).toBe("Added smith2020a");
      expect(t.action?.label).toBe("Undo");
      t.action!.run();
      await vi.waitFor(() => expect(disk["refs.bib"]).toBe("@misc{old,}\n"));
    } finally {
      bibIoFor.make = make;
    }
  });

  it("refuses remote BibTeX that could run code, and writes nothing", async () => {
    const disk: Record<string, string> = { "refs.bib": "@misc{old,}\n" };
    const io: BibIo = {
      openText: async () => null,
      editOpen: async () => {},
      readDisk: async (f) => disk[f] ?? "",
      writeDisk: async (f, t) => void (disk[f] = t),
    };
    const make = bibIoFor.make;
    bibIoFor.make = () => io;
    try {
      h.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "library_bibtex_for") return { key: "evil2020", bibtex: "@misc{evil2020,\n  title={\\directlua{os.execute('x')}}\n}", renamedFrom: null, warnings: [], bibFile: "refs.bib" };
        return null;
      });
      const p = paper("u1");
      useLibrary.setState({ items: [p], local: [p] });
      expect(await useLibrary.getState().addToBibliography(p, ["refs.bib"])).toBeNull();
      expect(disk["refs.bib"]).toBe("@misc{old,}\n");
      expect(useLibrary.getState().items[0].inProject).toBeUndefined();
      expect(useUi.getState().toasts.at(-1)?.text).toMatch(/directlua.*Texo didn't add it/);
      expect(calls()).not.toContain("library_sync_bib");
    } finally {
      bibIoFor.make = make;
    }
  });

  it("asks which file when the project has several .bib files", async () => {
    const p = paper("u1");
    expect(await useLibrary.getState().addToBibliography(p, ["a.bib", "b.bib"])).toBeNull();
    expect(calls()).not.toContain("library_bibtex_for");
    expect(useUi.getState().toasts.at(-1)?.text).toBe("Choose which .bib file to add it to.");
  });
});
