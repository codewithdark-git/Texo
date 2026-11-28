// State for the Papers tab: the search box, scope, sort and filters, the
// result list (local library matches, plus online results when "Search
// online" is on), each source's state during an online search, the open
// details, and the project's citation check. The pure helpers at the top
// are what the tests pin down; the store wires them to libraryApi.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { errorText } from "../lib/api";
import {
  isLibraryProgress,
  isUnsavedPaper,
  LIBRARY_PROGRESS_EVENT,
  libraryApi,
  type LibraryFilters,
  type LibraryPaper,
  type LibraryProgress,
  type LibraryProgressState,
  type LibraryScope,
  type LibrarySort,
  type LibraryStatus,
  type OnlineSearchOptions,
  type VerifyReport,
} from "../lib/libraryApi";
import { toast } from "../ui";
import { insertBibEntry, undoBibInsert, workspaceBibIo, type BibInsertResult, type BibIo } from "./bibInsert";
import { bibUnsafeReasons, unsafeEntryText } from "./bibSafety";

/** How long the search box waits after a keystroke before searching the library. */
export const SEARCH_DEBOUNCE_MS = 120;
/** Rows per page of local results. */
export const PAGE_SIZE = 50;
/** Results asked of the paper services per online search. */
export const ONLINE_LIMIT = 20;

/** The filters the filter popover sets; missing ones don't filter. */
export interface PanelFilters {
  yearFrom?: number;
  yearTo?: number;
  oaOnly?: boolean;
  minCitations?: number;
  source?: OnlineSource;
}

export type OnlineSource = "s2" | "crossref" | "arxiv" | "openalex";
export const ONLINE_SOURCES: OnlineSource[] = ["s2", "arxiv", "openalex", "crossref"];
export const SOURCE_NAMES: Record<string, string> = {
  s2: "Semantic Scholar",
  arxiv: "arXiv",
  openalex: "OpenAlex",
  crossref: "Crossref",
};

/** One source's state during an online search. */
export interface SourceChipState {
  state: LibraryProgressState;
  detail: string | null;
}

const validYear = (y: number | undefined) => (y !== undefined && Number.isInteger(y) && y >= 1000 && y <= 9999 ? y : undefined);

/** The arguments of `libraryApi.search` for what the panel shows. */
export function searchArgs(
  query: string,
  scope: LibraryScope,
  project: string | null,
  filters: PanelFilters,
  sort: LibrarySort,
  page = 0,
): { query: string; filters: LibraryFilters; sort: LibrarySort; limit: number; offset: number } {
  const f: LibraryFilters = { scope };
  // The project is always sent: it fills the "In project" badges.
  if (project) f.project = project;
  const yearFrom = validYear(filters.yearFrom);
  const yearTo = validYear(filters.yearTo);
  if (yearFrom !== undefined) f.yearFrom = yearFrom;
  if (yearTo !== undefined) f.yearTo = yearTo;
  if (filters.oaOnly) f.oaOnly = true;
  if (filters.minCitations && filters.minCitations > 0) f.minCitations = Math.floor(filters.minCitations);
  if (filters.source) f.source = filters.source;
  return { query: query.trim(), filters: f, sort, limit: PAGE_SIZE, offset: Math.max(0, page) * PAGE_SIZE };
}

/** The options of `libraryApi.searchOnline` for the same filters and sort. */
export function onlineOptions(filters: PanelFilters, sort: LibrarySort, limit = ONLINE_LIMIT): OnlineSearchOptions {
  const o: OnlineSearchOptions = { limit, sort };
  const yearFrom = validYear(filters.yearFrom);
  const yearTo = validYear(filters.yearTo);
  if (yearFrom !== undefined) o.yearFrom = yearFrom;
  if (yearTo !== undefined) o.yearTo = yearTo;
  if (filters.oaOnly) o.oaOnly = true;
  // "Only papers from this source" asks just that one.
  if (filters.source) o.sources = Object.fromEntries(ONLINE_SOURCES.map((s) => [s, s === filters.source]));
  return o;
}

