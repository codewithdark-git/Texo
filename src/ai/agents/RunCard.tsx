// One run in the Agents tab, and (RunView) a run in its own editor tab. The header has a progress ring (how far along,
// or spinning when that can't be told), the title, a health chip, elapsed
// time and tokens. In Summary density the body shows the phases, what the run
// does this moment and how it came out; Detailed adds the plan checklist, the
// grouped steps, the reviewer lanes and the papers it found. The actions fit
// the status: Review the plan, Review changes, Open report, Stop, Retry, Delete.
// A card's title opens the run's tab; the chevron folds the card. The tab
// shows the same with everything open, plus what the run was asked to do,
// and announces its phase changes and how it finished to a screen reader
// (the Agents tab, whose live region covers the list, isn't mounted then).

import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronRight, CircleCheck, CirclePause, CircleX, FileDiff, Square, Trash2 } from "lucide-react";
import { agentsApi, isActive, runProgress, runStatusText, type RunStatus, type RunSummary, type Step } from "../../lib/agentsApi";
import { ProgressRing } from "../../components/ui/ProgressRing";
import { StatusDot } from "../../components/ui/StatusDot";
import { usePresence, useReducedMotion } from "../../lib/motion";
import { toast } from "../../ui";
import type { Density } from "../panel/aiPanelStore";
import { errorText, retryRun } from "./actions";
import { openAgentDialog } from "./dialogStore";
import { useRunFocus } from "./focusStore";
import { LiveLine } from "./progress/LiveLine";
import { PersonaLanes } from "./progress/PersonaLanes";
import { PhaseStepper } from "./progress/PhaseStepper";
import { PlanChecklist } from "./progress/PlanChecklist";
import { health, runFraction } from "./progress/progressModel";
import { linkBtn, ResultActions, ResultSummary } from "./progress/ResultSummary";
import { StepGroups } from "./progress/StepGroups";
import { runNews, type RunNewsMemory } from "./runNews";
import { elapsedSecs, formatElapsed, formatTokens, kindLabel, runStream, useRuns } from "./runsStore";

/** The id of a run's card, for scrolling it into view. */
export const runCardId = (runId: string) => `run-card-${runId}`;

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

const SETTLED_ICON: Partial<Record<RunStatus, [typeof CircleCheck, string]>> = {
  awaiting_input: [CirclePause, "text-warning bg-warning/10"],
  awaiting_review: [FileDiff, "text-info bg-info/10"],
  done: [CircleCheck, "text-success bg-success/10"],
  failed: [CircleX, "text-danger bg-danger/10"],
  interrupted: [CircleX, "text-danger bg-danger/10"],
  cancelled: [Square, "text-muted bg-surface-2"],
};

/** A ring while the run works (with the percentage when known), else an icon for how it ended. 28px, or 40px in a run's tab. */
function RunBadge({ run, large = false }: { run: RunSummary; large?: boolean }) {
  const settled = SETTLED_ICON[run.status];
  const box = large ? "size-10" : "size-7";
  if (settled) {
    const [Icon, tone] = settled;
    return (
      <span aria-hidden="true" className={`texo-fade-in grid ${box} shrink-0 place-items-center rounded-full ${tone}`}>
        <Icon size={(run.status === "cancelled" ? 11 : 15) * (large ? 1.35 : 1)} />
      </span>
    );
  }
  const fraction = runFraction(run);
  const label = run.status === "queued" ? "Waiting for a free slot" : `${run.title || kindLabel(run.kind)}: progress`;
  return (
    <span className={`relative grid ${box} shrink-0 place-items-center`}>
      <ProgressRing size={large ? 40 : 28} stroke={large ? 3 : 2.5} value={fraction ?? undefined} label={label} tone={run.status === "queued" ? "text-muted" : "text-accent"} />
      {fraction !== null && (
        <span aria-hidden="true" className={`absolute inset-0 grid place-items-center font-semibold tabular-nums text-muted ${large ? "text-[10.5px]" : "text-[8.5px]"}`}>
          {Math.round(fraction * 100)}
        </span>
      )}
    </span>
  );
}

