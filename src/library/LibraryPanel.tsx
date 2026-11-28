// The paper library, shown in the Papers editor tab: search the library
// (and, with "Search online", the paper services), narrow it by scope, sort
// and filters, and act on each paper: add it to the bibliography, save it,
// copy its \cite, or open its details. The library is optional: when it
// can't be opened the panel says why and online search still works without
// saving. It fits any width from 180px to the tab's 48rem column: short scope
// and sort labels when narrow, the sort as a drop-down when narrower still,
// filters in a popover and the details drawer over the list. Menus and
// popovers open along the panel's width, so its edge never cuts them off.
import { ArrowLeft, BookOpen, Download, Globe, Loader2, MoreHorizontal, Search, Square, TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ConfirmDialog } from "../components/Dialog";
import { Menu } from "../components/Menu";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Skeleton } from "../components/ui/Skeleton";
import { Kbd } from "../components/ui/Kbd";
import { errorText } from "../lib/api";
import { libraryApi, type ExportFormat, type LibraryPaper, type LibraryScope, type LibrarySort } from "../lib/libraryApi";
import { toast } from "../ui";
import { useWorkspace } from "../workspace/store";
import { bibFilesOf, moveRow, onlineAnnouncement, showsOnline, useLibrary } from "./libraryStore";
import { PaperCard } from "./PaperCard";
import { PaperDetails } from "./PaperDetails";
import { ProjectRefs } from "./ProjectRefs";
import { FilterButton, OnlineSources } from "./SourceFilters";

export const SCOPES: { value: LibraryScope; label: string; short: string }[] = [
  { value: "all", label: "All", short: "All" },
  { value: "saved", label: "Saved", short: "Saved" },
  { value: "project", label: "In this project", short: "Project" },
  { value: "agents", label: "Found by agents (30d)", short: "Agents" },
];

export const SORTS: { value: LibrarySort; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "cited", label: "Most cited" },
  { value: "newest", label: "Newest" },
];

/** Below this width the sort control shows short labels. */
export const WIDE_MIN = 400;
/** Below this width the scopes show short labels ("Project", "Agents"). */
export const SCOPE_LABELS_MIN = 360;
/** Below this width the sort is a drop-down instead of a row of choices. */
export const SORT_SEGMENTS_MIN = 300;

/** A scope's label at the panel's width. */
export function scopeLabel(scope: (typeof SCOPES)[number], width: number): string {
  return width < SCOPE_LABELS_MIN ? scope.short : scope.label;
}

/** A sort's label at the panel's width: "Best" and "Cited" when space is short. */
export function sortLabel(sort: LibrarySort, width: number): string {
  const label = SORTS.find((o) => o.value === sort)?.label ?? sort;
  if (width >= WIDE_MIN) return label;
  return sort === "relevance" ? "Best" : sort === "cited" ? "Cited" : label;
}

/** How the sort shows at the panel's width: a row of choices, or a drop-down when narrow. */
export function sortControl(width: number): "segments" | "select" {
  return width < SORT_SEGMENTS_MIN ? "select" : "segments";
}

const rowId = (i: number) => `library-row-${i}`;
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