/** Whether a paper is open access: an OA status other than closed, or a free PDF. */
const isOpenAccess = (p: LibraryPaper) => {
  const status = p.oa?.status?.toLowerCase();
  return (!!status && status !== "closed") || !!p.oa?.pdfUrl;
};

/**
 * The online results that pass the panel's filters. The services are asked
 * with the same years, open access and source, but they can't filter by
 * citations, and results from before a filter changed stay listed until the
 * new search answers; this keeps both out of the list.
 */
export function filterOnline(items: LibraryPaper[], filters: PanelFilters): LibraryPaper[] {
  const yearFrom = validYear(filters.yearFrom);
  const yearTo = validYear(filters.yearTo);
  const minCitations = filters.minCitations && filters.minCitations > 0 ? filters.minCitations : undefined;
  return items.filter((p) => {
    if (yearFrom !== undefined && (p.year === null || p.year < yearFrom)) return false;
    if (yearTo !== undefined && (p.year === null || p.year > yearTo)) return false;
    if (filters.oaOnly && !isOpenAccess(p)) return false;
    if (minCitations !== undefined && (p.citations ?? 0) < minCitations) return false;
    if (filters.source && p.sources.length > 0 && !p.sources.some((s) => s.source === filters.source)) return false;
    return true;
  });
}

/** How many filters are set, for the filter button's badge. */
export function activeFilterCount(f: PanelFilters): number {
  return [validYear(f.yearFrom) !== undefined || validYear(f.yearTo) !== undefined, !!f.oaOnly, !!f.minCitations && f.minCitations > 0, !!f.source].filter(Boolean)
    .length;
}

const idKeys = (p: LibraryPaper): string[] => {
  const keys: string[] = [];
  if (p.ids.doi) keys.push(`doi:${p.ids.doi.toLowerCase()}`);
  if (p.ids.arxiv) keys.push(`arxiv:${p.ids.arxiv.toLowerCase().replace(/v\d+$/, "")}`);
  if (p.ids.s2) keys.push(`s2:${p.ids.s2}`);
  return keys;
};

/**
 * The local results with the online ones merged in: a paper both lists have
 * (same uid, or an unsaved result with the same DOI, arXiv or S2 id) shows
 * once, in the local position with the fresher online data and the local
 * search snippet. The rest of the online results follow in their order.
 */
export function mergeResults(local: LibraryPaper[], online: LibraryPaper[]): LibraryPaper[] {
  const out = local.map((p) => p);
  const byUid = new Map<string, number>();
  const byId = new Map<string, number>();
  const index = (p: LibraryPaper, i: number) => {
    byUid.set(p.uid, i);
    for (const k of idKeys(p)) if (!byId.has(k)) byId.set(k, i);
  };
  out.forEach(index);
  for (const p of online) {
    let at = byUid.get(p.uid);
    if (at === undefined && isUnsavedPaper(p)) at = idKeys(p).map((k) => byId.get(k)).find((i) => i !== undefined);
    if (at !== undefined) {
      const known = out[at];
      // Keep the library's uid (an unsaved copy has none), its snippet and its project link.
      out[at] = { ...p, uid: known.uid, snippet: known.snippet ?? p.snippet, inProject: p.inProject ?? known.inProject, saved: known.saved || p.saved };
      index(out[at], at);
      continue;
    }
    index(p, out.length);
    out.push(p);
  }
  return out;
}

/** The source chips after one progress event. */
export function reduceProgress(chips: Record<string, SourceChipState>, ev: LibraryProgress): Record<string, SourceChipState> {
  return { ...chips, [ev.source]: { state: ev.state, detail: ev.detail ?? null } };
}

/** The chips still waiting for an answer, marked done: when the search stopped or ended without one. */
export function settleChips(chips: Record<string, SourceChipState>, detail: string): Record<string, SourceChipState> {
  let changed = false;
  const out: Record<string, SourceChipState> = {};
  for (const [source, chip] of Object.entries(chips)) {
    if (chip.state === "pending" || chip.state === "waiting") {
      out[source] = { state: "skipped", detail };
      changed = true;
    } else out[source] = chip;
  }
  return changed ? out : chips;
}

