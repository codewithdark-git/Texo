// The details drawer: slides over the result list inside the Papers tab with
// everything known about one paper: the full abstract and TL;DR, its ids, a
// BibTeX preview, its references and citing papers (asked for on demand),
// tags and a note, and the agent runs that found it.
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, BookmarkCheck, BookmarkPlus, Bot, Copy, ExternalLink, FileText, Loader2, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Menu } from "../components/Menu";
import { Skeleton } from "../components/ui/Skeleton";
import { errorText } from "../lib/api";
import { authorLine, isUnsavedPaper, libraryApi, type BibtexForResult, type LibraryPaper, type RelatedKind } from "../lib/libraryApi";
import { usePresence } from "../lib/motion";
import { toast } from "../ui";
import { useAiPanel } from "../ai/panel/aiPanelStore";
import { useRunFocus } from "../ai/agents/focusStore";
import { Badge, formatCount, pageUrl, paperBadges, pdfUrl, SourceChips } from "./PaperCard";
import { paperId, useLibrary } from "./libraryStore";

/** How long the drawer's slide-out may run before it is removed anyway. */
export const DRAWER_EXIT_MS = 200;

const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "Nature 521(7553):436–444 · Springer". */
export function citationLine(p: LibraryPaper): string {
  let where = p.venue ?? "";
  if (p.volume) where += `${where ? " " : ""}${p.volume}${p.issue ? `(${p.issue})` : ""}`;
  if (p.pages) where += `${where ? ":" : ""}${p.pages}`;
  return [where, p.year ? String(p.year) : null, p.publisher].filter(Boolean).join(" · ");
}

const ID_ROWS: { key: keyof LibraryPaper["ids"]; label: string; url?: (v: string) => string }[] = [
  { key: "doi", label: "DOI", url: (v) => `https://doi.org/${encodeURI(v)}` },
  { key: "arxiv", label: "arXiv", url: (v) => `https://arxiv.org/abs/${encodeURI(v)}` },
  { key: "s2", label: "Semantic Scholar", url: (v) => `https://www.semanticscholar.org/paper/${encodeURIComponent(v)}` },
  { key: "openalex", label: "OpenAlex", url: (v) => `https://openalex.org/${encodeURIComponent(v)}` },
  { key: "pmid", label: "PubMed" },
  { key: "dblp", label: "DBLP" },
];

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, "success");
  } catch {
    toast("Couldn't copy to the clipboard.", "error");
  }
}

interface PaperDetailsProps {
  paper: LibraryPaper | null;
  bibFiles: string[];
  onClose: () => void;
}

export function PaperDetails({ paper, bibFiles, onClose }: PaperDetailsProps) {
  const { mounted, state, onAnimationEnd } = usePresence(!!paper, DRAWER_EXIT_MS);
  // Keep showing the last paper while the drawer slides out.
  const last = useRef<LibraryPaper | null>(paper);
  if (paper) last.current = paper;
  const shown = paper ?? last.current;
  if (!mounted || !shown) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <section
      role="dialog"
      aria-label="Paper details"
      onKeyDown={onKeyDown}
      onAnimationEnd={onAnimationEnd}
      className={`${state === "exit" ? "texo-slide-out-right pointer-events-none" : "texo-slide-in-right"} absolute inset-0 z-20 flex min-h-0 flex-col bg-surface shadow-[var(--shadow-panel)]`}
    >
      <DetailsBody key={shown.uid} paper={shown} bibFiles={bibFiles} onClose={onClose} />
    </section>
  );
}

