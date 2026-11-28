// The task agent's plan as a checklist that ticks itself off: a hollow
// circle waits, a spinner works, a drawn tick is done, a half circle is partly
// done and a cross is not done. Rows glide when the list changes (FLIP).

import { useRef } from "react";
import { CircleDashed, CircleX, Loader2 } from "lucide-react";
import type { PlanItem, PlanStatus } from "../../../lib/agentsApi";
import { useFlip } from "../../../lib/motion";

const WORDS: Record<PlanStatus, string> = {
  pending: "To do",
  active: "Working on it",
  done: "Done",
  partly: "Partly done",
  notDone: "Not done",
  skipped: "Skipped",
};

/** A tick that draws itself in (held still under reduced motion). */
function DrawnCheck() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-success">
      <circle cx={8} cy={8} r={7} fill="currentColor" opacity={0.15} />
      <path d="M4.8 8.3 7 10.4l4.2-4.6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="texo-check-draw" />
    </svg>
  );
}

function HalfCircle() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-warning">
      <circle cx={8} cy={8} r={6.25} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor" />
    </svg>
  );
}

function ItemIcon({ status }: { status: PlanStatus }) {
  switch (status) {
    case "pending":
      return <span aria-hidden="true" className="mx-px block size-3 shrink-0 rounded-full border-[1.5px] border-muted/50" />;
    case "active":
      return <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-accent" />;
    case "done":
      return <DrawnCheck />;
    case "partly":
      return <HalfCircle />;
    case "notDone":
      return <CircleX size={14} aria-hidden="true" className="shrink-0 text-danger" />;
    case "skipped":
      return <CircleDashed size={14} aria-hidden="true" className="shrink-0 text-muted" />;
  }
}

export function PlanChecklist({ plan }: { plan: PlanItem[] }) {
  const list = useRef<HTMLOListElement>(null);
  useFlip(list, [plan.map((i) => `${i.n}:${i.status}:${i.note ?? ""}`).join("|")]);
  if (plan.length === 0) return null;
  const settled = plan.filter((i) => i.status !== "pending" && i.status !== "active").length;
  return (
    <section aria-label="Plan">
      <p className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted">
        <span>Plan</span>
        <span className="tabular-nums">
          {settled} of {plan.length}
        </span>
      </p>
      <ol ref={list} className="space-y-0.5">
        {plan.map((item) => (
          <li key={item.n} data-flip={item.n} className="flex items-start gap-2 rounded-md px-1 py-0.5 text-[12px]">
            <span className="mt-px">
              <ItemIcon key={item.status} status={item.status} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={item.status === "pending" ? "text-muted" : item.status === "skipped" ? "text-muted line-through" : "text-text/90"}>{item.task}</span>
              <span className="sr-only">: {WORDS[item.status]}</span>
              {item.note && <span className="block truncate text-[11px] text-muted">{item.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
