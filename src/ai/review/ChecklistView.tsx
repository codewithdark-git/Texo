// The reviewer's automatic checks (no AI): one row per check, worst first,
// with its details and a click to jump to the first finding.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, XCircle } from "lucide-react";
import { checklistSummary, sortChecks, type Check, type CheckStatus } from "../../lib/reviewApi";
import { locationText } from "./reviewLogic";

const ICON: Record<CheckStatus, { Icon: typeof CheckCircle2; cls: string; word: string }> = {
  pass: { Icon: CheckCircle2, cls: "text-emerald-400", word: "OK" },
  warn: { Icon: AlertTriangle, cls: "text-amber-400", word: "Warning" },
  fail: { Icon: XCircle, cls: "text-danger", word: "Problem" },
};

export function ChecklistView({ checks, onJump }: { checks: Check[]; onJump?: (file: string, line: number) => void }) {
  if (!checks.length) return <p className="text-xs text-muted">The automatic checks weren't run for this review.</p>;
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted">{checklistSummary(checks)}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {sortChecks(checks).map((c) => (
          <CheckRow key={c.id} check={c} onJump={onJump} />
        ))}
      </ul>
    </div>
  );
}

function CheckRow({ check, onJump }: { check: Check; onJump?: (file: string, line: number) => void }) {
  const [open, setOpen] = useState(check.status === "fail");
  const { Icon, cls, word } = ICON[check.status];
  const where = locationText(check.file, check.line);
  const hasDetails = check.details.length > 0;
  return (
    <li className="px-2.5 py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
          onClick={() => setOpen(!open)}
          disabled={!hasDetails}
          aria-expanded={hasDetails ? open : undefined}
        >
          <ChevronRight size={13} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""} ${hasDetails ? "" : "invisible"}`} />
          <Icon size={14} className={`shrink-0 ${cls}`} aria-label={word} />
          <span className="truncate">{check.title}</span>
        </button>
        {where && onJump && (
          <button
            type="button"
            className="shrink-0 font-mono text-[11px] text-accent hover:underline"
            title="Show this place in the editor"
            onClick={() => onJump(check.file!, check.line ?? 1)}
          >
            {where}
          </button>
        )}
      </div>
      {open && hasDetails && (
        <ul className="mt-1 ml-9 list-disc space-y-0.5 pl-3 text-xs text-muted">
          {check.details.map((d, i) => (
            <li key={i} className="select-text">
              {d}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
