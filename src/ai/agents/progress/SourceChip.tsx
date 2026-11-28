// One paper source (arXiv, Crossref …) of the search running now: a spinner
// while it is asked, a tick and the number of results, "waiting 3s" while it
// asks Texo to slow down, or "busy" when it couldn't answer.

import { Check, Clock, Loader2, TriangleAlert } from "lucide-react";
import type { SourceChip as Chip } from "../../../lib/agentsApi";

/** Plain words for a chip, for its tooltip and screen readers. */
export function sourceChipText(chip: Chip): string {
  switch (chip.state) {
    case "pending":
      return `${chip.source}: asking`;
    case "ok":
      return chip.detail ? `${chip.source}: ${chip.detail} found` : `${chip.source}: answered`;
    case "waiting":
      return chip.detail ? `${chip.source}: waiting ${chip.detail}` : `${chip.source}: waiting`;
    case "degraded":
      return chip.detail ? `${chip.source}: ${chip.detail}` : `${chip.source}: busy, skipped`;
  }
}

const TONE: Record<Chip["state"], string> = {
  pending: "border-border text-muted",
  ok: "border-success/30 bg-success/10 text-text",
  waiting: "border-warning/30 bg-warning/10 text-text",
  degraded: "border-border bg-surface-2 text-muted",
};

export function SourceChip({ chip }: { chip: Chip }) {
  const text = sourceChipText(chip);
  return (
    <span
      title={text}
      aria-label={text}
      className={`texo-fade-in inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[10px] leading-none transition-colors duration-[var(--dur-2)] ${TONE[chip.state]}`}
    >
      {chip.state === "pending" && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
      {chip.state === "ok" && <Check size={10} className="text-success" aria-hidden="true" />}
      {chip.state === "waiting" && <Clock size={10} className="text-warning" aria-hidden="true" />}
      {chip.state === "degraded" && <TriangleAlert size={10} aria-hidden="true" />}
      <span aria-hidden="true">{chip.source}</span>
      {chip.state === "ok" && chip.detail && (
        <span aria-hidden="true" className="tabular-nums text-muted">
          {chip.detail}
        </span>
      )}
      {chip.state === "waiting" && (
        <span aria-hidden="true" className="text-muted">
          {chip.detail ? `waiting ${chip.detail}` : "waiting"}
        </span>
      )}
      {chip.state === "degraded" && <span aria-hidden="true">busy</span>}
    </span>
  );
}
