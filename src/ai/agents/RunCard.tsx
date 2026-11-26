// One run in the Agents tab: status, title, elapsed time, tokens, the live
// step list (tool names and short results), and the actions that fit the
// status: Stop, Review the plan, Review changes, Open report, Retry, Delete.

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CirclePause,
  CircleX,
  Clock,
  FileDiff,
  FileText,
  Loader2,
  MessageSquare,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { agentsApi, isActive, isRebuttalPlan, runStatusText, type RunStatus, type RunSummary, type Step } from "../../lib/agentsApi";
import { toast } from "../../ui";
import { errorText, retryRun } from "./actions";
import { openAgentDialog } from "./dialogStore";
import { canRetry, elapsedSecs, plainSummary, formatElapsed, formatTokens, kindLabel, useRuns } from "./runsStore";

function StatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case "queued":
      return <Clock size={15} className="text-muted" />;
    case "running":
      return <Loader2 size={15} className="animate-spin text-accent" />;
    case "awaiting_input":
      return <CirclePause size={15} className="text-amber-400" />;
    case "awaiting_review":
      return <FileDiff size={15} className="text-accent" />;
    case "done":
      return <CircleCheck size={15} className="text-emerald-400" />;
    case "failed":
    case "interrupted":
      return <CircleX size={15} className="text-danger" />;
    case "cancelled":
      return <Square size={13} className="text-muted" />;
  }
}

/** Ticks once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now() / 1000);
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const detail = step.result || step.text || "";
  const icon =
    step.kind === "toolCall" ? (
      <Wrench size={12} className={step.ok ? "text-muted" : "text-danger"} />
    ) : (
      <MessageSquare size={12} className={step.notice ? "text-amber-400" : "text-accent"} />
    );
  return (
    <li className="text-[12px]">
      <button
        type="button"
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left enabled:hover:bg-surface-2"
      >
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          {step.sub && <span className="mr-1 rounded bg-surface-2 px-1 text-[10px] text-muted">{step.sub}</span>}
          {step.tool && <span className="mr-1.5 font-mono text-[11px] text-text">{step.tool}</span>}
          <span className={step.ok ? "text-muted" : "text-danger"}>{step.kind === "message" ? plainSummary(step.resultSummary || "") || "Message" : step.resultSummary}</span>
        </span>
        {step.ms > 0 && <span className="shrink-0 text-[10px] text-muted">{step.ms < 1000 ? `${step.ms} ms` : `${(step.ms / 1000).toFixed(1)} s`}</span>}
      </button>
      {open && detail && (
        <pre className="mt-0.5 mb-1 ml-5 max-h-48 overflow-auto rounded bg-bg px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-text/85 select-text">{detail}</pre>
      )}
    </li>
  );
}

function Steps({ project, runId, active }: { project: string; runId: string; active: boolean }) {
  const steps = useRuns((s) => s.steps[runId]);
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    void useRuns.getState().follow(project, runId);
    return () => useRuns.getState().unfollow(runId);
  }, [project, runId]);
  useEffect(() => {
    if (active) end.current?.scrollIntoView({ block: "nearest" });
  }, [steps?.length, active]);
  if (!steps) return null;
  if (steps.length === 0) return <p className="px-1 py-1 text-[12px] text-muted">{active ? "Starting…" : "No steps were recorded."}</p>;
  return (
    <ul className="max-h-72 overflow-y-auto">
      {steps.map((s) => (
        <StepRow key={s.n} step={s} />
      ))}
      <li ref={end} />
    </ul>
  );
}

const linkBtn =
  "inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted hover:border-accent/60 hover:text-text disabled:opacity-50";

export function RunCard({ project, run }: { project: string; run: RunSummary }) {
  const active = isActive(run.status);
  const [open, setOpen] = useState(active);
  const [busy, setBusy] = useState(false);
  const now = useNow(active);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const toReview = run.pendingFiles > 0 || run.conflictFiles > 0;
  const plan = run.status === "awaiting_input" && isRebuttalPlan(run.awaiting);

  const cancel = async () => {
    setBusy(true);
    try {
      const stopped = await agentsApi.cancel(run.id);
      if (!stopped) toast("That run had already finished.", "info");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const meta = [
    kindLabel(run.kind),
    run.profileName && run.profileName !== kindLabel(run.kind) ? run.profileName : null,
    run.model || null,
  ].filter(Boolean);

  return (
    <article
      aria-label={run.title || kindLabel(run.kind)}
      className={`rounded-lg border bg-surface px-2.5 py-2 ${run.needsAttention && toReview ? "border-amber-500/50" : "border-border"}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <StatusIcon status={run.status} />
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1">
            {open ? <ChevronDown size={12} className="shrink-0 text-muted" /> : <ChevronRight size={12} className="shrink-0 text-muted" />}
            <span className="truncate text-[13px] font-medium">{run.title || kindLabel(run.kind)}</span>
          </span>
          <span className="block truncate text-[11px] text-muted">{meta.join(" · ")}</span>
        </button>
        <span className="shrink-0 text-right text-[11px] text-muted">
          <span className="block">{formatElapsed(elapsedSecs(run, now))}</span>
          {tokens > 0 && <span className="block">{formatTokens(tokens)}</span>}
        </span>
      </div>

      <p className={`mt-1 text-[12px] ${run.status === "failed" || run.status === "interrupted" ? "text-danger" : "text-text/85"}`}>
        {runStatusText(run)}
        {run.stepCount > 0 && <span className="text-muted"> · {run.stepCount} step{run.stepCount === 1 ? "" : "s"}</span>}
      </p>
      {!open && active && run.lastStep && <p className="truncate text-[11px] text-muted">{run.lastStep}</p>}
      {run.error && <p className="mt-1 text-[12px] leading-relaxed text-text/85">{run.error}</p>}
      {run.needsAttention && toReview && (
        <p className="mt-1 flex items-center gap-1 text-[12px] text-amber-400">
          <TriangleAlert size={12} /> Some changes need your attention.
        </p>
      )}

      {open && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <Steps project={project} runId={run.id} active={active} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {plan && (
          <button type="button" className={`${linkBtn} border-amber-500/50 text-text`} onClick={() => openAgentDialog({ type: "plan", runId: run.id })}>
            <CirclePause size={12} /> Review the plan
          </button>
        )}
        {run.status === "awaiting_input" && !plan && <span className="text-[11px] text-muted">This run is waiting for an answer Texo can't show yet.</span>}
        {toReview && (
          <button type="button" className={`${linkBtn} border-accent/50 text-text`} onClick={() => openAgentDialog({ type: "changes", runId: run.id })}>
            <FileDiff size={12} /> Review changes
          </button>
        )}
        {!toReview && run.changedFiles > 0 && !active && (
          <button type="button" className={linkBtn} onClick={() => openAgentDialog({ type: "changes", runId: run.id })}>
            <FileDiff size={12} /> Changes
          </button>
        )}
        {run.hasReport && (
          <button type="button" className={linkBtn} onClick={() => openAgentDialog({ type: "report", runId: run.id })}>
            <FileText size={12} /> Open report
          </button>
        )}
        {active && (
          <button type="button" className={linkBtn} disabled={busy} onClick={() => void cancel()}>
            <Square size={11} /> Stop
          </button>
        )}
        {canRetry(run) && (
          <button type="button" className={linkBtn} onClick={() => void retryRun(project, run.id)}>
            <RotateCcw size={12} /> Retry
          </button>
        )}
        <button
          type="button"
          aria-label="Delete run"
          title="Delete run"
          className={`${linkBtn} ml-auto`}
          onClick={() => openAgentDialog({ type: "delete", run })}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}