/** The run's steps, fetched and followed while the card shows them. */
function useSteps(project: string, runId: string, on: boolean): Step[] | undefined {
  const steps = useRuns((s) => s.steps[runId]);
  useEffect(() => {
    if (!on) return;
    void useRuns.getState().follow(project, runId);
    return () => useRuns.getState().unfollow(runId);
  }, [project, runId, on]);
  return on ? steps : undefined;
}

/** Whether a card is open, and the focus request it last acted on. */
export interface CardView {
  open: boolean;
  /** The density the card last matched. */
  density: Density;
  /** The last focus request (seq) the card acted on. */
  seq: number;
  /** The request whose flash shows now; 0 when none. */
  flash: number;
}

/**
 * The card's view after a render with these props. A density switch opens or
 * folds the card to match; a new focus request opens it and flashes it. Both
 * are worked out while rendering, so a card that mounts with a request ends up
 * open whatever the density. Returns `v` itself when nothing changes.
 */
export function cardView(v: CardView, density: Density, focusSeq: number): CardView {
  let next = v;
  if (density !== next.density) next = { ...next, density, open: density === "detailed" };
  if (focusSeq && focusSeq !== next.seq) next = { ...next, seq: focusSeq, open: true, flash: focusSeq };
  return next;
}

/** The first view of a card. */
export const initialCardView = (density: Density, focusSeq: number): CardView =>
  cardView({ open: density === "detailed", density, seq: 0, flash: 0 }, density, focusSeq);

/** Scrolls the card into view when someone asks for this run, then clears the request. */
function useFocusScroll(runId: string, focusSeq: number, ref: RefObject<HTMLElement | null>) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!focusSeq) return;
    ref.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    if (useRunFocus.getState().runId === runId) useRunFocus.getState().clear();
    // Only a new request (seq) acts; `reduced` is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq, runId]);
}

/** Stop for a working run, with a busy flag while it is asked. */
function useStop(runId: string): [boolean, () => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      const stopped = await agentsApi.cancel(runId);
      if (!stopped) toast("That run had already finished.", "info");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return [busy, stop];
}

/** "Fix compile errors · Reviewer 2 · model · 12k tokens". */
function metaLine(run: RunSummary): string {
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  return [
    kindLabel(run.kind),
    run.profileName && run.profileName !== kindLabel(run.kind) ? run.profileName : null,
    run.model || null,
    tokens > 0 ? formatTokens(tokens) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The health chip and the elapsed time. */
function RunState({ run, now }: { run: RunSummary; now: number }) {
  const h = health(run);
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] text-muted">
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] text-text/85">
        <StatusDot tone={h.tone} pulse={h.id === "running" && run.status === "running"} />
        {h.label}
      </span>
      <span className="tabular-nums">{formatElapsed(elapsedSecs(run, now))}</span>
    </span>
  );
}

/** Phases (or the status line), what the run does now, and how it came out. */
function RunProgressBody({ run }: { run: RunSummary }) {
  const active = isActive(run.status);
  const progress = runProgress(run);
  const stream = useRuns((s) => runStream(s.streams, run.id));
  const stepWord = `${run.stepCount}${active && run.maxSteps ? ` of ${run.maxSteps}` : ""} step${run.stepCount === 1 && !(active && run.maxSteps) ? "" : "s"}`;
  return (
    <>
      {progress.phases.length > 0 ? (
        <PhaseStepper phases={progress.phases} active={active} />
      ) : (
        <p className={`text-[12px] ${run.status === "failed" || run.status === "interrupted" ? "text-danger" : "text-text/85"}`}>
          {runStatusText(run)}
          {run.stepCount > 0 && <span className="text-muted"> · {stepWord}</span>}
        </p>
      )}
      {active && (
        <LiveLine
          activity={progress.activity}
          stream={stream}
          idle={run.status === "queued" ? "Waiting for a free slot" : run.status === "awaiting_input" ? undefined : progress.phases.length ? undefined : (run.lastStep ?? undefined)}
        />
      )}
      {progress.phases.length > 0 && !active && <p className="text-[12px] text-text/85">{runStatusText(run)}</p>}
      <ResultSummary run={run} />
    </>
  );
}