/** Words for screen readers when an online search starts and ends (not per source). */
export function onlineAnnouncement(running: boolean, chips: Record<string, SourceChipState>): string {
  if (running) return "Searching online…";
  const all = Object.values(chips);
  if (all.length === 0) return "";
  if (all.some((c) => c.detail === STOPPED_DETAIL)) return "Online search stopped.";
  const answered = all.filter((c) => c.state === "ok").length;
  return `Online search finished: ${answered} of ${all.length} ${all.length === 1 ? "source" : "sources"} answered.`;
}

/** The detail on a chip whose source was still being asked when the search was stopped. */
export const STOPPED_DETAIL = "stopped";

/** The words on a source chip. */
export function chipText(source: string, chip: SourceChipState | undefined): string {
  const name = SOURCE_NAMES[source] ?? source;
  if (!chip) return name;
  if (chip.detail && chip.state !== "ok" && chip.state !== "pending") return `${name}: ${chip.detail}`;
  return name;
}

/** The row after moving `delta` from `index` in a list of `len` (stops at the ends; -1 means none). */
export function moveRow(index: number, delta: number, len: number): number {
  if (len <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : len - 1;
  return Math.min(len - 1, Math.max(0, index + delta));
}

/** Whether the list includes the online results. */
export function showsOnline(s: { online: boolean; scope: LibraryScope; onlineQuery: string | null; query: string }): boolean {
  return s.online && s.scope === "all" && s.onlineQuery !== null && s.onlineQuery === s.query.trim();
}

/** `\cite{key}`. */
export const citeCommand = (key: string) => `\\cite{${key}}`;

/** The id the backend can find a paper by: its uid, or for an unsaved result its DOI or arXiv id. */
export function paperId(p: LibraryPaper): string | null {
  if (!isUnsavedPaper(p)) return p.uid;
  return p.ids.doi ?? p.ids.arxiv ?? p.ids.s2 ?? null;
}

/** The project's .bib files, from the workspace file list. */
export function bibFilesOf(files: { path: string; isDir: boolean }[]): string[] {
  return files.filter((f) => !f.isDir && /\.bib$/i.test(f.path)).map((f) => f.path).sort((a, b) => a.localeCompare(b));
}

/** Where a new entry goes when the project has no .bib file yet. */
export const NEW_BIB_FILE = "references.bib";

let requestSeq = 0;
const newRequestId = (what: string) => `${what}-${Date.now().toString(36)}-${++requestSeq}`;

/** Copies text to the clipboard; resolves false if the webview refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface VerifyProgress {
  requestId: string;
  done: number;
  total: number;
  /** The key being checked now. */
  current: string | null;
}

interface LibraryStore {
  project: string | null;
  status: LibraryStatus | null;
  /** "Library unavailable: <reason>", when the database couldn't be opened. */
  unavailable: string | null;

  query: string;
  online: boolean;
  scope: LibraryScope;
  sort: LibrarySort;
  filters: PanelFilters;

  local: LibraryPaper[];
  localTotal: number;
  page: number;
  onlineItems: LibraryPaper[];
  /** What the panel lists: the local results with the online ones merged in. */
  items: LibraryPaper[];
  loading: boolean;
  error: string | null;

  /** The running online search, if any. */
  onlineRequest: string | null;
  /** Per source, during and after the last online search. */
  sources: Record<string, SourceChipState>;
  onlineNotes: string[];
  /** Why online results weren't saved, if so. */
  onlineWarning: string | null;
  /** The query the online results belong to. */
  onlineQuery: string | null;

  /** The paper shown in the details drawer. */
  detail: LibraryPaper | null;
  /** The keyboard-focused row. */
  cursor: number;
  /** uids with an action running (save, add to bibliography...). */
  busy: Record<string, string>;
  verify: VerifyProgress | null;
  lastVerify: VerifyReport | null;
  /** Set while the list shows something other than a search (Find similar). */
  listTitle: string | null;
  /** The paper waiting for "Remove from library" to be confirmed. */
  confirmRemove: LibraryPaper | null;

