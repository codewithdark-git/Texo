// Paper cards under an agent step that found papers (`step.data.papers`).
// A compact list: the first few papers with their year, citations and
// whether they are already saved or cited; a click opens the paper in the
// Papers editor tab. Anything that isn't a paper is skipped.
import { ChevronDown, FileText } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { authorLine, isLibraryPaper, isUnsavedPaper, type LibraryPaper } from "../lib/libraryApi";
import { openPapersTab } from "../ai/tabs/aiTabsStore";
import { Badge, formatCount, paperBadges } from "./PaperCard";
import { useLibrary } from "./libraryStore";

/** Papers shown before "Show n more". */
export const STRIP_SHOWN = 3;

/** The papers in a step's data, at most ten. */
export function stripPapers(papers: unknown[]): LibraryPaper[] {
  return (Array.isArray(papers) ? papers : []).filter(isLibraryPaper).slice(0, 10);
}

/** Opens a paper's details in the Papers editor tab, opening the tab or bringing it forward. */
export function openInLibrary(paper: LibraryPaper) {
  openPapersTab();
  if (isUnsavedPaper(paper)) useLibrary.getState().openDetail(paper);
  else void useLibrary.getState().openDetailById(paper.uid);
}

const STRIP_BADGES = new Set(["saved", "project", "oa", "preprint"]);

export function PaperStrip({ papers }: { papers: unknown[] }) {
  const [all, setAll] = useState(false);
  const items = stripPapers(papers);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, STRIP_SHOWN);
  const more = items.length - shown.length;
  return (
    <div className="mt-1.5">
      <ul aria-label="Papers found" className="texo-stagger flex flex-col gap-1">
        {shown.map((p, i) => {
          const badges = paperBadges(p).filter((b) => STRIP_BADGES.has(b.id));
          const meta = [authorLine(p.authors), p.year ? String(p.year) : null, p.citations ? `${formatCount(p.citations)} citations` : null].filter(Boolean).join(" · ");
          return (
            <li key={p.uid} style={{ "--i": i } as CSSProperties}>
              <button
                type="button"
                onClick={() => openInLibrary(p)}
                title="Open in Papers"
                className="group flex w-full items-start gap-2 rounded-md border border-border bg-surface-2/40 px-2.5 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
              >
                <FileText size={13} className="mt-0.5 shrink-0 text-muted group-hover:text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 text-[12px] leading-snug text-text">{p.title || "Untitled"}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted">{meta}</span>
                  {badges.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {badges.map((b) => (
                        <Badge key={b.id} badge={b} />
                      ))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted hover:text-text">
          <ChevronDown size={12} /> Show {more} more
        </button>
      )}
    </div>
  );
}
