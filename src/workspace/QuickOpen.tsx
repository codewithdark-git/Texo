import { useEffect, useMemo, useRef, useState } from "react";
import { File, FileText, Image, BookMarked, Search } from "lucide-react";
import { fuzzyFilter, type FuzzyMatch } from "../lib/fuzzy";
import { useWorkspace } from "./store";

function iconFor(path: string) {
  if (/\.(tex|sty|cls)$/i.test(path)) return FileText;
  if (/\.bib$/i.test(path)) return BookMarked;
  if (/\.(png|jpe?g|gif|svg|webp|pdf|eps)$/i.test(path)) return Image;
  return File;
}

/** Bold the matched characters of a path. */
function Highlighted({ match }: { match: FuzzyMatch }) {
  const hits = new Set(match.positions);
  const nameStart = match.path.lastIndexOf("/") + 1;
  const part = (from: number, to: number) =>
    [...match.path.slice(from, to)].map((ch, i) => (
      <span key={from + i} className={hits.has(from + i) ? "font-semibold text-accent" : ""}>
        {ch}
      </span>
    ));
  return (
    <span className="min-w-0 truncate">
      <span>{part(nameStart, match.path.length)}</span>
      {nameStart > 0 && <span className="ml-2 text-xs text-muted">{part(0, nameStart - 1)}</span>}
    </span>
  );
}

/** Ctrl+P: type part of a file name, press Enter to open it. */
export function QuickOpen({ onClose }: { onClose: () => void }) {
  const files = useWorkspace((s) => s.files);
  const openFile = useWorkspace((s) => s.openFile);
  const expandTo = useWorkspace((s) => s.expandTo);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const paths = useMemo(() => files.filter((f) => !f.isDir).map((f) => f.path), [files]);
  const matches = useMemo(() => fuzzyFilter(query, paths), [query, paths]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (path: string | undefined) => {
    if (!path) return;
    onClose();
    expandTo(path);
    void openFile(path);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-label="Quick Open" className="texo-pop flex h-fit max-h-[60vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={15} className="text-muted" />
          <input
            autoFocus
            value={query}
            placeholder="Go to file…"
            aria-label="File name"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                choose(matches[selected]?.path);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            className="h-11 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <ul ref={list} role="listbox" className="overflow-auto p-1">
          {matches.map((m, i) => {
            const Icon = iconFor(m.path);
            return (
              <li key={m.path} role="option" aria-selected={i === selected}>
                <button
                  type="button"
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => choose(m.path)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${
                    i === selected ? "bg-accent/15" : ""
                  }`}
                >
                  <Icon size={15} className="shrink-0 text-muted" />
                  <Highlighted match={m} />
                </button>
              </li>
            );
          })}
          {matches.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">No matching files</li>}
        </ul>
      </div>
    </div>
  );
}