  setProject: (project: string | null) => void;
  /** Starts listening for progress events; returns the stop function. */
  listen: () => () => void;
  loadStatus: () => Promise<void>;
  setQuery: (query: string) => void;
  setOnline: (on: boolean) => void;
  setScope: (scope: LibraryScope) => void;
  setSort: (sort: LibrarySort) => void;
  setFilters: (filters: PanelFilters) => void;
  /** Searches the library now. */
  search: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Searches the paper services for the query. */
  searchOnline: () => Promise<void>;
  stopOnline: () => void;
  setCursor: (cursor: number) => void;
  openDetail: (paper: LibraryPaper) => void;
  /** Opens a paper by uid (from a paper card in an agent run). */
  openDetailById: (uid: string) => Promise<void>;
  closeDetail: () => void;
  /** Shows these papers as the list (Find similar). */
  showPapers: (label: string, papers: LibraryPaper[]) => void;
  /** Lists papers like this one (Semantic Scholar recommendations). */
  findSimilar: (paper: LibraryPaper) => Promise<void>;
  askRemove: (paper: LibraryPaper | null) => void;

  toggleSave: (paper: LibraryPaper) => Promise<void>;
  remove: (paper: LibraryPaper) => Promise<void>;
  setTags: (paper: LibraryPaper, tags: string[]) => Promise<void>;
  setNote: (paper: LibraryPaper, note: string) => Promise<void>;
  /** Adds the paper to a .bib file; resolves to the key, or null when it didn't. */
  addToBibliography: (paper: LibraryPaper, bibFiles: string[], bibFile?: string) => Promise<string | null>;
  /** Copies `\cite{key}`; a paper with no key yet copies nothing and says to add it first. */
  cite: (paper: LibraryPaper) => Promise<void>;
  rescanBib: () => Promise<void>;
  verifyAll: () => Promise<void>;
  cancelVerify: () => void;
}

/** Overridable in tests. */
export const bibIoFor: { make: (project: string) => BibIo } = { make: workspaceBibIo };

let debounce: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;
let listeners = 0;
let unlisten: (() => void) | null = null;