/** The plan checklist, the reviewer lanes and the grouped steps. */
function RunDetails({ run, steps }: { run: RunSummary; steps: Step[] | undefined }) {
  const active = isActive(run.status);
  const progress = runProgress(run);
  const reviewer = run.kind === "reviewer";
  const ownSteps = steps && reviewer ? steps.filter((s) => !s.sub) : steps;
  // A reviewer's steps may all sit in its lanes.
  const showSteps = !ownSteps || ownSteps.length > 0 || !steps?.length;
  return (
    <>
      <PlanChecklist plan={progress.plan} />
      {steps && reviewer && <PersonaLanes steps={steps} activity={progress.activity} active={active} />}
      {!ownSteps ? (
        <p className="px-1 text-[12px] text-muted">Loading steps…</p>
      ) : (
        showSteps && (
          <section aria-label="Steps">
            {(progress.plan.length > 0 || reviewer) && <p className="mb-1 text-[11px] font-medium text-muted">Steps</p>}
            <StepGroups steps={ownSteps} active={active} />
          </section>
        )
      )}
    </>
  );
}

/** What to do next, Stop while it works, and Delete. */
function RunActionsRow({ project, run }: { project: string; run: RunSummary }) {
  const [busy, stop] = useStop(run.id);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ResultActions run={run} onRetry={() => void retryRun(project, run.id)} />
      {isActive(run.status) && (
        <button type="button" className={linkBtn} disabled={busy} onClick={() => void stop()}>
          <Square size={11} /> Stop
        </button>
      )}
      <button type="button" aria-label="Delete run" title="Delete run" className={`${linkBtn} ml-auto`} onClick={() => openAgentDialog({ type: "delete", run })}>
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export interface RunCardProps {
  project: string;
  run: RunSummary;
  density?: Density;
  /** Goes up when someone asks to see this run (the dock, Command Center); 0 otherwise. */
  focusSeq?: number;
}

export function RunCard({ project, run, density = "summary", focusSeq = 0 }: RunCardProps) {
  const active = isActive(run.status);
  const [view, setView] = useState(() => initialCardView(density, focusSeq));
  const card = useRef<HTMLElement>(null);
  const now = useNow(active);
  // Density switches and focus requests are applied while rendering (see cardView).
  const next = cardView(view, density, focusSeq);
  if (next !== view) setView(next);
  const { open, flash } = next;
  const details = usePresence(open, 220);
  const steps = useSteps(project, run.id, details.mounted);
  const toReview = run.pendingFiles > 0 || run.conflictFiles > 0;
  const title = run.title || kindLabel(run.kind);

  useFocusScroll(run.id, focusSeq, card);
  // The flash ends on its own; clearing the request (seq back to 0) doesn't cut it short.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setView((v) => (v.flash === flash ? { ...v, flash: 0 } : v)), 700);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <article
      ref={card}
      id={runCardId(run.id)}
      aria-label={title}
      className={`relative rounded-xl border bg-surface px-2.5 py-2 shadow-sm transition-colors duration-[var(--dur-3)] ${
        run.needsAttention && toReview ? "border-warning/50" : run.status === "awaiting_input" ? "border-warning/40" : "border-border"
      }`}
    >
      {/* Keyed on the request, so every request plays the flash afresh. */}
      {flash > 0 && <span key={flash} aria-hidden="true" data-flash="" className="texo-flash pointer-events-none absolute inset-0 rounded-xl" />}
      <div className="flex items-start gap-2.5">
        <RunBadge run={run} />
        <div className="flex min-w-0 flex-1 items-start gap-0.5">
          <button type="button" onClick={() => useRunFocus.getState().focus(run.id)} title="Open in a tab" className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[13px] font-medium hover:underline">{title}</span>
            <span className="block truncate text-[11px] text-muted">{metaLine(run)}</span>
          </button>
          <button
            type="button"
            onClick={() => setView((v) => ({ ...v, open: !v.open }))}
            aria-expanded={open}
            aria-label={open ? `Fold ${title}` : `Unfold ${title}`}
            title={open ? "Show less" : "Show more"}
            className="grid size-5 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ChevronRight size={12} aria-hidden="true" className={`transition-transform duration-[var(--dur-2)] ${open ? "rotate-90" : ""}`} />
          </button>
        </div>
        <RunState run={run} now={now} />
      </div>

      <div className="mt-2 space-y-2">
        <RunProgressBody run={run} />
      </div>

      <div className="texo-collapse" data-open={open ? "" : "false"}>
        <div inert={!open}>
          {details.mounted && (
            <div className="mt-2 space-y-2.5 border-t border-border pt-2">
              <RunDetails run={run} steps={steps} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-2">
        <RunActionsRow project={project} run={run} />
      </div>
    </article>
  );
}

/** A run's steps and what it was asked, fetched and followed while its tab shows. */
function useRunJournal(project: string, runId: string): { steps: Step[] | undefined; prompt: string | null } {
  const steps = useRuns((s) => s.steps[runId]);
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPrompt(null);
    void useRuns
      .getState()
      .follow(project, runId)
      .then((r) => live && setPrompt(r?.prompt.trim() || null));
    return () => {
      live = false;
      useRuns.getState().unfollow(runId);
    };
  }, [project, runId]);
  return { steps, prompt };
}

