// The head of the "In this project" scope: how the project's .bib entries
// stand against the published records, "Check all citations" (with a k of n
// bar, the key being checked, and Cancel), and a re-scan of the .bib files.
import { RefreshCw, ShieldCheck, X } from "lucide-react";
import { ProgressBar } from "../components/ui/ProgressBar";
import { StatusDot, type StatusTone } from "../components/ui/StatusDot";
import type { LibraryPaper, VerifyReport, VerifyStatus } from "../lib/libraryApi";
import { useLibrary } from "./libraryStore";

export type VerifyCounts = Record<VerifyStatus, number> & { cited: number };

/** How many of the project's cited papers are in each check state. */
export function verifyCounts(papers: LibraryPaper[]): VerifyCounts {
  const c: VerifyCounts = { cited: 0, verified: 0, mismatch: 0, notFound: 0, unchecked: 0 };
  for (const p of papers) {
    if (!p.inProject?.inBib) continue;
    c.cited++;
    c[p.inProject.verify ?? "unchecked"]++;
  }
  return c;
}

/** "Checked 12: 10 verified, 1 mismatch, 1 not found." */
export function reportSummary(r: VerifyReport): string {
  const by: Record<VerifyStatus, number> = { verified: 0, mismatch: 0, notFound: 0, unchecked: 0 };
  let failed = 0;
  for (const c of r.checks) {
    if (c.failed) failed++;
    else by[c.check.status]++;
  }
  const parts = [
    by.verified && `${by.verified} verified`,
    by.mismatch && `${by.mismatch} ${by.mismatch === 1 ? "mismatch" : "mismatches"}`,
    by.notFound && `${by.notFound} not found`,
    by.unchecked && `${by.unchecked} couldn't be checked`,
    failed && `${failed} not reached`,
  ].filter(Boolean);
  const head = `Checked ${r.checks.length}${r.total > r.checks.length ? ` of ${r.total}` : ""}`;
  return parts.length ? `${head}: ${parts.join(", ")}.` : `${head}.`;
}

const LEGEND: { status: VerifyStatus; label: string; tone: StatusTone }[] = [
  { status: "verified", label: "verified", tone: "success" },
  { status: "mismatch", label: "mismatch", tone: "warning" },
  { status: "notFound", label: "not found", tone: "danger" },
  { status: "unchecked", label: "unchecked", tone: "muted" },
];

export function ProjectRefs({ papers }: { papers: LibraryPaper[] }) {
  const verify = useLibrary((s) => s.verify);
  const last = useLibrary((s) => s.lastVerify);
  const unavailable = useLibrary((s) => s.unavailable);
  const lib = useLibrary.getState;
  const counts = verifyCounts(papers);
  const running = !!verify;

  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-[12px] text-text">
          {counts.cited ? `${counts.cited} cited ${counts.cited === 1 ? "paper" : "papers"} found in your library` : "No cited papers linked yet"}
        </p>
        <span className="flex-1" />
        <button
          type="button"
          disabled={running || !!unavailable}
          onClick={() => void lib().rescanBib()}
          title="Read the project's .bib files again"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-50"
        >
          <RefreshCw size={13} /> Re-scan
        </button>
        {!running && (
          <button
            type="button"
            onClick={() => void lib().verifyAll()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2/60 px-2.5 text-[12px] text-text hover:bg-surface-2"
          >
            <ShieldCheck size={13} className="text-accent" /> Check all citations
          </button>
        )}
      </div>

      {counts.cited > 0 && !running && (
        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted" aria-label="Citation checks">
          {LEGEND.filter((l) => counts[l.status] > 0).map((l) => (
            <li key={l.status} className="inline-flex items-center gap-1.5">
              <StatusDot tone={l.tone} /> {counts[l.status]} {l.label}
            </li>
          ))}
        </ul>
      )}

      {running && (
        <div className="texo-fade-in mt-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <ProgressBar value={verify.total ? verify.done : undefined} max={verify.total || 1} label="Checking citations" />
            <p className="mt-1 truncate text-[11.5px] text-muted">
              {verify.total ? `${verify.done} of ${verify.total}` : "Starting…"}
              {verify.current && <span className="font-mono"> · {verify.current}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={() => lib().cancelVerify()}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={13} /> Cancel
          </button>
        </div>
      )}

      {/* Phase changes only: started and finished, never each key. */}
      <p aria-live="polite" className="mt-1 text-[11.5px] text-muted empty:hidden">
        {running ? <span className="sr-only">Checking citations.</span> : last ? reportSummary(last) : null}
        {!running && last && last.missing.length > 0 && ` Not in any .bib file: ${last.missing.join(", ")}.`}
      </p>
    </div>
  );
}