function DetailsBody({ paper, bibFiles, onClose }: { paper: LibraryPaper; bibFiles: string[]; onClose: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  const busy = useLibrary((s) => s.busy[paper.uid]);
  const project = useLibrary((s) => s.project);
  const lib = useLibrary.getState;
  const unsaved = isUnsavedPaper(paper);
  const cited = paper.inProject?.citeKey;
  const page = pageUrl(paper);
  const pdf = pdfUrl(paper);

  useEffect(() => back.current?.focus(), []);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          ref={back}
          type="button"
          onClick={onClose}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-surface-2 hover:text-text"
        >
          <ArrowLeft size={14} /> Results
        </button>
        <span className="flex-1" />
        <button type="button" aria-label="Close details" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] @max-[260px]/papers:px-3">
        <h2 className="text-[15px] leading-snug font-semibold break-words select-text">{paper.title || "Untitled"}</h2>
        <p className="mt-1 text-[12px] text-muted select-text">{paper.authors.length > 12 ? authorLine(paper.authors) : paper.authors.join(", ") || "Unknown authors"}</p>
        {citationLine(paper) && <p className="mt-0.5 text-[12px] text-muted select-text">{citationLine(paper)}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {paperBadges(paper).map((b) => (
            <Badge key={b.id} badge={b} />
          ))}
          <SourceChips paper={paper} />
        </div>

        {/* The bibliography menu anchors to this row ([&>div]:static), so it opens across the drawer. */}
        <div className="relative mt-3 flex flex-wrap gap-1.5 [&>div]:static">
          <BibButton paper={paper} bibFiles={bibFiles} busy={busy === "bib"} />
          <DrawerButton disabled={unsaved || busy === "save"} onClick={() => void lib().toggleSave(paper)} title={unsaved ? "This result isn't in your library" : undefined}>
            {paper.saved ? <BookmarkCheck size={13} className="text-accent" /> : <BookmarkPlus size={13} />}
            {paper.saved ? "Saved" : "Save"}
          </DrawerButton>
          <DrawerButton disabled={!cited} onClick={() => void lib().cite(paper)} title={cited ? undefined : "Add it to the bibliography first"}>
            <Copy size={13} /> {cited ? `\\cite{${cited}}` : "Cite"}
          </DrawerButton>
          {page && (
            <DrawerButton onClick={() => void openUrl(page)}>
              <ExternalLink size={13} /> Page
            </DrawerButton>
          )}
          {pdf && (
            <DrawerButton onClick={() => void openUrl(pdf)}>
              <FileText size={13} /> PDF
            </DrawerButton>
          )}
        </div>

        {paper.tldr && (
          <Section title="TL;DR">
            <p className="border-l-2 border-accent/50 pl-2.5 leading-relaxed select-text">{paper.tldr}</p>
          </Section>
        )}
        <Section title="Abstract">
          {paper.abstract ? (
            <p className="leading-relaxed whitespace-pre-line text-text/90 select-text">{paper.abstract}</p>
          ) : (
            <p className="text-muted">No abstract from the sources.</p>
          )}
        </Section>

        <Identifiers paper={paper} />
        {project && <BibtexPreview paper={paper} project={project} bibFiles={bibFiles} />}
        <RelatedLists paper={paper} project={project} />
        {!unsaved && <TagsAndNote paper={paper} />}
        <FoundBy paper={paper} />
      </div>
    </>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">{title}</h3>
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function DrawerButton({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2/60 px-2.5 text-[12px] text-text transition-colors enabled:hover:bg-surface-2 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function BibButton({ paper, bibFiles, busy }: { paper: LibraryPaper; bibFiles: string[]; busy: boolean }) {
  const cited = !!paper.inProject?.citeKey;
  const add = (file?: string) => void useLibrary.getState().addToBibliography(paper, bibFiles, file);
  const className =
    "inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-ink transition-colors enabled:hover:bg-accent-strong disabled:bg-surface-2 disabled:text-muted";
  const content = (
    <>
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
      {cited ? "In bibliography" : "Add to bibliography"}
    </>
  );
  if (bibFiles.length <= 1 || cited) {
    return (
      <button type="button" disabled={busy || cited} onClick={() => add()} className={className}>
        {content}
      </button>
    );
  }
  return (
    <Menu
      align="left"
      items={bibFiles.map((f) => ({ label: f, icon: <FileText size={14} />, onSelect: () => add(f) }))}
      trigger={({ open, toggle }) => (
        <button type="button" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={toggle} className={className}>
          {content}
        </button>
      )}
    />
  );
}

function Identifiers({ paper }: { paper: LibraryPaper }) {
  const rows = ID_ROWS.filter((r) => paper.ids[r.key]);
  if (rows.length === 0) return null;
  return (
    <Section title="Identifiers">
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-[12px]">
        {rows.map((r) => {
          const value = paper.ids[r.key]!;
          return (
            <div key={r.key} className="contents">
              <dt className="text-muted">{r.label}</dt>
              <dd className="min-w-0 truncate font-mono text-[11.5px] select-text" title={value}>
                {r.url ? (
                  <button type="button" onClick={() => void openUrl(r.url!(value))} className="truncate text-left hover:text-accent hover:underline">
                    {value}
                  </button>
                ) : (
                  value
                )}
              </dd>
              <button type="button" aria-label={`Copy ${r.label}`} onClick={() => void copy(value, r.label)} className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-text">
                <Copy size={12} />
              </button>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}

function BibtexPreview({ paper, project, bibFiles }: { paper: LibraryPaper; project: string; bibFiles: string[] }) {
  const [entry, setEntry] = useState<BibtexForResult | { error: string } | "loading" | null>(null);
  const id = paperId(paper);
  if (!id) return null;
  const load = async () => {
    setEntry("loading");
    try {
      setEntry(await libraryApi.bibtexFor(project, id, bibFiles.length === 1 ? bibFiles[0] : undefined));
    } catch (err) {
      setEntry({ error: errorText(err) });
    }
  };
  return (
    <Section
      title="BibTeX"
      action={
        entry && entry !== "loading" && !("error" in entry) ? (
          <button type="button" onClick={() => void copy(entry.bibtex, "the BibTeX entry")} className="inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-text">
            <Copy size={12} /> Copy
          </button>
        ) : null
      }
    >
      {entry === null && (
        <button type="button" onClick={() => void load()} className="text-[12px] text-accent hover:underline">
          Show the BibTeX entry
        </button>
      )}
      {entry === "loading" && (
        <div aria-live="polite" className="flex flex-col gap-1.5">
          <span className="sr-only">Loading…</span>
          <Skeleton lines={4} />
        </div>
      )}
      {entry && entry !== "loading" && "error" in entry && <p className="text-[12px] text-muted">{entry.error}</p>}
      {entry && entry !== "loading" && !("error" in entry) && (
        <div className="texo-fade-in">
          <pre className="max-h-56 overflow-auto rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-text">{entry.bibtex}</pre>
          {entry.renamedFrom && <p className="mt-1 text-[11.5px] text-muted">The key {entry.renamedFrom} was taken, so it is {entry.key}.</p>}
          {entry.warnings.map((w, i) => (
            <p key={i} className="mt-1 text-[11.5px] text-warning">
              {w}
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}

const RELATED: { kind: RelatedKind; label: string }[] = [
  { kind: "references", label: "References" },
  { kind: "citations", label: "Cited by" },
  { kind: "recommendations", label: "Similar" },
];

function RelatedLists({ paper, project }: { paper: LibraryPaper; project: string | null }) {
  const [kind, setKind] = useState<RelatedKind | null>(null);
  const [list, setList] = useState<LibraryPaper[] | { error: string } | "loading">("loading");
  const id = paperId(paper);
  if (!id) return null;
  const load = async (k: RelatedKind) => {
    setKind(k);
    setList("loading");
    try {
      const items = await libraryApi.related(id, k, project ?? undefined);
      setList(items);
    } catch (err) {
      setList({ error: errorText(err) });
    }
  };
  return (
    <Section title="Related papers">
      <div className="flex flex-wrap gap-1">
        {RELATED.map((r) => (
          <button
            key={r.kind}
            type="button"
            aria-pressed={kind === r.kind}
            onClick={() => void load(r.kind)}
            className={`h-6 rounded-full border px-2.5 text-[11.5px] transition-colors ${
              kind === r.kind ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {kind && (
        <div className="mt-2" aria-live="polite">
          {list === "loading" ? (
            <div className="flex flex-col gap-2">
              <span className="sr-only">Loading…</span>
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : "error" in list ? (
            <p className="text-[12px] text-muted">{list.error}</p>
          ) : list.length === 0 ? (
            <p className="text-[12px] text-muted">Semantic Scholar lists none.</p>
          ) : (
            <ul className="texo-stagger flex flex-col">
              {list.map((p, i) => (
                <li key={p.uid} style={{ "--i": i } as CSSProperties}>
                  <button
                    type="button"
                    onClick={() => useLibrary.getState().openDetail(p)}
                    className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                  >
                    <span className="line-clamp-2 text-[12.5px] leading-snug">{p.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted">
                      {authorLine(p.authors)}
                      {p.year ? ` · ${p.year}` : ""}
                      {p.citations ? ` · ${formatCount(p.citations)} citations` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

/** Splits typed tags on commas. */
export function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function TagsAndNote({ paper }: { paper: LibraryPaper }) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(paper.note ?? "");
  const lib = useLibrary.getState;
  const addTags = () => {
    const next = [...paper.tags];
    for (const t of parseTags(draft)) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    setDraft("");
    if (next.length !== paper.tags.length) void lib().setTags(paper, next);
  };
  return (
    <Section title="Tags and note">
      <div className="flex flex-wrap items-center gap-1">
        {paper.tags.map((t) => (
          <span key={t} className="inline-flex h-[22px] items-center gap-1 rounded-full bg-surface-2 pr-1 pl-2 text-[11.5px]">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => void lib().setTags(paper, paper.tags.filter((x) => x !== t))} className="rounded-full p-0.5 text-muted hover:text-text">
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          aria-label="Add tags"
          placeholder={paper.tags.length ? "Add a tag" : "Add tags, separated by commas"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTags();
            }
          }}
          onBlur={() => draft.trim() && addTags()}
          className="h-[22px] min-w-28 flex-1 bg-transparent px-1 text-[12px] placeholder:text-muted/70 focus:outline-none"
        />
      </div>
      <textarea
        value={note}
        aria-label="Note"
        placeholder="A note for yourself"
        rows={3}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== (paper.note ?? "") && void lib().setNote(paper, note)}
        className="mt-2 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] leading-relaxed placeholder:text-muted/70 focus:border-accent/60 focus:outline-none"
      />
    </Section>
  );
}

function FoundBy({ paper }: { paper: LibraryPaper }) {
  if (paper.foundBy.length === 0) return null;
  const show = (runId: string) => {
    useAiPanel.getState().show("agents");
    useRunFocus.getState().focus(runId);
  };
  return (
    <Section title="Found by">
      <ul className="flex flex-col">
        {paper.foundBy.slice(0, 6).map((f) => (
          <li key={f.runId}>
            <button type="button" onClick={() => show(f.runId)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-surface-2">
              <Bot size={13} className="shrink-0 text-muted" />
              <span className="flex-1 truncate">An agent run{f.tool ? ` (${f.tool.replace(/_/g, " ")})` : ""}</span>
              <span className="shrink-0 text-[11px] text-muted">{date.format(new Date(f.at))}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
