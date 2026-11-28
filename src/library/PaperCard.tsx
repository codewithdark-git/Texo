// One paper in the Papers tab: title, authors, venue and year, the TL;DR or
// the start of the abstract (with search matches marked), badges for what
// is known about it, the sources it came from, and its actions. In a narrow
// sidebar it tightens: less padding, no source chips (the details have
// them), short or icon-only actions, and its menus open across the card.
// Every text field is rendered as text: nothing from a paper is ever parsed
// as HTML.
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BookmarkCheck,
  BookmarkPlus,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Menu, type MenuItem } from "../components/Menu";
import { Tooltip } from "../components/ui/Tooltip";
import { authorLine, isUnsavedPaper, type LibraryPaper, type VerifyStatus } from "../lib/libraryApi";
import { Highlight } from "./highlight";
import { SOURCE_NAMES, useLibrary } from "./libraryStore";

export type BadgeTone = "accent" | "success" | "warning" | "danger" | "muted" | "info";

export interface PaperBadge {
  id: "citations" | "oa" | "preprint" | "saved" | "project" | "verify" | "duplicate";
  label: string;
  tone: BadgeTone;
  /** Longer words for the tooltip. */
  title?: string;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");

/** "940", "1,234", "12K": counts as they read at a glance. */
export function formatCount(n: number): string {
  return n < 10_000 ? full.format(n) : compact.format(n);
}

const OA_NAMES: Record<string, string> = { gold: "Gold", green: "Green", bronze: "Bronze", hybrid: "Hybrid", diamond: "Diamond" };

export const VERIFY_BADGES: Record<VerifyStatus, { label: string; tone: BadgeTone; title: string }> = {
  verified: { label: "Verified", tone: "success", title: "The .bib entry matches the published record." },
  mismatch: { label: "Mismatch", tone: "warning", title: "The .bib entry differs from the published record." },
  notFound: { label: "Not found", tone: "danger", title: "No published record matches the .bib entry." },
  unchecked: { label: "Unchecked", tone: "muted", title: "Not checked yet." },
};

/** Whether the paper is a preprint: so marked, or only on arXiv. */
export function isPreprint(p: LibraryPaper): boolean {
  const type = p.workType?.toLowerCase() ?? "";
  return type.includes("preprint") || type === "posted-content" || (!!p.ids.arxiv && !p.ids.doi);
}

/** The badges a card shows, in order. */
export function paperBadges(p: LibraryPaper): PaperBadge[] {
  const badges: PaperBadge[] = [];
  if (p.citations !== null && p.citations !== undefined) {
    const inf = p.influential ? ` · ${formatCount(p.influential)} influential` : "";
    badges.push({
      id: "citations",
      label: `${formatCount(p.citations)} ${p.citations === 1 ? "citation" : "citations"}`,
      tone: "muted",
      title: `Cited ${full.format(p.citations)} ${p.citations === 1 ? "time" : "times"}${inf}`,
    });
  }
  const oaStatus = p.oa?.status?.toLowerCase();
  if (oaStatus && oaStatus !== "closed") {
    const name = OA_NAMES[oaStatus] ?? oaStatus;
    badges.push({ id: "oa", label: `OA · ${name}`, tone: "success", title: `Open access (${name.toLowerCase()})${p.oa?.pdfUrl ? ", with a free PDF" : ""}` });
  } else if (p.oa?.pdfUrl) {
    badges.push({ id: "oa", label: "PDF", tone: "success", title: "A free PDF is available" });
  }
  if (isPreprint(p)) badges.push({ id: "preprint", label: "Preprint", tone: "info", title: "Not yet peer reviewed, as far as the sources know" });
  if (p.saved) badges.push({ id: "saved", label: "In library", tone: "accent", title: "Saved in your library" });
  if (p.inProject) {
    const key = p.inProject.citeKey;
    badges.push({
      id: "project",
      label: key ? `In project · ${key}` : "In project",
      tone: "accent",
      title: p.inProject.bibFile ? `Cited in ${p.inProject.bibFile}` : "Linked to this project",
    });
    if (p.inProject.inBib) {
      const v = VERIFY_BADGES[p.inProject.verify ?? "unchecked"];
      badges.push({ id: "verify", label: v.label, tone: v.tone, title: p.inProject.verifyNote || v.title });
    }
  }
  if (p.dupOf) badges.push({ id: "duplicate", label: "Possible duplicate", tone: "warning", title: "Another paper in your library looks like the same work" });
  return badges;
}

const TONES: Record<BadgeTone, string> = {
  accent: "border-accent/25 bg-accent/10 text-accent",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  info: "border-info/25 bg-info/10 text-info",
  muted: "border-border bg-surface-2/70 text-muted",
};

export function Badge({ badge }: { badge: PaperBadge }) {
  return (
    <span
      title={badge.title}
      data-badge={badge.id}
      className={`inline-flex h-[18px] max-w-full min-w-0 items-center rounded-full border px-1.5 text-[10.5px] leading-none font-medium whitespace-nowrap ${TONES[badge.tone]}`}
    >
      <span className="min-w-0 truncate">{badge.label}</span>
    </span>
  );
}

const SOURCE_SHORT: Record<string, string> = { s2: "S2", arxiv: "arXiv", openalex: "OpenAlex", crossref: "Crossref" };
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** A source chip's tooltip: "Semantic Scholar · 1,234 citations · fetched 3 Mar 2026". */
export function sourceTitle(s: LibraryPaper["sources"][number]): string {
  const parts = [SOURCE_NAMES[s.source] ?? s.source];
  if (s.citations !== null && s.citations !== undefined) parts.push(`${full.format(s.citations)} ${s.citations === 1 ? "citation" : "citations"}`);
  if (s.fetchedAt > 0) parts.push(`fetched ${day.format(new Date(s.fetchedAt))}`);
  return parts.join(" · ");
}

export function SourceChips({ paper }: { paper: LibraryPaper }) {
  if (paper.sources.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label="Sources">
      {paper.sources.map((s) => (
        <Tooltip key={s.source} content={sourceTitle(s)} side="top">
          <span
            data-source={s.source}
            className="inline-flex h-[18px] items-center rounded-md bg-surface-2 px-1.5 text-[10px] leading-none text-muted"
          >
            {SOURCE_SHORT[s.source] ?? s.source}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

/** The line under the title: venue and year. */
export function venueLine(p: LibraryPaper): string {
  return [p.venue, p.year ? String(p.year) : null].filter(Boolean).join(" · ");
}

/** A paper's web page: its own URL, else its DOI, else its arXiv page. Only http(s). */
export function pageUrl(p: LibraryPaper): string | null {
  const url = p.url && /^https?:\/\//i.test(p.url) ? p.url : null;
  if (url) return url;
  if (p.ids.doi) return `https://doi.org/${encodeURI(p.ids.doi)}`;
  if (p.ids.arxiv) return `https://arxiv.org/abs/${encodeURI(p.ids.arxiv)}`;
  return null;
}

/** The free PDF's address, only when it is http(s). */
export function pdfUrl(p: LibraryPaper): string | null {
  const u = p.oa?.pdfUrl;
  return u && /^https?:\/\//i.test(u) ? u : null;
}

const open = (url: string | null) => {
  if (url) void openUrl(url);
};

interface PaperCardProps {
  paper: LibraryPaper;
  /** The project's .bib files, for "Add to bibliography". */
  bibFiles: string[];
  /** The keyboard-focused row. */
  active?: boolean;
  /** Its place in the list, for the staggered entrance. */
  index?: number;
  /** DOM id, for aria-activedescendant. */
  id?: string;
  onOpen: (paper: LibraryPaper) => void;
}

export function PaperCard({ paper, bibFiles, active = false, index = 0, id, onOpen }: PaperCardProps) {
  const busy = useLibrary((s) => s.busy[paper.uid]);
  const lib = useLibrary.getState;
  const unsaved = isUnsavedPaper(paper);
  const badges = paperBadges(paper);
  const summary = paper.snippet ?? paper.tldr ?? paper.abstract;
  const meta = venueLine(paper);
  const cited = !!paper.inProject?.citeKey;

  const overflow: MenuItem[] = [];
  const page = pageUrl(paper);
  const pdf = pdfUrl(paper);
  if (page) overflow.push({ label: "Open page", icon: <ExternalLink size={14} />, onSelect: () => open(page) });
  if (pdf) overflow.push({ label: "Open PDF", icon: <FileText size={14} />, onSelect: () => open(pdf) });
  overflow.push({ label: "Find similar", icon: <Sparkles size={14} />, onSelect: () => void lib().findSimilar(paper) });
  if (!unsaved) overflow.push({ label: "Remove from library", icon: <Trash2 size={14} />, danger: true, onSelect: () => lib().askRemove(paper) });

  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      style={{ "--i": index } as CSSProperties}
      data-active={active ? "" : undefined}
      className="group relative rounded-lg border border-transparent px-3 py-2.5 transition-colors @max-[260px]/papers:px-2.5 @max-[260px]/papers:py-2 hover:bg-surface-2/50 data-[active]:border-accent/40 data-[active]:bg-surface-2/60"
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={() => onOpen(paper)}
        className="block w-full text-left text-[13px] leading-snug font-medium text-text hover:text-accent focus-visible:outline-none"
      >
        <span className="line-clamp-2 break-words">{paper.title || "Untitled"}</span>
      </button>
      <p className="mt-0.5 truncate text-[11.5px] text-muted" title={paper.authors.join(", ")}>
        {authorLine(paper.authors)}
        {meta && <span className="text-muted/80"> · {meta}</span>}
      </p>
      {summary && (
        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-text/75">
          {paper.snippet ? <Highlight text={paper.snippet} /> : summary}
        </p>
      )}
      {(badges.length > 0 || paper.sources.length > 0) && (
        <div className={`mt-1.5 flex flex-wrap items-center gap-1 ${badges.length === 0 ? "@max-[300px]/papers:hidden" : ""}`}>
          {badges.map((b) => (
            <Badge key={b.id} badge={b} />
          ))}
          <span className="flex-1 @max-[300px]/papers:hidden" />
          <span className="contents @max-[300px]/papers:hidden">
            <SourceChips paper={paper} />
          </span>
        </div>
      )}
      {/*
        An option's content is presentational to screen readers, and the list is one
        tab stop: these buttons are for the mouse. The keyboard reaches the same
        actions with Enter (details, which has them all), Ctrl+Enter and C.
      */}
      {/* The menus anchor to the card ([&>div]:static), so they open across its width. */}
      <div aria-hidden="true" className="mt-1.5 flex items-center gap-0.5 opacity-70 [&>div]:static transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 group-data-[active]:opacity-100">
        <AddToBibButton paper={paper} bibFiles={bibFiles} busy={busy === "bib"} disabled={cited} />
        <Action
          label={paper.saved ? "Saved in your library" : unsaved ? "Not in your library" : "Save to library"}
          disabled={unsaved || busy === "save"}
          onClick={() => void lib().toggleSave(paper)}
          pressed={paper.saved}
        >
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : paper.saved ? <BookmarkCheck size={13} className="text-accent" /> : <BookmarkPlus size={13} />}
          <span className="@max-[300px]/papers:hidden">{paper.saved ? "Saved" : "Save"}</span>
        </Action>
        <Action
          label={cited ? `Copy \\cite{${paper.inProject?.citeKey}}` : "Add it to the bibliography first to copy its \\cite"}
          disabled={!cited}
          onClick={() => void lib().cite(paper)}
        >
          <Copy size={13} />
          <span className="@max-[300px]/papers:hidden">Cite</span>
        </Action>
        <span className="flex-1" />
        {busy === "similar" && <Loader2 size={13} className="mr-1 animate-spin text-muted" aria-label="Finding similar papers" />}
        <Menu
          items={overflow}
          trigger={({ open: isOpen, toggle }) => (
            <button
              type="button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              tabIndex={-1}
              onClick={toggle}
              className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        />
      </div>
    </li>
  );
}

function Action({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted transition-colors enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** "Add to bibliography": straight into the only .bib file, or a menu of them. */
function AddToBibButton({ paper, bibFiles, busy, disabled }: { paper: LibraryPaper; bibFiles: string[]; busy: boolean; disabled: boolean }) {
  const add = (file?: string) => void useLibrary.getState().addToBibliography(paper, bibFiles, file);
  const icon = busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />;
  const label = disabled ? "Already in the bibliography" : bibFiles.length === 0 ? "Add to a new references.bib" : "Add to bibliography";
  const className =
    "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-accent transition-colors enabled:hover:bg-accent/10 disabled:text-muted disabled:opacity-60";
  if (bibFiles.length <= 1 || disabled) {
    return (
      <button type="button" title={label} aria-label={label} tabIndex={-1} disabled={busy || disabled} onClick={() => add()} className={className}>
        {icon}
        <BibLabel long={disabled ? "In bibliography" : "Add to bibliography"} short={disabled ? "Added" : "Add"} />
      </button>
    );
  }
  return (
    <Menu
      align="left"
      items={bibFiles.map((f) => ({ label: f, icon: <FileText size={14} />, onSelect: () => add(f) }))}
      trigger={({ open: isOpen, toggle }) => (
        <button type="button" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={isOpen} tabIndex={-1} disabled={busy} onClick={toggle} className={className}>
          {icon}
          <BibLabel long="Add to bibliography" short="Add" />
        </button>
      )}
    />
  );
}

/** The bibliography button's words: in full when wide, one word when narrow, none in the narrowest sidebar. */
function BibLabel({ long, short }: { long: string; short: string }) {
  return (
    <>
      <span className="@max-[360px]/papers:hidden">{long}</span>
      <span className="hidden @max-[360px]/papers:inline @max-[220px]/papers:hidden">{short}</span>
    </>
  );
}
