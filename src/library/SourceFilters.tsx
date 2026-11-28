// The Papers tab's filter popover (years, open access, citations, source)
// and the row of source chips an online search fills in: a spinner while a
// source is asked, its count when it answered, and a plain note when it was
// busy, failed or is off. A failed source is a chip, never an empty list.
import { AlertTriangle, Check, Clock, Loader2, MinusCircle, SlidersHorizontal, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Popover } from "../components/ui/Popover";
import { Toggle } from "../components/settingsControls";
import { useUi } from "../ui";
import { activeFilterCount, chipText, ONLINE_SOURCES, SOURCE_NAMES, type OnlineSource, type PanelFilters, type SourceChipState } from "./libraryStore";

const numberOrUndefined = (v: string): number | undefined => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const inputClass =
  "h-7 w-full rounded-md border border-border bg-bg px-2 text-[12px] text-text placeholder:text-muted/70 focus:border-accent/60 focus:outline-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </label>
  );
}

export function FilterButton({ filters, onChange }: { filters: PanelFilters; onChange: (f: PanelFilters) => void }) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const patch = (p: Partial<PanelFilters>) => onChange({ ...filters, ...p });
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filters"
      align="end"
      width={260}
      trigger={
        <button
          type="button"
          aria-label={count ? `Filters (${count} on)` : "Filters"}
          title="Filters"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`relative inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] transition-colors ${
            count ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-muted hover:bg-surface-2 hover:text-text"
          }`}
        >
          <SlidersHorizontal size={13} />
          {count > 0 && <span className="text-[11px] font-medium tabular-nums">{count}</span>}
        </button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="From year">
            <input
              type="number"
              inputMode="numeric"
              min={1000}
              max={9999}
              placeholder="Any"
              value={filters.yearFrom ?? ""}
              onChange={(e) => patch({ yearFrom: numberOrUndefined(e.target.value) })}
              className={inputClass}
            />
          </Field>
          <Field label="To year">
            <input
              type="number"
              inputMode="numeric"
              min={1000}
              max={9999}
              placeholder="Any"
              value={filters.yearTo ?? ""}
              onChange={(e) => patch({ yearTo: numberOrUndefined(e.target.value) })}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="At least this many citations">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Any"
            value={filters.minCitations ?? ""}
            onChange={(e) => patch({ minCitations: numberOrUndefined(e.target.value) })}
            className={inputClass}
          />
        </Field>
        <Field label="Source">
          <select
            value={filters.source ?? ""}
            onChange={(e) => patch({ source: (e.target.value || undefined) as OnlineSource | undefined })}
            className={inputClass}
          >
            <option value="">Any source</option>
            {ONLINE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_NAMES[s]}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-center justify-between">
          <span className="text-[12px]">Open access only</span>
          <Toggle label="Open access only" checked={!!filters.oaOnly} onChange={(on) => patch({ oaOnly: on || undefined })} />
        </div>
        <button
          type="button"
          disabled={count === 0}
          onClick={() => onChange({})}
          className="inline-flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[12px] text-muted enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-40"
        >
          <X size={12} /> Clear filters
        </button>
      </div>
    </Popover>
  );
}

function ChipIcon({ chip, running }: { chip: SourceChipState | undefined; running: boolean }) {
  // A chip left waiting when the search is over shows as done, not as still asking.
  const raw = chip?.state ?? (running ? "pending" : undefined);
  const state = !running && (raw === "pending" || raw === "waiting") ? "skipped" : raw;
  switch (state) {
    case "pending":
      return <Loader2 size={11} className="animate-spin" />;
    case "waiting":
      return <Clock size={11} />;
    case "ok":
      return <Check size={11} className="texo-check-draw text-success" />;
    case "degraded":
      return <AlertTriangle size={11} className="text-warning" />;
    case "skipped":
      return <MinusCircle size={11} />;
    default:
      return null;
  }
}

/** A chip's count after it answered ("12"), from "12 results". */
const okCount = (chip: SourceChipState | undefined) => (chip?.state === "ok" && chip.detail ? (/\d+/.exec(chip.detail)?.[0] ?? null) : null);

/** One chip per source during and after an online search. */
export function OnlineSources({ sources, running }: { sources: Record<string, SourceChipState>; running: boolean }) {
  const shown = ONLINE_SOURCES.filter((s) => running || sources[s]);
  if (shown.length === 0) return null;
  const openAlexOff = sources.openalex?.state === "skipped" && /key/i.test(sources.openalex.detail ?? "");
  return (
    <div className="flex flex-col gap-1.5">
      <ul aria-label="Paper sources" className="flex flex-wrap gap-1">
        {shown.map((s) => {
          const chip = sources[s];
          const n = okCount(chip);
          const degraded = chip?.state === "degraded";
          return (
            <li
              key={s}
              data-state={chip?.state ?? "pending"}
              title={chip?.detail ?? undefined}
              className={`texo-fade-in inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px] whitespace-nowrap ${
                degraded ? "border-warning/30 bg-warning/10 text-warning" : chip?.state === "skipped" ? "border-border text-muted/80" : "border-border bg-surface-2/60 text-muted"
              }`}
            >
              <ChipIcon chip={chip} running={running} />
              <span className={chip?.state === "ok" ? "text-text" : undefined}>{chipText(s, chip)}</span>
              {n !== null && <span className="tabular-nums text-muted">{n}</span>}
            </li>
          );
        })}
      </ul>
      {openAlexOff && (
        <p className="text-[11.5px] text-muted">
          OpenAlex key not set: results come from Semantic Scholar, Crossref and arXiv.{" "}
          <button type="button" onClick={() => useUi.getState().openSettings("ai")} className="text-accent hover:underline">
            Settings
          </button>
        </p>
      )}
    </div>
  );
}
