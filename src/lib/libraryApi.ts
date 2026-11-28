// Bindings for the paper library (src-tauri/src/library): one app-wide
// SQLite file with every paper the user or an agent found, saved papers,
// tags and notes, and links to the projects whose .bib files cite them.
// Most commands use only the local database. The online ones (searchOnline,
// verify, bibtexFor, related) go to the paper services with the keys from
// Settings, which never reach the webview; they still work without the
// library, returning results that aren't saved (uids starting "online:").
// Errors reject with a plain sentence. If the library could not be opened,
// the local calls reject with "Library unavailable: <reason>" and
// `status()` says why.
import { invoke } from "@tauri-apps/api/core";

export type LibraryScope = "all" | "saved" | "project" | "agents";
export type LibrarySort = "relevance" | "cited" | "newest";
export type VerifyStatus = "verified" | "mismatch" | "notFound" | "unchecked";
export type ExportFormat = "bibtex" | "json";

/** Starts a highlighted match inside `LibraryPaper.snippet`. */
export const MARK_START = "\u0002";
/** Ends a highlighted match inside `LibraryPaper.snippet`. */
export const MARK_END = "\u0003";

/** Emitted while an online search or a citation check runs. */
export const LIBRARY_PROGRESS_EVENT = "library-progress";

export interface PaperIds {
  doi?: string;
  arxiv?: string;
  s2?: string;
  openalex?: string;
  corpus?: string;
  pmid?: string;
  dblp?: string;
}

export interface PaperSource {
  /** `crossref`, `openalex`, `s2`, `arxiv`. */
  source: string;
  /** Unix milliseconds. */
  fetchedAt: number;
  citations: number | null;
}

export interface InProject {
  citeKey: string | null;
  /** Project-relative, with forward slashes. */
  bibFile: string | null;
  /** null: never checked. */
  verify: VerifyStatus | null;
  verifyNote: string | null;
  inBib: boolean;
  /** "user", "agent:<run id>" or "bib-scan". */
  addedBy: string | null;
}

export interface RunFind {
  runId: string;
  tool: string | null;
  at: number;
}

export interface LibraryPaper {
  uid: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  tldr: string | null;
  citations: number | null;
  influential: number | null;
  oa: { status: string | null; pdfUrl: string | null } | null;
  ids: PaperIds;
  sources: PaperSource[];
  /** In "Saved". */
  saved: boolean;
  /** Only when the request named a project and the paper is linked to it. */
  inProject?: InProject;
  /** uid of the paper this may duplicate. */
  dupOf?: string;
  /** Search results only: text with matches between MARK_START and MARK_END (never HTML). */
  snippet?: string;
  tags: string[];
  note: string | null;
  /** The publisher's or service's page. */
  url: string | null;
  workType: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  /** The agent runs that found it, newest first. */
  foundBy: RunFind[];
  lastSeenAt: number;
}

/** Missing fields don't filter. */
export interface LibraryFilters {
  scope?: LibraryScope;
  /** The open project's path: needed for scope "project" and for `inProject`. */
  project?: string;
  yearFrom?: number;
  yearTo?: number;
  oaOnly?: boolean;
  minCitations?: number;
  /** Only papers seen from this source. */
  source?: string;
}

export interface LibrarySearchPage {
  items: LibraryPaper[];
  /** Matches before paging. */
  total: number;
}

export interface LibraryStatus {
  /** false: the database couldn't be opened; `warning` says why. */
  available: boolean;
  /** A damaged file set aside, a newer schema, or why the library is unavailable. */
  warning: string | null;
  papers: number;
  saved: number;
  cacheEntries: number;
  cacheBytes: number;
  fileBytes: number;
}

export type LibraryProgressState = "pending" | "waiting" | "ok" | "degraded" | "skipped";