/** A run in its own editor tab: the card's content with everything open, centred in the editor area. */
export function RunView({ project, runId }: { project: string; runId: string }) {
  const run = useRuns((s) => s.runs[runId]);
  const loading = useRuns((s) => s.loading || s.project !== project);
  // The request that opened this tab has been met.
  const seq = useRunFocus((s) => (s.runId === runId ? s.seq : 0));
  useEffect(() => {
    if (seq) useRunFocus.getState().clear();
  }, [seq]);
  if (!run)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted">
        {loading ? <p>Loading this task…</p> : <p>This task is no longer here.</p>}
      </div>
    );
  return <RunPage project={project} run={run} />;
}

/** The latest news about the run in this tab, for its live region. */
function useRunNews(run: RunSummary): string {
  const memory = useRef<RunNewsMemory>({ phases: {} });
  const [text, setText] = useState("");
  useEffect(() => {
    // A different run in the same tab starts fresh.
    if (memory.current.status !== undefined && !(run.id in memory.current.phases)) memory.current = { phases: {} };
    const { lines, memory: next } = runNews(memory.current, run);
    memory.current = next;
    if (lines.length) setText(lines.join(". "));
  }, [run]);
  return text;
}

function RunPage({ project, run }: { project: string; run: RunSummary }) {
  const active = isActive(run.status);
  const now = useNow(active);
  const { steps, prompt } = useRunJournal(project, run.id);
  const news = useRunNews(run);
  const title = run.title || kindLabel(run.kind);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Visually hidden; phase changes and the finish only, never streamed text. */}
      <div aria-live="polite" aria-atomic="true" role="status" className="sr-only">
        {news}
      </div>
      <article aria-label={title} className="texo-fade-in mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
        <header className="flex items-start gap-3">
          <RunBadge run={run} large />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold" title={title}>
              {title}
            </h2>
            <p className="truncate text-xs text-muted">{metaLine(run)}</p>
          </div>
          <RunState run={run} now={now} />
        </header>
        {prompt && (
          <blockquote className="line-clamp-4 border-l-2 border-accent/40 pl-3 text-[13px] whitespace-pre-wrap text-text/85" title={prompt}>
            {prompt}
          </blockquote>
        )}
        <section aria-label="Progress" className="space-y-2 rounded-xl border border-border bg-surface px-3.5 py-3 shadow-sm">
          <RunProgressBody run={run} />
          <div className="pt-1">
            <RunActionsRow project={project} run={run} />
          </div>
        </section>
        <section aria-label="Details" className="space-y-3">
          <RunDetails run={run} steps={steps} />
        </section>
      </article>
    </div>
  );
}
