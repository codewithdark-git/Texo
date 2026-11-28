// A run's steps, with runs of the same tool folded into one line ("Ran 6
// paper searches · 14 results"). A group opens to its steps, and a step to
// its raw output. Steps that found papers show them as cards underneath.

import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessageSquare, Wrench } from "lucide-react";
import type { Step } from "../../../lib/agentsApi";
import { PaperStrip } from "../../../library/PaperStrip";
import { plainSummary } from "../runsStore";
import { groupSteps, stepPapers, type StepGroup } from "./progressModel";

const ms = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

function stepLine(step: Step): string {
  return step.kind === "message" ? plainSummary(step.resultSummary || "") || "Message" : step.resultSummary;
}

function StepIcon({ step }: { step: Pick<Step, "kind" | "ok" | "notice"> }) {
  return step.kind === "toolCall" ? (
    <Wrench size={12} className={step.ok ? "text-muted" : "text-danger"} />
  ) : (
    <MessageSquare size={12} className={step.notice ? "text-warning" : "text-accent"} />
  );
}

/** One step: a line that opens to the tool's output or the message text. */
export function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const detail = step.result || step.text || "";
  return (
    <li className="text-[12px]">
      <button
        type="button"
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={detail ? open : undefined}
        className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left transition-colors enabled:hover:bg-surface-2"
      >
        <span className="mt-0.5 shrink-0">
          <StepIcon step={step} />
        </span>
        <span className="min-w-0 flex-1">
          {step.sub && <span className="mr-1 rounded bg-surface-2 px-1 text-[10px] text-muted">{step.sub}</span>}
          {step.tool && <span className="mr-1.5 font-mono text-[11px] text-text">{step.tool}</span>}
          <span className={step.ok ? "text-muted" : "text-danger"}>{stepLine(step)}</span>
        </span>
        {step.ms > 0 && <span className="shrink-0 text-[10px] tabular-nums text-muted">{ms(step.ms)}</span>}
      </button>
      {open && detail && (
        <pre className="texo-fade-in mt-0.5 mb-1 ml-5 max-h-48 overflow-auto rounded bg-bg px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-text/85 select-text">{detail}</pre>
      )}
    </li>
  );
}

const MAX_PAPERS = 10;

function groupPapers(g: StepGroup): unknown[] {
  return g.steps.flatMap(stepPapers).slice(0, MAX_PAPERS);
}

function Group({ group }: { group: StepGroup }) {
  const [open, setOpen] = useState(false);
  const papers = groupPapers(group);
  if (group.count === 1)
    return (
      <>
        <StepRow step={group.steps[0]} />
        {papers.length > 0 && (
          <li className="ml-5 py-0.5">
            <PaperStrip papers={papers} />
          </li>
        )}
      </>
    );
  const failed = group.count - group.okCount;
  const totalMs = group.steps.reduce((a, s) => a + s.ms, 0);
  return (
    <li className="text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="mt-0.5 shrink-0">
          <StepIcon step={{ kind: "toolCall", ok: failed === 0 }} />
        </span>
        <span className="min-w-0 flex-1">
          {group.sub && <span className="mr-1 rounded bg-surface-2 px-1 text-[10px] text-muted">{group.sub}</span>}
          {group.tool && <span className="mr-1.5 font-mono text-[11px] text-text">{group.tool}</span>}
          <span className="text-muted">{group.summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted">
          {totalMs > 0 && ms(totalMs)}
          <ChevronRight size={11} className={`transition-transform duration-[var(--dur-2)] ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      <div className="texo-collapse" data-open={open ? "" : "false"}>
        {/* Kept mounted so it can fold away; out of reach while folded. */}
        <div inert={!open}>
          <ul className="ml-4 border-l border-border pl-1">
            {group.steps.map((s) => (
              <StepRow key={s.n} step={s} />
            ))}
          </ul>
        </div>
      </div>
      {papers.length > 0 && (
        <div className="ml-5 py-0.5">
          <PaperStrip papers={papers} />
        </div>
      )}
    </li>
  );
}

/** The step list, grouped; follows the newest step while the run works. */
export function StepGroups({ steps, active, empty }: { steps: Step[]; active: boolean; empty?: string }) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) end.current?.scrollIntoView({ block: "nearest" });
  }, [steps.length, active]);
  if (steps.length === 0) return <p className="px-1 py-1 text-[12px] text-muted">{empty ?? (active ? "Starting…" : "No steps were recorded.")}</p>;
  return (
    <ul className="max-h-72 overflow-y-auto">
      {groupSteps(steps).map((g) => (
        <Group key={g.key} group={g} />
      ))}
      <li ref={end} aria-hidden="true" />
    </ul>
  );
}