/** One `library-progress` event: a source's state during a request. */
export interface LibraryProgress {
  requestId: string;
  /** `s2`, `crossref`, `arxiv`, `openalex`, or `verify` during a citation check. */
  source: string;
  state: LibraryProgressState;
  /** Plain words: "waiting 3s", "Key not set", "12 results", or the key being checked. */
  detail: string | null;
  /** Citation checks only: entries finished so far. */
  done?: number;
  /** Citation checks only: entries in all. */
  total?: number;
}

export interface BibSyncReport {
  files: string[];
  entries: number;
  matched: number;
  added: number;
  removed: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumOrNull = (v: unknown) => v === null || typeof v === "number";
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function isLibraryPaper(v: unknown): v is LibraryPaper {
  return (
    isObject(v) &&
    typeof v.uid === "string" &&
    v.uid !== "" &&
    typeof v.title === "string" &&
    isStringArray(v.authors) &&
    isNumOrNull(v.year) &&
    isStrOrNull(v.venue) &&
    isNumOrNull(v.citations) &&
    isObject(v.ids) &&
    Array.isArray(v.sources) &&
    v.sources.every((s) => isObject(s) && typeof s.source === "string" && typeof s.fetchedAt === "number") &&
    typeof v.saved === "boolean" &&
    isStringArray(v.tags) &&
    (v.oa === null || isObject(v.oa)) &&
    (v.snippet === undefined || typeof v.snippet === "string") &&
    (v.inProject === undefined || isObject(v.inProject))
  );
}

export function isLibraryStatus(v: unknown): v is LibraryStatus {
  return (
    isObject(v) &&
    typeof v.available === "boolean" &&
    isStrOrNull(v.warning) &&
    typeof v.papers === "number" &&
    typeof v.saved === "number" &&
    typeof v.cacheBytes === "number"
  );
}

const PROGRESS_STATES: readonly string[] = ["pending", "waiting", "ok", "degraded", "skipped"];

export function isLibraryProgress(v: unknown): v is LibraryProgress {
  return (
    isObject(v) &&
    typeof v.requestId === "string" &&
    typeof v.source === "string" &&
    typeof v.state === "string" &&
    PROGRESS_STATES.includes(v.state) &&
    (v.detail === undefined || isStrOrNull(v.detail))
  );
}

/** "Smith, Jones, Lee et al.": the first three authors. */
export function authorLine(authors: string[]): string {
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

/** A snippet as text runs, `match: true` for highlighted words. Unpaired markers are dropped. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let match = false;
  let buf = "";
  const flush = () => {
    if (buf) parts.push({ text: buf, match });
    buf = "";
  };
  for (const ch of snippet) {
    if (ch === MARK_START || ch === MARK_END) {
      flush();
      match = ch === MARK_START;
    } else {
      buf += ch;
    }
  }
  flush();
  return parts;
}

/** Results that couldn't be saved in the library have uids starting with this. */
export const ONLINE_UID_PREFIX = "online:";

/** Whether the paper is only a search result (not in the library). */
export function isUnsavedPaper(p: Pick<LibraryPaper, "uid">): boolean {
  return p.uid.startsWith(ONLINE_UID_PREFIX);
}

/** Options of an online search; missing ones don't filter. */
export interface OnlineSearchOptions {
  /** 1-25 (default 10). */
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  oaOnly?: boolean;
  sort?: LibrarySort;
  /** Narrows the sources left on in Settings; missing ones stay on. */
  sources?: Partial<Record<"s2" | "crossref" | "arxiv" | "openalex", boolean>>;
}

export interface OnlineSearchResult {
  items: LibraryPaper[];
  /** Plain remarks: a source that was busy or unreachable. */
  notes: string[];
  /** The papers are in the library (real uids). */
  stored: boolean;
  /** Why they weren't saved, if so. */
  warning: string | null;
}

export interface CitationCheckResult {
  /** The .bib file, project-relative. */
  file: string;
  check: {
    key: string;
    status: VerifyStatus;
    /** One plain sentence. */
    message: string;
    differences: string[];
    /** The paper it was compared with. */
    found: Record<string, unknown> | null;
  };
  /** Answered from the cache. */
  cached: boolean;
  /** Couldn't be checked now (offline, busy); not saved. */
  failed: boolean;
}

export interface VerifyReport {
  checks: CitationCheckResult[];
  /** Asked-for keys that aren't in any .bib file. */
  missing: string[];
  /** Entries that could be checked (more than `checks` when capped). */
  total: number;
  /** Why the results couldn't be saved in the library. */
  warning: string | null;
}

/** A BibTeX entry whose key no .bib file of the project uses yet. */
export interface BibtexForResult {
  key: string;
  bibtex: string;
  /** The service's key, when it had to change ("smith2020" → "smith2020a"). */
  renamedFrom: string | null;
  warnings: string[];
  /** The file to add it to; null when the project has several and none was named. */
  bibFile: string | null;
}

export type RelatedKind = "references" | "citations" | "recommendations";

export function isOnlineSearchResult(v: unknown): v is OnlineSearchResult {
  return (
    isObject(v) &&
    Array.isArray(v.items) &&
    v.items.every(isLibraryPaper) &&
    isStringArray(v.notes) &&
    typeof v.stored === "boolean" &&
    isStrOrNull(v.warning)
  );
}

export const libraryApi = {
  status: () => invoke<LibraryStatus>("library_status"),
  search: (query: string, filters?: LibraryFilters, sort?: LibrarySort, limit?: number, offset?: number) =>
    invoke<LibrarySearchPage>("library_search", { query, filters, sort, limit, offset }),
  /** `id`: a uid, DOI, arXiv id or OpenAlex id. */
  get: (id: string, project?: string) => invoke<LibraryPaper>("library_get", { id, project }),
  save: (uid: string) => invoke<void>("library_save", { uid }),
  unsave: (uid: string) => invoke<void>("library_unsave", { uid }),
  remove: (uid: string) => invoke<void>("library_remove", { uid }),
  /** Replaces the tags; resolves to them as stored. */
  tag: (uid: string, tags: string[]) => invoke<string[]>("library_tag", { uid, tags }),
  /** null or "" clears the note. */
  note: (uid: string, note: string | null) => invoke<void>("library_note", { uid, note }),
  projectRefs: (project: string) => invoke<LibraryPaper[]>("library_project_refs", { project }),
  syncBib: (project: string) => invoke<BibSyncReport>("library_sync_bib", { project }),
  clearCache: () => invoke<LibraryStatus>("library_clear_cache"),
  /** Resolves to the backup's file name (in the library's backups folder). */
  backup: () => invoke<string>("library_backup"),
  /** Texo asks where to save (the dialog opens from the backend); without `uids`, every saved paper. Resolves to the count, or null when cancelled. */
  export: (format: ExportFormat, uids?: string[]) => invoke<number | null>("library_export", { format, uids }),
  /** Searches the paper services; `library-progress` events carry `requestId`. Results are saved as seen. */
  searchOnline: (requestId: string, query: string, opts?: OnlineSearchOptions, project?: string) =>
    invoke<OnlineSearchResult>("library_search_online", { requestId, query, opts, project }),
  /** Checks the project's .bib entries (or `keys`) and saves each status; progress comes as `library-progress` with source "verify". */
  verify: (requestId: string, project: string, keys?: string[]) => invoke<VerifyReport>("library_verify", { requestId, project, keys }),
  /** BibTeX for a library uid, DOI or arXiv id with a key that is free in the project. Rejects when the paper is already cited. */
  bibtexFor: (project: string, id: string, bibFile?: string) => invoke<BibtexForResult>("library_bibtex_for", { project, id, bibFile }),
  /** A paper's references, citing papers or similar papers (Semantic Scholar). */
  related: (id: string, kind: RelatedKind, project?: string) => invoke<LibraryPaper[]>("library_related", { id, kind, project }),
  /** Stops a running searchOnline or verify. */
  cancel: (requestId: string) => invoke<void>("library_cancel", { requestId }),
};