/** The panel's width, measured before the first paint; a hidden panel (0px) keeps its last width. */
function useWidth(el: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0) setWidth(node.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

export function LibraryPanel({ project }: { project: string }) {
  const s = useLibrary();
  const files = useWorkspace((w) => w.files);
  const bibFiles = useMemo(() => bibFilesOf(files), [files]);
  const root = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const width = useWidth(root);
  const lib = useLibrary.getState;

  useEffect(() => lib().listen(), [lib]);
  useEffect(() => lib().setProject(project), [lib, project]);

  // Keep the keyboard-focused row in view.
  useEffect(() => {
    if (s.cursor < 0) return;
    document.getElementById(rowId(s.cursor))?.scrollIntoView({ block: "nearest" });
  }, [s.cursor]);

  const running = !!s.onlineRequest;
  const query = s.query.trim();
  const onlineShown = showsOnline(s);
  const staleOnline = s.online && !!query && !running && s.onlineQuery !== query;
  const current: LibraryPaper | undefined = s.items[s.cursor];

  const closeDetail = () => {
    lib().closeDetail();
    requestAnimationFrame(() => list.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (s.detail) return;
    if (e.key === "/" && !isTyping(e.target)) {
      e.preventDefault();
      searchBox.current?.focus();
      return;
    }
    if (e.target === searchBox.current) {
      if (e.key === "ArrowDown" && s.items.length) {
        e.preventDefault();
        lib().setCursor(0);
        list.current?.focus();
      }
      return;
    }
    if (isTyping(e.target) || e.target !== list.current) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      lib().setCursor(moveRow(s.cursor, e.key === "ArrowDown" ? 1 : -1, s.items.length));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      lib().setCursor(s.items.length ? (e.key === "Home" ? 0 : s.items.length - 1) : -1);
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        if (bibFiles.length > 1) lib().openDetail(current);
        else void lib().addToBibliography(current, bibFiles);
      } else lib().openDetail(current);
    } else if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey && current) {
      e.preventDefault();
      void lib().cite(current);
    }
  };

  const exportAs = async (format: ExportFormat) => {
    try {
      const n = await libraryApi.export(format);
      if (n !== null) toast(`Exported ${n} ${n === 1 ? "paper" : "papers"}.`, "success");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  return (
    <div ref={root} onKeyDown={onKeyDown} className="@container/papers relative flex min-h-0 flex-1 flex-col overflow-hidden text-[13px] [&_.texo-menu]:max-w-full [&_.texo-menu-out]:max-w-full">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5 @max-[259px]/papers:px-2">
        <div className="flex items-center gap-1.5">
          <label className="relative flex h-8 min-w-0 flex-1 items-center rounded-lg border border-border bg-bg transition-colors focus-within:border-accent/60">
            <Search size={14} className="pointer-events-none ml-2.5 shrink-0 text-muted" />
            <input
              ref={searchBox}
              type="search"
              value={s.query}
              aria-label={s.online ? "Search your library and online" : "Search your library"}
              placeholder={s.online ? "Search your library and online…" : "Search your library…"}
              onChange={(e) => lib().setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void lib().search();
                  if (s.online) void lib().searchOnline();
                } else if (e.key === "Escape" && s.query) {
                  e.preventDefault();
                  e.stopPropagation();
                  lib().setQuery("");
                }
              }}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] placeholder:text-muted/70 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {running ? (
              <button type="button" aria-label="Stop the online search" title="Stop" onClick={() => lib().stopOnline()} className="mr-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text">
                <Square size={12} />
              </button>
            ) : (
              s.query && (
                <button type="button" aria-label="Clear the search" onClick={() => lib().setQuery("")} className="mr-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text">
                  <X size={13} />
                </button>
              )
            )}
          </label>
          <button
            type="button"
            aria-pressed={s.online}
            title={s.online ? "Searching online too: press Enter to ask the paper services" : "Also search Semantic Scholar, arXiv, OpenAlex and Crossref"}
            onClick={() => lib().setOnline(!s.online)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors ${
              s.online ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <Globe size={13} />}
            <span className="@max-[359px]/papers:hidden">Search online</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <div role="radiogroup" aria-label="Show" className="-mx-0.5 flex min-w-0 flex-1 gap-1 overflow-x-auto px-0.5 [scrollbar-width:none]">
            {SCOPES.map((o) => {
              const on = s.scope === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={scopeLabel(o, width) === o.label ? undefined : o.label}
                  onClick={() => lib().setScope(o.value)}
                  className={`h-6 shrink-0 rounded-full px-2.5 @max-[259px]/papers:px-2 text-[11.5px] whitespace-nowrap transition-colors ${
                    on ? "bg-surface-2 font-medium text-text ring-1 ring-border" : "text-muted hover:bg-surface-2/60 hover:text-text"
                  }`}
                >
                  {scopeLabel(o, width)}
                </button>
              );
            })}
          </div>
        </div>

        {/*
          The menu and the filters anchor to this row rather than to their buttons
          ([&>div]:static), so they open across the panel's full width.
        */}
        <div className="relative flex items-center gap-1.5 [&>div]:static">
          {sortControl(width) === "segments" ? (
            <span className="flex min-w-0">
              <SegmentedControl<LibrarySort>
                label="Sort by"
                value={s.sort}
                onChange={(v) => lib().setSort(v)}
                options={SORTS.map((o) => ({ value: o.value, label: sortLabel(o.value, width) }))}
              />
            </span>
          ) : (
            <select
              aria-label="Sort by"
              value={s.sort}
              onChange={(e) => lib().setSort(e.target.value as LibrarySort)}
              className="h-7 min-w-0 rounded-md border border-border bg-bg px-1.5 text-[12px] text-text focus:border-accent/60 focus:outline-none"
            >
              {SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <span className="flex-1" />
          <Menu
            items={[
              { label: "Export saved papers as BibTeX…", icon: <Download size={14} />, onSelect: () => void exportAs("bibtex") },
              { label: "Export saved papers as JSON…", icon: <Download size={14} />, onSelect: () => void exportAs("json") },
            ]}
            trigger={({ open, toggle }) => (
              <button
                type="button"
                aria-label="Library actions"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={!!s.unavailable}
                onClick={toggle}
                className="inline-flex h-7 items-center rounded-md border border-border px-1.5 text-muted enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-40"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          />
          <FilterButton filters={s.filters} onChange={(f) => lib().setFilters(f)} />
        </div>

        {s.online && <OnlineSources sources={s.sources} running={running} />}
        {/* Announces the start and end of an online search, not each source. */}
        <p className="sr-only" aria-live="polite">
          {s.online ? onlineAnnouncement(running, s.sources) : ""}
        </p>
        {staleOnline && (
          <p className="text-[11.5px] text-muted">
            Press <Kbd>Enter</Kbd> to search online for “{query}”.
          </p>
        )}
        {onlineShown && s.onlineWarning && <p className="text-[11.5px] text-warning">{s.onlineWarning}</p>}
        {s.online && s.onlineNotes.map((n, i) => (
          <p key={i} className="text-[11.5px] text-muted">
            {n}
          </p>
        ))}
      </div>

      {s.unavailable && (
        <div role="status" className="mx-3 mt-2.5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px]">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" />
          <span>
            {s.unavailable} Online search still works; results just aren't saved.
          </span>
        </div>
      )}

      {s.scope === "project" && !s.listTitle && <ProjectRefs papers={s.items} />}

      {s.listTitle && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <button type="button" onClick={() => void lib().search()} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-surface-2 hover:text-text">
            <ArrowLeft size={13} /> Back
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px]" title={s.listTitle}>
            {s.listTitle}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {s.error && <p className="px-2 py-2 text-[12px] text-danger">{s.error}</p>}
        {s.loading && s.items.length === 0 ? (
          <LoadingRows />
        ) : s.items.length === 0 ? (
          <EmptyState running={running} />
        ) : (
          <ul
            ref={list}
            role="listbox"
            tabIndex={0}
            aria-label="Papers"
            aria-describedby="library-keys"
            aria-activedescendant={s.cursor >= 0 ? rowId(s.cursor) : undefined}
            onFocus={() => s.cursor < 0 && s.items.length && lib().setCursor(0)}
            className="texo-stagger flex flex-col gap-0.5 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            {s.items.map((p, i) => (
              <PaperCard
                key={p.uid}
                id={rowId(i)}
                paper={p}
                index={i}
                active={i === s.cursor}
                bibFiles={bibFiles}
                onOpen={(paper) => {
                  lib().setCursor(i);
                  lib().openDetail(paper);
                }}
              />
            ))}
          </ul>
        )}
        <p id="library-keys" className="sr-only">
          Up and down move between papers. Enter opens the details, Control Enter adds to the bibliography, C copies the cite command.
        </p>
        {!s.listTitle && s.local.length < s.localTotal && (
          <div className="flex justify-center py-2">
            <button type="button" disabled={s.loading} onClick={() => void lib().loadMore()} className="rounded-md px-3 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">
              {s.loading ? "Loading…" : `Show more (${s.localTotal - s.local.length} left)`}
            </button>
          </div>
        )}
      </div>

      <StatusLine />

      <PaperDetails paper={s.detail} bibFiles={bibFiles} onClose={closeDetail} />

      {s.confirmRemove && (
        <ConfirmDialog
          title="Remove from library?"
          message={
            s.confirmRemove.inProject
              ? "This paper is cited in this project. Removing it from the library leaves your .bib files as they are."
              : "It disappears from your library, its tags and note included. Your .bib files are not changed."
          }
          confirmLabel="Remove"
          danger
          onConfirm={() => {
            const paper = s.confirmRemove!;
            lib().askRemove(null);
            void lib().remove(paper);
          }}
          onClose={() => lib().askRemove(null)}
        />
      )}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-4 px-3 py-3" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton lines={2} />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ running }: { running: boolean }) {
  const { query, scope, online, unavailable, status, listTitle } = useLibrary();
  const q = query.trim();
  let title: string;
  let hint: string | null = null;
  if (running) {
    title = "Searching the paper services…";
  } else if (listTitle) {
    title = "No similar papers found.";
  } else if (q) {
    title = `Nothing in your library matches “${q}”.`;
    hint = online ? "Press Enter to search online." : "Turn on Search online to look further.";
  } else if (scope === "saved") {
    title = "No saved papers yet.";
    hint = "Save papers from a search, or from what an agent found.";
  } else if (scope === "project") {
    title = "No papers from this project's .bib files are in your library yet.";
    hint = "Re-scan after adding entries, or add papers from a search.";
  } else if (scope === "agents") {
    title = "No agent found papers in the last 30 days.";
  } else if (unavailable) {
    title = "Search online to find papers.";
  } else if (status && status.papers === 0) {
    title = "Your paper library is empty.";
    hint = "Turn on Search online and look for a paper. Agents add what they find here too.";
  } else {
    title = "Search your library.";
  }
  return (
    <div className="texo-fade-in flex flex-col items-center gap-2 px-6 py-10 text-center @max-[259px]/papers:px-3 @max-[259px]/papers:py-8" aria-live="polite">
      {running ? <Loader2 size={20} className="animate-spin text-muted" /> : <BookOpen size={22} className="text-muted/70" />}
      <p className="text-[13px] text-text/85">{title}</p>
      {hint && <p className="max-w-64 text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

function StatusLine() {
  const status = useLibrary((s) => s.status);
  const total = useLibrary((s) => s.localTotal);
  const listTitle = useLibrary((s) => s.listTitle);
  if (!status?.available) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-t border-border px-3 py-1 text-[11px] text-muted @max-[259px]/papers:px-2">
      <span>{listTitle ? `${total} shown` : `${total} ${total === 1 ? "match" : "matches"}`}</span>
      <span>
        {status.papers} in library · {status.saved} saved
      </span>
    </div>
  );
}