export const useLibrary = create<LibraryStore>((set, get) => {
  /** Replaces a paper wherever the panel shows it. */
  const patchPaper = (uid: string, patch: (p: LibraryPaper) => LibraryPaper) => {
    const map = (list: LibraryPaper[]) => list.map((p) => (p.uid === uid ? patch(p) : p));
    set((s) => ({
      local: map(s.local),
      onlineItems: map(s.onlineItems),
      items: map(s.items),
      detail: s.detail?.uid === uid ? patch(s.detail) : s.detail,
    }));
  };
  const setBusy = (uid: string, what: string | null) =>
    set((s) => {
      const busy = { ...s.busy };
      if (what) busy[uid] = what;
      else delete busy[uid];
      return { busy };
    });
  /** Online results join the list only in the "All" scope and while they answer the query in the box. */
  const remerge = () => set((s) => ({ items: showsOnline(s) ? mergeResults(s.local, filterOnline(s.onlineItems, s.filters)) : s.local }));

  const onProgress = (ev: LibraryProgress) => {
    const s = get();
    if (ev.requestId === s.onlineRequest) {
      set({ sources: reduceProgress(s.sources, ev) });
    } else if (s.verify && ev.requestId === s.verify.requestId && ev.source === "verify") {
      set({
        verify: { ...s.verify, done: ev.done ?? s.verify.done, total: ev.total ?? s.verify.total, current: ev.state === "pending" ? ev.detail : null },
      });
    }
  };

  return {
    project: null,
    status: null,
    unavailable: null,
    query: "",
    online: false,
    scope: "all",
    sort: "relevance",
    filters: {},
    local: [],
    localTotal: 0,
    page: 0,
    onlineItems: [],
    items: [],
    loading: false,
    error: null,
    onlineRequest: null,
    sources: {},
    onlineNotes: [],
    onlineWarning: null,
    onlineQuery: null,
    detail: null,
    cursor: -1,
    busy: {},
    verify: null,
    lastVerify: null,
    listTitle: null,
    confirmRemove: null,

    setProject: (project) => {
      if (get().project === project) return;
      get().stopOnline();
      get().cancelVerify();
      // A paper opened before the panel first showed (from an agent's paper card) stays open.
      const detail = get().project === null ? get().detail : null;
      set({ project, local: [], onlineItems: [], items: [], detail, cursor: -1, lastVerify: null, onlineQuery: null, sources: {}, listTitle: null });
      if (project) {
        void get().loadStatus().then(() => get().search());
        // Link the project's .bib entries quietly, so "In project" badges are right.
        if (!get().unavailable) void libraryApi.syncBib(project).then(() => get().search(), () => {});
      }
    },

    listen: () => {
      listeners++;
      if (listeners === 1) {
        let stopped = false;
        void listen<unknown>(LIBRARY_PROGRESS_EVENT, (e) => {
          if (isLibraryProgress(e.payload)) onProgress(e.payload);
        }).then((stop) => {
          if (stopped) stop();
          else unlisten = stop;
        });
        unlisten = () => {
          stopped = true;
        };
      }
      return () => {
        listeners--;
        if (listeners === 0) {
          unlisten?.();
          unlisten = null;
        }
      };
    },

    loadStatus: async () => {
      try {
        const status = await libraryApi.status();
        set({ status, unavailable: status.available ? null : `Library unavailable: ${status.warning ?? "the database couldn't be opened."}` });
      } catch (err) {
        set({ status: null, unavailable: `Library unavailable: ${errorText(err)}` });
      }
    },

    setQuery: (query) => {
      set({ query });
      clearTimeout(debounce);
      debounce = setTimeout(() => void get().search(), SEARCH_DEBOUNCE_MS);
    },

    setOnline: (online) => {
      if (!online) {
        set({ online });
        get().stopOnline();
        remerge();
        return;
      }
      // Online results belong to the whole library, not a narrower scope.
      const rescope = get().scope !== "all";
      set({ online, scope: "all" });
      if (rescope) void get().search();
      if (get().query.trim()) void get().searchOnline();
    },

    setScope: (scope) => {
      set({ scope, cursor: -1 });
      void get().search();
    },
    setSort: (sort) => {
      set({ sort });
      void get().search();
      if (get().online && get().query.trim()) void get().searchOnline();
    },
    setFilters: (filters) => {
      set({ filters });
      // Hide the online results the new filters rule out now; the new online search replaces them.
      remerge();
      void get().search();
      if (get().online && get().query.trim()) void get().searchOnline();
    },

    search: async () => {
      clearTimeout(debounce);
      const s = get();
      if (s.unavailable) {
        set({ local: [], localTotal: 0, page: 0, loading: false });
        remerge();
        return;
      }
      const seq = ++searchSeq;
      const a = searchArgs(s.query, s.scope, s.project, s.filters, s.sort, 0);
      set({ loading: true, error: null, listTitle: null });
      try {
        const page = await libraryApi.search(a.query, a.filters, a.sort, a.limit, a.offset);
        if (seq !== searchSeq) return;
        set({ local: page.items, localTotal: page.total, page: 0, loading: false, cursor: -1 });
      } catch (err) {
        if (seq !== searchSeq) return;
        const text = errorText(err);
        if (text.startsWith("Library unavailable")) set({ unavailable: text, local: [], localTotal: 0, loading: false });
        else set({ error: text, loading: false });
      }
      remerge();
    },

    loadMore: async () => {
      const s = get();
      if (s.loading || s.listTitle || s.local.length >= s.localTotal || s.unavailable) return;
      const seq = searchSeq;
      const a = searchArgs(s.query, s.scope, s.project, s.filters, s.sort, s.page + 1);
      set({ loading: true });
      try {
        const page = await libraryApi.search(a.query, a.filters, a.sort, a.limit, a.offset);
        if (seq !== searchSeq) return;
        const seen = new Set(get().local.map((p) => p.uid));
        set((st) => ({ local: [...st.local, ...page.items.filter((p) => !seen.has(p.uid))], localTotal: page.total, page: st.page + 1, loading: false }));
        remerge();
      } catch (err) {
        set({ error: errorText(err), loading: false });
      }
    },

    searchOnline: async () => {
      const s = get();
      const query = s.query.trim();
      if (!query) return;
      s.stopOnline();
      const requestId = newRequestId("lib");
      set({ onlineRequest: requestId, sources: {}, onlineNotes: [], onlineWarning: null });
      try {
        const res = await libraryApi.searchOnline(requestId, query, onlineOptions(s.filters, s.sort), s.project ?? undefined);
        if (get().onlineRequest !== requestId) return;
        set((st) => ({
          onlineItems: res.items,
          onlineNotes: res.notes,
          onlineWarning: res.warning,
          onlineQuery: query,
          onlineRequest: null,
          sources: settleChips(st.sources, "no answer"),
        }));
        remerge();
        // Saved results are part of the library now; refresh the counts.
        if (res.stored) void get().loadStatus();
      } catch (err) {
        if (get().onlineRequest !== requestId) return;
        const text = errorText(err);
        set((st) => ({
          onlineRequest: null,
          onlineNotes: text === "Stopped." ? [] : [text],
          sources: settleChips(st.sources, text === "Stopped." ? STOPPED_DETAIL : "no answer"),
        }));
      }
    },

    stopOnline: () => {
      const id = get().onlineRequest;
      if (!id) return;
      set((s) => ({ onlineRequest: null, sources: settleChips(s.sources, STOPPED_DETAIL) }));
      void libraryApi.cancel(id).catch(() => {});
    },

    setCursor: (cursor) => set({ cursor }),
    openDetail: (paper) => set({ detail: paper }),
    openDetailById: async (uid) => {
      const known = get().items.find((p) => p.uid === uid);
      if (known) {
        set({ detail: known });
        return;
      }
      try {
        set({ detail: await libraryApi.get(uid, get().project ?? undefined) });
      } catch (err) {
        toast(errorText(err), "error");
      }
    },
    closeDetail: () => set({ detail: null }),
    showPapers: (label, papers) => {
      get().stopOnline();
      searchSeq++;
      clearTimeout(debounce);
      set({ listTitle: label, local: papers, localTotal: papers.length, items: papers, page: 0, cursor: -1, detail: null, loading: false, error: null });
    },

    findSimilar: async (paper) => {
      const id = paperId(paper);
      if (!id) {
        toast("This paper has no id Semantic Scholar knows, so Texo can't find similar ones.", "info");
        return;
      }
      setBusy(paper.uid, "similar");
      try {
        const papers = await libraryApi.related(id, "recommendations", get().project ?? undefined);
        get().showPapers(`Similar to "${paper.title}"`, papers);
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        setBusy(paper.uid, null);
      }
    },

    askRemove: (confirmRemove) => set({ confirmRemove }),

    toggleSave: async (paper) => {
      if (isUnsavedPaper(paper)) {
        toast("This result isn't in your library, so it can't be saved.", "info");
        return;
      }
      setBusy(paper.uid, "save");
      try {
        await (paper.saved ? libraryApi.unsave(paper.uid) : libraryApi.save(paper.uid));
        patchPaper(paper.uid, (p) => ({ ...p, saved: !paper.saved }));
        void get().loadStatus();
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        setBusy(paper.uid, null);
      }
    },

    remove: async (paper) => {
      if (isUnsavedPaper(paper)) return;
      try {
        await libraryApi.remove(paper.uid);
        set((s) => ({
          local: s.local.filter((p) => p.uid !== paper.uid),
          onlineItems: s.onlineItems.filter((p) => p.uid !== paper.uid),
          items: s.items.filter((p) => p.uid !== paper.uid),
          detail: s.detail?.uid === paper.uid ? null : s.detail,
          confirmRemove: null,
        }));
        toast("Removed from your library.", "success");
        void get().loadStatus();
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    setTags: async (paper, tags) => {
      if (isUnsavedPaper(paper)) return;
      try {
        const stored = await libraryApi.tag(paper.uid, tags);
        patchPaper(paper.uid, (p) => ({ ...p, tags: stored }));
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    setNote: async (paper, note) => {
      if (isUnsavedPaper(paper)) return;
      const value = note.trim() ? note : null;
      try {
        await libraryApi.note(paper.uid, value);
        patchPaper(paper.uid, (p) => ({ ...p, note: value }));
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    addToBibliography: async (paper, bibFiles, bibFile) => {
      const project = get().project;
      const id = paperId(paper);
      if (!project) return null;
      if (!id) {
        toast("This paper has no DOI or arXiv id, so Texo can't make a BibTeX entry for it.", "error");
        return null;
      }
      setBusy(paper.uid, "bib");
      try {
        // One .bib file is used directly; with none, a new references.bib is started.
        const target = bibFile ?? (bibFiles.length === 1 ? bibFiles[0] : bibFiles.length === 0 ? NEW_BIB_FILE : undefined);
        if (!target) throw new Error("Choose which .bib file to add it to.");
        const entry = await libraryApi.bibtexFor(project, id, target === NEW_BIB_FILE && bibFiles.length === 0 ? undefined : target);
        // Remote BibTeX is saved without review, so TeX that could run code is refused here.
        const unsafe = bibUnsafeReasons(entry.bibtex);
        if (unsafe.length) throw new Error(unsafeEntryText(unsafe));
        const io = bibIoFor.make(project);
        const done: BibInsertResult = await insertBibEntry(io, entry.bibFile ?? target, entry.bibtex);
        patchPaper(paper.uid, (p) => ({
          ...p,
          inProject: { citeKey: done.key, bibFile: done.file, verify: null, verifyNote: null, inBib: true, addedBy: "user" },
        }));
        const created = bibFiles.length === 0 ? ` to a new ${done.file}` : "";
        toast(`Added ${done.key}${created}`, "success", {
          label: "Undo",
          run: () =>
            void undoBibInsert(io, done).then(
              (undone) => {
                if (!undone) toast(`${done.file} changed since, so the entry was left in place.`, "info");
                else {
                  patchPaper(paper.uid, (p) => ({ ...p, inProject: undefined }));
                  void libraryApi.syncBib(project).catch(() => {});
                }
              },
              (err) => toast(errorText(err), "error"),
            ),
        });
        void libraryApi.syncBib(project).catch(() => {});
        return done.key;
      } catch (err) {
        toast(errorText(err), "error");
        return null;
      } finally {
        setBusy(paper.uid, null);
      }
    },

    cite: async (paper) => {
      // Copying never writes a .bib file: a paper with no key is added first, on purpose.
      const key = paper.inProject?.citeKey;
      if (!key) {
        toast("Add it to the bibliography first, then copy its \\cite.", "info");
        return;
      }
      if (await copyText(citeCommand(key))) toast(`Copied ${citeCommand(key)}`, "success");
      else toast("Couldn't copy to the clipboard.", "error");
    },

    rescanBib: async () => {
      const project = get().project;
      if (!project) return;
      try {
        const r = await libraryApi.syncBib(project);
        toast(r.entries ? `Read ${r.entries} ${r.entries === 1 ? "entry" : "entries"} from ${r.files.length} .bib ${r.files.length === 1 ? "file" : "files"}.` : "No .bib entries found in this project.", "info");
        await get().search();
      } catch (err) {
        toast(errorText(err), "error");
      }
    },

    verifyAll: async () => {
      const project = get().project;
      if (!project || get().verify) return;
      const requestId = newRequestId("verify");
      set({ verify: { requestId, done: 0, total: 0, current: null } });
      try {
        const report = await libraryApi.verify(requestId, project);
        if (get().verify?.requestId !== requestId) return;
        set({ verify: null, lastVerify: report });
        if (report.warning) toast(report.warning, "info");
      } catch (err) {
        if (get().verify?.requestId !== requestId) return;
        set({ verify: null });
        const text = errorText(err);
        if (text !== "Stopped.") toast(text, "error");
      }
      // Statuses are saved on the project links; show them.
      await get().search();
    },

    cancelVerify: () => {
      const v = get().verify;
      if (!v) return;
      void libraryApi.cancel(v.requestId).catch(() => {});
    },
  };
});
