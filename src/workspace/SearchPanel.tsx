// The sidebar's Search panel (Ctrl+Shift+F): finds text across the
// project's text files. Open files are searched as they are in the editor,
// so unsaved edits count; everything else is read from disk.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { CaseSensitive, ChevronDown, ChevronRight, Loader2, RefreshCw, Regex, WholeWord } from "lucide-react";
import { api, type FileEntry } from "../lib/api";
import { isHiddenPath } from "../lib/hiddenFiles";
import { revealSource } from "./EditorPane";
import { baseName, parentDir } from "./paths";
import { MAX_HITS, compileQuery, searchFiles, type SearchOptions, type SearchResult } from "./searchCore";
import { getModel, useWorkspace } from "./store";

const TEXT_FILE = /\.(tex|ltx|sty|cls|bib|md|markdown|txt|bbx|cbx)$/i;
const MAX_SIZE = 2 * 1024 * 1024;
const DEBOUNCE_MS = 300;
/** Files read from disk at a time. */
const BATCH = 16;

/** The query and options outlive the panel, so switching tabs keeps them. */
const useSearchState = create<{ query: string; options: SearchOptions }>(() => ({
  query: "",
  options: { caseSensitive: false, wholeWord: false, regex: false },
}));

function searchable(f: FileEntry): boolean {
  return !f.isDir && TEXT_FILE.test(f.path) && f.size <= MAX_SIZE && !isHiddenPath(f.path);
}

/** A file's current text: the editor's copy if it's open, else the disk's. */
async function textOf(project: string, path: string): Promise<string | null> {
  const model = getModel(path);
  if (model) return model.getValue();
  try {
    const content = await api.readFile(project, path);
    return content.kind === "text" ? content.content : null;
  } catch {
    return null;
  }
}

function OptionToggle({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={`rounded p-0.5 ${on ? "bg-accent/20 text-accent" : "text-muted hover:bg-surface-2 hover:text-text"}`}
    >
      {children}
    </button>
  );
}

/** `focusKey` changes each time Ctrl+Shift+F asks for the search box. */
export function SearchPanel({ focusKey }: { focusKey: number }) {
  const { query, options } = useSearchState();
  const files = useWorkspace((s) => s.files);
  const projectPath = useWorkspace((s) => s.project?.path);
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rerun, setRerun] = useState(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  useEffect(() => {
    const re = compileQuery(query, options);
    if (!re || !(re instanceof RegExp)) {
      setResult(null);
      setBusy(false);
      setError(re && "error" in re ? re.error : null);
      return;
    }
    setError(null);
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!projectPath) return;
      setBusy(true);
      const candidates = files.filter(searchable);
      const merged: SearchResult = { files: [], total: 0, capped: false };
      for (let i = 0; i < candidates.length && !merged.capped; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        const texts = await Promise.all(batch.map((f) => textOf(projectPath, f.path)));
        if (cancelled) return;
        const found = searchFiles(
          batch.flatMap((f, j) => (texts[j] === null ? [] : [{ path: f.path, text: texts[j]! }])),
          re,
          MAX_HITS - merged.total,
        );
        merged.files.push(...found.files);
        merged.total += found.total;
        merged.capped = found.capped || merged.total >= MAX_HITS;
      }
      if (cancelled) return;
      setResult(merged);
      setBusy(false);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, options, files, projectPath, rerun]);

  const setOption = (key: keyof SearchOptions) =>
    useSearchState.setState((s) => ({ options: { ...s.options, [key]: !s.options[key] } }));

  const toggleFile = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-0.5 px-3 pt-2 pb-1">
        <span className="flex-1 text-xs font-medium tracking-wide text-muted uppercase">Search</span>
        {busy && <Loader2 size={13} className="animate-spin text-muted" aria-label="Searching" />}
        <button
          type="button"
          aria-label="Search again"
          title="Search again"
          onClick={() => setRerun((n) => n + 1)}
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="px-2 pb-2">
        <div
          className={`flex items-center gap-0.5 rounded-md border bg-bg pr-1 ${error ? "border-danger" : "border-border focus-within:border-accent"}`}
        >
          <input
            ref={input}
            value={query}
            placeholder="Search in project"
            aria-label="Search in project"
            spellCheck={false}
            onChange={(e) => useSearchState.setState({ query: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && setRerun((n) => n + 1)}
            className="h-7 min-w-0 flex-1 bg-transparent px-2 text-[13px] outline-none"
          />
          <OptionToggle label="Match case" on={options.caseSensitive} onClick={() => setOption("caseSensitive")}>
            <CaseSensitive size={15} />
          </OptionToggle>
          <OptionToggle label="Match whole word" on={options.wholeWord} onClick={() => setOption("wholeWord")}>
            <WholeWord size={15} />
          </OptionToggle>
          <OptionToggle label="Use regular expression" on={options.regex} onClick={() => setOption("regex")}>
            <Regex size={15} />
          </OptionToggle>
        </div>
        {error && (
          <p role="alert" className="mt-1 px-1 text-xs text-danger">
            {error}
          </p>
        )}
        {result && !error && (
          <p className="mt-1 px-1 text-xs text-muted">
            {result.total === 0
              ? "No results."
              : `${result.total.toLocaleString()} result${result.total === 1 ? "" : "s"} in ${result.files.length.toLocaleString()} file${result.files.length === 1 ? "" : "s"}`}
          </p>
        )}
        {result?.capped && (
          <p className="mt-1 px-1 text-xs text-amber-400">Showing the first {MAX_HITS.toLocaleString()} results. Refine the search to see the rest.</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-4">
        {result?.files.map((file) => {
          const open = !collapsed.has(file.path);
          const dir = parentDir(file.path);
          return (
            <div key={file.path}>
              <button
                type="button"
                onClick={() => toggleFile(file.path)}
                title={file.path}
                className="flex w-full items-center gap-1 rounded-md py-[3px] pr-2 pl-1 text-left text-[13px] hover:bg-surface-2"
              >
                <span className="shrink-0 text-muted">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                <span className="truncate font-medium">{baseName(file.path)}</span>
                {dir && <span className="truncate text-xs text-muted">{dir}</span>}
                <span className="ml-auto shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] text-muted">{file.hits.length}</span>
              </button>
              {open &&
                file.hits.map((hit, i) => (
                  <button
                    key={`${hit.line}:${hit.column}:${i}`}
                    type="button"
                    onClick={() => void revealSource(file.path, hit.line)}
                    title={`Line ${hit.line}, column ${hit.column}`}
                    className="flex w-full items-baseline gap-2 rounded-md py-[3px] pr-2 pl-6 text-left text-[12px] hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-text/85">
                      {hit.preview.slice(0, hit.start)}
                      <mark className="rounded-sm bg-accent/30 text-text">{hit.preview.slice(hit.start, hit.end)}</mark>
                      {hit.preview.slice(hit.end)}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {hit.line}:{hit.column}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
        {!query && <p className="px-3 py-2 text-sm text-muted">Search the text of every .tex, .bib and .md file in the project.</p>}
      </div>
    </div>
  );
}
